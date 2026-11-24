// When and how this device syncs (spec "When clients sync"): on app open, when the browser
// comes back online, every 5 minutes while the app is visible, 3 seconds after the last local
// edit, and on "sync now". One run at a time per tab, and one per device across tabs through
// the Web Locks API where the browser has it. Only paired devices sync.
import { runSync, type SyncFailure, type SyncResult } from "@budgee/core";
import { type BudgeeDb, getMeta, setMeta } from "../db/db";
import type { Repository } from "../db/repository";
import type { Platform } from "../platform/types";
import {
  announcementFor,
  announce as announceText,
  type SyncStatus,
  setSyncStatus,
} from "./status";
import { createDexieSyncStore } from "./store";

export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const EDIT_DEBOUNCE_MS = 3000;
/** A sync the user asked for shows "Syncing…" at least this long, so it can be seen. */
export const MIN_SYNCING_MS = 600;
export const LOCK_NAME = "budgee-sync";

export interface SyncController {
  /**
   * Starts a run now, or one more right after the current run. Resolves when done. `manual`:
   * the user asked (sync now), so the result is announced and "Syncing…" stays readable.
   */
  syncNow(options?: { manual?: boolean }): Promise<void>;
  /** Hooks up the triggers and runs once (app open). Returns a function that unhooks them. */
  start(): () => void;
  /**
   * Runs `task` once no sync is running here, holding the sync lock (so none starts in any tab
   * meanwhile): for changing the pairing, which a run reads.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
}

type Handle = ReturnType<typeof setTimeout>;

/** What the triggers listen to and schedule with; the browser's by default. */
export interface SyncEnvironment {
  /** Fires `online` and `offline`. */
  window: EventTarget;
  /** Fires `visibilitychange`. */
  document: EventTarget & { readonly visibilityState: DocumentVisibilityState };
  setTimeout(callback: () => void, ms: number): Handle;
  clearTimeout(handle: Handle | undefined): void;
  setInterval(callback: () => void, ms: number): Handle;
  clearInterval(handle: Handle | undefined): void;
}

export type SyncLock = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Runs each task holding the `budgee-sync` Web Lock, so tabs sync one after another (a tab waits
 * rather than skips: the other tab's push may predate edits made here). Without the API, runs
 * the task directly; the per-tab single flight still holds.
 */
export function createLock(locks: LockManager | undefined): SyncLock {
  return (task) => (locks ? locks.request(LOCK_NAME, task) : task());
}

export interface SyncControllerOptions {
  db: BudgeeDb;
  repo: Repository;
  platform: Platform;
  now?: () => number;
  /** Where the status goes; the app's status signal by default. */
  report?: (status: SyncStatus) => void;
  /** Where screen reader announcements go; the app's live region by default. */
  announce?: (text: string) => void;
  lock?: SyncLock;
  /** Events and timers; only `start()` needs `window` and `document`. */
  env?: Partial<SyncEnvironment>;
}

/** The pairing a sync needs, or undefined while this device is not paired. */
export async function readPairing(db: BudgeeDb) {
  const [serverUrl, deviceToken, vaultKey] = await Promise.all([
    getMeta(db, "serverUrl"),
    getMeta(db, "deviceToken"),
    getMeta(db, "vaultKey"),
  ]);
  if (!serverUrl || !deviceToken || !vaultKey) return undefined;
  return { serverUrl, deviceToken, vaultKey };
}

const internalError = (error: unknown): SyncFailure => ({
  kind: "internal",
  message: error instanceof Error ? error.message : String(error),
});

export function createSyncController({
  db,
  repo,
  platform,
  now = Date.now,
  report = setSyncStatus,
  announce = announceText,
  lock = createLock(typeof navigator === "undefined" ? undefined : navigator.locks),
  env = {},
}: SyncControllerOptions): SyncController {
  const timers = {
    setTimeout: env.setTimeout ?? ((callback, ms) => setTimeout(callback, ms)),
    clearTimeout: env.clearTimeout ?? ((handle) => clearTimeout(handle)),
    setInterval: env.setInterval ?? ((callback, ms) => setInterval(callback, ms)),
    clearInterval: env.clearInterval ?? ((handle) => clearInterval(handle)),
  } satisfies Partial<SyncEnvironment>;
  const store = createDexieSyncStore(db, repo);
  let running: Promise<void> | undefined;
  let again = false;
  let manualPending = false;
  /** The token the server revoked: no request goes out with it again (pairing anew gives another). */
  let revokedToken: string | undefined;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  /** The last status other than "syncing", to tell transitions worth announcing. */
  let settled: SyncStatus | undefined;

  /** Reports a final status and announces it when it is a change worth hearing. */
  function settle(status: SyncStatus, manual: boolean) {
    report(status);
    const text = announcementFor(settled, status, manual);
    if (text) announce(text);
    settled = status;
  }

  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      timers.setTimeout(resolve, ms);
    });

  async function runOnce(manual: boolean): Promise<void> {
    const started = now();
    lastAttempt = started;
    const pairing = await readPairing(db);
    if (!pairing) {
      settle({ kind: "not_paired" }, manual);
      return;
    }
    if (pairing.deviceToken === revokedToken) {
      settle({ kind: "revoked" }, manual);
      return;
    }
    const lastSyncAt = await getMeta(db, "lastSyncAt");
    report({ kind: "syncing", lastSyncAt });

    let result: SyncResult;
    try {
      const transport = platform.createSyncTransport(pairing);
      result = await runSync({ transport, store, key: pairing.vaultKey, now });
    } catch (error) {
      // A bad stored server URL, for one; runSync itself reports rather than throws.
      const failure = internalError(error);
      result = {
        status: "error",
        pushed: 0,
        pulled: 0,
        applied: 0,
        reset: false,
        serverChanged: false,
        error: failure,
      };
    }
    if (manual) {
      const left = MIN_SYNCING_MS - (now() - started);
      if (left > 0) await delay(left);
    }

    if (result.status === "synced") {
      const at = now();
      await setMeta(db, "lastSyncAt", at);
      settle({ kind: "synced", at }, manual);
    } else if (result.status === "offline") {
      settle({ kind: "offline", lastSyncAt }, manual);
    } else if (result.error?.kind === "device_revoked") {
      revokedToken = pairing.deviceToken;
      settle({ kind: "revoked" }, manual);
    } else if (result.error) {
      if (import.meta.env.DEV) console.warn("Sync failed", result.error);
      settle({ kind: "error", error: result.error, lastSyncAt }, manual);
    }
  }

  function syncNow({ manual = false } = {}): Promise<void> {
    if (manual) manualPending = true;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          const asked = manualPending;
          manualPending = false;
          await lock(() => runOnce(asked));
        } while (again);
      } catch (error) {
        // Local storage failed around the run; say so rather than spin on "Syncing…".
        console.error("Sync run failed", error);
        settle({ kind: "error", error: internalError(error), lastSyncAt: undefined }, true);
      } finally {
        // Cleared here, not in a later `.finally`, so a request made right now starts a run.
        running = undefined;
      }
    })();
    return running;
  }

  function start(): () => void {
    const win = env.window ?? window;
    const doc = env.document ?? document;
    const cleanups: (() => void)[] = [];
    const listen = (target: EventTarget, type: string, handler: () => void) => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };
    const visible = () => doc.visibilityState === "visible";

    void syncNow();

    listen(win, "online", () => void syncNow());
    listen(win, "offline", () => {
      if (running) return; // the run in flight finds out and reports it
      void (async () => {
        const pairing = await readPairing(db);
        if (pairing && pairing.deviceToken !== revokedToken) {
          settle({ kind: "offline", lastSyncAt: await getMeta(db, "lastSyncAt") }, false);
        }
      })();
    });

    // Every 5 minutes while visible; on coming back, at once if a run is due.
    const interval = timers.setInterval(() => {
      if (visible()) void syncNow();
    }, SYNC_INTERVAL_MS);
    cleanups.push(() => timers.clearInterval(interval));
    listen(doc, "visibilitychange", () => {
      if (visible() && now() - lastAttempt >= SYNC_INTERVAL_MS) void syncNow();
    });

    // 3 seconds after the last edit.
    let debounce: Handle | undefined;
    const stopWatching = repo.onLocalWrite(() => {
      timers.clearTimeout(debounce);
      debounce = timers.setTimeout(() => void syncNow(), EDIT_DEBOUNCE_MS);
    });
    cleanups.push(() => {
      stopWatching();
      timers.clearTimeout(debounce);
    });

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }

  async function exclusive<T>(task: () => Promise<T>): Promise<T> {
    while (running) await running;
    // No await between the check and the request: a run asked for now queues behind the task.
    return lock(task);
  }

  return { syncNow, start, exclusive };
}
