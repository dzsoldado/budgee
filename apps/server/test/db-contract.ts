// Shared contract every Db adapter must pass (spec "Required tests: Database adapters").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Envelope, formatHlc, parseBackup } from "@budgee/core";
import { migrations } from "../migrations";
import { buildBackup } from "../src/backup";
import { purgeTombstones, TOMBSTONE_MAX_AGE } from "../src/cleanup";
import { revokeDevice } from "../src/devices";
import { storeEnvelopes } from "../src/envelopes";
import { readPurgeSeq } from "../src/init";
import { type Migration, migrate } from "../src/migrate";
import type { Db } from "../src/ports";

export interface TestDb {
  db: Db;
  dispose(): Promise<void> | void;
}

const ID_A = "6f1d3c2e-9a4b-4c8d-8e7f-0a1b2c3d4e5f";
const ID_B = "7a2e4d3f-0b5c-4d9e-9f80-1b2c3d4e5f60";
const ID_C = "8b3f5e40-1c6d-4eaf-a091-2c3d4e5f6071";

const hlc = (wall: number, device = "phone") => formatHlc({ wall, counter: 0, device });

const live = (id: string, wall: number, blob = `blob${wall}`, device = "phone"): Envelope => ({
  table: "transactions",
  id,
  hlc: hlc(wall, device),
  deleted: false,
  device,
  blob: btoa(blob),
});

const tombstone = (id: string, wall: number, device = "phone"): Envelope => ({
  table: "transactions",
  id,
  hlc: hlc(wall, device),
  deleted: true,
  device,
});

interface EnvelopeRow {
  table: string;
  id: string;
  hlc: string;
  deleted: number;
  device: string;
  seq: number;
  blob: string | null;
}

/** The server clock of every store in this suite unless a test passes another. */
const NOW = 1_763_337_600_000;
const store = (db: Db, envelopes: readonly Envelope[], now = NOW) =>
  storeEnvelopes(db, envelopes, now);

const stored = (db: Db) =>
  db.query<EnvelopeRow>(
    'SELECT "table", id, hlc, deleted, device, seq, blob FROM envelopes ORDER BY seq',
  );

const storedOne = async (db: Db, id: string) => {
  const rows = await stored(db);
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`envelope ${id} not stored`);
  return row;
};

const maxSeq = async (db: Db) => {
  const rows = await db.query<{ m: number | null }>("SELECT MAX(seq) AS m FROM envelopes");
  return rows[0]?.m ?? 0;
};

const ALL_MIGRATIONS = ["001_init", "002_envelope_updated_at"];

const appliedNames = async (db: Db) =>
  (await db.query<{ name: string }>("SELECT name FROM _migrations ORDER BY name")).map(
    (r) => r.name,
  );

export function runDbContract(name: string, open: () => Promise<TestDb>) {
  describe(`Db contract: ${name}`, () => {
    let handle: TestDb;
    let db: Db;

    beforeEach(async () => {
      handle = await open();
      db = handle.db;
    });
    afterEach(async () => {
      await handle.dispose();
    });

    describe("query, run, batch", () => {
      test("run reports changes and query binds positional params, NULL included", async () => {
        await db.run("CREATE TABLE t (k TEXT PRIMARY KEY, n INTEGER, s TEXT)");
        expect(await db.run("INSERT INTO t VALUES (?, ?, ?)", ["a", 1, null])).toEqual({
          changes: 1,
        });
        await db.run("INSERT INTO t VALUES (?, ?, ?)", ["b", 2, "two"]);
        expect(await db.run("UPDATE t SET n = n + 10")).toEqual({ changes: 2 });

        expect(await db.query("SELECT k, n, s FROM t WHERE n > ? ORDER BY k", [5])).toEqual([
          { k: "a", n: 11, s: null },
          { k: "b", n: 12, s: "two" },
        ]);
        expect(await db.query("SELECT k FROM t WHERE k = ?", ["zzz"])).toEqual([]);
      });

      test("batch runs statements in order and reports changes for each", async () => {
        await db.run("CREATE TABLE t (k TEXT PRIMARY KEY, n INTEGER)");
        const results = await db.batch([
          { sql: "INSERT INTO t VALUES (?, ?)", params: ["a", 1] },
          { sql: "INSERT INTO t VALUES (?, ?)", params: ["b", 2] },
          { sql: "UPDATE t SET n = n * 10" },
          { sql: "DELETE FROM t WHERE k = ?", params: ["nope"] },
        ]);
        expect(results).toEqual([{ changes: 1 }, { changes: 1 }, { changes: 2 }, { changes: 0 }]);
        expect(await db.query("SELECT k, n FROM t ORDER BY k")).toEqual([
          { k: "a", n: 10 },
          { k: "b", n: 20 },
        ]);
      });

      test("an empty batch does nothing", async () => {
        expect(await db.batch([])).toEqual([]);
      });

      test("batch is all-or-nothing: a failing statement rolls back the earlier ones", async () => {
        await db.run("CREATE TABLE t (k TEXT PRIMARY KEY, n INTEGER)");
        await db.run("INSERT INTO t VALUES ('a', 1)");

        await expect(
          db.batch([
            { sql: "UPDATE t SET n = 99 WHERE k = 'a'" },
            { sql: "INSERT INTO t VALUES (?, ?)", params: ["b", 2] },
            { sql: "INSERT INTO t VALUES (?, ?)", params: ["a", 3] }, // primary key clash
          ]),
        ).rejects.toThrow();

        expect(await db.query("SELECT k, n FROM t ORDER BY k")).toEqual([{ k: "a", n: 1 }]);
      });

      test("a failed run, query or batch leaves the database usable", async () => {
        await expect(db.run("INSERT INTO missing VALUES (1)")).rejects.toThrow();
        await expect(db.query("SELECT * FROM missing")).rejects.toThrow();
        await expect(db.batch([{ sql: "NOT SQL" }])).rejects.toThrow();
        await db.run("CREATE TABLE t (k TEXT)");
        expect(await db.batch([{ sql: "INSERT INTO t VALUES ('x')" }])).toEqual([{ changes: 1 }]);
      });
    });

    describe("migrations", () => {
      test("the bundled migrations create every server table", async () => {
        expect(await migrate(db, migrations)).toEqual(ALL_MIGRATIONS);

        for (const table of ["envelopes", "seq_counter", "devices", "pairing_codes", "config"]) {
          expect(await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).toHaveLength(1);
        }
        await db.run("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)", [
          "d1",
          "Phone",
          "ab".repeat(32),
          1,
        ]);
        expect(await db.query("SELECT last_seen, last_ack_seq, revoked FROM devices")).toEqual([
          { last_seen: null, last_ack_seq: 0, revoked: 0 },
        ]);
        await db.run("INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)", ["cd", 2]);
        expect(await db.query("SELECT used FROM pairing_codes")).toEqual([{ used: 0 }]);
        await db.run("INSERT INTO config (key, value) VALUES (?, ?)", ["serverId", "s1"]);
        expect(await db.query("SELECT value FROM seq_counter")).toEqual([{ value: 0 }]);
      });

      test("migrations apply once: running again changes nothing", async () => {
        expect(await migrate(db, migrations)).toEqual(ALL_MIGRATIONS);
        expect(await migrate(db, migrations)).toEqual([]);
        expect(await migrate(db, migrations)).toEqual([]);

        expect(await appliedNames(db)).toEqual(ALL_MIGRATIONS);
        // The seed row of the counter was inserted once, not on every run.
        expect(await db.query("SELECT COUNT(*) AS n FROM seq_counter")).toEqual([{ n: 1 }]);
      });

      test("only migrations not yet recorded are applied, in name order", async () => {
        const m1: Migration = { name: "001_a", sql: "CREATE TABLE a (x INTEGER);" };
        const m2: Migration = {
          name: "002_b",
          sql: "CREATE TABLE b (x INTEGER);\nINSERT INTO a (x) VALUES (1);",
        };
        const m3: Migration = { name: "003_c", sql: "INSERT INTO b (x) SELECT x + 1 FROM a;" };

        expect(await migrate(db, [m1])).toEqual(["001_a"]);
        expect(await migrate(db, [m3, m1, m2])).toEqual(["002_b", "003_c"]);
        expect(await appliedNames(db)).toEqual(["001_a", "002_b", "003_c"]);
        expect(await db.query("SELECT x FROM b")).toEqual([{ x: 2 }]);
      });

      test("a failing migration is not recorded and leaves no partial changes", async () => {
        const good: Migration = { name: "001_good", sql: "CREATE TABLE a (x INTEGER);" };
        const bad: Migration = {
          name: "002_bad",
          sql: "CREATE TABLE b (x INTEGER);\nINSERT INTO a (x) VALUES (1);\nINSERT INTO nowhere VALUES (1);",
        };

        await expect(migrate(db, [good, bad])).rejects.toThrow("002_bad");

        expect(await appliedNames(db)).toEqual(["001_good"]);
        expect(await db.query("SELECT x FROM a")).toEqual([]);
        await expect(db.query("SELECT x FROM b")).rejects.toThrow();

        const fixed: Migration = { ...bad, sql: "CREATE TABLE b (x INTEGER);" };
        expect(await migrate(db, [good, fixed])).toEqual(["002_bad"]);
      });

      test("two runners racing apply each migration exactly once", async () => {
        const results = await Promise.all([migrate(db, migrations), migrate(db, migrations)]);

        expect(results.flat().sort()).toEqual(ALL_MIGRATIONS);
        expect(await appliedNames(db)).toEqual(ALL_MIGRATIONS);
        expect(await db.query("SELECT COUNT(*) AS n FROM seq_counter")).toEqual([{ n: 1 }]);
      });

      test("002 stamps envelopes stored before it with the time it ran", async () => {
        const [init, stamp] = migrations;
        if (!init || !stamp) throw new Error("expected two migrations");
        await migrate(db, [init]);
        await db.run(
          `INSERT INTO envelopes ("table", id, hlc, deleted, device, seq) VALUES (?, ?, ?, 1, ?, 1)`,
          ["transactions", ID_A, hlc(1), "phone"],
        );
        const before = Date.now();
        await migrate(db, [init, stamp]);
        const [row] = await db.query<{ updated_at: number }>("SELECT updated_at FROM envelopes");
        // strftime('%s') has whole seconds.
        expect(row?.updated_at).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
        expect(row?.updated_at).toBeLessThanOrEqual(Date.now());
      });
    });

    describe("envelopes", () => {
      beforeEach(async () => {
        await migrate(db, migrations);
      });

      test("stores new envelopes; tombstones carry no blob", async () => {
        expect(await store(db, [live(ID_A, 100), tombstone(ID_B, 100)])).toEqual({
          accepted: 2,
          ignored: 0,
        });

        expect(await stored(db)).toEqual([
          {
            table: "transactions",
            id: ID_A,
            hlc: hlc(100),
            deleted: 0,
            device: "phone",
            seq: 1,
            blob: btoa("blob100"),
          },
          {
            table: "transactions",
            id: ID_B,
            hlc: hlc(100),
            deleted: 1,
            device: "phone",
            seq: 2,
            blob: null,
          },
        ]);
      });

      test("the same id in another table is another row", async () => {
        const category: Envelope = { ...live(ID_A, 100), table: "categories" };
        expect(await store(db, [live(ID_A, 100), category])).toEqual({
          accepted: 2,
          ignored: 0,
        });
        expect((await stored(db)).map((r) => r.table)).toEqual(["transactions", "categories"]);
      });

      test("upsert keeps the higher hlc whatever the arrival order", async () => {
        await store(db, [live(ID_A, 200, "v200")]);

        // Older and equal hlc are ignored.
        expect(await store(db, [live(ID_A, 100, "v100"), live(ID_A, 200, "other")])).toEqual({
          accepted: 0,
          ignored: 2,
        });
        expect(await storedOne(db, ID_A)).toMatchObject({ hlc: hlc(200), blob: btoa("v200") });

        // A higher hlc replaces every envelope column.
        expect(await store(db, [live(ID_A, 300, "v300", "laptop")])).toEqual({
          accepted: 1,
          ignored: 0,
        });
        expect(await storedOne(db, ID_A)).toMatchObject({
          hlc: hlc(300, "laptop"),
          device: "laptop",
          blob: btoa("v300"),
        });
      });

      test("the device id in the hlc breaks ties at the same wall time", async () => {
        await store(db, [live(ID_A, 100, "from-b", "dev-b")]);
        expect(await store(db, [live(ID_A, 100, "from-a", "dev-a")])).toEqual({
          accepted: 0,
          ignored: 1,
        });
        expect(await store(db, [live(ID_A, 100, "from-c", "dev-c")])).toEqual({
          accepted: 1,
          ignored: 0,
        });
        expect(await storedOne(db, ID_A)).toMatchObject({ blob: btoa("from-c") });
      });

      test("a newer tombstone clears the blob; an older edit cannot revive the row", async () => {
        await store(db, [live(ID_A, 100)]);
        expect(await store(db, [tombstone(ID_A, 200)])).toEqual({
          accepted: 1,
          ignored: 0,
        });
        expect(await store(db, [live(ID_A, 150)])).toEqual({ accepted: 0, ignored: 1 });
        expect(await storedOne(db, ID_A)).toMatchObject({ deleted: 1, blob: null, hlc: hlc(200) });
      });

      test("the same id twice in one push: the order inside the push does not matter", async () => {
        expect(await store(db, [live(ID_A, 100), live(ID_A, 200)])).toEqual({
          accepted: 2,
          ignored: 0,
        });
        expect(await store(db, [live(ID_B, 200), live(ID_B, 100)])).toEqual({
          accepted: 1,
          ignored: 1,
        });
        expect(await storedOne(db, ID_A)).toMatchObject({ hlc: hlc(200) });
        expect(await storedOne(db, ID_B)).toMatchObject({ hlc: hlc(200) });
      });

      test("an empty push stores nothing", async () => {
        expect(await store(db, [])).toEqual({ accepted: 0, ignored: 0 });
        expect(await stored(db)).toEqual([]);
      });

      test("seq only increases: every accepted envelope gets a seq above all earlier ones", async () => {
        const seen: number[] = [];
        const accept = async (envelope: Envelope) => {
          expect(await store(db, [envelope])).toEqual({ accepted: 1, ignored: 0 });
          const { seq } = await storedOne(db, envelope.id);
          expect(seq).toBeGreaterThan(Math.max(0, ...seen));
          seen.push(seq);
        };

        await accept(live(ID_A, 100));
        await accept(live(ID_B, 100));
        await accept(live(ID_A, 200)); // moves A past B
        await accept(tombstone(ID_B, 300)); // moves B past A
        await accept(live(ID_C, 100));
      });

      test("an ignored envelope keeps its row's seq and the next accepted one still goes higher", async () => {
        await store(db, [live(ID_A, 200), live(ID_B, 100)]);
        const before = await stored(db);

        expect(await store(db, [live(ID_A, 100)])).toEqual({ accepted: 0, ignored: 1 });
        expect(await stored(db)).toEqual(before);

        await store(db, [live(ID_C, 100)]);
        expect((await storedOne(db, ID_C)).seq).toBeGreaterThan(
          Math.max(...before.map((r) => r.seq)),
        );
      });

      test("the global max seq never decreases when an update moves a row to a new seq", async () => {
        let max = await maxSeq(db);
        // Each step: accepted envelopes raise the max, an ignored one leaves it where it was.
        const step = async (envelopes: Envelope[], expectRaise: boolean) => {
          const { accepted } = await store(db, envelopes);
          expect(accepted > 0).toBe(expectRaise);
          const next = await maxSeq(db);
          if (expectRaise) expect(next).toBeGreaterThan(max);
          else expect(next).toBe(max);
          max = next;
        };

        await step([live(ID_A, 100), live(ID_B, 100), live(ID_C, 100)], true);
        await step([live(ID_A, 200)], true); // A leaves the lowest seq for a new one
        await step([live(ID_C, 200)], true); // C leaves a high seq for a higher one
        await step([live(ID_A, 300)], true); // A held the max seq and moves above it
        await step([live(ID_A, 250)], false); // ignored
        await step([tombstone(ID_B, 300), live(ID_A, 400)], true);

        const seqs = (await stored(db)).map((r) => r.seq);
        expect(new Set(seqs).size).toBe(3);
        expect(Math.max(...seqs)).toBe(max);
      });

      test("seq inside one push follows the push order", async () => {
        await store(db, [live(ID_C, 100), live(ID_A, 100), live(ID_B, 100)]);
        expect((await stored(db)).map((r) => r.id)).toEqual([ID_C, ID_A, ID_B]);
      });

      test("a push is one batch: one counter write plus one upsert per envelope", async () => {
        const batches: number[] = [];
        const spy: Db = {
          ...db,
          batch: (statements) => {
            batches.push(statements.length);
            return db.batch(statements);
          },
        };
        await store(spy, [live(ID_A, 100), live(ID_B, 100), live(ID_C, 100)]);
        expect(batches).toEqual([4]);
        // Every envelope used up one number, accepted or not.
        expect(await db.query("SELECT value FROM seq_counter")).toEqual([{ value: 3 }]);
        await store(db, [live(ID_A, 50), live(ID_B, 200)]);
        expect(await db.query("SELECT value FROM seq_counter")).toEqual([{ value: 5 }]);
        expect((await storedOne(db, ID_B)).seq).toBe(5);
      });

      test("a push that fails on its last envelope stores nothing and leaves seq_counter as it was", async () => {
        await store(db, [live(ID_A, 100)]);
        const before = await stored(db);
        // A live envelope without a blob breaks the table's CHECK; the cast gets past the type.
        const broken = { ...live(ID_C, 100), blob: null } as unknown as Envelope;

        await expect(store(db, [live(ID_A, 200), live(ID_B, 100), broken])).rejects.toThrow();

        expect(await stored(db)).toEqual(before);
        expect(await db.query("SELECT value FROM seq_counter")).toEqual([{ value: 1 }]);
      });

      test("a seq is never reused, even after the row holding the max seq is deleted", async () => {
        // The daily cleanup purges old tombstones; one of them may hold the highest seq.
        await store(db, [live(ID_A, 100), tombstone(ID_B, 100)]);
        const purged = await storedOne(db, ID_B);
        await db.run('DELETE FROM envelopes WHERE "table" = ? AND id = ?', [purged.table, ID_B]);

        await store(db, [live(ID_C, 100)]);
        expect((await storedOne(db, ID_C)).seq).toBeGreaterThan(purged.seq);
      });

      test("every stored change records the server time; an ignored one leaves it", async () => {
        const times = () =>
          db.query<{ id: string; updated_at: number }>(
            "SELECT id, updated_at FROM envelopes ORDER BY id",
          );
        await store(db, [live(ID_A, 100), tombstone(ID_B, 100)], 1000);
        await store(db, [live(ID_A, 50), tombstone(ID_B, 200)], 2000);
        expect(await times()).toEqual([
          { id: ID_A, updated_at: 1000 },
          { id: ID_B, updated_at: 2000 },
        ]);
      });
    });

    describe("revoking devices", () => {
      beforeEach(async () => {
        await migrate(db, migrations);
      });

      const addDevices = async (...ids: string[]) => {
        for (const id of ids) {
          await db.run(
            "INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, 0)",
            [id, id, `hash-${id}`],
          );
        }
      };
      const active = async () =>
        (
          await db.query<{ id: string }>("SELECT id FROM devices WHERE revoked = 0 ORDER BY id")
        ).map((row) => row.id);

      test("the last device not revoked cannot be revoked", async () => {
        await addDevices("phone");
        expect(await revokeDevice(db, "phone")).toBe(false);
        expect(await active()).toEqual(["phone"]);

        await addDevices("laptop");
        await db.run("UPDATE devices SET revoked = 1 WHERE id = ?", ["laptop"]);
        expect(await revokeDevice(db, "phone")).toBe(false);
        expect(await active()).toEqual(["phone"]);
      });

      test("one of two can be revoked, and revoking it again still answers revoked", async () => {
        await addDevices("phone", "laptop");
        expect(await revokeDevice(db, "laptop")).toBe(true);
        expect(await active()).toEqual(["phone"]);
        expect(await revokeDevice(db, "laptop")).toBe(true);
        expect(await revokeDevice(db, "phone")).toBe(false);
        expect(await active()).toEqual(["phone"]);
      });

      test("revokes racing each other never leave zero devices", async () => {
        await addDevices("phone", "laptop", "tablet");
        const results = await Promise.all(
          ["phone", "laptop", "tablet"].map((id) => revokeDevice(db, id)),
        );
        expect(results.filter(Boolean)).toHaveLength(2);
        expect(await active()).toHaveLength(1);
      });

      test("a revoke deletes the pairing codes not yet used; a refused one keeps them", async () => {
        await addDevices("phone", "laptop");
        const addCode = (hash: string) =>
          db.run("INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)", [hash, NOW]);
        await addCode("a");
        await addCode("b");
        expect(await revokeDevice(db, "laptop")).toBe(true);
        expect(await db.query("SELECT code_hash FROM pairing_codes")).toEqual([]);

        await addCode("c");
        expect(await revokeDevice(db, "phone")).toBe(false);
        expect(await db.query("SELECT code_hash FROM pairing_codes")).toEqual([{ code_hash: "c" }]);
      });
    });

    describe("daily run", () => {
      beforeEach(async () => {
        await migrate(db, migrations);
      });

      const addDevice = (id: string, ack: number, revoked = 0) =>
        db.run(
          "INSERT INTO devices (id, name, token_hash, created_at, last_ack_seq, revoked) VALUES (?, ?, ?, 0, ?, ?)",
          [id, id, `hash-${id}`, ack, revoked],
        );

      test("purgeTombstones: old, acknowledged tombstones only; the purge point only rises", async () => {
        await store(db, [tombstone(ID_A, 100), live(ID_B, 100), tombstone(ID_C, 100)], 0);
        const later = TOMBSTONE_MAX_AGE + 1;
        await addDevice("phone", 3);
        await addDevice("laptop", 1);
        await addDevice("old", 0, 1);

        expect(await purgeTombstones(db, later)).toBe(1);
        expect((await stored(db)).map((r) => r.id)).toEqual([ID_B, ID_C]);
        expect(await readPurgeSeq(db)).toBe(1);

        await db.run("UPDATE devices SET last_ack_seq = 3 WHERE id = ?", ["laptop"]);
        expect(await purgeTombstones(db, later)).toBe(1);
        expect(await purgeTombstones(db, later)).toBe(0);
        expect(await readPurgeSeq(db)).toBe(3);
        expect(await db.query("SELECT value FROM seq_counter")).toEqual([{ value: 3 }]);

        await db.run("UPDATE devices SET revoked = 1");
        await store(db, [tombstone(ID_A, 200)], 0);
        expect(await purgeTombstones(db, later)).toBe(0);
      });

      test("buildBackup reads every envelope once, page by page", async () => {
        await store(db, [live(ID_A, 100), tombstone(ID_B, 100), live(ID_C, 100)]);
        await store(db, [live(ID_A, 200, "edited")]);
        const { bytes, envelopes } = await buildBackup(db, 2);
        expect(envelopes).toBe(3);
        expect(await parseBackup(bytes)).toEqual([
          { table: "transactions", id: ID_B, hlc: hlc(100), deleted: true },
          { table: "transactions", id: ID_C, hlc: hlc(100), deleted: false, blob: btoa("blob100") },
          { table: "transactions", id: ID_A, hlc: hlc(200), deleted: false, blob: btoa("edited") },
        ]);
      });
    });
  });
}
