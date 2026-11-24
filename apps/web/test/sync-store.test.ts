import { describe, expect, test } from "bun:test";
import { formatHlc, type RowOf, rowSchemas, SEED_HLC, type SyncRow } from "@budgee/core";
import * as v from "valibot";
import { getMeta, setMeta } from "../src/db/db";
import { type LocalChange, openRepository } from "../src/db/repository";
import { seedDefaults } from "../src/db/seed";
import { createDexieSyncStore } from "../src/sync/store";
import { expense, fakeNow, freshDb } from "./helpers";

const NOW = 1_763_370_000_000;

const remoteRow = (id: string, wall: number, amount = 100): SyncRow<"transactions"> => ({
  table: "transactions",
  row: v.parse(rowSchemas.transactions, {
    ...expense,
    amount,
    id,
    hlc: formatHlc({ wall, counter: 0, device: "laptop" }),
    device: "laptop",
    deleted: false,
  }) as RowOf<"transactions">,
});

async function setup() {
  const db = freshDb();
  const clock = fakeNow(NOW);
  const repo = await openRepository(db, { now: clock.now });
  const store = createDexieSyncStore(db, repo);
  const local: LocalChange[][] = [];
  const remote: LocalChange[][] = [];
  repo.onLocalWrite((changes) => local.push([...changes]));
  repo.onRemoteChange((changes) => remote.push([...changes]));
  return { db, repo, store, clock, local, remote };
}

describe("applyPage", () => {
  test("writes winning rows with their remote hlc and device, not dirty, and saves since", async () => {
    const { db, store } = await setup();
    const incoming = remoteRow(crypto.randomUUID(), NOW - 5);
    const applied = await store.applyPage({
      rows: [incoming],
      clock: incoming.row.hlc,
      since: 42,
    });
    expect(applied).toBe(1);
    expect(await db.transactions.get(incoming.row.id)).toEqual({ ...incoming.row, dirty: 0 });
    expect(await getMeta(db, "lastPulledSeq")).toBe(42);
    expect(await store.state()).toEqual({ serverId: undefined, since: 42 });
  });

  test("skips a row the local copy beats, even one edited after the page was read", async () => {
    const { db, repo, store } = await setup();
    const mine = await repo.put("transactions", expense);
    const older = remoteRow(mine.id, NOW - 1_000);
    expect(await store.applyPage({ rows: [older], clock: older.row.hlc, since: 1 })).toBe(0);
    expect(await db.transactions.get(mine.id)).toEqual({ ...mine, dirty: 1 });
  });

  test("a newer remote row replaces a dirty local edit", async () => {
    const { db, repo, store } = await setup();
    const mine = await repo.put("transactions", expense);
    const newer = remoteRow(mine.id, NOW + 1_000, 777);
    expect(await store.applyPage({ rows: [newer], clock: newer.row.hlc, since: 1 })).toBe(1);
    expect(await db.transactions.get(mine.id)).toEqual({ ...newer.row, dirty: 0 });
  });

  test("moves and persists the clock past the page, so the next edit sorts after it", async () => {
    const { db, repo, store } = await setup();
    const ahead = remoteRow(crypto.randomUUID(), NOW + 60_000);
    await store.applyPage({ rows: [ahead], clock: ahead.row.hlc, since: 1 });
    const persisted = await getMeta(db, "hlc");
    expect(persisted).toBe(formatHlc({ wall: NOW + 60_000, counter: 1, device: repo.deviceId }));
    const next = await repo.put("transactions", expense);
    expect(next.hlc > ahead.row.hlc).toBe(true);
  });

  test("receives only the clock it is given (the client passes it drift-capped)", async () => {
    const { db, repo, store } = await setup();
    const farAhead = remoteRow(crypto.randomUUID(), NOW + 72 * 3_600_000);
    const capped = formatHlc({ wall: NOW + 24 * 3_600_000, counter: 0, device: "laptop" });
    expect(await store.applyPage({ rows: [farAhead], clock: capped, since: 1 })).toBe(1);
    expect(await getMeta(db, "hlc")).toBe(
      formatHlc({ wall: NOW + 24 * 3_600_000, counter: 1, device: repo.deviceId }),
    );
  });

  test("fires onRemoteChange, never onLocalWrite", async () => {
    const { store, local, remote } = await setup();
    const a = remoteRow(crypto.randomUUID(), NOW - 5);
    const b = remoteRow(crypto.randomUUID(), NOW - 4);
    await store.applyPage({ rows: [a, b], clock: b.row.hlc, since: 2 });
    expect(local).toEqual([]);
    expect(remote).toEqual([
      [
        { table: "transactions", id: a.row.id },
        { table: "transactions", id: b.row.id },
      ],
    ]);
    // Nothing written, nothing fired.
    await store.applyPage({ rows: [a], clock: a.row.hlc, since: 3 });
    expect(remote).toHaveLength(1);
  });
});

describe("push bookkeeping", () => {
  test("dirtyRows lists rows not yet pushed, without the local flag", async () => {
    const { repo, store } = await setup();
    const row = await repo.put("transactions", expense);
    await repo.setSetting("theme", "dark");
    const dirty = await store.dirtyRows();
    expect(dirty).toHaveLength(2);
    expect(dirty).toContainEqual({ table: "transactions", row });
    expect(dirty.every((d) => !("dirty" in d.row))).toBe(true);
  });

  test("markPushed clears dirty only where the hlc is unchanged since the batch was read", async () => {
    const { db, repo, store, clock } = await setup();
    const a = await repo.put("transactions", expense);
    const b = await repo.put("transactions", { ...expense, amount: 5 });
    const batch = (await store.dirtyRows()).map(({ table, row }) => ({
      table,
      id: row.id,
      hlc: row.hlc,
    }));
    // Edited while the batch was in flight.
    clock.set(NOW + 10);
    const edited = await repo.update("transactions", b.id, { amount: 6 });

    await store.markPushed(batch);
    expect((await db.transactions.get(a.id))?.dirty).toBe(0);
    expect(await db.transactions.get(b.id)).toEqual({ ...edited, dirty: 1 });

    await store.markPushed([{ table: "transactions", id: b.id, hlc: edited.hlc }]);
    expect((await db.transactions.get(b.id))?.dirty).toBe(0);
  });

  test("localHlcs answers in the order asked, undefined where missing", async () => {
    const { repo, store } = await setup();
    const row = await repo.put("transactions", expense);
    const theme = await repo.setSetting("theme", "light");
    expect(
      await store.localHlcs([
        { table: "settings", id: theme.id },
        { table: "transactions", id: crypto.randomUUID() },
        { table: "transactions", id: row.id },
      ]),
    ).toEqual([theme.hlc, undefined, row.hlc]);
  });
});

describe("server changes", () => {
  test("adoptServer marks every row dirty except untouched defaults, saves the serverId and restarts at 0", async () => {
    const { db, repo, store, local } = await setup();
    await seedDefaults(db);
    const row = await repo.put("transactions", expense);
    const [first] = await db.categories.toArray();
    const edited = await repo.update("categories", first?.id ?? "", { name: "Food" });
    await store.markPushed([
      { table: "transactions", id: row.id, hlc: row.hlc },
      { table: "categories", id: edited.id, hlc: edited.hlc },
    ]);
    await setMeta(db, "lastPulledSeq", 9);
    local.length = 0;

    await store.adoptServer("server-2");
    expect(await store.state()).toEqual({ serverId: "server-2", since: 0 });
    const dirty = await store.dirtyRows();
    // Every device seeds its own defaults, so one never pushes them (seed.ts, storePairing).
    expect(dirty.some((d) => d.row.hlc === SEED_HLC)).toBe(false);
    expect(dirty).toContainEqual({ table: "transactions", row });
    expect(dirty.map((d) => d.row.id)).toContain(edited.id);
    expect(await db.categories.where("dirty").equals(1).count()).toBe(1);
    expect(local).toEqual([]);
  });

  test("wipe keeps the seeded defaults, which may exist only here", async () => {
    const { db, store } = await setup();
    await seedDefaults(db);
    const before = await db.categories.count();
    expect(before).toBeGreaterThan(0);
    await store.wipe();
    expect(await db.categories.count()).toBe(before);
    expect(await db.chart_configs.count()).toBeGreaterThan(0);
    expect(await db.settings.count()).toBeGreaterThan(0);
  });

  test("wipe removes a default once it was edited and pushed (the server copy comes back)", async () => {
    const { db, repo, store } = await setup();
    await seedDefaults(db);
    const [first] = await db.categories.toArray();
    const edited = await repo.update("categories", first?.id ?? "", { name: "Food" });
    await store.markPushed([{ table: "categories", id: edited.id, hlc: edited.hlc }]);
    await store.wipe();
    expect(await db.categories.get(edited.id)).toBeUndefined();
  });

  test("wipe removes pushed rows, keeps dirty ones and restarts at 0", async () => {
    const { db, repo, store } = await setup();
    const pushed = await repo.put("transactions", expense);
    await store.markPushed([{ table: "transactions", id: pushed.id, hlc: pushed.hlc }]);
    const pending = await repo.put("transactions", { ...expense, amount: 9 });
    await setMeta(db, "lastPulledSeq", 9);

    await store.wipe();
    expect(await db.transactions.get(pushed.id)).toBeUndefined();
    expect(await db.transactions.get(pending.id)).toEqual({ ...pending, dirty: 1 });
    expect((await store.state()).since).toBe(0);
  });
});
