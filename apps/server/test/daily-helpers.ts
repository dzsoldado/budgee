// A migrated in-memory database and a clock the test moves, for the daily-run tests.
import { Database } from "bun:sqlite";
import { bunSqliteDb } from "../adapters/db/bun-sqlite";
import { migrations } from "../migrations";
import { initDatabase } from "../src/init";
import type { BackupDestination } from "../src/ports";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
/** Tuesday 17 November 2026, 03:00 UTC: the daily run's slot. */
export const TODAY = Date.parse("2026-11-17T03:00:00Z");

export async function dailyFixture() {
  const database = new Database(":memory:");
  const db = bunSqliteDb(database);
  await initDatabase(db, migrations);
  let now = TODAY;
  return {
    db,
    clock: { now: () => now },
    advance(ms: number) {
      now += ms;
    },
    close: () => database.close(),
  };
}

/** `budgee-YYYY-MM-DD.jsonl.gz` for the UTC day `days` before (negative: after) `from`. */
export const backupName = (days: number, from = TODAY) =>
  `budgee-${new Date(from - days * DAY).toISOString().slice(0, 10)}.jsonl.gz`;

/** A destination whose calls all fail with `message`. */
export const failingBackup = (message: string): BackupDestination => ({
  kind: "broken",
  put: () => Promise.reject(new Error(message)),
  list: () => Promise.reject(new Error(message)),
  remove: () => Promise.reject(new Error(message)),
});

/** What a destination's error message might carry and the status must never show. */
export const SECRET = "ya29.a0AfB_byC3xKq9ZpQ7mN2vR8sT1uW4yX6zA5bD0eF";
