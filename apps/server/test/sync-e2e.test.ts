// End to end: the core sync engine with real encryption, two (or more) simulated devices with
// in-memory storage, and the real server over in-memory SQLite.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BLOB_MAX_LENGTH,
  createHttpTransport,
  encryptRow,
  formatHlc,
  generateVaultKey,
  MAX_CLOCK_DRIFT_MS,
  PUSH_MAX_BYTES,
  parseHlc,
  runSync,
  type SyncTransport,
} from "@budgee/core";
import { purgeTombstones, TOMBSTONE_MAX_AGE } from "../src/cleanup";
import { type TestServer, testServer } from "./api-helpers";
import { MemoryStore, SERVER_URL, testClient } from "./sync-clients";

const entry = (amount: number, extra: Record<string, unknown> = {}) => ({
  type: "expense",
  amount,
  date: "2026-11-17",
  category: "Groceries",
  detail: "Carrefour",
  created_at: "2026-11-17T09:00:00.000Z",
  ...extra,
});

let s: TestServer;
let key: CryptoKey;

beforeEach(async () => {
  s = await testServer();
  key = await generateVaultKey();
});
afterEach(() => s.close());

/** Phone (from /setup) and Laptop (paired), sharing one vault key. */
async function twoDevices(clocks: { phone?: () => number; laptop?: () => number } = {}) {
  const phoneToken = await s.setup("Phone");
  const laptopToken = await s.pair(phoneToken, "Laptop");
  const phone = testClient(s, {
    token: phoneToken,
    key,
    deviceId: "phone",
    ...(clocks.phone ? { now: clocks.phone } : {}),
  });
  const laptop = testClient(s, {
    token: laptopToken,
    key,
    deviceId: "laptop",
    ...(clocks.laptop ? { now: clocks.laptop } : {}),
  });
  return { phone, laptop, phoneToken, laptopToken };
}

const ok = async (run: Promise<{ status: string; error?: unknown }>) => {
  const result = await run;
  expect(result).toMatchObject({ status: "synced" });
  return result;
};

describe("two devices", () => {
  test("offline edits synced in different orders end identical", async () => {
    for (const order of [
      ["phone", "laptop", "phone"],
      ["laptop", "phone", "laptop"],
    ] as const) {
      s.close();
      s = await testServer();
      let phoneNow = 1_000_000;
      let laptopNow = 2_000_000; // the laptop's clock runs ahead
      const devices = await twoDevices({ phone: () => phoneNow, laptop: () => laptopNow });
      const { phone, laptop } = devices;

      // A shared row both devices then edit offline.
      const shared = phone.store.put("transactions", entry(100));
      await ok(phone.sync());
      await ok(laptop.sync());
      expect(laptop.store.get("transactions", shared.id)?.row).toEqual(shared);

      // Offline: each adds its own rows and edits the shared one; the phone edits later in real
      // time but its clock is behind, so the laptop's edit (higher hlc) wins everywhere.
      phoneNow += 10;
      const phoneOnly = phone.store.put("transactions", entry(200));
      phone.store.put("transactions", entry(111), shared.id);
      laptopNow += 10;
      const laptopOnly = laptop.store.put("transactions", entry(300));
      const laptopEdit = laptop.store.put("transactions", entry(222), shared.id);
      laptop.store.put("categories", {
        type: "expense",
        name: "Travel",
        sort: 11,
        archived: false,
      });

      for (const name of order) await ok(devices[name].sync());

      expect(phone.store.data()).toEqual(laptop.store.data());
      expect(phone.store.get("transactions", shared.id)?.row).toEqual(laptopEdit);
      expect(phone.store.get("transactions", laptopOnly.id)).toBeDefined();
      expect(laptop.store.get("transactions", phoneOnly.id)).toBeDefined();
      expect(phone.store.dirtyKeys()).toEqual([]);
      expect(laptop.store.dirtyKeys()).toEqual([]);
      // Every received row moved the phone's clock past the laptop's edits.
      expect(phone.store.put("transactions", entry(5), shared.id).hlc > laptopEdit.hlc).toBe(true);
    }
  });

  test("applying the same change twice is harmless", async () => {
    const { phone, laptop } = await twoDevices();
    phone.store.put("transactions", entry(100));
    phone.store.put("transactions", entry(200));
    await ok(phone.sync());
    const first = await ok(laptop.sync());
    expect(first).toMatchObject({ pulled: 2, applied: 2 });
    const before = laptop.store.data();

    // Pull everything again from the start, and push the same rows again.
    laptop.store.since = 0;
    expect(await ok(laptop.sync())).toMatchObject({ pulled: 2, applied: 0 });
    for (const row of laptop.store.rows.values()) row.dirty = true;
    expect(await ok(laptop.sync())).toMatchObject({ pushed: 2, pulled: 0 });
    expect(laptop.store.data()).toEqual(before);
    expect(await ok(phone.sync())).toMatchObject({ pulled: 0, applied: 0 });
  });

  test("tombstones propagate", async () => {
    const { phone, laptop } = await twoDevices();
    const row = phone.store.put("transactions", entry(100));
    await ok(phone.sync());
    await ok(laptop.sync());
    laptop.store.remove("transactions", row.id);
    await ok(laptop.sync());
    await ok(phone.sync());
    expect(phone.store.get("transactions", row.id)?.row).toMatchObject({
      id: row.id,
      deleted: true,
      device: "laptop",
    });
    expect(phone.store.data()).toEqual(laptop.store.data());
  });

  test("an edit made while a sync runs stays dirty and goes out next time", async () => {
    const { phone, laptop, phoneToken } = await twoDevices();
    const row = phone.store.put("transactions", entry(100));
    let edited: ReturnType<typeof phone.store.put> | undefined;
    const editing = testClient(s, {
      token: phoneToken,
      key,
      deviceId: "phone",
      onRequest: (url) => {
        // While the first push is in flight, the user edits the row being pushed.
        if (url.endsWith("/sync/push") && !edited) {
          edited = editing.store.put("transactions", entry(999), row.id);
        }
      },
    });
    editing.store.rows = phone.store.rows;
    editing.store.clock = phone.store.clock;

    expect(await ok(editing.sync())).toMatchObject({ pushed: 1 });
    expect(editing.store.get("transactions", row.id)).toMatchObject({ row: edited, dirty: true });

    expect(await ok(editing.sync())).toMatchObject({ pushed: 1 });
    expect(editing.store.dirtyKeys()).toEqual([]);
    await ok(laptop.sync());
    expect(laptop.store.get("transactions", row.id)?.row).toEqual(
      edited as NonNullable<typeof edited>,
    );
  });

  test("a device revoked elsewhere is told so", async () => {
    const { phone, phoneToken, laptop } = await twoDevices();
    const res = await s.call("GET", "/devices", { token: phoneToken });
    const { devices } = (await res.json()) as { devices: { id: string; name: string }[] };
    const laptopId = devices.find((d) => d.name === "Laptop")?.id;
    await s.call("POST", `/devices/${laptopId}/revoke`, { token: phoneToken });
    await ok(phone.sync());
    expect(await laptop.sync()).toMatchObject({
      status: "error",
      error: { kind: "device_revoked" },
    });
  });
});

describe("server changes", () => {
  test("resetRequired after a purge: a stale device wipes, repulls and keeps its own edits", async () => {
    const { phone, laptop } = await twoDevices();
    const gone = phone.store.put("transactions", entry(100));
    const kept = phone.store.put("transactions", entry(200));
    await ok(phone.sync());
    await ok(laptop.sync());
    // An old copy of the laptop's storage, from before it learned of the deletion.
    const stale = laptop.store.snapshot();

    phone.store.remove("transactions", gone.id);
    await ok(phone.sync());
    await ok(laptop.sync()); // receives the tombstone
    await ok(laptop.sync()); // acknowledges it
    await ok(phone.sync());
    s.advance(TOMBSTONE_MAX_AGE + 1);
    expect(await purgeTombstones(s.db, s.now())).toBe(1);

    // Edited on the stale copy before it syncs: pushed first, so it survives the wipe.
    const offline = stale.put("transactions", entry(300));
    const result = await ok(laptop.sync(stale));
    expect(result).toMatchObject({ reset: true, pushed: 1 });
    // Without the wipe, the purged row would still be live here.
    expect(stale.get("transactions", gone.id)).toBeUndefined();
    expect(stale.get("transactions", kept.id)?.row).toEqual(kept);
    expect(stale.get("transactions", offline.id)?.row).toEqual(offline);
    expect(stale.since).toBeGreaterThan(0);
    expect(stale.dirtyKeys()).toEqual([]);

    await ok(phone.sync());
    const live = (data: Record<string, { deleted: boolean }>) =>
      Object.fromEntries(Object.entries(data).filter(([, row]) => !row.deleted));
    expect(live(stale.data())).toEqual(live(phone.store.data()));
  });

  test("a new serverId (server reset or redeploy) pushes every row again", async () => {
    const { phone } = await twoDevices();
    for (let i = 1; i <= 3; i++) phone.store.put("transactions", entry(i * 100));
    expect(await ok(phone.sync())).toMatchObject({ pushed: 3, serverChanged: true });
    expect(await ok(phone.sync())).toMatchObject({ pushed: 0, serverChanged: false });

    const fresh = await testServer();
    try {
      const token = await fresh.setup("Phone");
      phone.moveTo(fresh, token);
      const result = await ok(phone.sync());
      expect(result).toMatchObject({ serverChanged: true, pushed: 3, pulled: 3, applied: 0 });
      expect(phone.store.serverId).toBe(fresh.serverId);
      expect(phone.store.dirtyKeys()).toEqual([]);

      // Another device on the new server gets the full copy.
      const tablet = testClient(fresh, {
        token: await fresh.pair(token, "Tablet"),
        key,
        deviceId: "tablet",
      });
      await ok(tablet.sync());
      expect(tablet.store.data()).toEqual(phone.store.data());
    } finally {
      fresh.close();
    }
  });
});

describe("failures", () => {
  test("a server that cannot be reached is offline, quietly", async () => {
    const { phone } = await twoDevices();
    phone.store.put("transactions", entry(100));
    const offline = testClient(s, {
      token: "x",
      key,
      deviceId: "phone",
      onRequest: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    offline.store.rows = phone.store.rows;
    expect(await offline.sync()).toMatchObject({
      status: "offline",
      pushed: 0,
      pulled: 0,
      error: { kind: "offline" },
    });
    expect(offline.store.dirtyKeys()).toHaveLength(1);
  });

  test("a blob that does not decrypt stops the sync with an error, applying nothing", async () => {
    const { phone, laptop } = await twoDevices();
    const row = phone.store.put("transactions", entry(100));
    await ok(phone.sync());
    laptop.key = await generateVaultKey(); // the wrong vault key
    const result = await laptop.sync();
    expect(result).toMatchObject({
      status: "error",
      pulled: 1,
      applied: 0,
      error: { kind: "decrypt", table: "transactions", id: row.id },
    });
    expect(laptop.store.get("transactions", row.id)).toBeUndefined();
    expect(laptop.store.since).toBe(0); // the page is fetched again next time

    laptop.key = key;
    expect(await ok(laptop.sync())).toMatchObject({ applied: 1 });
  });
});

describe("push batching", () => {
  const pushes = () => {
    const bodies: string[] = [];
    return {
      bodies,
      onRequest: (url: string, init: { body?: string }) => {
        if (url.endsWith("/sync/push")) bodies.push(init.body ?? "");
      },
    };
  };

  test("splits by count: at most 500 envelopes per request", async () => {
    const token = await s.setup();
    const seen = pushes();
    const phone = testClient(s, { token, key, deviceId: "phone", onRequest: seen.onRequest });
    for (let i = 1; i <= 1001; i++) phone.store.put("transactions", entry(i));
    expect(await ok(phone.sync())).toMatchObject({ pushed: 1001, pulled: 1001, applied: 0 });
    expect(
      seen.bodies.map((b) => (JSON.parse(b) as { envelopes: unknown[] }).envelopes.length),
    ).toEqual([500, 500, 1]);
  });

  test("splits by size: every request stays within PUSH_MAX_BYTES", async () => {
    const token = await s.setup();
    const seen = pushes();
    const phone = testClient(s, { token, key, deviceId: "phone", onRequest: seen.onRequest });
    const note = "n".repeat(40_000); // about 53 KB of blob each
    for (let i = 1; i <= 100; i++) phone.store.put("transactions", entry(i, { note }));
    expect(await ok(phone.sync())).toMatchObject({ pushed: 100 });
    expect(seen.bodies.length).toBeGreaterThan(1);
    for (const body of seen.bodies) {
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(PUSH_MAX_BYTES);
    }
    const [count] = await s.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM envelopes");
    expect(count?.n).toBe(100);
  });

  test("a row too large to push is reported by table and id, the rest still sync", async () => {
    const token = await s.setup();
    const phone = testClient(s, { token, key, deviceId: "phone" });
    const big = phone.store.put("transactions", entry(1, { note: "n".repeat(BLOB_MAX_LENGTH) }));
    phone.store.put("transactions", entry(2));
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await phone.sync()).toMatchObject({
        status: "error",
        pushed: attempt === 0 ? 1 : 0,
        error: { kind: "row_too_large", table: "transactions", id: big.id },
      });
    }
    expect(phone.store.dirtyKeys()).toEqual([`transactions:${big.id}`]);
  });
});

describe("clock drift cap", () => {
  const HOUR = 60 * 60 * 1000;

  test("a row from a clock days ahead is applied, but the local clock follows only 24h ahead", async () => {
    const now = s.now();
    const { phone, laptop } = await twoDevices({
      phone: () => now + 72 * HOUR, // the phone's clock is three days fast
      laptop: () => now,
    });
    const row = phone.store.put("transactions", entry(100));
    await ok(phone.sync());
    expect(await ok(laptop.sync())).toMatchObject({ applied: 1 });
    expect(laptop.store.get("transactions", row.id)?.row).toEqual(row);
    expect(parseHlc(laptop.store.clock.last() ?? "").wall).toBe(now + MAX_CLOCK_DRIFT_MS);
  });

  test("a clock a little ahead is followed exactly", async () => {
    const now = s.now();
    const { phone, laptop } = await twoDevices({
      phone: () => now + HOUR,
      laptop: () => now,
    });
    const row = phone.store.put("transactions", entry(100));
    await ok(phone.sync());
    await ok(laptop.sync());
    expect(laptop.store.clock.last()).toBe(
      `${row.hlc.slice(0, 15)}:${String(parseHlc(row.hlc).counter + 1).padStart(5, "0")}:laptop`,
    );
  });
});

describe("engine edge cases (scripted server)", () => {
  const HEALTH = { serverId: "srv", version: "0.1.0", serverTime: 0 };
  const empty = (since: number) => ({
    envelopes: [],
    nextSeq: since,
    hasMore: false,
    resetRequired: false,
  });

  /** A transport answering pulls from `pull`, everything else as an empty, healthy server. */
  const scripted = (pull: SyncTransport["pull"]): SyncTransport => ({
    health: async () => HEALTH,
    push: async ({ envelopes }) => ({ accepted: envelopes.length, ignored: 0 }),
    pull,
  });

  const storeAt = (since: number) => {
    const store = new MemoryStore("laptop", () => 1_000);
    store.serverId = HEALTH.serverId;
    store.since = since;
    return store;
  };

  test("a pulled row that decrypts but fails its schema stops the sync as invalid_row", async () => {
    // Fixed: a random id may itself contain "-1", the value the message must not quote.
    const id = "6f2d3c2e-9a4b-4c8d-8e7f-0a2b2c3d4e5f";
    const hlc = formatHlc({ wall: 5, counter: 0, device: "phone" });
    const blob = await encryptRow(key, "transactions", id, hlc, { amount: -1 });
    const store = storeAt(0);
    const result = await runSync({
      key,
      store,
      transport: scripted(async () => ({
        envelopes: [
          { table: "transactions", id, hlc, deleted: false, device: "phone", seq: 1, blob },
        ],
        nextSeq: 1,
        hasMore: false,
        resetRequired: false,
      })),
    });
    expect(result).toMatchObject({
      status: "error",
      applied: 0,
      error: { kind: "invalid_row", table: "transactions", id },
    });
    expect(result.error?.message).not.toContain("-1");
    expect(store.since).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  test("a pull whose nextSeq does not move while hasMore is a bad response, not a loop", async () => {
    let pulls = 0;
    const result = await runSync({
      key,
      store: storeAt(7),
      transport: scripted(async ({ since }) => {
        pulls++;
        return { ...empty(since), hasMore: true };
      }),
    });
    expect(result).toMatchObject({ status: "error", error: { kind: "bad_response" } });
    expect(pulls).toBe(1);
  });

  test("a second resetRequired in one run is a bad response; the wipe happens once", async () => {
    const store = storeAt(7);
    let wipes = 0;
    const wipe = store.wipe.bind(store);
    store.wipe = async () => {
      wipes++;
      await wipe();
    };
    const result = await runSync({
      key,
      store,
      transport: scripted(async ({ since }) => ({ ...empty(since), resetRequired: true })),
    });
    expect(result).toMatchObject({
      status: "error",
      reset: true,
      error: { kind: "bad_response" },
    });
    expect(wipes).toBe(1);
  });

  test("a pull answered with a 5xx is a server error; pushed rows stay pushed", async () => {
    const token = await s.setup();
    const phone = testClient(s, { token, key, deviceId: "phone" });
    phone.store.put("transactions", entry(100));
    const transport = createHttpTransport({
      serverUrl: SERVER_URL,
      token,
      fetch: async (url, init) =>
        url.includes("/sync/pull")
          ? new Response(JSON.stringify({ error: { code: "internal", message: "x" } }), {
              status: 500,
            })
          : s.app.request(url, init),
    });
    const result = await runSync({ transport, store: phone.store, key });
    expect(result).toMatchObject({
      status: "error",
      pushed: 1,
      error: { kind: "server" },
    });
    expect(phone.store.dirtyKeys()).toEqual([]);
  });
});
