import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseBackup } from "@budgee/core";
import { memoryBackup } from "../adapters/backup/memory";
import { readLastBackup, readLastSuccessfulBackup, runBackup, staticBackup } from "../src/backup";
import { readLastCleanup, TOMBSTONE_MAX_AGE } from "../src/cleanup";
import {
  DAILY_RUN_UTC_HOUR,
  isDailyRunDue,
  msUntilNextCheck,
  nextDailyRun,
  runDaily,
  runDailyIfDue,
} from "../src/daily";
import { storeEnvelopes } from "../src/envelopes";
import type { BackupDestination, Db } from "../src/ports";
import { liveEnvelope, tombstoneEnvelope, uuid } from "./api-helpers";
import { DAY, dailyFixture, failingBackup, HOUR, SECRET, TODAY } from "./daily-helpers";

let f: Awaited<ReturnType<typeof dailyFixture>>;
beforeEach(async () => {
  f = await dailyFixture();
});
afterEach(() => f.close());

/** One device that has seen everything, and a tombstone due for purging at TODAY. */
async function purgeableTombstone() {
  const [live, gone] = [uuid(), uuid()];
  await storeEnvelopes(
    f.db,
    [liveEnvelope(live, 1), tombstoneEnvelope(gone, 1)],
    TODAY - TOMBSTONE_MAX_AGE - 1,
  );
  await f.db.run(
    "INSERT INTO devices (id, name, token_hash, created_at, last_ack_seq) VALUES ('d', 'Phone', 'h', 0, 2)",
  );
  return { live, gone };
}

const ids = async () =>
  (await f.db.query<{ id: string }>("SELECT id FROM envelopes")).map((r) => r.id);

describe("runDaily", () => {
  test("backs up, then cleans up, and records both", async () => {
    const { live, gone } = await purgeableTombstone();
    const backup = memoryBackup();
    const result = await runDaily({ db: f.db, clock: f.clock, backup: staticBackup(backup) });

    expect(result.backup).toMatchObject({ status: "ok", envelopes: 2 });
    expect(result.cleanup).toMatchObject({ ok: true, purged: 1 });
    expect(await readLastBackup(f.db)).toEqual(result.backup);
    expect(await readLastCleanup(f.db)).toEqual(result.cleanup);
    // The backup ran first, so it still holds the tombstone the cleanup then purged.
    const file = backup.files.get("budgee-2026-11-17.jsonl.gz");
    expect(file && (await parseBackup(file)).map((r) => r.id)).toEqual([live, gone]);
    expect(await ids()).toEqual([live]);
  });

  test("without a destination the backup is `not_configured` and the cleanup still runs", async () => {
    await purgeableTombstone();
    const result = await runDaily({ db: f.db, clock: f.clock, backup: staticBackup(null) });
    expect(result.backup.status).toBe("not_configured");
    expect(result.cleanup).toMatchObject({ ok: true, purged: 1 });
  });

  test("a failed backup still lets the cleanup run, then fails the run without secrets", async () => {
    await purgeableTombstone();
    const backup = staticBackup(failingBackup(`401 for ${SECRET}`));
    const error = await runDaily({ db: f.db, clock: f.clock, backup }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("backup");
    expect((error as Error).message).not.toContain(SECRET.slice(5));
    expect(await readLastBackup(f.db)).toMatchObject({ status: "error" });
    expect(await readLastCleanup(f.db)).toMatchObject({ ok: true, purged: 1 });
  });

  test("a failed cleanup fails the run after both are recorded", async () => {
    const broken: Db = { ...f.db, batch: () => Promise.reject(new Error("locked")) };
    const error = await runDaily({
      db: broken,
      clock: f.clock,
      backup: staticBackup(memoryBackup()),
    }).catch((e: unknown) => e);
    expect((error as Error).message).toContain("cleanup: locked");
    expect(await readLastBackup(f.db)).toMatchObject({ status: "ok" });
    expect(await readLastCleanup(f.db)).toMatchObject({ ok: false, error: "locked" });
  });
});

describe("daily schedule", () => {
  const at = (iso: string) => Date.parse(iso);

  test(`is due when the last run is older than the latest ${DAILY_RUN_UTC_HOUR}:00 UTC`, () => {
    expect(DAILY_RUN_UTC_HOUR).toBe(3);
    // Never run: due at once, whatever the time.
    expect(isDailyRunDue(at("2026-11-17T02:59:59Z"), null)).toBe(true);
    expect(isDailyRunDue(at("2026-11-17T02:59:59Z"), at("2026-11-16T03:00:00Z"))).toBe(false);
    expect(isDailyRunDue(at("2026-11-17T03:00:00Z"), at("2026-11-16T03:00:00Z"))).toBe(true);
    expect(isDailyRunDue(at("2026-11-17T23:00:00Z"), at("2026-11-16T03:00:00Z"))).toBe(true);
    expect(isDailyRunDue(at("2026-11-17T23:00:00Z"), at("2026-11-17T03:00:00Z"))).toBe(false);
    // A run before today's slot (by run-daily at 01:00, say) does not count for today.
    expect(isDailyRunDue(at("2026-11-17T04:00:00Z"), at("2026-11-17T01:00:00Z"))).toBe(true);
    // Before the slot, yesterday's run is the latest one due.
    expect(isDailyRunDue(at("2026-11-17T01:00:00Z"), at("2026-11-16T03:00:01Z"))).toBe(false);
    expect(isDailyRunDue(at("2026-11-17T01:00:00Z"), at("2026-11-15T03:00:00Z"))).toBe(true);
  });

  test("checks on every full hour", () => {
    expect(msUntilNextCheck(at("2026-11-17T02:15:00Z"))).toBe(45 * 60_000);
    expect(msUntilNextCheck(at("2026-11-17T03:00:00Z"))).toBe(60 * 60_000);
    expect(msUntilNextCheck(at("2026-11-17T02:59:59.999Z"))).toBe(1);
  });

  test("runDailyIfDue runs once a day, going by the recorded run", async () => {
    const backup = memoryBackup();
    const run = () => runDailyIfDue({ db: f.db, clock: f.clock, backup: staticBackup(backup) });
    f.advance(-60 * 60_000); // 02:00, never run before: catches up at once
    expect(await run()).toBe(true);
    f.advance(30 * 60_000);
    expect(await run()).toBe(false);
    f.advance(30 * 60_000); // 03:00: today's run
    expect(await run()).toBe(true);
    expect(await readLastCleanup(f.db)).toMatchObject({ at: TODAY });
    f.advance(5 * 60 * 60_000);
    expect(await run()).toBe(false);
    f.advance(19 * 60 * 60_000); // 03:00 the next day
    expect(await run()).toBe(true);
    expect([...backup.files.keys()].sort()).toEqual([
      "budgee-2026-11-17.jsonl.gz",
      "budgee-2026-11-18.jsonl.gz",
    ]);
  });

  test("a failed backup is retried at each hourly check until it works; the cleanup is not", async () => {
    const memory = memoryBackup();
    let down = true;
    const flaky: BackupDestination = {
      ...memory,
      put: (name, bytes) => (down ? Promise.reject(new Error("down")) : memory.put(name, bytes)),
    };
    const run = () => runDailyIfDue({ db: f.db, clock: f.clock, backup: staticBackup(flaky) });

    await expect(run()).rejects.toThrow("down"); // 03:00: backup fails, cleanup runs
    const cleanup = await readLastCleanup(f.db);
    expect(cleanup).toMatchObject({ at: TODAY, ok: true });
    f.advance(HOUR);
    await expect(run()).rejects.toThrow("down"); // 04:00: retried
    down = false;
    f.advance(HOUR);
    expect(await run()).toBe(true); // 05:00: retried, works
    expect([...memory.files.keys()]).toEqual(["budgee-2026-11-17.jsonl.gz"]);
    expect(await readLastSuccessfulBackup(f.db)).toBe(TODAY + 2 * HOUR);
    expect(await readLastCleanup(f.db)).toEqual(cleanup);
    f.advance(HOUR);
    expect(await run()).toBe(false); // done for the day
    f.advance(21 * HOUR);
    expect(await run()).toBe(true); // 03:00 the next day: the full run again
    expect(await readLastCleanup(f.db)).toMatchObject({ at: TODAY + DAY });
  });

  test("a backup saved but not pruned is not retried hourly; the daily run reports the clean-up", async () => {
    const memory = memoryBackup();
    let failing = true;
    const pruneFails: BackupDestination = {
      ...memory,
      list: () => (failing ? Promise.reject(new Error("list down")) : memory.list()),
    };
    const run = () => runDailyIfDue({ db: f.db, clock: f.clock, backup: staticBackup(pruneFails) });

    await expect(run()).rejects.toThrow("retention: list down");
    expect(await readLastBackup(f.db)).toMatchObject({ status: "ok", retentionError: "list down" });
    failing = false;
    f.advance(HOUR);
    expect(await run()).toBe(false); // the file is there: nothing to retry
  });

  test("an hourly check with no destination leaves the recorded not_configured alone", async () => {
    const run = () => runDailyIfDue({ db: f.db, clock: f.clock, backup: staticBackup(null) });
    expect(await run()).toBe(true);
    for (let hour = 1; hour <= 3; hour++) {
      f.advance(HOUR);
      await run();
    }
    expect(await readLastBackup(f.db)).toMatchObject({ status: "not_configured", at: TODAY });
  });

  test(`the next daily run is the next ${DAILY_RUN_UTC_HOUR}:00 UTC`, () => {
    expect(nextDailyRun(at("2026-11-17T02:59:00Z"))).toBe(at("2026-11-17T03:00:00Z"));
    expect(nextDailyRun(at("2026-11-17T03:00:00Z"))).toBe(at("2026-11-18T03:00:00Z"));
    expect(nextDailyRun(at("2026-11-17T23:00:00Z"))).toBe(at("2026-11-18T03:00:00Z"));
  });

  test("a successful back up now after the slot counts as the day's backup", async () => {
    const memory = memoryBackup();
    let down = true;
    const flaky: BackupDestination = {
      ...memory,
      put: (name, bytes) => (down ? Promise.reject(new Error("down")) : memory.put(name, bytes)),
    };
    const deps = { db: f.db, clock: f.clock, backup: staticBackup(flaky) };
    await expect(runDailyIfDue(deps)).rejects.toThrow("down");
    down = false;
    f.advance(30 * 60_000);
    expect(await runBackup(deps)).toMatchObject({ status: "ok" });
    f.advance(30 * 60_000);
    expect(await runDailyIfDue(deps)).toBe(false);
  });

  test("a destination connected later gets its first backup at the next hourly check", async () => {
    let destination: BackupDestination | null = null;
    const backup = { ...staticBackup(null), open: async () => destination };
    const run = () => runDailyIfDue({ db: f.db, clock: f.clock, backup });
    expect(await run()).toBe(true);
    expect(await readLastBackup(f.db)).toMatchObject({ status: "not_configured" });
    const memory = memoryBackup();
    destination = memory;
    f.advance(HOUR);
    expect(await run()).toBe(true);
    expect(memory.files.size).toBe(1);
    f.advance(HOUR);
    expect(await run()).toBe(false);
  });
});
