// Tombstone cleanup, part of the daily run.
import { type CleanupRun, cleanupRunSchema, SEED_IDS } from "@budgee/core";
import { PURGE_SEQ_KEY, readConfigJson, writeConfigJson } from "./init";
import type { Clock, Db } from "./ports";
import { safeErrorMessage } from "./redact";

/** `config` key of the last cleanup, which only the daily run does. */
export const LAST_CLEANUP_KEY = "last_cleanup";

/** How long a tombstone is kept after its last change on the server. */
export const TOMBSTONE_MAX_AGE = 90 * 24 * 60 * 60 * 1000;

// A tombstone goes once its last change on the server (updated_at) is older than 90 days and
// every non-revoked device has acknowledged a seq at or past it. MIN over no devices is NULL,
// which matches nothing: with no active device, nothing is purged. Default (seeded) rows keep
// their tombstones for good: every device seeds them, so once purged, a device paired later would
// push the default back. The purge point is computed with the same predicate, so it skips them.
const PURGEABLE = `deleted = 1 AND updated_at < ?
  AND seq <= (SELECT MIN(last_ack_seq) FROM devices WHERE revoked = 0)
  AND id NOT IN (${SEED_IDS.map(() => "?").join(", ")})`;

/**
 * Deletes the purgeable tombstones and raises the purge point to the highest seq deleted, in one
 * batch. The purge point never goes down, and seq_counter is not touched (seqs are never reused).
 * Returns how many were deleted.
 */
export async function purgeTombstones(db: Db, now: number): Promise<number> {
  const cutoff = now - TOMBSTONE_MAX_AGE;
  const [, deleted] = await db.batch([
    {
      // The outer WHERE is also what lets SQLite parse INSERT … SELECT … ON CONFLICT.
      sql: `INSERT INTO config (key, value)
        SELECT ?, top FROM (SELECT MAX(seq) AS top FROM envelopes WHERE ${PURGEABLE})
        WHERE top IS NOT NULL
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
        WHERE CAST(excluded.value AS INTEGER) > CAST(config.value AS INTEGER)`,
      params: [PURGE_SEQ_KEY, cutoff, ...SEED_IDS],
    },
    { sql: `DELETE FROM envelopes WHERE ${PURGEABLE}`, params: [cutoff, ...SEED_IDS] },
  ]);
  return deleted?.changes ?? 0;
}

/** Purges what it can and records the run; a failure is recorded, not thrown. */
export async function runCleanup({ db, clock }: { db: Db; clock: Clock }): Promise<CleanupRun> {
  const at = clock.now();
  let run: Omit<CleanupRun, "durationMs">;
  try {
    run = { at, ok: true, error: null, purged: await purgeTombstones(db, at) };
  } catch (error) {
    run = { at, ok: false, error: safeErrorMessage(error), purged: 0 };
  }
  const record: CleanupRun = { ...run, durationMs: Math.max(0, clock.now() - at) };
  await writeConfigJson(db, LAST_CLEANUP_KEY, record);
  return record;
}

/** The last cleanup, null before the first. */
export function readLastCleanup(db: Db): Promise<CleanupRun | null> {
  return readConfigJson(db, LAST_CLEANUP_KEY, cleanupRunSchema);
}
