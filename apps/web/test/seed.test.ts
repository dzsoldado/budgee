import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_CHART_CONFIGS,
  DEFAULT_SETTINGS,
  SEED_DEVICE,
  SEED_HLC,
  SETTING_IDS,
} from "@budgee/core";
import { getMeta } from "../src/db/db";
import { openRepository } from "../src/db/repository";
import { seedDefaults } from "../src/db/seed";
import { freshDb } from "./helpers";

describe("seedDefaults", () => {
  test("adds every default row with the seed hlc, not dirty", async () => {
    const db = freshDb();
    expect(await seedDefaults(db)).toBe(true);
    const sets = [
      [db.categories, DEFAULT_CATEGORIES],
      [db.settings, DEFAULT_SETTINGS],
      [db.chart_configs, DEFAULT_CHART_CONFIGS],
    ] as const;
    for (const [table, defaults] of sets) {
      expect(await table.count()).toBe(defaults.length);
      for (const d of defaults) {
        expect(await table.get(d.id)).toEqual({
          ...d,
          hlc: SEED_HLC,
          device: SEED_DEVICE,
          deleted: false,
          dirty: 0,
        } as never);
      }
      expect(await table.where("dirty").equals(1).count()).toBe(0);
    }
  });

  test("keeps rows that already exist, live or deleted", async () => {
    const db = freshDb();
    const repo = await openRepository(db);
    await repo.setSetting("theme", "dark");
    const second = DEFAULT_CATEGORIES[1];
    if (!second) throw new Error("no second default");
    await db.categories.put({
      ...second,
      hlc: SEED_HLC,
      device: SEED_DEVICE,
      deleted: false,
      dirty: 0,
    });
    await repo.remove("categories", second.id);
    await seedDefaults(db);
    expect(await db.settings.get(SETTING_IDS.theme)).toMatchObject({ value: "dark", dirty: 1 });
    expect(await db.categories.get(second.id)).toMatchObject({ deleted: true, dirty: 1 });
    expect(await db.settings.get(SETTING_IDS.currency)).toMatchObject({ hlc: SEED_HLC });
  });

  test("runs once: a default removed later is not seeded again", async () => {
    const db = freshDb();
    expect(await seedDefaults(db)).toBe(true);
    expect(await getMeta(db, "seeded")).toBe(true);
    const first = DEFAULT_CATEGORIES[0];
    if (!first) throw new Error("no first default");
    await db.categories.delete(first.id); // e.g. a tombstone purged after sync
    expect(await seedDefaults(db)).toBe(false);
    expect(await db.categories.get(first.id)).toBeUndefined();
  });

  describe("a default changed since an earlier version", () => {
    const yearByYear = DEFAULT_CHART_CONFIGS[3];
    if (!yearByYear) throw new Error("no Year by year default");
    /** The row as an earlier version seeded it: Year by year followed the dashboard's exclusions. */
    const oldSeed = {
      ...yearByYear,
      config: { ...yearByYear.config, useDashboardExclusions: true },
      hlc: SEED_HLC,
      device: SEED_DEVICE,
      deleted: false,
      dirty: 0,
    } as const;

    test("a row still at the seed hlc takes the new default, keeping the seed hlc", async () => {
      const db = freshDb();
      await seedDefaults(db);
      await db.chart_configs.put(oldSeed);
      expect(await seedDefaults(db)).toBe(false);
      expect(await db.chart_configs.get(yearByYear.id)).toEqual({
        ...yearByYear,
        hlc: SEED_HLC,
        device: SEED_DEVICE,
        deleted: false,
        dirty: 0,
      } as never);
    });

    test("an edited row is never touched", async () => {
      const db = freshDb();
      await seedDefaults(db);
      await db.chart_configs.put(oldSeed);
      const repo = await openRepository(db);
      await repo.update("chart_configs", yearByYear.id, { name: "Years" });
      const edited = await db.chart_configs.get(yearByYear.id);
      await seedDefaults(db);
      expect(await db.chart_configs.get(yearByYear.id)).toEqual(edited as never);
      expect(edited).toMatchObject({ name: "Years", dirty: 1 });
      expect(edited?.deleted === false && edited.config.useDashboardExclusions).toBe(true);
    });

    test("a deleted default stays deleted", async () => {
      const db = freshDb();
      await seedDefaults(db);
      await db.chart_configs.put(oldSeed);
      const repo = await openRepository(db);
      await repo.remove("chart_configs", yearByYear.id);
      await seedDefaults(db);
      expect(await db.chart_configs.get(yearByYear.id)).toMatchObject({ deleted: true });
    });
  });

  test("a second run writes nothing", async () => {
    const db = freshDb();
    await seedDefaults(db);
    let writes = 0;
    for (const table of [db.categories, db.settings, db.chart_configs]) {
      table.hook("creating", () => {
        writes += 1;
      });
      table.hook("updating", () => {
        writes += 1;
      });
    }
    expect(await seedDefaults(db)).toBe(false);
    expect(writes).toBe(0);
  });

  test("a real edit of a seeded row wins by hlc, even at wall time 0", async () => {
    const db = freshDb();
    await seedDefaults(db);
    const repo = await openRepository(db, { now: () => 0 });
    const row = await repo.setSetting("currency", "EUR");
    expect(row.hlc > SEED_HLC).toBe(true);
  });
});
