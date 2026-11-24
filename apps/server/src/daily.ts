// The daily run: backup, then tombstone cleanup. A plain function, triggered by the Bun entry's
// hourly check or by POST /admin/run-daily.
import type { BackupRun, CleanupRun } from "@budgee/core";
import { type BackupDeps, readLastSuccessfulBackup, runBackup } from "./backup";
import { readLastCleanup, runCleanup } from "./cleanup";

/** Hour (UTC) of the daily run. */
export const DAILY_RUN_UTC_HOUR = 3;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type DailyDeps = BackupDeps;

export interface DailyResult {
  backup: BackupRun;
  cleanup: CleanupRun;
}

/**
 * Backs up, then purges old tombstones (so today's backup still holds them). Each step records
 * its outcome in `config` for Settings, and a failed backup does not stop the cleanup. When
 * either step failed, or old backups could not be removed, it then throws, so a scheduler sees
 * the failure. The next run retries; a failed backup (not a failed removal of old files) is
 * retried at the next check (runDailyIfDue), hourly on the Bun entry.
 */
export async function runDaily(deps: DailyDeps): Promise<DailyResult> {
  const backup = await runBackup(deps);
  const cleanup = await runCleanup(deps);
  const failures = [
    backup.status === "error" ? `backup: ${backup.error}` : null,
    backup.retentionError ? `retention: ${backup.retentionError}` : null,
    cleanup.ok ? null : `cleanup: ${cleanup.error}`,
  ].filter((failure) => failure !== null);
  if (failures.length > 0) throw new Error(`Daily run failed (${failures.join("; ")})`);
  return { backup, cleanup };
}

/** The next daily run after `now`: the next DAILY_RUN_UTC_HOUR:00 UTC. */
export function nextDailyRun(now: number): number {
  const date = new Date(now);
  const today = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    DAILY_RUN_UTC_HOUR,
  );
  return now < today ? today : today + DAY;
}

/** Whether a run is due: the last one (null: none yet) is older than the latest 03:00 UTC. */
export function isDailyRunDue(now: number, lastRunAt: number | null): boolean {
  const date = new Date(now);
  const today = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    DAILY_RUN_UTC_HOUR,
  );
  const latestSlot = now >= today ? today : today - DAY;
  return lastRunAt === null || lastRunAt < latestSlot;
}

/**
 * For hosts that poll; the Bun entry checks every hour. The daily run is due once a day, going
 * by the recorded cleanup, which only the daily run does; a failed cleanup still counts for the
 * day. The backup alone is due again until one succeeds for the day, so a failed (or not yet
 * configured) backup is retried at every check; "back up now" counts too. Throws when the
 * backup failed again. Returns whether anything ran.
 */
export async function runDailyIfDue(deps: DailyDeps): Promise<boolean> {
  const now = deps.clock.now();
  const lastCleanup = await readLastCleanup(deps.db);
  if (isDailyRunDue(now, lastCleanup?.at ?? null)) {
    await runDaily(deps);
    return true;
  }
  if (!isDailyRunDue(now, await readLastSuccessfulBackup(deps.db))) return false;
  const backup = await runBackup(deps);
  if (backup.status === "error") throw new Error(`Backup retry failed (${backup.error})`);
  return true;
}

/** Milliseconds from `now` to the next full hour (UTC), when the Bun entry checks again. */
export function msUntilNextCheck(now: number): number {
  return HOUR - (now % HOUR);
}
