// Backups: every envelope as gzipped JSON Lines, written to the BackupDestination, then old
// files pruned by the retention rule. The rows are already encrypted, so nothing more is added.
import {
  type BackupErrorCode,
  type BackupRecord,
  type BackupRun,
  backupRunSchema,
  type TableName,
} from "@budgee/core";
import * as v from "valibot";
import { readConfigJson, writeConfigJson } from "./init";
import {
  type BackupDestination,
  type BackupProvider,
  type Clock,
  type Db,
  DestinationError,
  ReconnectNeededError,
} from "./ports";
import { safeErrorMessage } from "./redact";

/** `config` key of the last backup attempt, daily or "back up now". */
export const LAST_BACKUP_KEY = "last_backup";

/** `config` key of when the last successful backup started, for the hourly retry. */
export const LAST_BACKUP_OK_KEY = "last_backup_ok";

/**
 * Envelopes read per query. A typical row is under 1 KB, so a page stays a few MB.
 */
export const BACKUP_PAGE_SIZE = 5000;

export interface BackupDeps {
  db: Db;
  clock: Clock;
  backup: BackupProvider;
}

/** Provider reasons for a full destination or missing permission (Google Drive's). */
const REFUSED_REASONS = new Set([
  "storageQuotaExceeded",
  "quotaExceeded",
  "insufficientFilePermissions",
  "insufficientPermissions",
  "forbidden",
]);

/** What kind of failure `error` is, for Settings to explain in its own words. */
export function backupErrorCode(error: unknown): BackupErrorCode {
  if (error instanceof ReconnectNeededError) return "reconnect";
  if (!(error instanceof DestinationError)) return "other";
  const { status, reason } = error;
  if (status === 401 || reason === "invalid_grant") return "reconnect";
  if (status === 403 || status === 507 || (reason && REFUSED_REASONS.has(reason))) {
    // A 403 for too many requests is a passing problem, not a refusal.
    return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"
      ? "unavailable"
      : "refused";
  }
  if (status === 404) return "not_found";
  if (status === null || status === 429 || status >= 500) return "unavailable";
  return "other";
}

/** The message and code a failure is recorded with. */
const failed = (error: unknown) => ({
  error: safeErrorMessage(error),
  errorCode: backupErrorCode(error),
});

/** A provider for a destination that is always there (or, with null, never). */
export function staticBackup(destination: BackupDestination | null): BackupProvider {
  return {
    open: async () => destination,
    status: async () => ({
      kind: destination?.kind ?? null,
      configured: destination !== null,
      connected: destination !== null,
      reconnectNeeded: false,
    }),
  };
}

/** `budgee-YYYY-MM-DD.jsonl.gz`, for the UTC day of `now`. */
export function backupFileName(now: number): string {
  return `budgee-${new Date(now).toISOString().slice(0, 10)}.jsonl.gz`;
}

interface EnvelopeRow {
  table: TableName;
  id: string;
  hlc: string;
  deleted: number;
  seq: number;
  blob: string | null;
}

const toRecord = ({ table, id, hlc, deleted, blob }: EnvelopeRow): BackupRecord =>
  deleted
    ? { table, id, hlc, deleted: true }
    : { table, id, hlc, deleted: false, blob: blob ?? "" };

/**
 * Every envelope as one JSON line, gzipped with CompressionStream. The rows are read page by
 * page in seq order and streamed into the compressor, so only one page of text is in memory at
 * a time. A row edited mid-backup moves to a higher seq, so it can be read twice, old and new;
 * readers keep the higher hlc of each row (core `latestRecords`).
 */
export async function buildBackup(
  db: Db,
  pageSize = BACKUP_PAGE_SIZE,
): Promise<{ bytes: Uint8Array; envelopes: number }> {
  const encoder = new TextEncoder();
  let cursor = 0;
  let envelopes = 0;
  const lines = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const rows = await db.query<EnvelopeRow>(
        `SELECT "table", id, hlc, deleted, seq, blob FROM envelopes
         WHERE seq > ? ORDER BY seq LIMIT ?`,
        [cursor, pageSize],
      );
      const last = rows.at(-1);
      if (!last) {
        controller.close();
        return;
      }
      let text = "";
      for (const row of rows) text += `${JSON.stringify(toRecord(row))}\n`;
      // TextEncoder always returns a fresh (never shared) ArrayBuffer; some typings lose that.
      controller.enqueue(encoder.encode(text) as Uint8Array<ArrayBuffer>);
      cursor = last.seq;
      envelopes += rows.length;
    },
  });
  const gzipped = lines.pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(gzipped).arrayBuffer());
  return { bytes, envelopes };
}

const BACKUP_NAME = /^budgee-(\d{4})-(\d{2})-(\d{2})\.jsonl\.gz$/;
const DAY = 24 * 60 * 60 * 1000;

/** The UTC day in a backup file name, as ms; null for any other name or an impossible date. */
function backupDate(name: string): number | null {
  const match = BACKUP_NAME.exec(name);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const time = Date.UTC(y, m - 1, d);
  const date = new Date(time);
  const real =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return real ? time : null;
}

const dayKey = (time: number) => time;
/** ISO weeks run Monday to Sunday; a week is keyed by its Monday. */
const weekKey = (time: number) => time - ((new Date(time).getUTCDay() + 6) % 7) * DAY;
const monthKey = (time: number) => {
  const date = new Date(time);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
};

/** Retention tiers, newest first (spec: 7 daily, 4 weekly, 12 monthly copies). */
const TIERS: readonly { count: number; key: (time: number) => number }[] = [
  { count: 7, key: dayKey },
  { count: 4, key: weekKey },
  { count: 12, key: monthKey },
];

/**
 * The backups to delete. The rule, on the UTC date in each file name:
 *
 * Backups are taken newest first. The daily tier keeps the newest backup of each of the 7 most
 * recent days that have one. The weekly tier then goes on with the older backups only, and keeps
 * the newest backup of each of the next 4 ISO weeks (Monday to Sunday) that do not already hold
 * a kept backup. The monthly tier does the same for the next 12 calendar months. Every other
 * `budgee-YYYY-MM-DD.jsonl.gz` is deleted.
 *
 * With one backup a day, that keeps exactly 7 + 4 + 12 = 23 files. Only days, weeks and months
 * holding a backup count, so missed days never shrink a tier. Names that are not
 * `budgee-YYYY-MM-DD.jsonl.gz` with a real date are never deleted.
 */
export function expiredBackups(names: readonly string[]): string[] {
  const byDate = new Map<number, string>();
  for (const name of names) {
    const date = backupDate(name);
    if (date !== null) byDate.set(date, name);
  }
  const dates = [...byDate.keys()].sort((a, b) => b - a);

  const kept = new Set<number>();
  let next = 0;
  for (const { count, key } of TIERS) {
    // A period that already holds a kept backup has had its newest one kept.
    const covered = new Set([...kept].map(key));
    let taken = 0;
    while (next < dates.length && taken < count) {
      const date = dates[next++] as number;
      if (covered.has(key(date))) continue;
      covered.add(key(date));
      kept.add(date);
      taken++;
    }
  }
  return dates.filter((date) => !kept.has(date)).map((date) => byDate.get(date) as string);
}

/**
 * Opens the destination, writes today's backup (overwriting one from earlier today), then
 * applies retention. Every outcome is recorded; nothing is thrown. Once the file is saved the
 * backup counts as done (`last_backup_ok`), even if removing old files then fails: that is
 * recorded in `retentionError`. A `not_configured` result is recorded only when the last
 * recorded run was something else, so hourly checks do not keep rewriting it.
 */
export async function runBackup({ db, clock, backup: provider }: BackupDeps): Promise<BackupRun> {
  const at = clock.now();
  const finish = async (
    run: Pick<BackupRun, "status" | "file" | "envelopes"> &
      Partial<Pick<BackupRun, "error" | "errorCode" | "retentionError" | "retentionErrorCode">>,
  ): Promise<BackupRun> => {
    const record: BackupRun = {
      at,
      status: run.status,
      error: run.error ?? null,
      errorCode: run.errorCode ?? null,
      file: run.file,
      envelopes: run.envelopes,
      durationMs: Math.max(0, clock.now() - at),
      retentionError: run.retentionError ?? null,
      retentionErrorCode: run.retentionErrorCode ?? null,
    };
    if (
      record.status !== "not_configured" ||
      (await readLastBackup(db))?.status !== record.status
    ) {
      await writeConfigJson(db, LAST_BACKUP_KEY, record);
    }
    return record;
  };

  let backup: BackupDestination | null;
  try {
    backup = await provider.open();
  } catch (error) {
    return finish({ status: "error", ...failed(error), file: null, envelopes: null });
  }
  if (!backup) {
    return finish({ status: "not_configured", file: null, envelopes: null });
  }

  const file = backupFileName(at);
  let envelopes: number;
  try {
    const built = await buildBackup(db);
    envelopes = built.envelopes;
    await backup.put(file, built.bytes);
  } catch (error) {
    return finish({ status: "error", ...failed(error), file: null, envelopes: null });
  }
  // Saved: the hourly retry has nothing left to do today, whatever retention does.
  await writeConfigJson(db, LAST_BACKUP_OK_KEY, at);

  try {
    for (const name of expiredBackups(await backup.list())) await backup.remove(name);
  } catch (error) {
    const { error: message, errorCode } = failed(error);
    return finish({
      status: "ok",
      file,
      envelopes,
      retentionError: message,
      retentionErrorCode: errorCode,
    });
  }
  return finish({ status: "ok", file, envelopes });
}

/** The last backup attempt, null before the first. */
export function readLastBackup(db: Db): Promise<BackupRun | null> {
  return readConfigJson(db, LAST_BACKUP_KEY, backupRunSchema);
}

/** When the last successful backup started (ms), null before the first. */
export function readLastSuccessfulBackup(db: Db): Promise<number | null> {
  return readConfigJson(db, LAST_BACKUP_OK_KEY, v.number());
}
