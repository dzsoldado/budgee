import { describe, expect, test } from "bun:test";
import {
  type ChartConfig,
  computeChart,
  type DashboardContext,
  type DashboardSettings,
  DEFAULT_CHART_CONFIGS,
  GALLERY_PRESETS,
  type Kpi,
  type LiveTransaction,
  type SeriesChart,
} from "@budgee/core";
import { fade, metricColor, type Palette, plotted } from "../src/dashboard/chart";
import {
  compareOptionLabel,
  compareRangeText,
  formatThousands,
  groupLabel,
  hasNextPeriod,
  kpiText,
  partialIndex,
  periodTitle,
  seriesNames,
  seriesSubtitle,
  shiftPeriod,
  tableSubtitle,
  toThousands,
  usesThousands,
} from "../src/dashboard/format";

const TODAY = "2026-11-17";
const dashboard = (o: Partial<DashboardSettings> = {}): DashboardSettings => ({
  period: "month",
  compare: "same_period_last_year",
  exclude: { categories: [], tags: [] },
  ...o,
});
const ctx = (o: Partial<DashboardSettings> = {}, ref?: string): DashboardContext => ({
  today: TODAY,
  dashboard: dashboard(o),
  ...(ref ? { ref } : {}),
});

let n = 0;
function tx(
  date: string,
  type: "income" | "expense",
  units: number,
  category: string,
): LiveTransaction {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    hlc: "001763000000000:00000:dev-a",
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
  };
}
const ROWS = [
  tx("2026-11-02", "expense", 4500, "Medical"),
  tx("2026-11-10", "expense", 20000, "Groceries"),
  tx("2026-11-01", "income", 85000, "Salary"),
  tx("2026-10-05", "expense", 26000, "Groceries"),
  tx("2025-11-04", "expense", 5600, "Groceries"),
  tx("2025-11-10", "expense", 1200, "Medical"),
  tx("2025-06-10", "expense", 28000, "Bills"),
];
const chartNamed = (name: string): ChartConfig => {
  const found = DEFAULT_CHART_CONFIGS.find((c) => c.name === name);
  if (!found) throw new Error(name);
  return found.config;
};
const series = (config: ChartConfig, c = ctx()) => {
  const data = computeChart(config, ROWS, c);
  if (data.shape !== "series") throw new Error("not a series");
  return data;
};

describe("period navigation", () => {
  test("titles", () => {
    expect(periodTitle("2026-11", "month", "en")).toBe("November 2026");
    expect(periodTitle("2026-11", "year", "en")).toBe("2026");
  });

  test("steps by a month or a year, never past the current period", () => {
    expect(shiftPeriod("2026-01", "month", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-11", "year", -1)).toBe("2025-11");
    expect(hasNextPeriod("2026-11", "month", TODAY)).toBe(false);
    expect(hasNextPeriod("2026-10", "month", TODAY)).toBe(true);
    expect(hasNextPeriod("2026-03", "year", TODAY)).toBe(false);
    expect(hasNextPeriod("2025-12", "year", TODAY)).toBe(true);
  });
});

describe("comparison options", () => {
  test("the select names the option only", () => {
    expect(compareOptionLabel("same_period_last_year", "month")).toBe("Same days last year");
    expect(compareOptionLabel("previous_period", "month")).toBe("Previous month");
    expect(compareOptionLabel("previous_period", "year")).toBe("Previous year");
    expect(compareOptionLabel("avg_12_months", "month")).toBe("Average of last 12 months");
    expect(compareOptionLabel("none", "month")).toBe("Nothing");
  });

  test("the line under it says which days are compared", () => {
    expect(compareRangeText(ctx(), "en")).toBe("Nov 1 – 17, 2026 against Nov 1 – 17, 2025");
    expect(compareRangeText(ctx({ compare: "previous_period" }), "en")).toBe(
      "Nov 1 – 17, 2026 against Oct 1 – 17, 2026",
    );
    // A finished month compares with the whole earlier month.
    expect(compareRangeText(ctx({ compare: "previous_period" }, "2026-10-01"), "en")).toBe(
      "Oct 1 – 31, 2026 against Sep 1 – 30, 2026",
    );
    expect(compareRangeText(ctx({ compare: "avg_12_months" }), "en")).toBe(
      "Nov 1 – 17, 2026 against the average of the 12 months before",
    );
    expect(compareRangeText(ctx({ compare: "none" }), "en")).toBeNull();
  });

  test("in the year view, Same days last year and Previous year name the same days", () => {
    const lastYear = compareRangeText(ctx({ period: "year" }), "en");
    expect(lastYear).toBe("Jan 1 – Nov 17, 2026 against Jan 1 – Nov 17, 2025");
    expect(compareRangeText(ctx({ period: "year", compare: "previous_period" }), "en")).toBe(
      lastYear,
    );
  });
});

describe("series names", () => {
  test("years for the same month or year a year apart", () => {
    expect(seriesNames(series(chartNamed("Expenses, this year vs last year")), "en")).toEqual({
      current: "2026",
      compare: "2025",
    });
    expect(seriesNames(series(chartNamed("By category vs last year")), "en")).toEqual({
      current: "2026",
      compare: "2025",
    });
  });

  test("months for the previous month, the average by name", () => {
    const byCategory = { ...chartNamed("By category vs last year") };
    expect(seriesNames(series({ ...byCategory, compare: "previous_period" }), "en")).toEqual({
      current: "Nov",
      compare: "Oct",
    });
    expect(seriesNames(series({ ...byCategory, compare: "avg_12_months" }), "en")).toEqual({
      current: "Nov 2026",
      compare: "12-month average",
    });
  });
});

describe("group labels", () => {
  test("by grouping, with Other judged by position, not by text", () => {
    expect(groupLabel("2026-11", "month", "en", { axis: true, narrow: true })).toBe("N");
    expect(groupLabel("2026-11", "month", "en")).toBe("November 2026");
    expect(groupLabel("2026-11-03", "day", "en", { axis: true })).toBe("3");
    expect(groupLabel("1", "weekday", "en", { axis: true })).toBe("Mon");
    expect(groupLabel("", "tag", "en")).toBe("No tag");
    expect(groupLabel("Other", "category", "en")).toBe("Other");
    expect(groupLabel("Groceries", "category", "en", { other: true })).toBe("Other");
  });

  test("By tag names each tag, and puts untagged entries under No tag", () => {
    const byTag = GALLERY_PRESETS.find((p) => p.key === "by_tag")?.config;
    if (!byTag) throw new Error("no By tag preset");
    const rows = [
      ...ROWS,
      { ...tx("2026-08-12", "expense", 2808, "Transport"), tags: ["Istanbul 2026"] },
      { ...tx("2026-08-13", "expense", 1500, "Going out"), tags: ["istanbul 2026", "Food"] },
    ];
    const data = computeChart(byTag, rows, ctx());
    if (data.shape !== "series") throw new Error("not a series");
    expect(data.labels.map((key) => groupLabel(key, byTag.groupBy, "en"))).toEqual([
      "No tag",
      "Istanbul 2026",
      "Food",
    ]);
  });
});

describe("numbers", () => {
  test("thousands", () => {
    expect(toThousands(2_345_000)).toBe(23);
    expect(toThousands(-2_350_000)).toBe(-24);
    expect(formatThousands(103_200_000, "en")).toBe("1,032k");
    expect(usesThousands([999_999, null])).toBe(false);
    expect(usesThousands([1_000_000])).toBe(true);
  });
});

describe("subtitles", () => {
  test("a monthly line: per month, the unit, the projection of the unfinished month", () => {
    const data = series(chartNamed("Expenses, this year vs last year"));
    expect(partialIndex(data)).toBe(10);
    expect(
      seriesSubtitle(data, chartNamed("Expenses, this year vs last year"), {
        locale: "en",
        currency: "DZD",
        thousands: true,
      }),
    ).toBe("Per month, thousands DZD · Nov projected from 17 days");
  });

  test("bars by category: the days counted and which mark is which", () => {
    const config = chartNamed("By category vs last year");
    expect(
      seriesSubtitle(series(config), config, { locale: "en", currency: "DZD", thousands: false }),
    ).toBe("Nov 1 – 17, 2026 · bar is 2026, tick is 2025");
  });

  test("year by year: the same window each year, all entries", () => {
    const config = chartNamed("Year by year");
    const data = computeChart(config, ROWS, ctx());
    if (data.shape !== "table") throw new Error("not a table");
    expect(tableSubtitle(data, config, "en")).toBe(
      "Same window each year: Jan 1 – Nov 17 · all entries",
    );
    expect(tableSubtitle(data, { ...config, useDashboardExclusions: true }, "en")).toBe(
      "Same window each year: Jan 1 – Nov 17",
    );
  });
});

describe("KPI texts", () => {
  const money = (v: number, signAlways = false) =>
    `${signAlways && v > 0 ? "+" : ""}${v < 0 ? "−" : ""}${Math.abs(v / 100).toLocaleString("en")}`;
  const opts = { locale: "en", money, excluding: false, comparing: true };
  const kpi = (o: Partial<Kpi>): Kpi => ({
    key: "expenses",
    value: 1297000,
    compare: 1365000,
    delta: -0.0498,
    deltaKind: "percent",
    ...o,
  });

  test("as drawn: −5% vs 13,650; −40 vs 803 a day; +9 pts vs 51%", () => {
    expect(kpiText(kpi({}), opts)).toEqual({
      label: "Expenses",
      value: "12,970",
      delta: "−5%",
      vs: "vs 13,650",
    });
    expect(kpiText(kpi({}), { ...opts, excluding: true }).label).toBe("Expenses (filtered)");
    expect(
      kpiText(
        kpi({ key: "per_day", value: 76300, compare: 80300, delta: -4000, deltaKind: "amount" }),
        opts,
      ),
    ).toMatchObject({ value: "763", delta: "−40", vs: "vs 803 a day" });
    expect(
      kpiText(
        kpi({ key: "kept_ratio", value: 0.6, compare: 0.51, delta: 0.09, deltaKind: "points" }),
        opts,
      ),
    ).toMatchObject({ value: "60%", delta: "+9 pts", vs: "vs 51%" });
  });

  test("without a comparison or a compared value", () => {
    expect(kpiText(kpi({}), { ...opts, comparing: false })).toMatchObject({ vs: null });
    expect(
      kpiText(kpi({ key: "kept_ratio", value: null, compare: null, delta: null }), opts),
    ).toMatchObject({ value: "—", delta: null, vs: "vs —" });
  });
});

describe("chart drawing helpers", () => {
  const palette: Palette = {
    income: "#008a78",
    expense: "#c2550f",
    compare: "#a6a8b8",
    ink: "#16151f",
    muted: "#595c70",
    surface: "#ffffff",
    grid: "#eeeef4",
    axis: "#c8c9d6",
    tipBg: "#16151f",
    tipInk: "#ffffff",
  };

  test("money in and out in teal and orange; the rest in neutral ink, never purple", () => {
    expect(metricColor("expenses", palette)).toBe("#c2550f");
    expect(metricColor("income", palette)).toBe("#008a78");
    expect(metricColor("difference", palette)).toBe("#16151f");
    expect(metricColor("kept_ratio", palette)).toBe("#16151f");
    expect(fade("#c2550f", 0.5)).toBe("#c2550f80");
  });

  test("a line plots the unfinished month at its projection; columns at the counted value", () => {
    const data: SeriesChart = series(chartNamed("Expenses, this year vs last year"));
    const counted = data.series[0]?.values[10];
    const projected = data.series[0]?.projected[10];
    expect(plotted(data, "line")[10]).toBe(projected ?? -1);
    expect(plotted(data, "columns")[10]).toBe(counted ?? -1);
    expect(projected).toBe(Math.round((24500 * 100 * 30) / 17));
  });
});
