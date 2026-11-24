// Spec "Required tests: Backups": retention keeps exactly the 7 daily, 4 weekly and 12 monthly
// files (against the in-memory fake); a backup file restores to identical data.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BackupRun,
  decryptRow,
  type Envelope,
  encryptRow,
  formatHlc,
  generateVaultKey,
  parseBackup,
  SYNCED_TABLES,
} from "@budgee/core";
import { memoryBackup } from "../adapters/backup/memory";
import {
  BACKUP_PAGE_SIZE,
  backupErrorCode,
  backupFileName,
  buildBackup,
  expiredBackups,
  readLastBackup,
  readLastSuccessfulBackup,
  runBackup,
  staticBackup,
} from "../src/backup";
import { storeEnvelopes } from "../src/envelopes";
import { type Db, DestinationError, ReconnectNeededError } from "../src/ports";
import { liveEnvelope, tombstoneEnvelope, uuid } from "./api-helpers";
import { backupName, DAY, dailyFixture, failingBackup, HOUR, SECRET, TODAY } from "./daily-helpers";

let f: Awaited<ReturnType<typeof dailyFixture>>;
beforeEach(async () => {
  f = await dailyFixture();
});
afterEach(() => f.close());

const store = (envelopes: Envelope[]) => storeEnvelopes(f.db, envelopes, f.clock.now());

const storedEnvelopes = () =>
  f.db.query<{ table: string; id: string; hlc: string; deleted: number; blob: string | null }>(
    'SELECT "table", id, hlc, deleted, blob FROM envelopes ORDER BY seq',
  );

/** Stored rows as backup records: `deleted` as a boolean, no blob on tombstones. */
const expectedRecords = async () =>
  (await storedEnvelopes()).map(({ table, id, hlc, deleted, blob }) =>
    deleted ? { table, id, hlc, deleted: true } : { table, id, hlc, deleted: false, blob },
  );

describe("backup file", () => {
  test("is named after the UTC day", () => {
    expect(backupFileName(TODAY)).toBe("budgee-2026-11-17.jsonl.gz");
    expect(backupFileName(Date.parse("2026-11-17T23:59:59.999Z"))).toBe(
      "budgee-2026-11-17.jsonl.gz",
    );
    expect(backupFileName(Date.parse("2027-01-05T00:00:00Z"))).toBe("budgee-2027-01-05.jsonl.gz");
  });

  test("restores to identical data", async () => {
    const key = await generateVaultKey();
    const fields = new Map<string, Record<string, unknown>>();
    const envelopes: Envelope[] = [];
    for (let i = 0; i < 30; i++) {
      const table = SYNCED_TABLES[i % SYNCED_TABLES.length] ?? "transactions";
      const id = uuid();
      const hlc = formatHlc({ wall: TODAY + i, counter: i, device: "phone" });
      if (i % 4 === 3) {
        envelopes.push({ table, id, hlc, deleted: true, device: "phone" });
      } else {
        const row = { n: i, note: `row ${i}, "quoted"\nwith a newline`, amount: -12_345 * i };
        fields.set(id, row);
        const blob = await encryptRow(key, table, id, hlc, row);
        envelopes.push({ table, id, hlc, deleted: false, device: "phone", blob });
      }
    }
    await store(envelopes);
    // An edit moves its row to a later seq; the backup still holds it once.
    const first = envelopes[0];
    if (!first || first.deleted) throw new Error("expected a live first envelope");
    const hlc = formatHlc({ wall: TODAY + 100, counter: 0, device: "laptop" });
    const edited = { n: 0, note: "edited" };
    fields.set(first.id, edited);
    await store([
      { ...first, hlc, blob: await encryptRow(key, first.table, first.id, hlc, edited) },
    ]);

    const backup = memoryBackup();
    const run = await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(backup) });
    expect(run).toMatchObject({ status: "ok", envelopes: 30 });

    const file = backup.files.get("budgee-2026-11-17.jsonl.gz");
    if (!file) throw new Error("no backup file");
    const records = await parseBackup(file);
    expect(records).toEqual((await expectedRecords()) as never);

    // Decrypting every live record gives back exactly the rows that were stored.
    const restored = new Map<string, unknown>();
    for (const record of records) {
      if (!record.deleted) restored.set(record.id, await decryptRow(key, record));
    }
    expect(restored).toEqual(fields);
  });

  test("reads the envelopes page by page in seq order, one query per page", async () => {
    await store(Array.from({ length: 10 }, (_, i) => liveEnvelope(uuid(), i + 1)));
    await store([tombstoneEnvelope(uuid(), 1), tombstoneEnvelope(uuid(), 1)]);
    const queries: string[] = [];
    const spy: Db = {
      ...f.db,
      query: (sql, params) => {
        queries.push(sql);
        return f.db.query(sql, params);
      },
    };

    const { bytes, envelopes } = await buildBackup(spy, 4);
    expect(envelopes).toBe(12);
    expect(await parseBackup(bytes)).toEqual((await expectedRecords()) as never);
    // 4 + 4 + 4, then an empty page ends it.
    expect(queries).toHaveLength(4);
    expect(queries.every((sql) => /FROM envelopes\s+WHERE seq > \?/.test(sql))).toBe(true);
    expect(BACKUP_PAGE_SIZE).toBeGreaterThanOrEqual(1000);
  });

  test("an empty database gives a valid, empty backup", async () => {
    const { bytes, envelopes } = await buildBackup(f.db);
    expect(envelopes).toBe(0);
    expect(await parseBackup(bytes)).toEqual([]);
  });
});

describe("runBackup", () => {
  test("writes today's file, overwriting an earlier one from the same day", async () => {
    const backup = memoryBackup();
    await store([liveEnvelope(uuid(), 1)]);
    await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(backup) });
    await store([liveEnvelope(uuid(), 2)]);
    f.advance(DAY / 2);
    await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(backup) });

    expect([...backup.files.keys()]).toEqual(["budgee-2026-11-17.jsonl.gz"]);
    const file = backup.files.get("budgee-2026-11-17.jsonl.gz");
    expect(file && (await parseBackup(file))).toHaveLength(2);
  });

  test("records the run in config: time, result, file, envelope count and duration", async () => {
    const memory = memoryBackup();
    // The upload takes 1.5 s on the test clock.
    const backup = {
      ...memory,
      put: (name: string, bytes: Uint8Array) => {
        f.advance(1500);
        return memory.put(name, bytes);
      },
    };
    await store([liveEnvelope(uuid(), 1), tombstoneEnvelope(uuid(), 1)]);
    expect(await readLastBackup(f.db)).toBeNull();

    const run = await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(backup) });
    const expected: BackupRun = {
      at: TODAY,
      status: "ok",
      error: null,
      file: "budgee-2026-11-17.jsonl.gz",
      envelopes: 2,
      durationMs: 1500,
      errorCode: null,
      retentionError: null,
      retentionErrorCode: null,
    };
    expect(run).toEqual(expected);
    expect(await readLastBackup(f.db)).toEqual(expected);
  });

  test("without a destination it records `not_configured` and writes nothing", async () => {
    const run = await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(null) });
    const expected: BackupRun = {
      at: TODAY,
      status: "not_configured",
      error: null,
      file: null,
      envelopes: null,
      durationMs: 0,
      errorCode: null,
      retentionError: null,
      retentionErrorCode: null,
    };
    expect(run).toEqual(expected);
    expect(await readLastBackup(f.db)).toEqual(expected);
  });

  test("not_configured is recorded once, not again at every check while nothing changes", async () => {
    const none = { db: f.db, clock: f.clock, backup: staticBackup(null) };
    await runBackup(none);
    f.advance(HOUR);
    expect(await runBackup(none)).toMatchObject({ status: "not_configured", at: TODAY + HOUR });
    expect(await readLastBackup(f.db)).toMatchObject({ status: "not_configured", at: TODAY });

    // A change of state is recorded: a backup, then the destination gone again.
    f.advance(HOUR);
    await runBackup({ ...none, backup: staticBackup(memoryBackup()) });
    f.advance(HOUR);
    await runBackup(none);
    expect(await readLastBackup(f.db)).toMatchObject({
      status: "not_configured",
      at: TODAY + 3 * HOUR,
    });
    f.advance(HOUR);
    await runBackup(none);
    expect(await readLastBackup(f.db)).toMatchObject({ at: TODAY + 3 * HOUR });
  });

  test("a failed upload is recorded without secrets, and no old backup is removed", async () => {
    const old = Array.from({ length: 40 }, (_, i) => backupName(i + 1));
    const memory = memoryBackup(old);
    const backup = {
      ...memory,
      put: () => Promise.reject(new Error(`Upload refused: invalid_grant for ${SECRET}`)),
    };

    const run = await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(backup) });
    expect(run).toMatchObject({ status: "error", file: null, envelopes: null });
    expect(run.error).toContain("Upload refused: invalid_grant");
    expect(run.error).not.toContain(SECRET.slice(5));
    expect(JSON.stringify(await readLastBackup(f.db))).not.toContain(SECRET.slice(5));
    expect([...memory.files.keys()].sort()).toEqual(old.sort());
  });

  test("a failed clean-up of old backups is recorded apart; the backup itself counts as done", async () => {
    const memory = memoryBackup(Array.from({ length: 40 }, (_, i) => backupName(i + 1)));
    const backup = {
      ...memory,
      remove: () => Promise.reject(new Error(`quota for ${SECRET}`)),
    };

    const run = await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(backup) });
    expect(run).toMatchObject({
      status: "ok",
      error: null,
      file: "budgee-2026-11-17.jsonl.gz",
      envelopes: 0,
    });
    expect(run.retentionError).toContain("quota");
    expect(run.retentionError).not.toContain(SECRET.slice(5));
    expect(await readLastBackup(f.db)).toEqual(run);
    expect(await readLastSuccessfulBackup(f.db)).toBe(TODAY);
    expect(memory.files.has("budgee-2026-11-17.jsonl.gz")).toBe(true);
  });

  test("a database failure is recorded", async () => {
    const broken: Db = { ...f.db, query: () => Promise.reject(new Error("database is down")) };
    const run = await runBackup({
      db: broken,
      clock: f.clock,
      backup: staticBackup(memoryBackup()),
    });
    expect(run).toMatchObject({
      status: "error",
      error: expect.stringContaining("database is down"),
    });
    expect(await readLastBackup(f.db)).toEqual(run);
  });

  test("an error message is cut to a reasonable length", async () => {
    const run = await runBackup({
      db: f.db,
      clock: f.clock,
      backup: staticBackup(failingBackup(`Upload failed: ${"no space left, ".repeat(100)}`)),
    });
    expect(run.error?.length).toBeLessThanOrEqual(300);
  });
});

describe("backupErrorCode", () => {
  test("sorts destination failures into the kinds Settings explains", () => {
    const drive = (status: number | null, reason: string | null = null) =>
      new DestinationError("Google Drive upload failed", status, reason);
    expect(backupErrorCode(new ReconnectNeededError("revoked"))).toBe("reconnect");
    expect(backupErrorCode(drive(401))).toBe("reconnect");
    expect(backupErrorCode(drive(400, "invalid_grant"))).toBe("reconnect");
    expect(backupErrorCode(drive(403, "storageQuotaExceeded"))).toBe("refused");
    expect(backupErrorCode(drive(403, "insufficientFilePermissions"))).toBe("refused");
    expect(backupErrorCode(drive(507))).toBe("refused");
    expect(backupErrorCode(drive(404, "notFound"))).toBe("not_found");
    expect(backupErrorCode(drive(500))).toBe("unavailable");
    expect(backupErrorCode(drive(503, "backendError"))).toBe("unavailable");
    expect(backupErrorCode(drive(429, "rateLimitExceeded"))).toBe("unavailable");
    expect(backupErrorCode(drive(null))).toBe("unavailable");
    expect(backupErrorCode(drive(400, "badRequest"))).toBe("other");
    expect(backupErrorCode(new Error("database is down"))).toBe("other");
    expect(backupErrorCode("nope")).toBe("other");
  });

  test("a run records the code beside the redacted message", async () => {
    const full = {
      ...memoryBackup(),
      put: () => Promise.reject(new DestinationError(`upload failed: ${SECRET}`, 403, null)),
    };
    const run = await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(full) });
    expect(run).toMatchObject({ status: "error", errorCode: "refused" });
    expect(run.error).not.toContain(SECRET.slice(5));

    f.advance(DAY);
    const pruning = {
      ...memoryBackup(Array.from({ length: 40 }, (_, i) => backupName(i + 1))),
      remove: () => Promise.reject(new DestinationError("delete failed", 502, null)),
    };
    const saved = await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(pruning) });
    expect(saved).toMatchObject({
      status: "ok",
      errorCode: null,
      retentionErrorCode: "unavailable",
    });
    expect(await readLastBackup(f.db)).toEqual(saved);
  });
});

describe("retention", () => {
  // One backup a day for 400 days up to Tuesday 17 November 2026.
  const yearOfDailies = Array.from({ length: 400 }, (_, i) => backupName(i));
  const KEPT = [
    // 7 daily: the 7 newest days.
    "budgee-2026-11-17.jsonl.gz",
    "budgee-2026-11-16.jsonl.gz",
    "budgee-2026-11-15.jsonl.gz",
    "budgee-2026-11-14.jsonl.gz",
    "budgee-2026-11-13.jsonl.gz",
    "budgee-2026-11-12.jsonl.gz",
    "budgee-2026-11-11.jsonl.gz",
    // 4 weekly: the newest of each earlier ISO week. The week of Monday 9 November already
    // holds kept files (11–15), so its 9th and 10th go.
    "budgee-2026-11-08.jsonl.gz",
    "budgee-2026-11-01.jsonl.gz",
    "budgee-2026-10-25.jsonl.gz",
    "budgee-2026-10-18.jsonl.gz",
    // 12 monthly: the newest of each earlier month. October already holds kept files.
    "budgee-2026-09-30.jsonl.gz",
    "budgee-2026-08-31.jsonl.gz",
    "budgee-2026-07-31.jsonl.gz",
    "budgee-2026-06-30.jsonl.gz",
    "budgee-2026-05-31.jsonl.gz",
    "budgee-2026-04-30.jsonl.gz",
    "budgee-2026-03-31.jsonl.gz",
    "budgee-2026-02-28.jsonl.gz",
    "budgee-2026-01-31.jsonl.gz",
    "budgee-2025-12-31.jsonl.gz",
    "budgee-2025-11-30.jsonl.gz",
    "budgee-2025-10-31.jsonl.gz",
  ];

  test("with one backup a day, keeps exactly 7 daily, 4 weekly and 12 monthly files", () => {
    const expired = expiredBackups(yearOfDailies);
    expect(expired).toHaveLength(400 - 23);
    expect(yearOfDailies.filter((name) => !expired.includes(name))).toEqual(KEPT);
  });

  test("applied through list and remove: the fake ends with exactly those 23 files", async () => {
    const backup = memoryBackup(yearOfDailies.slice(1));
    const run = await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(backup) });
    expect(run.status).toBe("ok");
    expect((await backup.list()).sort().reverse()).toEqual(KEPT);
    // Idempotent: the next run on the same day removes nothing more.
    await runBackup({ db: f.db, clock: f.clock, backup: staticBackup(backup) });
    expect((await backup.list()).sort().reverse()).toEqual(KEPT);
  });

  test("gaps never shrink a tier: only days, weeks and months holding a backup count", () => {
    // One backup every 10 days for two years.
    const sparse = Array.from({ length: 73 }, (_, i) => backupName(i * 10));
    const kept = sparse.filter((name) => !expiredBackups(sparse).includes(name));
    expect(kept.slice(0, 7)).toEqual(sparse.slice(0, 7));
    // Then the next 4 (each its own ISO week), then one per month for 12 months.
    expect(kept.slice(7, 11)).toEqual(sparse.slice(7, 11));
    expect(kept).toHaveLength(23);
    const months = kept.slice(11).map((name) => name.slice(7, 14));
    expect(new Set(months).size).toBe(12);
  });

  test("fewer backups than the tiers hold: nothing is removed", () => {
    expect(expiredBackups(yearOfDailies.slice(0, 7))).toEqual([]);
    expect(expiredBackups([])).toEqual([]);
  });

  test("never touches a file not named budgee-YYYY-MM-DD.jsonl.gz with a real date", () => {
    const others = [
      "notes.txt",
      "budgee-2020-01-01.jsonl",
      "budgee-2020-01-01.jsonl.gz.tmp",
      "Budgee-2020-01-01.jsonl.gz",
      "budgee-20-01-01.jsonl.gz",
      "budgee-2021-02-29.jsonl.gz",
      "budgee-2020-13-01.jsonl.gz",
      "old/budgee-2020-01-01.jsonl.gz",
    ];
    const expired = expiredBackups([...yearOfDailies, ...others]);
    expect(expired).toHaveLength(400 - 23);
    for (const name of others) expect(expired).not.toContain(name);
  });

  test("a name listed twice is decided once", () => {
    const expired = expiredBackups([...yearOfDailies, ...yearOfDailies]);
    expect(expired).toHaveLength(400 - 23);
  });
});
