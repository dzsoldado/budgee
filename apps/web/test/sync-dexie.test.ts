// The core sync engine over the real Dexie store (fake-indexeddb), against a small in-memory
// server that keeps the protocol's rules: higher hlc wins, a global seq, a purge point.
import { expect, test } from "bun:test";
import {
  DEFAULT_CATEGORIES,
  type Envelope,
  formatHlc,
  generateVaultKey,
  PULL_LIMIT,
  runSync,
  SEED_HLC,
  type SyncTransport,
  toEnvelope,
} from "@budgee/core";
import { setMeta } from "../src/db/db";
import { openRepository } from "../src/db/repository";
import { seedDefaults } from "../src/db/seed";
import { createDexieSyncStore } from "../src/sync/store";
import { expense, fakeNow, freshDb } from "./helpers";

function memoryServer() {
  const stored = new Map<string, Envelope & { seq: number }>();
  let seq = 0;
  let purgeSeq = 0;
  const keyOf = (e: { table: string; id: string }) => `${e.table}:${e.id}`;
  const transport: SyncTransport = {
    health: async () => ({ serverId: "srv", version: "0.1.0", serverTime: 0 }),
    async push({ envelopes }) {
      let accepted = 0;
      for (const envelope of envelopes) {
        const current = stored.get(keyOf(envelope));
        if (current && envelope.hlc <= current.hlc) continue;
        stored.set(keyOf(envelope), { ...envelope, seq: ++seq });
        accepted++;
      }
      return { accepted, ignored: envelopes.length - accepted };
    },
    async pull({ since, limit = PULL_LIMIT }) {
      if (since > 0 && since < purgeSeq) {
        return { envelopes: [], nextSeq: 0, hasMore: false, resetRequired: true };
      }
      const after = [...stored.values()].filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
      const page = after.slice(0, limit);
      return {
        envelopes: page,
        nextSeq: page.at(-1)?.seq ?? since,
        hasMore: after.length > limit,
        resetRequired: false,
      };
    },
  };
  return {
    transport,
    get: (table: string, id: string) => stored.get(`${table}:${id}`),
    /** What the daily cleanup does to an old tombstone. */
    purge(table: string, id: string) {
      const envelope = stored.get(`${table}:${id}`);
      if (!envelope?.deleted) throw new Error("only tombstones are purged");
      stored.delete(`${table}:${id}`);
      purgeSeq = Math.max(purgeSeq, envelope.seq);
    },
  };
}

test("resetRequired over Dexie: wipe and repull drop the purged row, keep seeds and new edits", async () => {
  const db = freshDb();
  const clock = fakeNow(1_763_370_000_000);
  const repo = await openRepository(db, { now: clock.now });
  await seedDefaults(db);
  const store = createDexieSyncStore(db, repo);
  const key = await generateVaultKey();
  const server = memoryServer();
  // Paired as Task 15 will: the serverId is known, so the seeds are never pushed.
  await setMeta(db, "serverId", "srv");
  const sync = () => runSync({ transport: server.transport, store, key, now: clock.now });

  const gone = await repo.put("transactions", expense);
  const kept = await repo.put("transactions", { ...expense, amount: 7 });
  expect(await sync()).toMatchObject({ status: "synced", pushed: 2, serverChanged: false });
  const seededCategories = await db.categories.count();

  // Another device deletes `gone`; much later the server purges that tombstone.
  await server.transport.push({
    envelopes: [
      {
        table: "transactions",
        id: gone.id,
        hlc: formatHlc({ wall: clock.now() + 1, counter: 0, device: "phone" }),
        deleted: true,
        device: "phone",
      },
    ],
  });
  server.purge("transactions", gone.id);

  clock.set(clock.now() + 10);
  const offline = await repo.put("transactions", { ...expense, amount: 9 });

  const result = await sync();
  expect(result).toMatchObject({ status: "synced", reset: true, pushed: 1 });
  expect(await db.transactions.get(gone.id)).toBeUndefined();
  expect(await db.transactions.get(kept.id)).toEqual({ ...kept, dirty: 0 });
  expect(await db.transactions.get(offline.id)).toEqual({ ...offline, dirty: 0 });
  expect(await db.categories.count()).toBe(seededCategories);
  expect(await db.transactions.where("dirty").equals(1).count()).toBe(0);
  expect((await store.state()).since).toBeGreaterThan(0);
  expect(server.get("transactions", offline.id)).toBeDefined();
});

test("after a reset, the server's edit or tombstone of a default replaces the spared seed", async () => {
  const db = freshDb();
  const clock = fakeNow(1_763_370_000_000);
  const repo = await openRepository(db, { now: clock.now });
  await seedDefaults(db);
  const store = createDexieSyncStore(db, repo);
  const key = await generateVaultKey();
  const server = memoryServer();
  await setMeta(db, "serverId", "srv");
  const sync = () => runSync({ transport: server.transport, store, key, now: clock.now });

  const gone = await repo.put("transactions", expense);
  expect(await sync()).toMatchObject({ status: "synced", pushed: 1 });

  // Another device renames "Groceries" and deletes "Transport", then deletes `gone`, which is purged.
  const [groceries, transport] = DEFAULT_CATEGORIES;
  if (!groceries || !transport) throw new Error("expected two default categories");
  const hlc = (n: number) => formatHlc({ wall: clock.now() + n, counter: 0, device: "phone" });
  const renamed = { ...groceries, name: "Food", hlc: hlc(1), device: "phone", deleted: false };
  await server.transport.push({
    envelopes: [
      await toEnvelope(key, "categories", renamed),
      { table: "categories", id: transport.id, hlc: hlc(2), deleted: true, device: "phone" },
      { table: "transactions", id: gone.id, hlc: hlc(3), deleted: true, device: "phone" },
    ],
  });
  server.purge("transactions", gone.id);
  // This device still holds both defaults as seeded: wipe spares them.
  expect((await db.categories.get(groceries.id))?.hlc).toBe(SEED_HLC);
  expect((await db.categories.get(transport.id))?.hlc).toBe(SEED_HLC);

  expect(await sync()).toMatchObject({ status: "synced", reset: true });
  expect(await db.categories.get(groceries.id)).toEqual({ ...renamed, dirty: 0 });
  expect(await db.categories.get(transport.id)).toEqual({
    id: transport.id,
    hlc: hlc(2),
    device: "phone",
    deleted: true,
    dirty: 0,
  });
  expect(await db.transactions.get(gone.id)).toBeUndefined();
});
