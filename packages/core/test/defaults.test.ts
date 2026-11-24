import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_CHART_CONFIGS,
  DEFAULT_SETTINGS,
  GALLERY_PRESETS,
  SEED_DEVICE,
  SEED_HLC,
} from "../src/defaults";
import { createClock, parseHlc } from "../src/hlc";
import { shouldApply } from "../src/merge";
import {
  categoryFieldsSchema,
  chartConfigFieldsSchema,
  chartConfigSchema,
  SETTING_IDS,
  settingFieldsSchema,
} from "../src/schema";

const uuid = v.pipe(v.string(), v.uuid());
const fields = <T extends { id: string }>(row: T) => {
  const { id: _id, ...rest } = row;
  return rest;
};

describe("default lists", () => {
  test("categories per the spec, in order", () => {
    const names = (type: string) =>
      DEFAULT_CATEGORIES.filter((c) => c.type === type).map((c) => c.name);
    expect(names("expense")).toEqual([
      "Groceries",
      "Transport",
      "Bills",
      "Home",
      "Going out",
      "Clothing",
      "Shopping",
      "Medical",
      "Gifts",
      "Fees",
      "Misc",
    ]);
    expect(names("income")).toEqual(["Salary", "Freelance", "Gifts received"]);
    expect(DEFAULT_CATEGORIES.every((c) => !c.archived)).toBe(true);
    for (const c of DEFAULT_CATEGORIES) v.parse(categoryFieldsSchema, fields(c));
  });

  test("income category ids do not depend on the length of the expense list", () => {
    expect(DEFAULT_CATEGORIES[0]?.id).toBe("00000000-0000-4000-8000-000100000001");
    expect(DEFAULT_CATEGORIES.filter((c) => c.type === "income").map((c) => c.id)).toEqual([
      "00000000-0000-4000-8000-000100000101",
      "00000000-0000-4000-8000-000100000102",
      "00000000-0000-4000-8000-000100000103",
    ]);
  });

  test("settings: one per key, valid, with the fixed setting ids", () => {
    expect(Object.fromEntries(DEFAULT_SETTINGS.map((s) => [s.key, s.value]))).toEqual({
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
    for (const s of DEFAULT_SETTINGS) {
      expect(s.id).toBe(SETTING_IDS[s.key]);
      v.parse(settingFieldsSchema, fields(s));
    }
  });

  test("every default row has a distinct, stable UUID", () => {
    const ids = [...DEFAULT_CATEGORIES, ...DEFAULT_SETTINGS, ...DEFAULT_CHART_CONFIGS].map(
      (r) => r.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(v.is(uuid, id)).toBe(true);
  });
});

describe("default dashboard charts", () => {
  test("the four charts from the spec, in order", () => {
    expect(DEFAULT_CHART_CONFIGS.map((c) => [c.sort, c.name])).toEqual([
      [0, "Expenses, this year vs last year"],
      [1, "By category vs last year"],
      [2, "Kept of income"],
      [3, "Year by year"],
    ]);
    const pick = (i: number) => {
      const c = DEFAULT_CHART_CONFIGS[i]?.config;
      return c && [c.kind, c.metric, c.groupBy, c.period, c.compare];
    };
    expect(pick(0)).toEqual(["line", "expenses", "month", "this_year", "same_period_last_year"]);
    expect(pick(1)).toEqual(["bar", "expenses", "category", "dashboard", "same_period_last_year"]);
    expect(pick(2)).toEqual(["line", "kept_ratio", "month", "last_12_months", "none"]);
    expect(pick(3)?.slice(0, 1)).toEqual(["table"]);
    expect([pick(3)?.[2], pick(3)?.[3]]).toEqual(["year", "all_time"]);
  });

  test("only Year by year opts out of the dashboard's exclusions (it shows all entries)", () => {
    expect(DEFAULT_CHART_CONFIGS.map((c) => c.config.useDashboardExclusions)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  test("each validates against the ChartConfig schema unchanged", () => {
    for (const row of DEFAULT_CHART_CONFIGS) {
      v.parse(chartConfigFieldsSchema, fields(row));
      expect(v.parse(chartConfigSchema, row.config)).toEqual(row.config);
    }
  });
});

describe("Add-chart gallery presets", () => {
  test("the eight templates, in gallery order", () => {
    expect(GALLERY_PRESETS.map((p) => p.name)).toEqual([
      "Month pace",
      "By tag",
      "Trip total",
      "Biggest changes",
      "Top details",
      "By weekday",
      "Spending calendar",
      "Income sources",
    ]);
    const keys = GALLERY_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("each validates against the ChartConfig schema unchanged", () => {
    for (const preset of GALLERY_PRESETS) {
      expect(v.parse(chartConfigSchema, preset.config)).toEqual(preset.config);
    }
  });

  test("Month pace is a cumulative daily line against the usual month", () => {
    const pace = GALLERY_PRESETS.find((p) => p.key === "month_pace")?.config;
    expect(pace).toMatchObject({
      kind: "line",
      metric: "expenses",
      groupBy: "day",
      period: "dashboard",
      compare: "avg_12_months",
      cumulative: true,
    });
  });

  test("By tag is a 12-month expense bar by tag that ignores dashboard exclusions", () => {
    const byTag = GALLERY_PRESETS.find((p) => p.key === "by_tag")?.config;
    expect(byTag).toMatchObject({
      kind: "bar",
      metric: "expenses",
      groupBy: "tag",
      period: "last_12_months",
      useDashboardExclusions: false,
    });
  });

  test("Trip total ignores dashboard exclusions, which usually leave the trip out", () => {
    const trip = GALLERY_PRESETS.find((p) => p.key === "trip_total")?.config;
    expect(trip).toMatchObject({ groupBy: "category", useDashboardExclusions: false });
  });

  test("Income sources counts income", () => {
    expect(GALLERY_PRESETS.find((p) => p.key === "income_sources")?.config.metric).toBe("income");
  });
});

describe("seed clock", () => {
  test("is a valid hlc from the seed device, at wall time 0 and counter 0", () => {
    expect(SEED_HLC).toBe("000000000000000:00000:seed");
    expect(parseHlc(SEED_HLC)).toEqual({ wall: 0, counter: 0, device: SEED_DEVICE });
  });

  test("loses to any edit stamped by a clock, even one reading wall time 0", () => {
    expect(createClock("z", () => 0).tick() > SEED_HLC).toBe(true);
    expect(createClock("A", () => 1).tick() > SEED_HLC).toBe(true);
  });

  test("two devices seeding the same defaults hold equal hlcs, so neither applies", () => {
    const seeded = { hlc: SEED_HLC };
    expect(shouldApply(seeded, { hlc: SEED_HLC })).toBe(false);
  });
});
