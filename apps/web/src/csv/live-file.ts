// The local CSV file (spec "Local CSV file"): on desktop Chrome and Edge the user picks a file
// once (File System Access API) and it is rewritten after every change and sync, debounced.
// The handle is kept in IndexedDB; after a restart the browser wants access confirmed again
// (paused until the user allows it). Android browsers don't have the API, so it is hidden there.
import { createSignal } from "solid-js";
import type { LocalChange, Repository } from "../db/repository";
import { isAndroid } from "./export";

/** The part of a FileSystemWritableFileStream used here. */
export interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

/** The part of a FileSystemFileHandle used here, permission calls included. */
export interface LiveFileHandle {
  readonly name: string;
  queryPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
  createWritable(): Promise<WritableLike>;
}

/** Where the chosen handle is kept (shared by every tab). */
export interface HandleStore {
  load(): Promise<LiveFileHandle | undefined>;
  save(handle: LiveFileHandle): Promise<void>;
  clear(): Promise<void>;
}

/**
 * `paused`: the browser needs access confirmed again (after a restart). `failed`: the last
 * write failed for another reason (e.g. the file is locked by another app).
 */
export type LiveFileState =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "on"; name: string; writtenAt: number | undefined }
  | { kind: "paused"; name: string }
  | { kind: "failed"; name: string };

type Handle = ReturnType<typeof setTimeout>;

export interface LiveFileOptions {
  store: HandleStore;
  /** The whole file's text, read when a write starts. */
  content: () => Promise<string>;
  /** Calls `listener` after each change to the data; returns a function that unsubscribes. */
  subscribe: (listener: () => void) => () => void;
  debounceMs?: number;
  now?: () => number;
  timers?: {
    setTimeout(callback: () => void, ms: number): Handle;
    clearTimeout(handle: Handle | undefined): void;
  };
}

export interface LiveFile {
  state(): LiveFileState;
  /** Subscribes to changes and reads the stored handle; writes once when access is still granted. */
  start(): Promise<void>;
  /** Uses a file the user just picked: kept, then written at once. */
  use(handle: LiveFileHandle): Promise<void>;
  /** Asks the browser for access again (needs a user gesture); true once granted and written. */
  allow(): Promise<boolean>;
  /** Writes again after a failure. */
  retry(): Promise<void>;
  /** Forgets the file; it keeps its last contents. */
  stop(): Promise<void>;
  /** Writes a pending change now. */
  flush(): Promise<void>;
  /** Resolves once no write is running or queued. */
  idle(): Promise<void>;
  dispose(): void;
}

export const LIVE_FILE_DEBOUNCE_MS = 2000;
/** Failed writes in a row after which changes stop trying again until Try again. */
export const MAX_FAILED_WRITES = 5;

const READ_WRITE = { mode: "readwrite" } as const;

/** Errors that mean "no access": ask again rather than report a failure. */
const isAccessError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "NotAllowedError" || error.name === "SecurityError");

export function createLiveFile(options: LiveFileOptions): LiveFile {
  const { store, content, subscribe } = options;
  const debounceMs = options.debounceMs ?? LIVE_FILE_DEBOUNCE_MS;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: Handle | undefined) => clearTimeout(handle),
  };
  const [state, setState] = createSignal<LiveFileState>({ kind: "loading" });

  /** The handle in use, for asking access again. */
  let current: LiveFileHandle | undefined;
  /** A change not written yet. */
  let pending = false;
  /** Writes failed in a row (not for lack of access); a success resets it. */
  let failures = 0;
  let timer: Handle | undefined;
  let running: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;

  const cancelTimer = () => {
    timers.clearTimeout(timer);
    timer = undefined;
  };

  /** Writing is wanted: the file is on, or failed and being tried again. */
  const active = () => state().kind === "on" || state().kind === "failed";

  /** Writes the whole file once, if a change is pending and the file is on (or failed). */
  const writeOnce = async () => {
    if (!pending || !active()) return;
    // The store is the truth: another tab may have stopped or replaced the file.
    const handle = await store.load().catch(() => undefined);
    if (!handle) {
      current = undefined;
      pending = false;
      setState({ kind: "off" });
      return;
    }
    current = handle;
    pending = false;
    try {
      const text = await content();
      const writable = await handle.createWritable();
      try {
        await writable.write(text);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => {});
        throw error;
      }
      if (current === handle && active()) {
        failures = 0;
        setState({ kind: "on", name: handle.name, writtenAt: now() });
      }
    } catch (error) {
      if (current !== handle || !active()) return;
      pending = true;
      console.error("Writing the CSV file failed", error);
      if (isAccessError(error)) {
        failures = 0;
        setState({ kind: "paused", name: handle.name });
      } else {
        failures++;
        setState({ kind: "failed", name: handle.name });
      }
    }
  };

  /** Queues a write behind any running one. */
  const run = () => {
    running = running.then(writeOnce);
    return running;
  };

  /**
   * After a change: a write debounceMs later. While failed, a change tries again, waiting twice
   * as long after each failure, up to MAX_FAILED_WRITES failures in a row; then only Try again
   * writes. The state stays failed until a write succeeds.
   */
  const schedule = () => {
    pending = true;
    const kind = state().kind;
    if (kind !== "on" && (kind !== "failed" || failures >= MAX_FAILED_WRITES)) return;
    const delay = kind === "failed" ? debounceMs * 2 ** (failures - 1) : debounceMs;
    cancelTimer();
    timer = timers.setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
  };

  const writeNow = () => {
    cancelTimer();
    pending = true;
    return run();
  };

  return {
    state,

    async start() {
      unsubscribe ??= subscribe(schedule);
      let handle: LiveFileHandle | undefined;
      try {
        handle = await store.load();
      } catch (error) {
        console.error("Reading the CSV file choice failed", error);
      }
      if (!handle) {
        setState({ kind: "off" });
        return;
      }
      current = handle;
      failures = 0;
      const permission = await handle.queryPermission(READ_WRITE).catch(() => "prompt");
      if (permission === "granted") {
        setState({ kind: "on", name: handle.name, writtenAt: undefined });
        // Catch up on anything that changed while the app was closed (e.g. pulled at open).
        await writeNow();
      } else {
        pending = true;
        setState({ kind: "paused", name: handle.name });
      }
    },

    async use(handle) {
      await store.save(handle);
      current = handle;
      failures = 0;
      setState({ kind: "on", name: handle.name, writtenAt: undefined });
      await writeNow();
    },

    async allow() {
      const handle = current;
      if (!handle) return false;
      let permission: PermissionState;
      try {
        permission = await handle.requestPermission(READ_WRITE);
      } catch (error) {
        console.error("Asking for access to the CSV file failed", error);
        return false;
      }
      if (permission !== "granted" || current !== handle) return false;
      failures = 0;
      setState({ kind: "on", name: handle.name, writtenAt: undefined });
      await writeNow();
      return state().kind === "on";
    },

    async retry() {
      if (!current || state().kind !== "failed") return;
      failures = 0;
      await writeNow();
    },

    async stop() {
      cancelTimer();
      current = undefined;
      pending = false;
      failures = 0;
      setState({ kind: "off" });
      await store.clear();
    },

    flush() {
      if (!pending) return running;
      return active() ? writeNow() : running;
    },

    async idle() {
      let last: Promise<void>;
      do {
        last = running;
        await last;
      } while (last !== running);
    },

    dispose() {
      cancelTimer();
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/** The File System Access save picker, on desktop only (never on Android). */
export function isLiveFileSupported(
  win: { showSaveFilePicker?: unknown } = window as never,
  userAgent: string = navigator.userAgent,
): boolean {
  return typeof win.showSaveFilePicker === "function" && !isAndroid(userAgent);
}

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<LiveFileHandle>;

/** Opens the save picker (needs a user gesture); undefined when the user closes it. */
export async function pickLiveFile(suggestedName: string, description: string) {
  const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker;
  try {
    return await picker({
      suggestedName,
      types: [{ description, accept: { "text/csv": [".csv"] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return undefined;
    throw error;
  }
}

/**
 * Subscribes to changes to the entries, made here or pulled by a sync (or a restore): what the
 * live file holds. Other tables (settings, charts…) are left out.
 */
export function entryChanges(repo: Pick<Repository, "onLocalWrite" | "onRemoteChange">) {
  return (listener: () => void) => {
    const onChanges = (changes: readonly LocalChange[]) => {
      if (changes.some((change) => change.table === "transactions")) listener();
    };
    const stopLocal = repo.onLocalWrite(onChanges);
    const stopRemote = repo.onRemoteChange(onChanges);
    return () => {
      stopLocal();
      stopRemote();
    };
  };
}
