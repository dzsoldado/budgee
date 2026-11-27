import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  type ChartData,
  comparisonWindows,
  computeChart,
  computeKpis,
  type DashboardContext,
  dataStart,
  filterTransactions,
  resolvePeriod,
  type SeriesChart,
  type TableChart,
} from "../src/dashboard";
import { DEFAULT_CHART_CONFIGS, GALLERY_PRESETS } from "../src/defaults";
import {
  type ChartConfig,
  chartConfigSchema,
  type DashboardSettings,
  type LiveTransaction,
  type Tombstone,
  type TransactionRow,
} from "../src/schema";

// ─── Fixture ────────────────────────────────────────────────────────────────
// "Today" is 2026-11-17 (a Tuesday). Amounts are written in units and stored in hundredths.

const TODAY = "2026-11-17";
const HLC = "001763000000000:00000:dev-a";
let n = 0;

function tx(
  date: string,
  type: "income" | "expense",
  units: number,
  category: string,
  extra: Partial<LiveTransaction> = {},
): LiveTransaction {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    hlc: HLC,
    deleted: false,
    device: "dev-a",
    type,
    amount: units * 100,
    date,
    category,
    detail: "",
    note: "",
    tags: [],
    original_amount: null,
    original_currency: null,
    created_at: `${date}T10:00:00.000Z`,
    ...extra,
  };
}
const income = (date: string, units: number, cat: string, extra?: Partial<LiveTransaction>) =>
  tx(date, "income", units, cat, extra);
const expense = (date: string, units: number, cat: string, extra?: Partial<LiveTransaction>) =>
  tx(date, "expense", units, cat, extra);

const tombstone: Tombstone = {
  id: "00000000-0000-4000-8000-999999999999",
  hlc: HLC,
  deleted: true,
  device: "dev-a",
};

const FIXTURE: TransactionRow[] = [
  // November 2026, up to today
  income("2026-11-01", 85000, "Salary"),
  expense("2026-11-02", 4500, "Medical", { detail: "dentist" }),
  expense("2026-11-03", 2350, "Groceries", { detail: "Carrefour" }),
  // Paid EUR 120.00; only the 18 000 DZD amount counts.
  expense("2026-11-05", 18000, "Home", {
    detail: "IKEA desk chair",
    original_amount: 12000,
    original_currency: "EUR",
  }),
  expense("2026-11-10", 650, "Transport", { detail: "Taxi" }),
  income("2026-11-12", 25000, "Freelance", { detail: "Logo project" }),
  expense("2026-11-20", 999, "Groceries"), // after today: not counted yet
  // October 2026
  income("2026-10-01", 85000, "Salary"),
  expense("2026-10-15", 4180, "Bills"),
  expense("2026-10-20", 2000, "Groceries"),
  // Istanbul trip, August 2026 (tags spelled with different case)
  expense("2026-08-12", 2808, "Transport", {
    detail: "ferry",
    tags: ["Istanbul 2026"],
    original_amount: 72000,
    original_currency: "TRY",
  }),
  expense("2026-08-13", 1500, "Eating out", {
    tags: ["istanbul 2026", "Food"],
  }),
  // November 2025
  income("2025-11-01", 80000, "Salary"),
  expense("2025-11-04", 5600, "Groceries"),
  expense("2025-11-10", 500, "Medical"),
  expense("2025-11-15", 700, "Clothes"),
  expense("2025-11-25", 3900, "Bills"), // after the 17th: outside "same days last year"
  // 2024
  income("2024-03-10", 70000, "Salary"),
  expense("2024-03-11", 4000, "Groceries"),
  expense("2024-12-01", 3000, "Bills"), // after 17 Nov: outside the year-by-year window
  tombstone,
];

const NO_EXCLUSIONS = { categories: [], tags: [] };
const dashboard = (overrides: Partial<DashboardSettings> = {}): DashboardSettings => ({
  period: "month",
  compare: "same_period_last_year",
  exclude: NO_EXCLUSIONS,
  ...overrides,
});
const ctx = (overrides: Partial<DashboardSettings> = {}, ref?: string): DashboardContext => ({
  today: TODAY,
  dashboard: dashboard(overrides),
  ...(ref === undefined ? {} : { ref }),
});

function chart(fields: Partial<ChartConfig> = {}): ChartConfig {
  return {
    kind: "bar",
    metric: "expenses",
    groupBy: "category",
    period: "dashboard",
    compare: "none",
    cumulative: false,
    onlyTags: [],
    exclude: NO_EXCLUSIONS,
    useDashboardExclusions: true,
    ...fields,
  };
}

function asSeries(data: ChartData): SeriesChart {
  if (data.shape !== "series") throw new Error("expected a series chart");
  return data;
}
function asTable(data: ChartData): TableChart {
  if (data.shape !== "table") throw new Error("expected a table");
  return data;
}
const current = (data: SeriesChart) => {
  const s = data.series.find((x) => x.role === "current");
  if (!s) throw new Error("no current series");
  return s;
};
const compared = (data: SeriesChart) => {
  const s = data.series.find((x) => x.role === "compare");
  if (!s) throw new Error("no compare series");
  return s;
};
/** label → value of a series. */
const byLabel = (data: SeriesChart, values: readonly (number | null)[]) =>
  Object.fromEntries(data.labels.map((label, i) => [label, values[i]]));

const defaultChart = (name: string) => {
  const found = DEFAULT_CHART_CONFIGS.find((c) => c.name === name);
  if (!found) throw new Error(`no default chart ${name}`);
  return found.config;
};
const preset = (key: string) => {
  const found = GALLERY_PRESETS.find((p) => p.key === key);
  if (!found) throw new Error(`no preset ${key}`);
  return found.config;
};

const months2026 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);

// ─── Periods and comparison windows ─────────────────────────────────────────

describe("periods", () => {
  test("the month view of the current month runs to today and is partial", () => {
    expect(resolvePeriod("dashboard", ctx())).toEqual({
      start: "2026-11-01",
      end: "2026-11-17",
      fullEnd: "2026-11-30",
      partial: true,
      months: 1,
    });
  });

  test("the year view runs from 1 January to today", () => {
    expect(resolvePeriod("dashboard", ctx({ period: "year" }))).toEqual({
      start: "2026-01-01",
      end: "2026-11-17",
      fullEnd: "2026-12-31",
      partial: true,
      months: 12,
    });
  });

  test("a past month picked in the dashboard is complete", () => {
    expect(resolvePeriod("dashboard", ctx({}, "2026-10-09"))).toEqual({
      start: "2026-10-01",
      end: "2026-10-31",
      fullEnd: "2026-10-31",
      partial: false,
      months: 1,
    });
  });

  test("a dashboard month after today shows the current month, never an inverted window", () => {
    expect(resolvePeriod("dashboard", ctx({}, "2027-03-05"))).toEqual(
      resolvePeriod("dashboard", ctx()),
    );
    const kpis = computeKpis(FIXTURE, ctx({}, "2027-03-05"));
    expect(kpis.window).toEqual({ start: "2026-11-01", end: "2026-11-17" });
    expect(kpis.compareWindows).toEqual([{ start: "2025-11-01", end: "2025-11-17" }]);
  });

  test("the last day of a month is not partial", () => {
    const period = resolvePeriod("dashboard", { ...ctx(), today: "2026-02-28" });
    expect(period).toMatchObject({ start: "2026-02-01", end: "2026-02-28", partial: false });
  });

  test("last_12_months covers 12 calendar months including the current one", () => {
    expect(resolvePeriod("last_12_months", ctx())).toEqual({
      start: "2025-12-01",
      end: "2026-11-17",
      fullEnd: "2026-11-30",
      partial: true,
      months: 12,
    });
  });

  test("this_year ignores the dashboard view", () => {
    expect(resolvePeriod("this_year", ctx({ period: "month" }, "2026-03-03"))).toEqual({
      start: "2026-01-01",
      end: "2026-11-17",
      fullEnd: "2026-12-31",
      partial: true,
      months: 12,
    });
  });

  test("all_time starts at the earliest entry and has no previous period", () => {
    expect(resolvePeriod("all_time", ctx(), "2024-03-10")).toEqual({
      start: "2024-03-10",
      end: "2026-11-17",
      fullEnd: "2026-11-17",
      partial: false,
      months: null,
    });
  });
});

describe("a chosen month or year", () => {
  test("a month period shows the month it names, whatever the dashboard shows", () => {
    expect(resolvePeriod("month", ctx({ period: "year" }), undefined, "2025-02")).toEqual({
      start: "2025-02-01",
      end: "2025-02-28",
      fullEnd: "2025-02-28",
      partial: false,
      months: 1,
    });
  });

  test("a year period shows the year of its month", () => {
    expect(resolvePeriod("year", ctx(), undefined, "2024-07")).toEqual({
      start: "2024-01-01",
      end: "2024-12-31",
      fullEnd: "2024-12-31",
      partial: false,
      months: 12,
    });
  });

  test("the current month or year runs to today; a later or missing one is today's", () => {
    const current = {
      start: "2026-11-01",
      end: "2026-11-17",
      fullEnd: "2026-11-30",
      partial: true,
      months: 1,
    };
    expect(resolvePeriod("month", ctx(), undefined, "2026-11")).toEqual(current);
    expect(resolvePeriod("month", ctx(), undefined, "2027-01")).toEqual(current);
    expect(resolvePeriod("month", ctx())).toEqual(current);
    expect(resolvePeriod("year", ctx(), undefined, "2028-01")).toMatchObject({
      start: "2026-01-01",
      end: "2026-11-17",
    });
  });

  test("a chart on a chosen month counts that month and compares with the one before", () => {
    const data = computeChart(
      chart({
        kind: "bar",
        groupBy: "category",
        period: "month",
        periodRef: "2026-10",
        compare: "previous_period",
      }),
      FIXTURE,
      ctx(),
    );
    expect(data.window).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(data.shape === "series" && data.compareWindows).toEqual([
      { start: "2026-09-01", end: "2026-09-30" },
    ]);
  });

  test("the schema takes a YYYY-MM month and nothing else", () => {
    const parse = (periodRef: string) =>
      v.safeParse(chartConfigSchema, { ...chart({ period: "month" }), periodRef }).success;
    expect(parse("2025-02")).toBe(true);
    expect(parse("2025-13")).toBe(false);
    expect(parse("2025")).toBe(false);
    expect(parse("2025-02-01")).toBe(false);
  });
});

describe("comparison windows", () => {
  const nov = { start: "2026-11-01", end: "2026-11-17" };

  test("a partial month is compared with the same days (1–17 Nov 2026 vs 1–17 Nov 2025)", () => {
    expect(comparisonWindows(nov, 1, "same_period_last_year", false)).toEqual([
      { start: "2025-11-01", end: "2025-11-17", monthsBack: 12 },
    ]);
    expect(comparisonWindows(nov, 1, "previous_period", false)).toEqual([
      { start: "2026-10-01", end: "2026-10-17", monthsBack: 1 },
    ]);
  });

  test("a partial year is compared with the same days last year", () => {
    const ytd = { start: "2026-01-01", end: "2026-11-17" };
    expect(comparisonWindows(ytd, 12, "previous_period", false)).toEqual([
      { start: "2025-01-01", end: "2025-11-17", monthsBack: 12 },
    ]);
  });

  test("the 12-month average uses the same days in each of the 12 previous months", () => {
    const windows = comparisonWindows(nov, 1, "avg_12_months", false);
    expect(windows).toHaveLength(12);
    expect(windows[0]).toEqual({ start: "2026-10-01", end: "2026-10-17", monthsBack: 1 });
    expect(windows[11]).toEqual({ start: "2025-11-01", end: "2025-11-17", monthsBack: 12 });
  });

  test("a full month is compared with the full previous month", () => {
    expect(
      comparisonWindows({ start: "2026-10-01", end: "2026-10-31" }, 1, "previous_period", true),
    ).toEqual([{ start: "2026-09-01", end: "2026-09-30", monthsBack: 1 }]);
    expect(
      comparisonWindows({ start: "2026-03-01", end: "2026-03-31" }, 1, "previous_period", true),
    ).toEqual([{ start: "2026-02-01", end: "2026-02-28", monthsBack: 1 }]);
  });

  test("days that do not exist last year are clamped, without time zone drift", () => {
    expect(
      comparisonWindows(
        { start: "2028-02-01", end: "2028-02-29" },
        1,
        "same_period_last_year",
        true,
      ),
    ).toEqual([{ start: "2027-02-01", end: "2027-02-28", monthsBack: 12 }]);
    expect(
      comparisonWindows({ start: "2026-03-01", end: "2026-03-30" }, 1, "previous_period", false),
    ).toEqual([{ start: "2026-02-01", end: "2026-02-28", monthsBack: 1 }]);
  });

  test("a whole period is compared with the whole earlier period", () => {
    expect(
      comparisonWindows({ start: "2026-09-01", end: "2026-09-30" }, 1, "previous_period", true),
    ).toEqual([{ start: "2026-08-01", end: "2026-08-31", monthsBack: 1 }]);
    expect(
      comparisonWindows(
        { start: "2025-02-01", end: "2025-02-28" },
        1,
        "same_period_last_year",
        true,
      ),
    ).toEqual([{ start: "2024-02-01", end: "2024-02-29", monthsBack: 12 }]);
  });

  test("an unfinished year ending 28 Feb keeps the same days across a leap February", () => {
    const ytd = { start: "2025-01-01", end: "2025-02-28" };
    expect(comparisonWindows(ytd, 12, "same_period_last_year", false)).toEqual([
      { start: "2024-01-01", end: "2024-02-28", monthsBack: 12 },
    ]);
    const kpis = computeKpis([], { ...ctx({ period: "year" }), today: "2025-02-28" });
    expect(kpis.partial).toBe(true);
    expect(kpis.window).toEqual(ytd);
    expect(kpis.compareWindows).toEqual([{ start: "2024-01-01", end: "2024-02-28" }]);
  });

  test("no comparison, or none possible for all_time", () => {
    expect(comparisonWindows(nov, 1, "none", false)).toEqual([]);
    expect(comparisonWindows(nov, null, "previous_period", false)).toEqual([]);
  });
});

describe("data start", () => {
  const configs = (...charts: Partial<ChartConfig>[]) => charts.map((c) => chart(c));

  test("an all-time chart needs every entry", () => {
    expect(dataStart([chart({ period: "all_time" })], ctx())).toBeNull();
    expect(
      dataStart(
        DEFAULT_CHART_CONFIGS.map((c) => c.config),
        ctx(),
      ),
    ).toBeNull();
  });

  test("the KPI cards alone: the viewed period and its comparison", () => {
    expect(dataStart([], ctx({ compare: "none" }))).toBe("2026-11-01");
    expect(dataStart([], ctx({ compare: "previous_period" }))).toBe("2026-10-01");
    expect(dataStart([], ctx())).toBe("2025-11-01");
    expect(dataStart([], ctx({ compare: "avg_12_months" }))).toBe("2025-11-01");
    expect(dataStart([], ctx({ period: "year", compare: "previous_period" }))).toBe("2025-01-01");
    // Navigated back to March 2025.
    expect(dataStart([], ctx({}, "2025-03-09"))).toBe("2024-03-01");
  });

  test("the earliest day any chart or its comparison reads", () => {
    const ctxNone = ctx({ compare: "none" });
    expect(dataStart(configs({ period: "last_12_months" }), ctxNone)).toBe("2025-12-01");
    expect(
      dataStart(configs({ period: "this_year", compare: "same_period_last_year" }), ctxNone),
    ).toBe("2025-01-01");
    expect(
      dataStart(
        configs({ period: "dashboard" }, { period: "last_12_months", compare: "avg_12_months" }),
        ctxNone,
      ),
    ).toBe("2024-12-01");
  });

  test("a chart on a chosen month or year reads from there", () => {
    const ctxNone = ctx({ compare: "none" });
    expect(dataStart(configs({ period: "year", periodRef: "2023-05" }), ctxNone)).toBe(
      "2023-01-01",
    );
    expect(
      dataStart(
        configs({ period: "month", periodRef: "2024-03", compare: "previous_period" }),
        ctxNone,
      ),
    ).toBe("2024-02-01");
  });

  test("reading from the data start computes the same charts as reading everything", () => {
    const charts = [
      ...GALLERY_PRESETS.map((p) => p.config).filter((c) => c.period !== "all_time"),
      ...DEFAULT_CHART_CONFIGS.map((c) => c.config).filter((c) => c.period !== "all_time"),
    ];
    for (const settings of [ctx(), ctx({ compare: "avg_12_months", period: "year" })]) {
      const start = dataStart(charts, settings) ?? "";
      const read = FIXTURE.filter((t) => t.deleted || t.date >= start);
      for (const c of charts)
        expect(computeChart(c, read, settings)).toEqual(computeChart(c, FIXTURE, settings));
      expect(computeKpis(read, settings)).toEqual(computeKpis(FIXTURE, settings));
    }
  });
});

// ─── Filters ────────────────────────────────────────────────────────────────

describe("filters", () => {
  const sumOf = (rows: readonly LiveTransaction[]) => rows.reduce((s, t) => s + t.amount, 0);
  const cats = (rows: readonly LiveTransaction[]) => rows.map((t) => t.category).sort();

  test("deleted rows are dropped", () => {
    const rows = filterTransactions(FIXTURE, chart(), NO_EXCLUSIONS);
    expect(rows).toHaveLength(FIXTURE.length - 1);
    expect(rows.every((t) => !t.deleted)).toBe(true);
  });

  test("dashboard-wide and per-chart exclusions combine", () => {
    const rows = filterTransactions(
      FIXTURE,
      chart({ exclude: { categories: ["Groceries"], tags: [] } }),
      { categories: ["Home"], tags: ["Istanbul 2026"] },
    );
    expect(rows.some((t) => t.category === "Home")).toBe(false);
    expect(rows.some((t) => t.category === "Groceries")).toBe(false);
    expect(rows.some((t) => t.tags.length > 0)).toBe(false);
    expect(rows.filter((t) => t.type === "income")).toHaveLength(5);
  });

  test("a chart can opt out of the dashboard-wide exclusions and keep its own", () => {
    const rows = filterTransactions(
      FIXTURE,
      chart({
        useDashboardExclusions: false,
        exclude: { categories: ["Groceries"], tags: [] },
      }),
      { categories: ["Home"], tags: ["Istanbul 2026"] },
    );
    expect(rows.some((t) => t.category === "Home")).toBe(true);
    expect(rows.some((t) => t.tags.length > 0)).toBe(true);
    expect(rows.some((t) => t.category === "Groceries")).toBe(false);
  });

  test("tag exclusions match case-insensitively and drop an entry carrying any excluded tag", () => {
    const rows = filterTransactions(FIXTURE, chart(), {
      ...NO_EXCLUSIONS,
      tags: [" ISTANBUL 2026 "],
    });
    expect(rows.filter((t) => t.date.startsWith("2026-08"))).toEqual([]);
    const food = filterTransactions(FIXTURE, chart(), { ...NO_EXCLUSIONS, tags: ["food"] });
    expect(cats(food.filter((t) => t.date.startsWith("2026-08")))).toEqual(["Transport"]);
  });

  test("onlyTags keeps only entries carrying one of the tags, matched case-insensitively", () => {
    const rows = filterTransactions(FIXTURE, chart({ onlyTags: ["istanbul 2026"] }), NO_EXCLUSIONS);
    expect(cats(rows)).toEqual(["Eating out", "Transport"]);
    expect(sumOf(rows)).toBe(430800);
    const either = filterTransactions(
      FIXTURE,
      chart({ onlyTags: ["FOOD", "Wedding"] }),
      NO_EXCLUSIONS,
    );
    expect(cats(either)).toEqual(["Eating out"]);
  });

  test("onlyTags and exclusions apply together", () => {
    const rows = filterTransactions(
      FIXTURE,
      chart({ onlyTags: ["Istanbul 2026"], exclude: { ...NO_EXCLUSIONS, tags: ["Food"] } }),
      NO_EXCLUSIONS,
    );
    expect(cats(rows)).toEqual(["Transport"]);
  });
});

// ─── KPI cards ──────────────────────────────────────────────────────────────

describe("KPI cards", () => {
  const card = (kpis: ReturnType<typeof computeKpis>, key: string) => {
    const found = kpis.cards.find((c) => c.key === key);
    if (!found) throw new Error(`no card ${key}`);
    return found;
  };

  test("Expenses, Per day, Income and Kept of income against the same days last year", () => {
    const kpis = computeKpis(FIXTURE, ctx());
    expect(kpis.window).toEqual({ start: "2026-11-01", end: "2026-11-17" });
    expect(kpis.partial).toBe(true);
    expect(kpis.compareWindows).toEqual([{ start: "2025-11-01", end: "2025-11-17" }]);
    expect(kpis.cards.map((c) => c.key)).toEqual(["expenses", "per_day", "income", "kept_ratio"]);

    // 4 500 + 2 350 + 18 000 + 650; the entry dated 20 Nov is not counted yet.
    expect(card(kpis, "expenses")).toEqual({
      key: "expenses",
      value: 2550000,
      compare: 680000,
      delta: (2550000 - 680000) / 680000,
      deltaKind: "percent",
    });
    expect(card(kpis, "per_day")).toEqual({
      key: "per_day",
      value: 150000,
      compare: 40000,
      delta: 110000,
      deltaKind: "amount",
    });
    expect(card(kpis, "income")).toEqual({
      key: "income",
      value: 11000000,
      compare: 8000000,
      delta: 0.375,
      deltaKind: "percent",
    });
    const kept = card(kpis, "kept_ratio");
    expect(kept.value).toBeCloseTo(84500 / 110000, 12);
    expect(kept.compare).toBeCloseTo(0.915, 12);
    expect(kept.delta).toBeCloseTo(84500 / 110000 - 0.915, 12);
    expect(kept.deltaKind).toBe("points");
  });

  test("dashboard exclusions apply to every card", () => {
    const kpis = computeKpis(
      FIXTURE,
      ctx({ exclude: { categories: ["Home"], tags: ["Istanbul 2026"] } }),
    );
    expect(card(kpis, "expenses").value).toBe(750000);
    expect(card(kpis, "per_day").value).toBe(Math.round(750000 / 17));
  });

  test("previous period: 1–17 October", () => {
    const kpis = computeKpis(FIXTURE, ctx({ compare: "previous_period" }));
    expect(kpis.compareWindows).toEqual([{ start: "2026-10-01", end: "2026-10-17" }]);
    expect(card(kpis, "expenses").compare).toBe(418000);
    expect(card(kpis, "income").compare).toBe(8500000);
  });

  test("12-month average: the same 17 days of each previous month, averaged", () => {
    const kpis = computeKpis(FIXTURE, ctx({ compare: "avg_12_months" }));
    expect(kpis.compareWindows).toHaveLength(12);
    // Oct 2026: 4 180; Aug 2026: 2 808 + 1 500; Nov 2025: 5 600 + 500 + 700.
    expect(card(kpis, "expenses").compare).toBe(Math.round(1528800 / 12));
    expect(card(kpis, "income").compare).toBe(Math.round(16500000 / 12));
    expect(card(kpis, "per_day").compare).toBe(Math.round(1528800 / (17 * 12)));
  });

  test("no comparison leaves compare and delta empty", () => {
    const kpis = computeKpis(FIXTURE, ctx({ compare: "none" }));
    expect(kpis.compareWindows).toEqual([]);
    for (const c of kpis.cards) {
      expect(c.compare).toBeNull();
      expect(c.delta).toBeNull();
    }
  });

  test("without income, kept of income has no value (not NaN or Infinity)", () => {
    const kpis = computeKpis(FIXTURE, ctx({}, "2026-08-01"));
    expect(card(kpis, "income").value).toBe(0);
    expect(card(kpis, "kept_ratio").value).toBeNull();
    expect(card(kpis, "kept_ratio").delta).toBeNull();
    // Nothing spent in August 2025, so no percentage change either.
    expect(card(kpis, "expenses").delta).toBeNull();
  });

  test("the year view counts 1 January to today against the same days last year", () => {
    const kpis = computeKpis(FIXTURE, ctx({ period: "year" }));
    expect(card(kpis, "expenses").value).toBe(430800 + 618000 + 2550000);
    expect(card(kpis, "expenses").compare).toBe(680000);
    expect(card(kpis, "per_day").value).toBe(Math.round(3598800 / 321));
  });

  test("original amounts never enter totals", () => {
    const kpis = computeKpis(FIXTURE, ctx({}, "2026-08-01"));
    // The ferry was paid TRY 720.00 (72 000 hundredths); only its 2 808 DZD amount counts.
    expect(card(kpis, "expenses").value).toBe(280800 + 150000);
  });
});

// ─── Default charts ─────────────────────────────────────────────────────────

describe("default charts", () => {
  test("Expenses, this year vs last year: every month of 2026 against 2025", () => {
    const data = asSeries(
      computeChart(defaultChart("Expenses, this year vs last year"), FIXTURE, ctx()),
    );
    expect(data.labels).toEqual(months2026);
    expect(data.hasOther).toBe(false);
    const cur = current(data);
    expect(cur.key).toBe("current");
    expect(cur.values).toEqual([0, 0, 0, 0, 0, 0, 0, 430800, 0, 618000, 2550000, null]);
    // November is unfinished: drawn dashed and projected over its 30 days.
    expect(cur.partial).toEqual(months2026.map((m) => m === "2026-11"));
    expect(cur.projected).toEqual(months2026.map((m) => (m === "2026-11" ? 4500000 : null)));
    const cmp = compared(data);
    expect(cmp.key).toBe("compare");
    // The comparison line is all of 2025, including the full November and December.
    expect(cmp.values).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1070000, 0]);
    expect(cmp.partial.every((p) => !p)).toBe(true);
    expect(data.compareWindows).toEqual([{ start: "2025-01-01", end: "2025-12-31" }]);
  });

  test("By category vs last year: 1–17 Nov 2026 against 1–17 Nov 2025", () => {
    const data = asSeries(computeChart(defaultChart("By category vs last year"), FIXTURE, ctx()));
    expect(data.window).toEqual({ start: "2026-11-01", end: "2026-11-17" });
    expect(data.compareWindows).toEqual([{ start: "2025-11-01", end: "2025-11-17" }]);
    // Biggest first; a category spent on only last year still shows.
    expect(data.labels).toEqual(["Home", "Medical", "Groceries", "Transport", "Clothes"]);
    expect(current(data).values).toEqual([1800000, 450000, 235000, 65000, 0]);
    expect(compared(data).values).toEqual([0, 50000, 560000, 0, 70000]);
    // Same days on both sides: nothing to dash.
    expect(current(data).partial.every((p) => !p)).toBe(true);
    expect(data.partial).toBe(true);
  });

  test("By category follows the dashboard exclusions", () => {
    const data = asSeries(
      computeChart(
        defaultChart("By category vs last year"),
        FIXTURE,
        ctx({ exclude: { categories: ["Home"], tags: [] } }),
      ),
    );
    expect(data.labels).toEqual(["Medical", "Groceries", "Transport", "Clothes"]);
  });

  test("Kept of income: 12 months, no value where there was no income", () => {
    const data = asSeries(computeChart(defaultChart("Kept of income"), FIXTURE, ctx()));
    expect(data.labels).toEqual(["2025-12", ...months2026.slice(0, 11)]);
    expect(data.series).toHaveLength(1);
    const values = byLabel(data, current(data).values);
    expect(values["2025-12"]).toBeNull();
    expect(values["2026-08"]).toBeNull();
    expect(values["2026-10"]).toBeCloseTo((85000 - 6180) / 85000, 12);
    expect(values["2026-11"]).toBeCloseTo(84500 / 110000, 12);
    expect(current(data).partial.at(-1)).toBe(true);
    expect(current(data).projected.at(-1)).toBeCloseTo(84500 / 110000, 12);
  });

  test("Year by year: income, expenses and kept ratio for 1 Jan – 17 Nov of each year", () => {
    const data = asTable(computeChart(defaultChart("Year by year"), FIXTURE, ctx()));
    expect(data.rows.map((r) => r.label)).toEqual(["2024", "2025", "2026"]);
    const [y2024, y2025, y2026] = data.rows;
    expect(y2024).toMatchObject({
      window: { start: "2024-01-01", end: "2024-11-17" },
      income: 7000000,
      expenses: 400000, // the December bill is outside the window
      current: false,
    });
    expect(y2024?.keptRatio).toBeCloseTo(66000 / 70000, 12);
    expect(y2025).toMatchObject({ income: 8000000, expenses: 680000, current: false });
    expect(y2025?.keptRatio).toBeCloseTo(0.915, 12);
    expect(y2026).toMatchObject({
      window: { start: "2026-01-01", end: "2026-11-17" },
      income: 19500000,
      expenses: 3598800,
      current: true,
    });
    expect(y2026?.keptRatio).toBeCloseTo((195000 - 35988) / 195000, 12);
  });

  test("Year by year counts all entries: the dashboard's exclusions leave it alone", () => {
    const excluding = ctx({ exclude: { categories: ["Home"], tags: [] } });
    const all = asTable(computeChart(defaultChart("Year by year"), FIXTURE, ctx()));
    const excluded = asTable(computeChart(defaultChart("Year by year"), FIXTURE, excluding));
    expect(excluded.rows).toEqual(all.rows);
    expect(excluded.rows.at(-1)?.expenses).toBe(3598800); // the IKEA chair still counts
  });
});

// ─── Gallery presets ────────────────────────────────────────────────────────

describe("gallery presets", () => {
  test("Month pace: running total by day against the usual month", () => {
    const data = asSeries(computeChart(preset("month_pace"), FIXTURE, ctx()));
    expect(data.labels).toHaveLength(30);
    expect(data.labels[0]).toBe("2026-11-01");
    expect(data.labels[29]).toBe("2026-11-30");
    const cur = byLabel(data, current(data).values);
    expect(cur["2026-11-01"]).toBe(0);
    expect(cur["2026-11-02"]).toBe(450000);
    expect(cur["2026-11-05"]).toBe(2485000);
    expect(cur["2026-11-17"]).toBe(2550000);
    expect(cur["2026-11-18"]).toBeNull();
    // Days are whole: nothing is partial at day resolution.
    expect(current(data).partial.every((p) => !p)).toBe(true);
    const cmp = byLabel(data, compared(data).values);
    expect(cmp["2026-11-04"]).toBe(Math.round(560000 / 12));
    // Every expense of Nov 2025 – Oct 2026, averaged over 12 months.
    expect(cmp["2026-11-30"]).toBe(Math.round(2118800 / 12));
  });

  test("By tag: by tag over 12 months, untagged together, ignoring dashboard exclusions", () => {
    const data = asSeries(
      computeChart(
        preset("by_tag"),
        FIXTURE,
        ctx({ exclude: { categories: ["Home"], tags: ["Istanbul 2026"] } }),
      ),
    );
    // Untagged entries group under "".
    expect(data.labels).toEqual(["", "Istanbul 2026", "Food"]);
    // The Istanbul meal also counts under Food.
    expect(current(data).values).toEqual([3168000, 430800, 150000]);
  });

  test("Trip total: one tag by category over all time", () => {
    const config = { ...preset("trip_total"), onlyTags: ["Istanbul 2026"] };
    const data = asSeries(computeChart(config, FIXTURE, ctx()));
    expect(data.labels).toEqual(["Transport", "Eating out"]);
    expect(current(data).values).toEqual([280800, 150000]);
  });

  test("Biggest changes: top categories against last year", () => {
    const data = asSeries(computeChart(preset("biggest_changes"), FIXTURE, ctx()));
    expect(data.labels).toEqual(["Home", "Medical", "Groceries", "Transport", "Clothes"]);
    expect(data.hasOther).toBe(false);
    expect(compared(data).values).toEqual([0, 50000, 560000, 0, 70000]);
  });

  test("Top details: where the money went this month", () => {
    const data = asSeries(computeChart(preset("top_details"), FIXTURE, ctx()));
    expect(data.labels).toEqual(["IKEA desk chair", "dentist", "Carrefour", "Taxi"]);
    expect(current(data).values).toEqual([1800000, 450000, 235000, 65000]);
  });

  test("By weekday: Monday to Sunday over 12 months", () => {
    const data = asSeries(computeChart(preset("by_weekday"), FIXTURE, ctx()));
    expect(data.labels).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    // Mon: 2 Nov; Tue: 20 Oct, 3 + 10 Nov; Wed: 12 Aug; Thu: 13 Aug, 15 Oct, 5 Nov.
    expect(current(data).values).toEqual([450000, 500000, 280800, 2368000, 0, 0, 0]);
  });

  test("Spending calendar: one value per day of the month", () => {
    const data = asSeries(computeChart(preset("spending_calendar"), FIXTURE, ctx()));
    expect(data.labels).toHaveLength(30);
    const values = byLabel(data, current(data).values);
    expect(values["2026-11-05"]).toBe(1800000);
    expect(values["2026-11-06"]).toBe(0);
    expect(values["2026-11-20"]).toBeNull();
  });

  test("Income sources: income by category over 12 months", () => {
    const data = asSeries(computeChart(preset("income_sources"), FIXTURE, ctx()));
    expect(data.labels).toEqual(["Salary", "Freelance"]);
    expect(current(data).values).toEqual([17000000, 2500000]);
  });
});

// ─── Grouping and metrics ───────────────────────────────────────────────────

describe("grouping and metrics", () => {
  test("an entry with several tags counts in each tag group; untagged entries group under ''", () => {
    const data = asSeries(
      computeChart(chart({ groupBy: "tag", period: "all_time" }), FIXTURE, ctx()),
    );
    const values = byLabel(data, current(data).values);
    // Spelled as first used.
    expect(values["Istanbul 2026"]).toBe(430800);
    expect(values.Food).toBe(150000);
    expect(data.labels).toContain("");
    expect(data.labels.filter((l) => l.toLowerCase() === "istanbul 2026")).toHaveLength(1);
  });

  test("limit keeps the top groups and folds the rest into Other, on both series", () => {
    const data = asSeries(
      computeChart(chart({ limit: 2, compare: "same_period_last_year" }), FIXTURE, ctx()),
    );
    expect(data.labels).toEqual(["Home", "Medical", "Other"]);
    expect(data.hasOther).toBe(true);
    expect(current(data).values).toEqual([1800000, 450000, 235000 + 65000]);
    expect(compared(data).values).toEqual([0, 50000, 560000 + 70000]);
  });

  test("Other counts an entry once even when several of its tags are folded", () => {
    const rows: TransactionRow[] = [
      expense("2026-11-02", 100, "Gifts", { tags: ["A"] }),
      expense("2026-11-03", 10, "Gifts", { tags: ["B", "C"] }),
    ];
    const data = asSeries(computeChart(chart({ groupBy: "tag", limit: 1 }), rows, ctx()));
    expect(data.labels).toEqual(["A", "Other"]);
    expect(current(data).values).toEqual([10000, 1000]);
  });

  test("difference, count and income metrics", () => {
    const by = (metric: ChartConfig["metric"]) =>
      asSeries(computeChart(chart({ metric, groupBy: "month" }), FIXTURE, ctx())).series[0]?.values;
    expect(by("income")).toEqual([11000000]);
    expect(by("difference")).toEqual([11000000 - 2550000]);
    expect(by("count")).toEqual([6]);
  });

  test("cumulative adds up the buckets in order", () => {
    const data = asSeries(
      computeChart(
        chart({ groupBy: "month", period: "this_year", cumulative: true }),
        FIXTURE,
        ctx(),
      ),
    );
    const values = byLabel(data, current(data).values);
    expect(values["2026-07"]).toBe(0);
    expect(values["2026-08"]).toBe(430800);
    expect(values["2026-10"]).toBe(430800 + 618000);
    expect(values["2026-11"]).toBe(3598800);
    expect(values["2026-12"]).toBeNull();
    expect(current(data).projected[10]).toBe(430800 + 618000 + 4500000);
  });

  test("all_time charts have no comparison", () => {
    const data = asSeries(
      computeChart(
        chart({ groupBy: "year", period: "all_time", compare: "same_period_last_year" }),
        FIXTURE,
        ctx(),
      ),
    );
    expect(data.labels).toEqual(["2024", "2025", "2026"]);
    expect(data.series.map((s) => s.role)).toEqual(["current"]);
    expect(current(data).values).toEqual([700000, 1070000, 3598800]);
    expect(current(data).partial).toEqual([false, false, true]);
  });

  test("results do not depend on the device's time zone", () => {
    // `bun test` pins the zone, so each zone runs in its own process. US clocks change on
    // 1 Nov 2026, inside the month the fixture looks at.
    const dir = import.meta.dir.replaceAll("\\", "/");
    const script = `
      const d = await import("${dir}/../src/dashboard.ts");
      const { GALLERY_PRESETS } = await import("${dir}/../src/defaults.ts");
      const rows = ${JSON.stringify(FIXTURE)};
      const ctx = ${JSON.stringify(ctx({ compare: "avg_12_months" }))};
      const preset = (key) => GALLERY_PRESETS.find((p) => p.key === key).config;
      console.log(JSON.stringify({
        offset: new Date(2026, 10, 17).getTimezoneOffset(),
        weekday: d.computeChart(preset("by_weekday"), rows, ctx),
        pace: d.computeChart(preset("month_pace"), rows, ctx),
        kpis: d.computeKpis(rows, ctx),
      }));
    `;
    const inZone = (zone: string) => {
      const run = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, TZ: zone },
      });
      return JSON.parse(run.stdout.toString());
    };
    const c = ctx({ compare: "avg_12_months" });
    const expected = JSON.parse(
      JSON.stringify({
        weekday: computeChart(preset("by_weekday"), FIXTURE, c),
        pace: computeChart(preset("month_pace"), FIXTURE, c),
        kpis: computeKpis(FIXTURE, c),
      }),
    );
    for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles"]) {
      const { offset, ...result } = inZone(zone);
      expect(offset).not.toBe(0); // the zone really applied
      expect(result).toEqual(expected);
    }
  });

  test("entries dated after today stay out of comparison series too", () => {
    const rows: TransactionRow[] = [
      expense("2026-11-05", 50, "Gifts"),
      expense("2026-11-25", 100, "Gifts"), // after today
      expense("2026-10-05", 12, "Gifts"),
    ];
    const data = asSeries(
      computeChart(
        chart({ groupBy: "month", period: "this_year", compare: "avg_12_months" }),
        rows,
        ctx(),
      ),
    );
    const cmp = byLabel(data, compared(data).values);
    // December's 12-month average covers Dec 2025 – Nov 2026: only 12 + 50 count so far.
    expect(cmp["2026-12"]).toBe(Math.round(6200 / 12));
    expect(byLabel(data, current(data).values)["2026-11"]).toBe(5000);
  });

  test("averages and projections round half up exactly, in integers", () => {
    // 51 hundredths in the first 6 days of a 29-day February: 51 × 29 / 6 = 246.5 exactly,
    // which multiplying by a float factor rounds down to 246.
    const feb: TransactionRow[] = [expense("2028-02-03", 1, "Gifts", { amount: 51 })];
    const projected = asSeries(
      computeChart(chart({ groupBy: "month" }), feb, { ...ctx(), today: "2028-02-06" }),
    );
    expect(current(projected).partial).toEqual([true]);
    expect(current(projected).projected).toEqual([247]);
    // 6 hundredths averaged over 12 months is 0.5: half up gives 1.
    const oct: TransactionRow[] = [expense("2026-10-03", 1, "Gifts", { amount: 6 })];
    const kpis = computeKpis(oct, ctx({ compare: "avg_12_months" }));
    expect(kpis.cards.find((c) => c.key === "expenses")?.compare).toBe(1);
  });

  test("no transactions", () => {
    const data = asSeries(computeChart(chart(), [], ctx()));
    expect(data.labels).toEqual([]);
    expect(current(data).values).toEqual([]);
    const table = asTable(computeChart(defaultChart("Year by year"), [], ctx()));
    expect(table.rows.map((r) => r.label)).toEqual(["2026"]);
  });
});
