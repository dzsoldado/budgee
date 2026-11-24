import { describe, expect, test } from "bun:test";
import {
  type ChartConfig,
  computeChart,
  type DashboardContext,
  DEFAULT_CHART_CONFIGS,
  GALLERY_PRESETS,
  type LiveTransaction,
  type SeriesChart,
} from "@budgee/core";
import {
  type BuildInput,
  buildChartConfig,
  fade,
  type Layout,
  type Palette,
  placeLabel,
} from "../src/dashboard/chart";

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

const ctx: DashboardContext = {
  today: "2026-11-17",
  dashboard: {
    period: "month",
    compare: "same_period_last_year",
    exclude: { categories: [], tags: [] },
  },
};

let n = 0;
function expense(date: string, units: number, category: string): LiveTransaction {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    hlc: "001763000000000:00000:dev-a",
    deleted: false,
    device: "dev-a",
    type: "expense",
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
  expense("2026-11-02", 4500, "Medical"),
  expense("2026-11-03", 3240, "Groceries"),
  expense("2026-11-04", 650, "Transport"),
  expense("2026-11-05", 400, "Eating out"),
  expense("2026-10-05", 26000, "Groceries"),
  expense("2025-11-04", 5600, "Groceries"),
  expense("2025-11-10", 1200, "Medical"),
];

const named = (name: string) => {
  const c = DEFAULT_CHART_CONFIGS.find((x) => x.name === name)?.config;
  if (!c) throw new Error(name);
  return c;
};
const preset = (key: string) => {
  const c = GALLERY_PRESETS.find((p) => p.key === key)?.config;
  if (!c) throw new Error(key);
  return c;
};

/** The Chart.js configuration as plain data, to read its options. */
function build(config: ChartConfig, layout: Layout) {
  const data = computeChart(config, ROWS, ctx) as SeriesChart;
  const input: BuildInput = {
    data,
    config,
    layout,
    palette,
    axisLabels: data.labels,
    titles: data.labels,
    names: { current: "2026", compare: "2025" },
    formatValue: String,
    formatTick: String,
    marks: null,
    reducedMotion: true,
  };
  // biome-ignore lint/suspicious/noExplicitAny: reading Chart.js options in a test
  return { data, chart: buildChartConfig(input) as any };
}

describe("buildChartConfig", () => {
  test("a line dashes the segment into the unfinished month only", () => {
    const { chart } = build(named("Expenses, this year vs last year"), "line");
    const dash = chart.data.datasets[0].segment.borderDash;
    expect(dash({ p1DataIndex: 10 })).toEqual([3, 3]); // into November (partial)
    expect(dash({ p1DataIndex: 9 })).toBeUndefined(); // September to October
    expect(chart.data.datasets[0].borderColor).toBe(palette.expense);
  });

  test("the comparison is drawn in --compare, in every layout", () => {
    const line = build(named("Expenses, this year vs last year"), "line").chart;
    expect(line.data.datasets[1].borderColor).toBe(palette.compare);
    const rows = build(named("By category vs last year"), "rows").chart;
    expect(rows.data.datasets[1]).toMatchObject({
      type: "line",
      pointStyle: "line",
      borderColor: palette.compare,
    });
    const columns = build(
      { ...preset("by_weekday"), compare: "same_period_last_year", period: "dashboard" },
      "columns",
    ).chart;
    expect(columns.data.datasets[1].backgroundColor).toBe(palette.compare);
  });

  test("rows never auto-pad, so the bands line up with the 40px HTML rows", () => {
    const { chart } = build(named("By category vs last year"), "rows");
    expect(chart.options.layout).toEqual({ autoPadding: false, padding: 0 });
    expect(chart.options.scales.y).toMatchObject({ display: false, offset: true });
  });

  test("the Other bucket is shaded by position: lighter bar, gray slice", () => {
    const limited = { ...preset("biggest_changes"), limit: 2 };
    const { data, chart } = build(limited, "rows");
    expect(data.hasOther).toBe(true);
    const colors: string[] = chart.data.datasets[0].backgroundColor;
    expect(colors.at(-1)).toBe(fade(palette.expense, 0.55));
    expect(colors.slice(0, -1).every((c) => c === palette.expense)).toBe(true);

    const ring = build({ ...preset("trip_total"), onlyTags: [], limit: 2 }, "doughnut").chart;
    expect(ring.data.datasets[0].backgroundColor.at(-1)).toBe(palette.compare);
  });

  test("a category literally named Other is not the Other bucket", () => {
    const rows = [...ROWS, expense("2026-11-06", 9000, "Other")];
    const config = preset("top_details");
    const data = computeChart({ ...config, groupBy: "category" }, rows, ctx) as SeriesChart;
    expect(data.labels[0]).toBe("Other");
    expect(data.hasOther).toBe(false);
  });
});

describe("placeLabel", () => {
  const area = { left: 0, right: 300, top: 0, bottom: 160 };
  const size = { width: 50, height: 12 };

  test("below the point when nothing is there", () => {
    expect(placeLabel(size, { x: 150, y: 50 }, [], area)).toMatchObject({ x: 125, y: 58 });
  });

  test("off its own line: a line rising into the point pushes the label clear of it", () => {
    // The line comes up from the bottom left into the point, through the spot below it.
    const line = [
      { x: 100, y: 150 },
      { x: 150, y: 60 },
    ];
    const box = placeLabel(size, { x: 150, y: 60 }, [line], area);
    for (let x = box.x; x <= box.x + box.width; x += 5) {
      const t = (x - 100) / 50;
      if (t < 0 || t > 1) continue;
      const y = 150 - 90 * t;
      expect(y < box.y - 2 || y > box.y + box.height + 2).toBe(true);
    }
  });

  test("never over a label already placed", () => {
    const first = placeLabel(size, { x: 150, y: 50 }, [], area);
    const second = placeLabel(size, { x: 150, y: 50 }, [], area, [first]);
    expect(second.y + second.height <= first.y || second.y >= first.y + first.height).toBe(true);
  });
});
