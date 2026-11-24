import { describe, expect, test } from "bun:test";
import { SETTING_IDS } from "@budgee/core";
import { openRepository } from "../src/db/repository";
import { seedDefaults } from "../src/db/seed";
import { readSettings } from "../src/db/settings";
import { freshDb } from "./helpers";

describe("readSettings", () => {
  test("falls back to the defaults on an empty table", async () => {
    expect(await readSettings(freshDb())).toEqual({
      currency: "DZD",
      decimals: 0,
      locale: "en",
      theme: "system",
      dashboard: {
        period: "month",
        compare: "same_period_last_year",
        exclude: { categories: [], tags: [] },
      },
    });
  });

  test("reads stored values, and defaults for a deleted row", async () => {
    const db = freshDb();
    await seedDefaults(db);
    const repo = await openRepository(db);
    await repo.setSetting("theme", "dark");
    await repo.setSetting("decimals", 2);
    await repo.setSetting("currency", "EUR");
    await repo.remove("settings", SETTING_IDS.currency);
    expect(await readSettings(db)).toMatchObject({ theme: "dark", decimals: 2, currency: "DZD" });
  });
});
