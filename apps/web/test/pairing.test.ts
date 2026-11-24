import { describe, expect, test } from "bun:test";
import {
  type Device,
  type DeviceApi,
  encryptRow,
  exportKey,
  generateVaultKey,
  SEED_HLC,
  SyncError,
  type SyncTransport,
} from "@budgee/core";
import { getMeta, setMeta } from "../src/db/db";
import { openRepository } from "../src/db/repository";
import { seedDefaults } from "../src/db/seed";
import type { DeviceApiConfig, SyncTransportConfig } from "../src/platform/types";
import {
  canPair,
  canRevoke,
  createQuestion,
  forgetPairing,
  PairingError,
  PairingSaveError,
  pairingErrorText,
  pairWithCode,
  type StoredPairing,
  serverOrigin,
  setUpServer,
  storePairing,
  unpair,
} from "../src/sync/pairing";
import { expense, freshDb } from "./helpers";

const ORIGIN = "https://budgee.example";
const device = { id: "me", name: "n", createdAt: 1, lastSeen: 1, revoked: false, current: true };

/** A fake server: records device API calls; `envelopes` is what a pull from 0 returns. */
function fakeServer({
  serverId = "srv",
  envelopes = [] as Awaited<ReturnType<SyncTransport["pull"]>>["envelopes"],
  pullFails = false,
} = {}) {
  const calls: string[] = [];
  const configs: (DeviceApiConfig | SyncTransportConfig)[] = [];
  const api = (config: DeviceApiConfig): DeviceApi => {
    configs.push(config);
    return {
      async setup(body) {
        calls.push(`setup ${body.secret} ${body.deviceName}`);
        if (body.secret !== "right") {
          throw new SyncError("unauthorized", "401", { status: 401, code: "invalid_secret" });
        }
        return { token: "tok-setup", serverId };
      },
      async pair(body) {
        calls.push(`pair ${body.code} ${body.deviceName}`);
        return { token: "tok-pair", serverId };
      },
      invite: async () => ({ code: "C", expiresAt: 0 }),
      list: async () => {
        calls.push(`list ${config.deviceToken}`);
        return [{ ...device, current: false, id: "other" }, device];
      },
      rename: async () => device,
      async revoke(id, body) {
        calls.push(`revoke ${id} ${JSON.stringify(body)} ${config.deviceToken}`);
        return { ...device, revoked: true };
      },
    };
  };
  const transport = (config: SyncTransportConfig): SyncTransport => {
    configs.push(config);
    return {
      health: async () => ({ serverId, version: "0.1.0", serverTime: 0 }),
      push: async () => ({ accepted: 0, ignored: 0 }),
      async pull() {
        calls.push(`pull ${config.deviceToken}`);
        if (pullFails) throw new SyncError("offline", "GET /sync/pull failed");
        return { envelopes, nextSeq: envelopes.length, hasMore: false, resetRequired: false };
      },
    };
  };
  return { calls, configs, platform: { createDeviceApi: api, createSyncTransport: transport } };
}

async function seededDb() {
  const db = freshDb();
  const repo = await openRepository(db);
  await seedDefaults(db);
  return { db, repo };
}

/** The raw bytes of a key kept in meta (IndexedDB hands back a copy of the CryptoKey). */
const keptKey = async (db: ReturnType<typeof freshDb>) => {
  const key = await getMeta(db, "vaultKey");
  return key && (await exportKey(key));
};

const pairingMeta = async (db: ReturnType<typeof freshDb>) => ({
  serverUrl: await getMeta(db, "serverUrl"),
  deviceToken: await getMeta(db, "deviceToken"),
  serverId: await getMeta(db, "serverId"),
  vaultKey: await keptKey(db),
  lastPulledSeq: await getMeta(db, "lastPulledSeq"),
  lastSyncAt: await getMeta(db, "lastSyncAt"),
});

describe("serverOrigin", () => {
  test("keeps the origin of an absolute http(s) address", () => {
    expect(serverOrigin(" https://budgee.example/some/path?x=1 ")).toBe(ORIGIN);
    expect(serverOrigin("http://localhost:5174/")).toBe("http://localhost:5174");
  });

  test("refuses anything else", () => {
    for (const text of ["", "budgee.example", "/api", "ftp://budgee.example"]) {
      expect(() => serverOrigin(text)).toThrow(PairingError);
    }
  });
});

describe("storePairing", () => {
  test("keeps the pairing with its serverId and queues every row but the untouched defaults", async () => {
    const { db, repo } = await seededDb();
    const entry = await repo.put("transactions", expense);
    // A row pushed to an earlier server (clean) must go to the new one too.
    await db.transactions.update(entry.id, { dirty: 0 });
    const edited = (await db.categories.toArray())[0];
    if (!edited) throw new Error("no seeded category");
    await repo.update("categories", edited.id, { name: "Daily" });
    await db.categories.update(edited.id, { dirty: 0 });
    await setMeta(db, "lastPulledSeq", 42);
    await setMeta(db, "lastSyncAt", 1);

    const vaultKey = await generateVaultKey();
    await storePairing(db, { serverUrl: ORIGIN, deviceToken: "tok", serverId: "srv", vaultKey });

    expect(await pairingMeta(db)).toEqual({
      serverUrl: ORIGIN,
      deviceToken: "tok",
      serverId: "srv",
      vaultKey: await exportKey(vaultKey),
      lastPulledSeq: 0,
      lastSyncAt: undefined,
    });
    expect((await db.transactions.get(entry.id))?.dirty).toBe(1);
    expect((await db.categories.get(edited.id))?.dirty).toBe(1);
    const seeds = await db.categories.filter((row) => row.hlc === SEED_HLC).toArray();
    expect(seeds.length).toBeGreaterThan(0);
    for (const seed of seeds) expect(seed.dirty).toBe(0);
    expect(await db.settings.where("dirty").equals(1).count()).toBe(0);
  });
});

describe("forgetPairing", () => {
  test("drops the pairing and sync position, keeps entries and this device's clock", async () => {
    const { db, repo } = await seededDb();
    const entry = await repo.put("transactions", expense);
    await storePairing(db, {
      serverUrl: ORIGIN,
      deviceToken: "tok",
      serverId: "srv",
      vaultKey: await generateVaultKey(),
    });
    await setMeta(db, "lastSyncAt", 5);
    await forgetPairing(db);
    expect(Object.values(await pairingMeta(db)).every((value) => value === undefined)).toBe(true);
    expect(await db.transactions.get(entry.id)).toBeDefined();
    expect(await getMeta(db, "deviceId")).toBe(repo.deviceId);
    expect(await getMeta(db, "hlc")).toBeDefined();
  });
});

describe("setUpServer", () => {
  test("claims the server with the secret, then keeps a new vault key and the pairing", async () => {
    const { db } = await seededDb();
    const server = fakeServer();
    const key = await setUpServer(
      { db, platform: server.platform },
      { serverUrl: `${ORIGIN}/`, secret: "right", deviceName: "Chrome on Windows" },
    );
    expect(server.calls).toEqual(["setup right Chrome on Windows"]);
    expect(server.configs[0]).toEqual({ serverUrl: ORIGIN });
    expect(await pairingMeta(db)).toMatchObject({
      serverUrl: ORIGIN,
      deviceToken: "tok-setup",
      serverId: "srv",
      vaultKey: await exportKey(key),
    });
    expect(key.extractable).toBe(true);
  });

  test("a restored vault key is kept instead of a new one", async () => {
    const { db } = await seededDb();
    const restored = await generateVaultKey();
    const key = await setUpServer(
      { db, platform: fakeServer().platform },
      { serverUrl: ORIGIN, secret: "right", deviceName: "n", vaultKey: restored },
    );
    expect(key).toBe(restored);
    expect(await keptKey(db)).toEqual(await exportKey(restored));
  });

  test("a refused setup keeps nothing", async () => {
    const { db } = await seededDb();
    const attempt = setUpServer(
      { db, platform: fakeServer().platform },
      { serverUrl: ORIGIN, secret: "wrong", deviceName: "n" },
    );
    await expect(attempt).rejects.toMatchObject({ code: "invalid_secret" });
    expect(await getMeta(db, "deviceToken")).toBeUndefined();
  });
});

describe("pairWithCode", () => {
  test("pairs with the code and keeps the given key and the server's id", async () => {
    const { db } = await seededDb();
    const server = fakeServer();
    const vaultKey = await generateVaultKey();
    await pairWithCode(
      { db, platform: server.platform },
      { serverUrl: ORIGIN, code: "ABCD1234", deviceName: "Pixel", vaultKey, serverId: "srv" },
    );
    expect(server.calls).toEqual(["pair ABCD1234 Pixel"]);
    expect(await pairingMeta(db)).toMatchObject({
      serverUrl: ORIGIN,
      deviceToken: "tok-pair",
      serverId: "srv",
      vaultKey: await exportKey(vaultKey),
    });
  });

  test("a link made for another server is refused before the code is used", async () => {
    const { db } = await seededDb();
    const server = fakeServer({ serverId: "other" });
    const attempt = pairWithCode(
      { db, platform: server.platform },
      {
        serverUrl: ORIGIN,
        code: "C",
        deviceName: "n",
        vaultKey: await generateVaultKey(),
        serverId: "srv",
      },
    );
    await expect(attempt).rejects.toMatchObject({ reason: "other_server" });
    expect(server.calls).toEqual([]);
    expect(await getMeta(db, "deviceToken")).toBeUndefined();
  });

  test("checkKey: a key that opens the server's rows is kept", async () => {
    const { db } = await seededDb();
    const vaultKey = await generateVaultKey();
    const id = "00000000-0000-4000-8000-000000000001";
    const hlc = "000001763370000000:00000:phone";
    const blob = await encryptRow(vaultKey, "transactions", id, hlc, {});
    const server = fakeServer({
      envelopes: [{ table: "transactions", id, hlc, device: "phone", deleted: false, blob }],
    });
    await pairWithCode(
      { db, platform: server.platform },
      { serverUrl: ORIGIN, code: "C", deviceName: "n", vaultKey, checkKey: true },
    );
    expect(server.calls).toEqual(["pair C n", "pull tok-pair"]);
    expect(await keptKey(db)).toEqual(await exportKey(vaultKey));
  });

  test("checkKey: a key that does not match removes the new device again and keeps nothing", async () => {
    const { db } = await seededDb();
    const id = "00000000-0000-4000-8000-000000000001";
    const hlc = "000001763370000000:00000:phone";
    const blob = await encryptRow(await generateVaultKey(), "transactions", id, hlc, {});
    const server = fakeServer({
      envelopes: [{ table: "transactions", id, hlc, device: "phone", deleted: false, blob }],
    });
    const attempt = pairWithCode(
      { db, platform: server.platform },
      {
        serverUrl: ORIGIN,
        code: "C",
        deviceName: "n",
        vaultKey: await generateVaultKey(),
        checkKey: true,
      },
    );
    await expect(attempt).rejects.toMatchObject({ reason: "key_mismatch" });
    expect(server.calls).toEqual([
      "pair C n",
      "pull tok-pair",
      "list tok-pair",
      'revoke me {"confirmSelf":true} tok-pair',
    ]);
    expect(await getMeta(db, "deviceToken")).toBeUndefined();
    expect(await getMeta(db, "vaultKey")).toBeUndefined();
  });
});

/** A save that fails the first `times` calls, then stores for real. */
function failingSave(times: number) {
  let calls = 0;
  const save = async (db: ReturnType<typeof freshDb>, pairing: StoredPairing) => {
    calls++;
    if (calls <= times) throw new Error("QuotaExceededError");
    await storePairing(db, pairing);
  };
  return { save, calls: () => calls };
}

const recoveryInput = async () => ({
  serverUrl: ORIGIN,
  code: "C",
  deviceName: "n",
  vaultKey: await generateVaultKey(),
  checkKey: true,
});

describe("when this device cannot keep a pairing", () => {
  test("setup: the key exists before the server is claimed, and a failed save can be retried", async () => {
    const { db } = await seededDb();
    const server = fakeServer();
    const store = failingSave(1);
    let error: unknown;
    try {
      await setUpServer(
        { db, platform: server.platform, save: store.save },
        { serverUrl: ORIGIN, secret: "right", deviceName: "n" },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PairingSaveError);
    const { pending } = error as PairingSaveError;
    expect(pending).toMatchObject({ serverUrl: ORIGIN, deviceToken: "tok-setup", serverId: "srv" });
    expect(pending.vaultKey.extractable).toBe(true);
    expect(await getMeta(db, "deviceToken")).toBeUndefined();

    // "Try saving again" keeps exactly what the server accepted; setup is not called again.
    await storePairing(db, pending);
    expect(await getMeta(db, "deviceToken")).toBe("tok-setup");
    expect(await keptKey(db)).toEqual(await exportKey(pending.vaultKey));
    expect(server.calls).toEqual(["setup right n"]);
  });

  test("pair: a save that fails once is retried", async () => {
    const { db } = await seededDb();
    const server = fakeServer();
    const store = failingSave(1);
    await pairWithCode(
      { db, platform: server.platform, save: store.save },
      { serverUrl: ORIGIN, code: "C", deviceName: "n", vaultKey: await generateVaultKey() },
    );
    expect(store.calls()).toBe(2);
    expect(await getMeta(db, "deviceToken")).toBe("tok-pair");
  });

  test("pair: a save that keeps failing revokes the new device again", async () => {
    const { db } = await seededDb();
    const server = fakeServer();
    const attempt = pairWithCode(
      { db, platform: server.platform, save: failingSave(9).save },
      { serverUrl: ORIGIN, code: "C", deviceName: "n", vaultKey: await generateVaultKey() },
    );
    await expect(attempt).rejects.toMatchObject({ reason: "save_failed" });
    expect(server.calls.slice(-2)).toEqual([
      "list tok-pair",
      'revoke me {"confirmSelf":true} tok-pair',
    ]);
    expect(await getMeta(db, "deviceToken")).toBeUndefined();
  });
});

describe("checkKey on a server with nothing to check against", () => {
  test("asks before keeping an unverified key, and keeps it when confirmed", async () => {
    const { db } = await seededDb();
    const server = fakeServer();
    let asked = 0;
    await pairWithCode(
      { db, platform: server.platform },
      {
        ...(await recoveryInput()),
        confirmUnverified: async () => {
          asked++;
          return true;
        },
      },
    );
    expect(asked).toBe(1);
    expect(await getMeta(db, "deviceToken")).toBe("tok-pair");
  });

  test("declined (or nobody to ask): revokes the new device, keeps nothing", async () => {
    for (const confirmUnverified of [async () => false, undefined]) {
      const { db } = await seededDb();
      const server = fakeServer();
      const attempt = pairWithCode(
        { db, platform: server.platform },
        { ...(await recoveryInput()), ...(confirmUnverified ? { confirmUnverified } : {}) },
      );
      await expect(attempt).rejects.toMatchObject({ reason: "unverified" });
      expect(server.calls.at(-1)).toBe('revoke me {"confirmSelf":true} tok-pair');
      expect(await getMeta(db, "deviceToken")).toBeUndefined();
    }
  });

  test("a check that cannot reach the server revokes the new device and says so", async () => {
    const { db } = await seededDb();
    const server = fakeServer({ pullFails: true });
    const attempt = pairWithCode({ db, platform: server.platform }, await recoveryInput());
    await expect(attempt).rejects.toBeInstanceOf(PairingError);
    await expect(attempt).rejects.toMatchObject({ reason: "check_failed" });
    expect(server.calls.at(-1)).toBe('revoke me {"confirmSelf":true} tok-pair');
    expect(await getMeta(db, "deviceToken")).toBeUndefined();
  });
});

describe("unpair", () => {
  test("revokes this device on the server and forgets the pairing, keeping entries", async () => {
    const { db, repo } = await seededDb();
    const entry = await repo.put("transactions", expense);
    const server = fakeServer();
    await storePairing(db, {
      serverUrl: ORIGIN,
      deviceToken: "tok",
      serverId: "srv",
      vaultKey: await generateVaultKey(),
    });
    await unpair({ db, platform: server.platform });
    expect(server.calls).toEqual(["list tok", 'revoke me {"confirmSelf":true} tok']);
    expect(await getMeta(db, "deviceToken")).toBeUndefined();
    expect(await db.transactions.get(entry.id)).toBeDefined();
  });
});

describe("Restore screen flow (Task 15 carry-overs)", () => {
  test("a claimed pairing waiting to be saved blocks a new submit and the mode switch", () => {
    const pending = {} as StoredPairing;
    expect(canPair({ busy: false, pending: undefined })).toBe(true);
    expect(canPair({ busy: true, pending: undefined })).toBe(false);
    expect(canPair({ busy: false, pending })).toBe(false);
  });

  test("leaving with the key question open declines it, so the new device is revoked", async () => {
    const { calls, platform } = fakeServer({ envelopes: [] });
    const db = freshDb();
    const opens: boolean[] = [];
    const question = createQuestion((open) => opens.push(open));
    const pairing = pairWithCode(
      { db, platform },
      {
        serverUrl: ORIGIN,
        code: "C",
        deviceName: "Pixel",
        vaultKey: await generateVaultKey(),
        checkKey: true,
        confirmUnverified: question.ask,
      },
    ).catch((e: unknown) => e);
    while (!question.open) await Bun.sleep(1);
    expect(opens).toEqual([true]);
    question.dismiss(); // what the screen does when it unmounts
    const error = await pairing;
    expect(error).toBeInstanceOf(PairingError);
    expect((error as PairingError).reason).toBe("unverified");
    expect(calls.some((call) => call.startsWith("revoke me"))).toBe(true);
    expect(opens).toEqual([true, false]);
    expect(await getMeta(db, "deviceToken")).toBeUndefined();
    // Nothing left to answer: dismissing again is harmless.
    question.dismiss();
  });

  test("an answer settles the open question once; a new question replaces a stale one", async () => {
    const question = createQuestion(() => {});
    const first = question.ask();
    const second = question.ask();
    expect(await first).toBe(false);
    question.answer(true);
    expect(await second).toBe(true);
    expect(question.open).toBe(false);
  });
});

describe("revoking the last device", () => {
  const device = (id: string, revoked = false): Device => ({
    id,
    name: id,
    createdAt: 0,
    lastSeen: null,
    revoked,
    current: id === "phone",
  });

  test("canRevoke: never the only device not revoked", () => {
    const phone = device("phone");
    const laptop = device("laptop");
    expect(canRevoke([phone], phone)).toBe(false);
    expect(canRevoke([phone, device("laptop", true)], phone)).toBe(false);
    expect(canRevoke([phone, laptop], phone)).toBe(true);
    expect(canRevoke([phone, laptop], laptop)).toBe(true);
    expect(canRevoke([phone, device("laptop", true)], device("laptop", true))).toBe(false);
  });

  test("the server's last_device refusal reads as plain words", () => {
    const refused = new SyncError("server", "x", { status: 409, code: "last_device" });
    expect(pairingErrorText(refused, "budgee.example")).toBe(
      "This is the only device left on the server, so it can't be revoked. Pair another device first.",
    );
  });
});

test("too many setup or pairing attempts read as plain words", () => {
  const limited = new SyncError("server", "x", { status: 429, code: "rate_limited" });
  expect(pairingErrorText(limited, "budgee.example")).toBe(
    "Too many attempts from this network. Wait a minute and try again.",
  );
});
