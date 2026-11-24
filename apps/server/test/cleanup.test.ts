// Spec "Cleanup": tombstones older than 90 days are purged once every non-revoked device has
// acknowledged a seq past them; a device behind the purge point gets resetRequired.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type CleanupRun,
  type Envelope,
  type PullResponse,
  pullResponseSchema,
  SEED_IDS,
} from "@budgee/core";
import * as v from "valibot";
import { purgeTombstones, readLastCleanup, runCleanup, TOMBSTONE_MAX_AGE } from "../src/cleanup";
import { PURGE_SEQ_KEY, readPurgeSeq } from "../src/init";
import type { Db } from "../src/ports";
import { liveEnvelope, type TestServer, testServer, tombstoneEnvelope, uuid } from "./api-helpers";
import { DAY } from "./daily-helpers";

let s: TestServer;
let phone: string;
let laptop: string;

beforeEach(async () => {
  s = await testServer();
  phone = await s.setup("Phone");
  laptop = await s.pair(phone, "Laptop");
});
afterEach(() => s.close());

const push = async (envelopes: Envelope[]) => {
  const res = await s.call("POST", "/sync/push", { token: phone, body: { envelopes } });
  expect(res.status).toBe(200);
};

const pull = async (token: string, since: number): Promise<PullResponse> => {
  const res = await s.call("GET", `/sync/pull?since=${since}`, { token });
  expect(res.status).toBe(200);
  return v.parse(pullResponseSchema, await res.json());
};

const cleanup = () => runCleanup({ db: s.db, clock: { now: s.now } });

const ids = async () =>
  (await s.db.query<{ id: string }>("SELECT id FROM envelopes ORDER BY seq")).map((r) => r.id);

const counter = async () =>
  (await s.db.query<{ value: number }>("SELECT value FROM seq_counter"))[0]?.value;

describe("tombstone cleanup", () => {
  test("purges old tombstones only up to the lowest seq every device acknowledged", async () => {
    const [a, b, c, d] = [uuid(), uuid(), uuid(), uuid()];
    await push([tombstoneEnvelope(a, 1), liveEnvelope(b, 1), tombstoneEnvelope(c, 1)]);
    s.advance(TOMBSTONE_MAX_AGE + 1);
    await push([tombstoneEnvelope(d, 1)]); // seq 4, deleted just now
    await pull(phone, 4);
    await pull(laptop, 1);

    expect(await cleanup()).toMatchObject({ ok: true, purged: 1 });
    expect(await ids()).toEqual([b, c, d]);
    expect(await readPurgeSeq(s.db)).toBe(1);

    await pull(laptop, 4);
    expect(await cleanup()).toMatchObject({ ok: true, purged: 1 });
    // The live row and the recent tombstone stay; the counter is never touched.
    expect(await ids()).toEqual([b, d]);
    expect(await readPurgeSeq(s.db)).toBe(3);
    expect(await counter()).toBe(4);
  });

  test("never purges the tombstone of a default (seeded) row, and the purge point skips it", async () => {
    const seedId = SEED_IDS[0] as string; // the default "Groceries" category
    const other = uuid();
    await push([
      tombstoneEnvelope(other, 1),
      { ...tombstoneEnvelope(seedId, 1), table: "categories" },
    ]);
    s.advance(TOMBSTONE_MAX_AGE + 1);
    await pull(phone, 2);
    await pull(laptop, 2);
    expect(await cleanup()).toMatchObject({ ok: true, purged: 1 });
    expect(await ids()).toEqual([seedId]);
    // The purge point is the purged tombstone's seq (1), not the kept one's (2).
    expect(await readPurgeSeq(s.db)).toBe(1);
    s.advance(TOMBSTONE_MAX_AGE);
    expect(await cleanup()).toMatchObject({ purged: 0 });
  });

  test("a tombstone exactly 90 days old stays one more moment", async () => {
    const a = uuid();
    await push([tombstoneEnvelope(a, 1)]);
    s.advance(90 * DAY);
    await pull(phone, 1);
    await pull(laptop, 1);
    expect(await cleanup()).toMatchObject({ purged: 0 });
    s.advance(1);
    expect(await cleanup()).toMatchObject({ purged: 1 });
    expect(TOMBSTONE_MAX_AGE).toBe(90 * DAY);
  });

  test("age counts from the server's last change of the row, not from the client's hlc", async () => {
    const a = uuid();
    await push([liveEnvelope(a, 1)]);
    s.advance(60 * DAY);
    // Deleted 60 days after it was created, with an hlc from far in the past.
    await push([tombstoneEnvelope(a, 2)]);
    s.advance(31 * DAY);
    await pull(phone, 2);
    await pull(laptop, 2);
    expect(await cleanup()).toMatchObject({ purged: 0 });
    s.advance(60 * DAY);
    expect(await cleanup()).toMatchObject({ purged: 1 });
  });

  test("a device that never pulled holds everything back; a revoked one holds nothing", async () => {
    await push([tombstoneEnvelope(uuid(), 1)]);
    s.advance(TOMBSTONE_MAX_AGE + 1);
    await pull(phone, 1);
    expect(await cleanup()).toMatchObject({ purged: 0 });

    const devices = await s.call("GET", "/devices", { token: phone });
    const list = (await devices.json()) as { devices: { id: string; name: string }[] };
    const laptopId = list.devices.find((x) => x.name === "Laptop")?.id;
    await s.call("POST", `/devices/${laptopId}/revoke`, { token: phone });
    expect(await cleanup()).toMatchObject({ purged: 1 });
  });

  test("with no device left un-revoked, nothing is purged", async () => {
    await push([tombstoneEnvelope(uuid(), 1)]);
    s.advance(TOMBSTONE_MAX_AGE + 1);
    await pull(phone, 1);
    await pull(laptop, 1);
    await s.db.run("UPDATE devices SET revoked = 1");
    expect(await cleanup()).toMatchObject({ ok: true, purged: 0 });
    expect(await ids()).toHaveLength(1);
    expect(await readPurgeSeq(s.db)).toBe(0);
  });

  test("is idempotent, and the purge point never goes back", async () => {
    await push([tombstoneEnvelope(uuid(), 1), tombstoneEnvelope(uuid(), 1)]);
    s.advance(TOMBSTONE_MAX_AGE + 1);
    await pull(phone, 2);
    await pull(laptop, 2);
    expect(await cleanup()).toMatchObject({ purged: 2 });
    expect(await cleanup()).toMatchObject({ purged: 0 });
    expect(await readPurgeSeq(s.db)).toBe(2);

    // A purge whose highest seq is below the stored point leaves the point where it was.
    await s.db.run("UPDATE config SET value = '7' WHERE key = ?", [PURGE_SEQ_KEY]);
    await push([tombstoneEnvelope(uuid(), 1)]);
    s.advance(TOMBSTONE_MAX_AGE + 1);
    await pull(phone, 3);
    await pull(laptop, 3);
    expect(await cleanup()).toMatchObject({ purged: 1 });
    expect(await readPurgeSeq(s.db)).toBe(7);
  });

  test("a device behind the purge point must reset; from 0 it gets what is left", async () => {
    const [a, b, c] = [uuid(), uuid(), uuid()];
    await push([liveEnvelope(a, 1), tombstoneEnvelope(b, 1), liveEnvelope(c, 1)]);
    s.advance(TOMBSTONE_MAX_AGE + 1);
    await pull(phone, 3);
    await pull(laptop, 3);
    await cleanup();
    expect(await readPurgeSeq(s.db)).toBe(2);

    // Say the laptop's local data was restored from an old copy at seq 1.
    expect(await pull(laptop, 1)).toEqual({
      envelopes: [],
      nextSeq: 0,
      hasMore: false,
      resetRequired: true,
    });
    const fresh = await pull(laptop, 0);
    expect(fresh.resetRequired).toBe(false);
    expect(fresh.envelopes.map((e) => e.id)).toEqual([a, c]);
    expect((await pull(laptop, 3)).resetRequired).toBe(false);
  });

  test("records the run in config", async () => {
    await push([tombstoneEnvelope(uuid(), 1)]);
    s.advance(TOMBSTONE_MAX_AGE + 1);
    await pull(phone, 1);
    await pull(laptop, 1);
    expect(await readLastCleanup(s.db)).toBeNull();

    const run = await cleanup();
    const expected: CleanupRun = { at: s.now(), ok: true, error: null, purged: 1, durationMs: 0 };
    expect(run).toEqual(expected);
    expect(await readLastCleanup(s.db)).toEqual(expected);
  });

  test("a database failure is recorded, not thrown", async () => {
    const broken: Db = { ...s.db, batch: () => Promise.reject(new Error("database is down")) };
    const run = await runCleanup({ db: broken, clock: { now: s.now } });
    expect(run).toMatchObject({ ok: false, purged: 0, error: "database is down" });
    expect(await readLastCleanup(s.db)).toEqual(run);
  });
});

describe("statement size", () => {
  // Statements stay at 100 bound parameters or fewer, well under any SQLite build's limit; each
  // purge statement binds every seed id plus its own few.
  const MAX_BOUND_PARAMS = 100;

  test("every purge statement binds at most 100 parameters, seed ids included", async () => {
    const counts: number[] = [];
    const recording: Db = {
      query: () => Promise.resolve([]),
      run: () => Promise.resolve({ changes: 0 }),
      batch: async (statements) => {
        for (const statement of statements) counts.push(statement.params?.length ?? 0);
        return statements.map(() => ({ changes: 0 }));
      },
    };
    await purgeTombstones(recording, Date.now());
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(SEED_IDS.length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_BOUND_PARAMS);
  });
});
