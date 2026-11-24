import { describe, expect, test } from "bun:test";
import { generateVaultKey, SyncError, type SyncTransport } from "@budgee/core";
import { getMeta, setMeta } from "../src/db/db";
import { openRepository } from "../src/db/repository";
import type { Platform } from "../src/platform/types";
import {
  createLock,
  createSyncController,
  EDIT_DEBOUNCE_MS,
  LOCK_NAME,
  MIN_SYNCING_MS,
  SYNC_INTERVAL_MS,
  type SyncEnvironment,
} from "../src/sync/controller";
import { announcementFor, describeSync, type SyncStatus } from "../src/sync/status";
import { expense, freshDb } from "./helpers";

const NOW = 1_763_370_000_000;
const MIN = 60_000;

function fakeTransport(overrides: Partial<SyncTransport> = {}) {
  const calls: string[] = [];
  const transport: SyncTransport = {
    async health() {
      calls.push("health");
      return { serverId: "srv", version: "0.1.0", serverTime: NOW };
    },
    async push({ envelopes }) {
      calls.push("push");
      return { accepted: envelopes.length, ignored: 0 };
    },
    async pull({ since }) {
      calls.push("pull");
      return { envelopes: [], nextSeq: since, hasMore: false, resetRequired: false };
    },
    ...overrides,
  };
  return { calls, transport, runs: () => calls.filter((c) => c === "health").length };
}

/** Event targets and timers the test drives, with a clock that moves only when told. */
function fakeEnv() {
  let elapsed = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void; every?: number }>();
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const handle = (id: number) => id as unknown as ReturnType<typeof setTimeout>;
  const idOf = (h: unknown) => h as number;
  const env: SyncEnvironment = {
    window: new EventTarget(),
    document,
    setTimeout(run, ms) {
      timers.set(++nextId, { at: elapsed + ms, run });
      return handle(nextId);
    },
    clearTimeout(h) {
      timers.delete(idOf(h));
    },
    setInterval(run, ms) {
      timers.set(++nextId, { at: elapsed + ms, run, every: ms });
      return handle(nextId);
    },
    clearInterval(h) {
      timers.delete(idOf(h));
    },
  };
  return {
    env,
    document,
    now: () => NOW + elapsed,
    pending: () => timers.size,
    /** Moves the clock, running each timer that comes due, in order. */
    advance(ms: number) {
      const end = elapsed + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        const [id, timer] = due;
        elapsed = timer.at;
        if (timer.every) timer.at += timer.every;
        else timers.delete(id);
        timer.run();
      }
      elapsed = end;
    },
  };
}

/** Waits (in real time) until `check` holds. */
async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(check()).toBe(true);
}

async function setup(transport: SyncTransport, { paired = true } = {}) {
  const db = freshDb();
  const fake = fakeEnv();
  const repo = await openRepository(db, { now: fake.now });
  if (paired) {
    await setMeta(db, "serverUrl", "https://budgee.example");
    await setMeta(db, "deviceToken", "token");
    await setMeta(db, "vaultKey", await generateVaultKey());
  }
  const statuses: SyncStatus[] = [];
  const announced: string[] = [];
  let created = 0;
  let locked = 0;
  const inflight = new Set<Promise<unknown>>();
  const platform = {
    createSyncTransport: () => {
      created++;
      return transport;
    },
  } as unknown as Platform;
  const controller = createSyncController({
    db,
    repo,
    platform,
    now: fake.now,
    report: (status) => statuses.push(status),
    announce: (text) => announced.push(text),
    lock: (task) => {
      locked++;
      const run = task();
      inflight.add(run);
      void run.finally(() => inflight.delete(run));
      return run;
    },
    env: fake.env,
  });
  /** Waits for the runs in flight to finish. */
  const idle = async () => {
    await new Promise((r) => setTimeout(r, 1));
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  return {
    db,
    repo,
    fake,
    controller,
    statuses,
    announced,
    idle,
    created: () => created,
    locked: () => locked,
  };
}

describe("one run", () => {
  test("does nothing but say so while not paired", async () => {
    const { transport, calls } = fakeTransport();
    const { controller, statuses, created } = await setup(transport, { paired: false });
    await controller.syncNow();
    expect(statuses).toEqual([{ kind: "not_paired" }]);
    expect(created()).toBe(0);
    expect(calls).toEqual([]);
  });

  test("reports syncing, then synced, and remembers when", async () => {
    const { transport } = fakeTransport();
    const { db, controller, statuses, locked } = await setup(transport);
    await controller.syncNow();
    expect(statuses).toEqual([
      { kind: "syncing", lastSyncAt: undefined },
      { kind: "synced", at: NOW },
    ]);
    expect(await getMeta(db, "lastSyncAt")).toBe(NOW);
    expect(locked()).toBe(1);
  });

  test("runs one sync at a time, with at most one more queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { transport, runs } = fakeTransport();
    const slow = {
      ...transport,
      health: async () => {
        await gate;
        return transport.health();
      },
    };
    const { controller } = await setup(slow);
    const all = [controller.syncNow(), controller.syncNow(), controller.syncNow()];
    release();
    await Promise.all(all);
    expect(runs()).toBe(2);
  });

  test("a request made as soon as a run ends starts another", async () => {
    const { transport, runs } = fakeTransport();
    const { controller } = await setup(transport);
    await controller.syncNow();
    await controller.syncNow();
    expect(runs()).toBe(2);
  });

  test("offline keeps the last sync time", async () => {
    const { transport } = fakeTransport({
      health: () => Promise.reject(new SyncError("offline", "GET /health failed")),
    });
    const { db, controller, statuses } = await setup(transport);
    await setMeta(db, "lastSyncAt", NOW - MIN);
    await controller.syncNow();
    expect(statuses.at(-1)).toEqual({ kind: "offline", lastSyncAt: NOW - MIN });
  });

  test("an error carries its kind for the indicator", async () => {
    const { transport } = fakeTransport({
      pull: () => Promise.reject(new SyncError("server", "GET /sync/pull answered 500")),
    });
    const { controller, statuses } = await setup(transport);
    await controller.syncNow();
    expect(statuses.at(-1)).toMatchObject({ kind: "error", error: { kind: "server" } });
  });

  test("a revoked device stops sending requests with that token", async () => {
    const { transport, calls } = fakeTransport({
      pull: () => Promise.reject(new SyncError("device_revoked", "revoked")),
    });
    const { controller, statuses } = await setup(transport);
    await controller.syncNow();
    expect(statuses.at(-1)).toEqual({ kind: "revoked" });
    const before = calls.length;
    await controller.syncNow();
    expect(calls).toHaveLength(before);
    expect(statuses.at(-1)).toEqual({ kind: "revoked" });
  });

  test("a sync the user asked for shows Syncing… at least MIN_SYNCING_MS", async () => {
    const { transport } = fakeTransport();
    const { controller, statuses, fake } = await setup(transport);
    let done = false;
    const run = controller.syncNow({ manual: true }).then(() => {
      done = true;
    });
    await until(() => fake.pending() > 0); // the run finished and waits out the minimum
    expect(statuses.at(-1)?.kind).toBe("syncing");
    fake.advance(MIN_SYNCING_MS - 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    fake.advance(1);
    await run;
    expect(statuses.at(-1)?.kind).toBe("synced");
  });
});

describe("triggers", () => {
  test("runs on start (app open)", async () => {
    const { transport, runs } = fakeTransport();
    const { controller, idle } = await setup(transport);
    controller.start();
    await idle();
    expect(runs()).toBe(1);
  });

  test("3 seconds after the last edit; each edit restarts the wait", async () => {
    const { transport, runs } = fakeTransport();
    const { controller, repo, fake, idle } = await setup(transport);
    controller.start();
    await idle();
    await repo.put("transactions", expense);
    fake.advance(EDIT_DEBOUNCE_MS - 1000);
    await repo.put("transactions", expense);
    fake.advance(EDIT_DEBOUNCE_MS - 1000);
    await idle();
    expect(runs()).toBe(1); // the first edit's timer was replaced
    fake.advance(1000);
    await idle();
    expect(runs()).toBe(2);
  });

  test("every 5 minutes, but only while the app is visible", async () => {
    const { transport, runs } = fakeTransport();
    const { controller, fake, idle } = await setup(transport);
    controller.start();
    await idle();
    fake.document.visibilityState = "hidden";
    fake.advance(SYNC_INTERVAL_MS);
    await idle();
    expect(runs()).toBe(1);
    fake.document.visibilityState = "visible";
    fake.advance(SYNC_INTERVAL_MS);
    await idle();
    expect(runs()).toBe(2);
  });

  test("coming back into view syncs at once only when a run is due", async () => {
    const { transport, runs } = fakeTransport();
    const { controller, fake, idle } = await setup(transport);
    controller.start();
    await idle();
    const show = () => {
      fake.document.visibilityState = "visible";
      fake.document.dispatchEvent(new Event("visibilitychange"));
    };
    fake.document.visibilityState = "hidden";
    fake.advance(MIN);
    show();
    await idle();
    expect(runs()).toBe(1); // a minute away: not due
    fake.document.visibilityState = "hidden";
    fake.advance(SYNC_INTERVAL_MS); // the interval passes while hidden
    show();
    await idle();
    expect(runs()).toBe(2);
  });

  test("online syncs; offline says so at once, keeping the last sync time", async () => {
    const { transport, runs } = fakeTransport();
    const { controller, fake, idle, statuses, announced } = await setup(transport);
    controller.start();
    await idle();
    fake.env.window.dispatchEvent(new Event("offline"));
    await until(() => statuses.at(-1)?.kind === "offline");
    expect(statuses.at(-1)).toEqual({ kind: "offline", lastSyncAt: NOW });
    expect(announced).toEqual(["Offline. Changes stay on this device until it is back online."]);
    fake.env.window.dispatchEvent(new Event("online"));
    await idle();
    expect(runs()).toBe(2);
    expect(statuses.at(-1)?.kind).toBe("synced");
    expect(announced.at(-1)).toBe("Back online. Synced.");
  });

  test("the cleanup from start() removes every listener and timer", async () => {
    const { transport, runs } = fakeTransport();
    const { controller, repo, fake, idle } = await setup(transport);
    const stop = controller.start();
    await idle();
    await repo.put("transactions", expense); // a debounce pending
    expect(fake.pending()).toBe(2);
    stop();
    expect(fake.pending()).toBe(0);
    fake.env.window.dispatchEvent(new Event("online"));
    fake.document.dispatchEvent(new Event("visibilitychange"));
    await repo.put("transactions", expense);
    fake.advance(2 * SYNC_INTERVAL_MS);
    await idle();
    expect(runs()).toBe(1);
  });
});

describe("createLock", () => {
  test("holds the budgee-sync Web Lock around each run", async () => {
    const names: string[] = [];
    const locks = {
      request: (name: string, task: () => Promise<unknown>) => {
        names.push(name);
        return task();
      },
    } as unknown as LockManager;
    expect(await createLock(locks)(async () => 42)).toBe(42);
    expect(names).toEqual([LOCK_NAME]);
  });

  test("without the Web Locks API, runs the task directly", async () => {
    expect(await createLock(undefined)(async () => "ran")).toBe("ran");
  });
});

describe("announcements", () => {
  const synced: SyncStatus = { kind: "synced", at: NOW };
  const offline: SyncStatus = { kind: "offline", lastSyncAt: NOW };
  const failed = (kind: "server" | "decrypt"): SyncStatus => ({
    kind: "error",
    error: { kind, message: "x" },
    lastSyncAt: undefined,
  });

  test("a background sync that changes nothing is quiet; one the user asked for is not", () => {
    expect(announcementFor(synced, synced, false)).toBeUndefined();
    expect(announcementFor(undefined, synced, false)).toBeUndefined();
    expect(announcementFor(synced, synced, true)).toBe("Synced.");
  });

  test("going offline and back, failures and removal", () => {
    expect(announcementFor(undefined, offline, false)).toBeUndefined(); // app opened offline
    expect(announcementFor(synced, offline, false)).toContain("Offline.");
    expect(announcementFor(offline, offline, false)).toBeUndefined();
    expect(announcementFor(offline, synced, false)).toBe("Back online. Synced.");
    expect(announcementFor(synced, failed("server"), false)).toContain("Sync failed.");
    expect(announcementFor(failed("server"), failed("server"), false)).toBeUndefined();
    expect(announcementFor(failed("server"), failed("decrypt"), false)).toContain("Sync failed.");
    expect(announcementFor(failed("server"), synced, false)).toBe("Synced.");
    expect(announcementFor(synced, { kind: "revoked" }, false)).toContain("removed");
    expect(announcementFor({ kind: "revoked" }, { kind: "revoked" }, false)).toBeUndefined();
  });

  test("the controller announces a manual sync finishing, not the relative-time ticks", async () => {
    const { transport } = fakeTransport();
    const { controller, announced, fake } = await setup(transport);
    await controller.syncNow();
    expect(announced).toEqual([]);
    const run = controller.syncNow({ manual: true });
    await until(() => fake.pending() > 0);
    fake.advance(MIN_SYNCING_MS);
    await run;
    expect(announced).toEqual(["Synced."]);
  });
});

describe("describeSync", () => {
  test("synced: the pill says how long ago, the action says it in full (Main.dc.html)", () => {
    const view = describeSync({ kind: "synced", at: NOW - 3 * MIN }, NOW, "en");
    expect(view).toMatchObject({
      canSync: true,
      dot: "on",
      short: "3 min ago",
      label: "Synced 3 min ago",
      action: "Sync now. Synced 3 minutes ago",
    });
    expect(describeSync({ kind: "synced", at: NOW - 20_000 }, NOW, "en").label).toBe(
      "Synced just now",
    );
    expect(describeSync({ kind: "synced", at: NOW - 125 * MIN }, NOW, "en").short).toBe("2 h ago");
  });

  test("syncing keeps Sync now in the accessible name", () => {
    expect(describeSync({ kind: "syncing", lastSyncAt: undefined }, NOW, "en")).toMatchObject({
      short: "Syncing…",
      syncing: true,
      action: "Sync now. Syncing…",
    });
  });

  test("offline, failed, removed and not paired", () => {
    expect(describeSync({ kind: "offline", lastSyncAt: NOW - 5 * MIN }, NOW, "en")).toMatchObject({
      short: "Offline",
      dot: "off",
      note: "Last synced 5 minutes ago",
      action: "Sync now. Offline. Last synced 5 minutes ago",
    });
    const failed = describeSync(
      {
        kind: "error",
        error: { kind: "row_too_large", message: "x", table: "transactions", id: "abc" },
        lastSyncAt: undefined,
      },
      NOW,
      "en",
    );
    expect(failed).toMatchObject({ short: "Sync failed", dot: "error", canSync: true });
    expect(failed.note).toContain("(transactions abc)");
    expect(failed.action.startsWith("Sync now. Sync failed. ")).toBe(true);
    expect(describeSync({ kind: "revoked" }, NOW, "en")).toMatchObject({
      short: "Removed",
      canSync: false,
    });
    expect(describeSync({ kind: "not_paired" }, NOW, "en")).toMatchObject({
      short: "Not paired",
      canSync: false,
      dot: "off",
    });
  });
});

describe("exclusive", () => {
  test("waits for the run in flight, then runs the task holding the sync lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const { transport } = fakeTransport({
      async pull({ since }) {
        order.push("pull started");
        await gate;
        order.push("pull done");
        return { envelopes: [], nextSeq: since, hasMore: false, resetRequired: false };
      },
    });
    const { controller, locked, idle } = await setup(transport);
    const run = controller.syncNow();
    await until(() => order.includes("pull started"));
    const lockedBefore = locked();
    const task = controller.exclusive(async () => {
      order.push("task");
      return 7;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["pull started"]);
    release();
    expect(await task).toBe(7);
    await run;
    await idle();
    expect(order).toEqual(["pull started", "pull done", "task"]);
    expect(locked()).toBe(lockedBefore + 1);
  });
});
