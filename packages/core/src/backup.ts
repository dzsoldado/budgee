// Backup files: every envelope as one JSON line (`table`, `id`, `hlc`, `deleted`, `blob`),
// gzipped. The server writes them; restore and the decrypt-backup script read them back here.
import * as v from "valibot";
import { type BackupRecord, backupRecordSchema } from "./schema";

export class BackupFormatError extends Error {
  override name = "BackupFormatError";
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/**
 * The records of a backup file, in file order. Throws BackupFormatError when the file is not
 * gzip or a line is not a valid record; the message gives the line number, never its content.
 */
export async function parseBackup(bytes: Uint8Array): Promise<BackupRecord[]> {
  let text: string;
  try {
    text = await new Response(streamOf(bytes).pipeThrough(new DecompressionStream("gzip"))).text();
  } catch (cause) {
    throw new BackupFormatError("Backup is not a gzip file", { cause });
  }

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, i) => {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      data = undefined;
    }
    const result = v.safeParse(backupRecordSchema, data);
    if (!result.success) throw new BackupFormatError(`Line ${i + 1} is not a valid backup record`);
    return result.output;
  });
}

/**
 * The newest record of each row (highest hlc per table and id), in order of first appearance.
 * A row edited while the backup ran is in the file twice, old and new.
 */
export function latestRecords(records: readonly BackupRecord[]): BackupRecord[] {
  const latest = new Map<string, BackupRecord>();
  for (const record of records) {
    const key = `${record.table}/${record.id}`;
    const seen = latest.get(key);
    if (!seen || record.hlc > seen.hlc) latest.set(key, record);
  }
  return [...latest.values()];
}

// Browsers add " (1)" to a repeated download, before or after `.jsonl`.
const BACKUP_FILE_DATE = /^budgee-(\d{4})-(\d{2})-(\d{2})\b.*\.gz$/i;

/** The `YYYY-MM-DD` day in a backup file's name; undefined for any other name. */
export function backupFileDate(name: string): string | undefined {
  const match = BACKUP_FILE_DATE.exec(name);
  if (!match) return undefined;
  const [, y, m, d] = match as unknown as [string, string, string, string];
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const day = `${y}-${m}-${d}`;
  return date.toISOString().slice(0, 10) === day ? day : undefined;
}
