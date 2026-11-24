import { describe, expect, test } from "bun:test";
import {
  DEVICE_ID_PATTERN,
  InvalidRowError,
  type LiveTransaction,
  parseHlc,
  SETTING_IDS,
} from "@budgee/core";
import { getMeta } from "../src/db/db";
import { type LocalChange, openRepository } from "../src/db/repository";
import { expense, fakeNow, freshDb } from "./helpers";

describe("device id", () => {
  test("is generated once, kept in meta, and fits the hlc device-id pattern", async () => {
    const db = freshDb();
    const first = await openRepository(db);
    const second = await openRepository(db);
    expect(first.deviceId).toBe(second.deviceId);
    expect(await getMeta(db, "deviceId")).toBe(first.deviceId);
    expect(first.deviceId).toMatch(DEVICE_ID_PATTERN);
    expect(first.deviceId).toMatch(/^[0-9a-z]{12}$/);
  });

  test("differs between installs", async () => {
    const a = await openRepository(freshDb());
    const b = await openRepository(freshDb());
    expect(a.deviceId).not.toBe(b.deviceId);
  });
});

describe("put", () => {
  test("stamps a new row with an id, the clock's hlc, this device and dirty", async () => {
    const db = freshDb();
    const repo = await openRepository(db, { now: () => 1_763_370_000_000 });
    const row = await repo.put("transactions", expense);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(parseHlc(row.hlc)).toEqual({
      wall: 1_763_370_000_000,
      counter: 0,
      device: repo.deviceId,
    });
    expect(row.device).toBe(repo.deviceId);
    expect(row.deleted).toBe(false);
    expect(await db.transactions.get(row.id)).toEqual({ ...row, dirty: 1 });
  });

  test("fills schema defaults (detail, note, tags, original pair)", async () => {
    const repo = await openRepository(freshDb());
    const { detail: _detail, ...bare } = expense;
    const row = await repo.put("transactions", bare);
    expect(row).toMatchObject({
      detail: "",
      note: "",
      tags: [],
      original_amount: null,
      original_currency: null,
    });
  });

  test("replaces a row by id with a newer hlc", async () => {
    const db = freshDb();
    const repo = await openRepository(db, { now: fakeNow(1_000).now });
    const first = await repo.put("transactions", expense);
    const second = await repo.put("transactions", { ...expense, amount: 500 }, first.id);
    expect(second.id).toBe(first.id);
    expect(second.hlc > first.hlc).toBe(true);
    expect(await db.transactions.get(first.id)).toMatchObject({ amount: 500 });
    expect(await db.transactions.count()).toBe(1);
  });

  test("rejects invalid fields with InvalidRowError and writes nothing", async () => {
    const db = freshDb();
    const repo = await openRepository(db);
    // Every entry needs a category; amounts are positive.
    await expect(repo.put("transactions", { ...expense, category: "" })).rejects.toBeInstanceOf(
      InvalidRowError,
    );
    await expect(repo.put("transactions", { ...expense, amount: 0 })).rejects.toBeInstanceOf(
      InvalidRowError,
    );
    expect(await db.transactions.count()).toBe(0);
  });

  test("settings rows always use the key's fixed id", async () => {
    const db = freshDb();
    const repo = await openRepository(db);
    const row = await repo.setSetting("theme", "dark");
    expect(row.id).toBe(SETTING_IDS.theme);
    expect(await db.settings.get(SETTING_IDS.theme)).toMatchObject({
      key: "theme",
      value: "dark",
      dirty: 1,
    });
  });
});

describe("update", () => {
  test("merges a patch into the live row and restamps it", async () => {
    const clock = fakeNow(1_000);
    const repo = await openRepository(freshDb(), { now: clock.now });
    const row = await repo.put("transactions", expense);
    clock.set(2_000);
    const updated = await repo.update("transactions", row.id, { detail: "Lidl" });
    expect(updated).toMatchObject({ ...expense, detail: "Lidl", id: row.id });
    expect(parseHlc(updated.hlc).wall).toBe(2_000);
  });

  test("refuses a missing or deleted row", async () => {
    const repo = await openRepository(freshDb());
    await expect(repo.update("transactions", crypto.randomUUID(), { detail: "x" })).rejects.toThrow(
      /not found/,
    );
    const row = await repo.put("transactions", expense);
    await repo.remove("transactions", row.id);
    await expect(repo.update("transactions", row.id, { detail: "x" })).rejects.toThrow(/not found/);
  });
});

describe("remove", () => {
  test("leaves a dirty tombstone holding only the sync columns", async () => {
    const db = freshDb();
    const repo = await openRepository(db, { now: fakeNow(1_000).now });
    const row = await repo.put("transactions", expense);
    await repo.remove("transactions", row.id);
    const stored = await db.transactions.get(row.id);
    expect(stored).toEqual({
      id: row.id,
      hlc: expect.any(String),
      device: repo.deviceId,
      deleted: true,
      dirty: 1,
    });
    expect((stored?.hlc ?? "") > row.hlc).toBe(true);
  });

  test("does nothing for a missing or already deleted row", async () => {
    const db = freshDb();
    const repo = await openRepository(db);
    const heard: unknown[] = [];
    repo.onLocalWrite((changes) => heard.push(changes));
    await repo.remove("transactions", crypto.randomUUID());
    expect(await db.transactions.count()).toBe(0);
    expect(heard).toEqual([]);
  });
});

describe("clock", () => {
  test("hlcs only grow, even when the wall clock steps back", async () => {
    const clock = fakeNow(5_000);
    const repo = await openRepository(freshDb(), { now: clock.now });
    const a = await repo.put("transactions", expense);
    clock.set(1_000);
    const b = await repo.put("transactions", expense);
    expect(b.hlc > a.hlc).toBe(true);
  });

  test("is persisted in meta and restored on the next start", async () => {
    const db = freshDb();
    const clock = fakeNow(9_000);
    const before = await openRepository(db, { now: clock.now });
    const last = await before.put("transactions", expense);
    expect(await getMeta(db, "hlc")).toBe(last.hlc);
    clock.set(1_000); // e.g. the device clock was ahead, then corrected
    const after = await openRepository(db, { now: clock.now });
    const next = await after.put("transactions", expense);
    expect(next.hlc > last.hlc).toBe(true);
  });
});

describe("clock shared by tabs (two repositories on one database)", () => {
  test("a tab whose wall clock is behind still stamps after the other tab's edit", async () => {
    const db = freshDb();
    const a = await openRepository(db, { now: () => 5_000 });
    const b = await openRepository(db, { now: () => 1_000 });
    const fromA = await a.put("transactions", expense);
    const fromB = await b.put("transactions", expense);
    expect(fromB.hlc > fromA.hlc).toBe(true);
    expect(await getMeta(db, "hlc")).toBe(fromB.hlc);
  });

  test("interleaved writes at the same wall time keep growing, and meta never goes back", async () => {
    const db = freshDb();
    const a = await openRepository(db, { now: () => 5_000 });
    const b = await openRepository(db, { now: () => 5_000 });
    const stamps: string[] = [];
    for (const repo of [a, a, a, b, a, b, b, a]) {
      stamps.push((await repo.put("transactions", expense)).hlc);
      expect(await getMeta(db, "hlc")).toBe(stamps.at(-1));
    }
    expect([...stamps].sort()).toEqual(stamps);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  test("tombstones follow the shared clock too", async () => {
    const db = freshDb();
    const a = await openRepository(db, { now: () => 9_000 });
    const b = await openRepository(db, { now: () => 1_000 });
    const row = await a.put("transactions", expense);
    await b.remove("transactions", row.id);
    expect(((await db.transactions.get(row.id))?.hlc ?? "") > row.hlc).toBe(true);
  });
});

describe("write (one transaction)", () => {
  test("applies every change or none", async () => {
    const db = freshDb();
    const repo = await openRepository(db);
    const kept = await repo.put("transactions", expense);
    const failing = repo.write(async (w) => {
      await w.update("transactions", kept.id, { detail: "renamed" });
      await w.put("transactions", { ...expense, amount: -1 });
    });
    await expect(failing).rejects.toBeInstanceOf(InvalidRowError);
    expect(await db.transactions.get(kept.id)).toMatchObject({ detail: "Carrefour" });
    expect(await db.transactions.count()).toBe(1);
  });

  test("tells onLocalWrite listeners once per committed write, with every change", async () => {
    const repo = await openRepository(freshDb());
    const calls: LocalChange[][] = [];
    const stop = repo.onLocalWrite((changes) => calls.push([...changes]));
    const a = await repo.put("transactions", expense);
    await repo.write(async (w) => {
      await w.update("transactions", a.id, { detail: "x" });
      await w.put("categories", { type: "expense", name: "Travel", sort: 11, archived: false });
      await w.remove("transactions", a.id);
    });
    await repo
      .write(async (w) => {
        await w.put("transactions", { ...expense, amount: 0 });
      })
      .catch(() => {});
    stop();
    await repo.put("transactions", expense);
    expect(calls.map((c) => c.map((x) => x.table))).toEqual([
      ["transactions"],
      ["transactions", "categories", "transactions"],
    ]);
    expect(calls[1]?.[0]?.id).toBe(a.id);
  });

  test("merge writes a row with its own hlc and device when it beats the local one", async () => {
    const db = freshDb();
    const clock = fakeNow(1_763_370_000_000);
    const repo = await openRepository(db, { now: clock.now });
    const calls: LocalChange[][] = [];
    repo.onLocalWrite((changes) => calls.push([...changes]));
    const local = await repo.put("transactions", expense);
    const newer: LiveTransaction = {
      ...expense,
      detail: "from a file",
      tags: [],
      note: "",
      original_amount: null,
      original_currency: null,
      id: local.id,
      hlc: "001763370500000:00002:otherdevice1",
      device: "otherdevice1",
      deleted: false,
    };
    const older = { ...newer, detail: "old", hlc: "001763300000000:00000:otherdevice1" };
    const fresh = { ...newer, id: "0b7c1e2a-5d3f-4c8e-9a1b-000000000009", detail: "new here" };
    const written = await repo.write(async (w) => [
      await w.merge("transactions", older),
      await w.merge("transactions", newer),
      await w.merge("transactions", fresh),
    ]);
    expect(written).toEqual([false, true, true]);
    expect(await db.transactions.get(local.id)).toEqual({ ...newer, dirty: 1 });
    expect(await db.transactions.get(fresh.id)).toMatchObject({ detail: "new here", dirty: 1 });
    expect(calls[1]?.map((c) => c.id)).toEqual([local.id, fresh.id]);
    // The clock moved past the merged hlc, so the next edit wins over it.
    const after = await repo.update("transactions", local.id, { detail: "edited" });
    expect(after.hlc > newer.hlc).toBe(true);
    expect(await getMeta(db, "hlc")).toBe(after.hlc);
  });

  test("merge caps how far a row's future hlc moves the clock", async () => {
    const db = freshDb();
    const now = 1_763_370_000_000;
    const repo = await openRepository(db, { now: () => now });
    const far: LiveTransaction = {
      ...expense,
      tags: [],
      detail: "",
      note: "",
      original_amount: null,
      original_currency: null,
      id: "0b7c1e2a-5d3f-4c8e-9a1b-00000000000a",
      hlc: "009999999999999:00000:otherdevice1",
      device: "otherdevice1",
      deleted: false,
    };
    await repo.write((w) => w.merge("transactions", far));
    expect(parseHlc((await getMeta(db, "hlc")) ?? "").wall).toBe(now + 24 * 60 * 60 * 1000);
  });

  test("a throwing listener does not break the write or other listeners", async () => {
    const repo = await openRepository(freshDb());
    let heard = 0;
    const originalError = console.error;
    console.error = () => {};
    try {
      repo.onLocalWrite(() => {
        throw new Error("boom");
      });
      repo.onLocalWrite(() => {
        heard += 1;
      });
      await repo.put("transactions", expense);
    } finally {
      console.error = originalError;
    }
    expect(heard).toBe(1);
  });
});
