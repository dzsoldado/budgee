// Restore from backup (spec "Backups → Restore"): a `budgee-YYYY-MM-DD.jsonl.gz` downloaded from
// Drive is read, decrypted with the vault key and merged like a sync: per row the higher hlc
// wins. Restored rows are written dirty so the next sync pushes them, which also seeds a fresh
// server. Everything is decrypted before anything is written, so a wrong key changes nothing.
import {
  BackupFormatError,
  backupFileDate,
  DecryptError,
  fromEnvelope,
  InvalidRowError,
  latestRecords,
  parseBackup,
  parseHlc,
  SYNCED_TABLES,
  type SyncRow,
  shouldApply,
  type TableName,
} from "@budgee/core";
import type { BudgeeDb } from "../db/db";
import type { Repository } from "../db/repository";

/**
 * `not_backup`: not a gzipped backup file. `wrong_key`: the first row does not open with the key.
 * `damaged`: a row fails after others opened, or decrypts to fields that are not a valid row.
 * `too_large`: over MAX_BACKUP_BYTES, refused before reading.
 */
export type RestoreProblem = "not_backup" | "wrong_key" | "damaged" | "too_large";

/**
 * The largest backup file read. Gzipped JSON Lines of encrypted rows: years of personal
 * entries stay far below; the whole file is held in memory while it is read.
 */
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

export class RestoreError extends Error {
  override name = "RestoreError";
  readonly reason: RestoreProblem;

  constructor(reason: RestoreProblem, options?: ErrorOptions) {
    super(reason, options);
    this.reason = reason;
  }
}

export interface BackupContents {
  /** The day in the file name (`YYYY-MM-DD`); undefined when the file was renamed. */
  date: string | undefined;
  /** The newest version of each row, decrypted: live rows and tombstones. */
  rows: SyncRow[];
  /** Live rows per table. */
  counts: Record<TableName, number>;
  /** Tombstones (deleted rows). */
  deleted: number;
  /** The highest hlc in the file, for the clock; undefined when the file is empty. */
  clock: string | undefined;
}

/** Throws RestoreError("too_large") for a file of `size` bytes over `max`; cheap, before reading. */
export function checkBackupSize(size: number, max = MAX_BACKUP_BYTES): void {
  if (size > max) throw new RestoreError("too_large");
}

/** Reads and decrypts a backup file. Throws RestoreError. */
export async function readBackupFile(
  bytes: Uint8Array,
  name: string,
  key: CryptoKey,
  maxBytes = MAX_BACKUP_BYTES,
): Promise<BackupContents> {
  checkBackupSize(bytes.length, maxBytes);
  let records: Awaited<ReturnType<typeof parseBackup>>;
  try {
    records = await parseBackup(bytes);
  } catch (error) {
    if (error instanceof BackupFormatError) throw new RestoreError("not_backup", { cause: error });
    throw error;
  }

  const counts = Object.fromEntries(SYNCED_TABLES.map((table) => [table, 0])) as Record<
    TableName,
    number
  >;
  const rows: SyncRow[] = [];
  let deleted = 0;
  let clock: string | undefined;
  let opened = false;
  for (const record of latestRecords(records)) {
    if (clock === undefined || record.hlc > clock) clock = record.hlc;
    // Backups leave out the device column; the hlc ends with it.
    const envelope = { ...record, device: parseHlc(record.hlc).device };
    try {
      rows.push({ table: record.table, row: await fromEnvelope(key, envelope) } as SyncRow);
    } catch (error) {
      if (error instanceof DecryptError) {
        throw new RestoreError(opened ? "damaged" : "wrong_key", { cause: error });
      }
      if (error instanceof InvalidRowError) throw new RestoreError("damaged", { cause: error });
      throw error;
    }
    if (record.deleted) deleted++;
    else {
      opened = true;
      counts[record.table]++;
    }
  }
  return { date: backupFileDate(name), rows, counts, deleted, clock };
}

/**
 * How many of `rows` would change this device now: their hlc beats the local row's, and a
 * tombstone has a row here to delete (restoreBackup skips the others). `deletions`: those that
 * delete a live row here.
 */
export async function countChanges(
  db: BudgeeDb,
  rows: readonly SyncRow[],
): Promise<{ changes: number; deletions: number }> {
  const tables = SYNCED_TABLES.map((table) => db.rows(table));
  return db.transaction("r", tables, async () => {
    let changes = 0;
    let deletions = 0;
    for (const table of SYNCED_TABLES) {
      const incoming = rows.filter((r) => r.table === table).map((r) => r.row);
      if (incoming.length === 0) continue;
      const local = await db.rows(table).bulkGet(incoming.map((row) => row.id));
      incoming.forEach((row, i) => {
        const target = local[i];
        if ((target || !row.deleted) && shouldApply(target, row)) {
          changes++;
          if (row.deleted && target && !target.deleted) deletions++;
        }
      });
    }
    return { changes, deletions };
  });
}

/**
 * Merges the backup into this device by hlc, winners marked dirty for the next push. `applied`:
 * rows written; the others were already as new here.
 */
export async function restoreBackup(
  repo: Repository,
  contents: BackupContents,
): Promise<{ applied: number; total: number }> {
  const applied = await repo.applyRestore(contents.rows, contents.clock);
  return { applied, total: contents.rows.length };
}
