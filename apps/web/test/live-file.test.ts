import { describe, expect, test } from "bun:test";
import { DEFAULT_CHART_CONFIGS } from "@budgee/core";
import {
  createLiveFile,
  entryChanges,
  type HandleStore,
  isLiveFileSupported,
  type LiveFileHandle,
  type LiveFileOptions,
  MAX_FAILED_WRITES,
} from "../src/csv/live-file";
import { openRepository } from "../src/db/repository";
import { expense, freshDb } from "./helpers";

type Permission = "granted" | "prompt" | "denied";

/** A file handle whose permission and writes the test controls. */
function fakeHandle(name = "budgee.csv", permission: Permission = "granted") {
  const handle = {
    name,
    permission,
    /** What a requestPermission call turns the permission into. */
    answer: "granted" as Permission,
    contents: undefined as string | undefined,
    writes: 0,
    /** Makes the next writes fail with this error. */
    failWith: undefined as Error | undefined,
    requests: 0,
    async queryPermission() {
      return handle.permission;
    },
    async requestPermission() {
      handle.requests++;
      handle.permission = handle.answer;
      return handle.permission;
    },
    async createWritable() {
      if (handle.permission !== "granted") throw new DOMException("no access", "NotAllowedError");
      let draft = "";
      return {
        async write(data: string) {
          if (handle.failWith) throw handle.failWith;
          draft += data;
        },
        async close() {
          handle.contents = draft;
          handle.writes++;
        },
        async abort() {},
      };
    },
  };
  return handle;
}

function memoryStore(
  initial?: LiveFileHandle,
): HandleStore & { saved: LiveFileHandle | undefined } {
  const store = {
    saved: initial,
    async load() {
      return store.saved;
    },
    async save(handle: LiveFileHandle) {
      store.saved = handle;
    },
    async clear() {
      store.saved = undefined;
    },
  };
  return store;
}

/** Timers run by hand: `tick(ms)` fires those due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id: ReturnType<typeof setTimeout> | undefined) => {
      timers.delete(id as unknown as number);
    },
    now: () => now,
    tick(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

function setup(store: HandleStore, extra: Partial<LiveFileOptions> = {}) {
  const timers = fakeTimers();
  let version = 0;
  const listeners = new Set<() => void>();
  const live = createLiveFile({
    store,
    content: async () => `rows v${version}`,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    debounceMs: 2000,
    timers,
    now: timers.now,
    ...extra,
  });
  const change = () => {
    version++;
    for (const listener of listeners) listener();
  };
  return { live, timers, change, listeners };
}

const quiet = async <T>(fn: () => Promise<T>) => {
  const error = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
};

describe("choosing a file", () => {
  test("is off until a file is chosen; choosing writes it at once and keeps the handle", async () => {
    const store = memoryStore();
    const { live } = setup(store);
    await live.start();
    expect(live.state()).toEqual({ kind: "off" });
    const handle = fakeHandle();
    await live.use(handle);
    expect(store.saved).toBe(handle);
    expect(handle.contents).toBe("rows v0");
    expect(live.state()).toEqual({ kind: "on", name: "budgee.csv", writtenAt: 0 });
  });

  test("stop forgets the file and writes no more", async () => {
    const store = memoryStore();
    const { live, timers, change } = setup(store);
    await live.start();
    const handle = fakeHandle();
    await live.use(handle);
    await live.stop();
    expect(store.saved).toBeUndefined();
    expect(live.state()).toEqual({ kind: "off" });
    change();
    timers.tick(5000);
    await live.idle();
    expect(handle.writes).toBe(1);
  });
});

describe("rewriting after changes (debounced)", () => {
  test("a burst of changes is written once, debounceMs after the last", async () => {
    const handle = fakeHandle();
    const { live, timers, change } = setup(memoryStore(handle));
    await live.start();
    await live.idle();
    expect(handle.writes).toBe(1); // the catch-up write on start

    change();
    timers.tick(1500);
    change();
    timers.tick(1500);
    change();
    timers.tick(1999);
    await live.idle();
    expect(handle.writes).toBe(1);
    timers.tick(1);
    await live.idle();
    expect(handle.writes).toBe(2);
    expect(handle.contents).toBe("rows v3");
    expect(live.state()).toEqual({ kind: "on", name: "budgee.csv", writtenAt: 5000 });
  });

  test("a change during a write leads to one more write with the newer rows", async () => {
    const handle = fakeHandle();
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { live, timers, change } = setup(memoryStore(handle), {
      content: async () => {
        calls++;
        if (calls === 2) await slow;
        return `rows ${calls}`;
      },
    });
    await live.start();
    await live.idle();
    change();
    timers.tick(2000); // the second write starts, reads its rows, and waits on `slow`
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    change();
    timers.tick(2000); // queued behind it
    release();
    await live.idle();
    expect(handle.writes).toBe(3);
    expect(handle.contents).toBe("rows 3");
  });

  test("flush writes a pending change now", async () => {
    const handle = fakeHandle();
    const { live, timers, change } = setup(memoryStore(handle));
    await live.start();
    await live.idle();
    change();
    await live.flush();
    expect(handle.writes).toBe(2);
    expect(timers.pending()).toBe(0);
  });
});

describe("permission", () => {
  test("after a restart the browser asks again: paused until allowed, then written", async () => {
    const handle = fakeHandle("budgee.csv", "prompt");
    const { live, timers, change } = setup(memoryStore(handle));
    await live.start();
    expect(live.state()).toEqual({ kind: "paused", name: "budgee.csv" });
    change();
    timers.tick(5000);
    await live.idle();
    expect(handle.writes).toBe(0);

    expect(await live.allow()).toBe(true);
    expect(handle.requests).toBe(1);
    expect(handle.writes).toBe(1);
    expect(handle.contents).toBe("rows v1");
    expect(live.state()).toMatchObject({ kind: "on" });
  });

  test("allow answered no stays paused", async () => {
    const handle = fakeHandle("budgee.csv", "prompt");
    handle.answer = "denied";
    const { live } = setup(memoryStore(handle));
    await live.start();
    expect(await live.allow()).toBe(false);
    expect(live.state()).toEqual({ kind: "paused", name: "budgee.csv" });
    expect(handle.writes).toBe(0);
  });

  test("a request without a user gesture (throws) stays paused", async () => {
    const handle = fakeHandle("budgee.csv", "prompt");
    handle.requestPermission = async () => {
      throw new DOMException("needs a gesture", "SecurityError");
    };
    const { live } = setup(memoryStore(handle));
    await live.start();
    expect(await quiet(() => live.allow())).toBe(false);
    expect(live.state()).toEqual({ kind: "paused", name: "budgee.csv" });
  });

  test("access lost while running pauses; allowing again writes the change it missed", async () => {
    const handle = fakeHandle();
    const { live, timers, change } = setup(memoryStore(handle));
    await live.start();
    await live.idle();
    handle.permission = "prompt";
    change();
    timers.tick(2000);
    await quiet(() => live.idle());
    expect(live.state()).toEqual({ kind: "paused", name: "budgee.csv" });
    expect(await live.allow()).toBe(true);
    expect(handle.contents).toBe("rows v1");
  });
});

describe("write failures", () => {
  test("another failure shows failed; retry writes again", async () => {
    const handle = fakeHandle();
    const { live, timers, change } = setup(memoryStore(handle));
    await live.start();
    await live.idle();
    handle.failWith = new DOMException("locked", "NoModificationAllowedError");
    change();
    timers.tick(2000);
    await quiet(() => live.idle());
    expect(live.state()).toEqual({ kind: "failed", name: "budgee.csv" });
    expect(handle.contents).toBe("rows v0"); // the file kept its last good contents

    handle.failWith = undefined;
    await live.retry();
    expect(handle.contents).toBe("rows v1");
    expect(live.state()).toMatchObject({ kind: "on" });
  });

  test("a file stopped in another tab: this tab stops writing too", async () => {
    const handle = fakeHandle();
    const store = memoryStore(handle);
    const { live, timers, change } = setup(store);
    await live.start();
    await live.idle();
    store.saved = undefined;
    change();
    timers.tick(2000);
    await live.idle();
    expect(handle.writes).toBe(1);
    expect(live.state()).toEqual({ kind: "off" });
  });

  test("a stored handle that can't be read starts off", async () => {
    const store = memoryStore();
    store.load = async () => {
      throw new Error("unreadable");
    };
    const { live } = setup(store);
    await quiet(() => live.start());
    expect(live.state()).toEqual({ kind: "off" });
  });
});

describe("support", () => {
  const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131";
  test("only where the save picker exists, never on Android", () => {
    const picker = () => undefined;
    expect(isLiveFileSupported({ showSaveFilePicker: picker }, desktop)).toBe(true);
    expect(isLiveFileSupported({}, desktop)).toBe(false);
    expect(
      isLiveFileSupported({ showSaveFilePicker: picker }, "Mozilla/5.0 (Linux; Android 14) Chrome"),
    ).toBe(false);
  });
});

describe("changes while failed", () => {
  async function failing() {
    const handle = fakeHandle();
    const setup1 = setup(memoryStore(handle));
    await setup1.live.start();
    await setup1.live.idle();
    handle.failWith = new DOMException("locked", "NoModificationAllowedError");
    setup1.change();
    setup1.timers.tick(2000);
    await quiet(() => setup1.live.idle());
    expect(setup1.live.state()).toEqual({ kind: "failed", name: "budgee.csv" });
    return { handle, ...setup1 };
  }

  test("a change while failed tries again after the debounce; success turns it back on", async () => {
    const { handle, live, timers, change } = await failing();
    handle.failWith = undefined;
    change();
    timers.tick(1999);
    await live.idle();
    expect(handle.contents).toBe("rows v0");
    expect(live.state()).toMatchObject({ kind: "failed" });
    timers.tick(1);
    await live.idle();
    expect(handle.contents).toBe("rows v2");
    expect(live.state()).toMatchObject({ kind: "on" });
  });

  test("each failure doubles the wait; the state stays failed meanwhile", async () => {
    const { handle, live, timers, change } = await failing();
    // Second failure: the change after it waits 2 × the debounce.
    change();
    timers.tick(2000);
    await quiet(() => live.idle());
    expect(live.state()).toMatchObject({ kind: "failed" });
    handle.failWith = undefined;
    change();
    timers.tick(3999);
    await live.idle();
    expect(handle.contents).toBe("rows v0");
    timers.tick(1);
    await live.idle();
    expect(handle.contents).toBe("rows v3");
  });

  test(`after ${MAX_FAILED_WRITES} failures in a row only Try again writes`, async () => {
    const { handle, live, timers, change } = await failing();
    for (let failures = 1; failures < MAX_FAILED_WRITES; failures++) {
      change();
      timers.tick(2000 * 2 ** (failures - 1));
      await quiet(() => live.idle());
    }
    const writesBefore = handle.writes;
    handle.failWith = undefined;
    change();
    timers.tick(10 * 60 * 1000);
    await live.idle();
    expect(timers.pending()).toBe(0);
    expect(handle.writes).toBe(writesBefore);
    expect(live.state()).toMatchObject({ kind: "failed" });
    await live.retry();
    expect(handle.contents).toBe(`rows v${MAX_FAILED_WRITES + 1}`);
    expect(live.state()).toMatchObject({ kind: "on" });
  });
});

describe("entryChanges", () => {
  test("only changes to entries, local or pulled, reach the listener", async () => {
    const repo = await openRepository(freshDb());
    let heard = 0;
    const stop = entryChanges(repo)(() => {
      heard++;
    });
    await repo.setSetting("theme", "dark");
    await repo.put("chart_configs", {
      name: "Pace",
      sort: 9,
      config: DEFAULT_CHART_CONFIGS[0]?.config as never,
    });
    expect(heard).toBe(0);
    const entry = await repo.put("transactions", expense);
    expect(heard).toBe(1);
    await repo.applyRemote({
      rows: [
        {
          table: "transactions",
          row: { ...entry, detail: "pulled", hlc: "009000000000000:00000:otherdevice1" },
        },
      ],
      clock: undefined,
      since: 1,
    } as never);
    expect(heard).toBe(2);
    stop();
    await repo.put("transactions", expense);
    expect(heard).toBe(2);
  });
});
