import { describe, expect, test } from "bun:test";
import {
  type ChartConfig,
  chartConfigSchema,
  computeChart,
  type DashboardContext,
  DEFAULT_CHART_CONFIGS,
  GALLERY_PRESETS,
  type LiveTransaction,
} from "@budgee/core";
import * as v from "valibot";
import {
  BLANK_CONFIG,
  type ChartDraft,
  COMPARES,
  changeConfig,
  compareApplies,
  cumulativeApplies,
  dashboardExclusionText,
  effectiveConfig,
  exclusionRows,
  GROUPINGS,
  groupingsFor,
  KINDS,
  latestTag,
  limitApplies,
  METRICS,
  metricApplies,
  metricsFor,
  newDraft,
  optionLabel,
  PERIODS,
  sameDraft,
  TEMPLATES,
  templateDescription,
  templateTitle,
  toggleExclusion,
} from "../src/dashboard/editor";
import { miniShapes } from "../src/dashboard/mini";

const base = (fields: Partial<ChartConfig>): ChartConfig => ({ ...BLANK_CONFIG, ...fields });

describe("option compatibility rules", () => {
  test("lines need an ordered axis: time groupings and weekdays", () => {
    expect(groupingsFor("line")).toEqual(["day", "month", "year", "weekday"]);
  });

  test("doughnuts are parts of a whole: no time groupings, additive metrics only", () => {
    expect(groupingsFor("doughnut")).toEqual(["category", "detail", "tag", "weekday"]);
    expect(metricsFor("doughnut")).toEqual(["expenses", "income", "count"]);
  });

  test("tables are time rows (income, expenses, kept), so time groupings only", () => {
    expect(groupingsFor("table")).toEqual(["day", "month", "year"]);
  });

  test("bars take every grouping and metric", () => {
    expect(groupingsFor("bar")).toEqual([...GROUPINGS]);
    expect(metricsFor("bar")).toEqual([...METRICS]);
  });

  test("a table shows income, expenses and kept whatever the metric", () => {
    expect(metricApplies(base({ kind: "table", groupBy: "year" }))).toBe(false);
    expect(metricApplies(base({ kind: "bar" }))).toBe(true);
  });

  test("a comparison needs a series chart and a period with a length", () => {
    expect(compareApplies(base({ kind: "bar", period: "dashboard" }))).toBe(true);
    expect(compareApplies(base({ kind: "line", groupBy: "month", period: "this_year" }))).toBe(
      true,
    );
    expect(compareApplies(base({ kind: "bar", period: "all_time" }))).toBe(false);
    expect(compareApplies(base({ kind: "doughnut" }))).toBe(false);
    expect(compareApplies(base({ kind: "table", groupBy: "year" }))).toBe(false);
  });

  test("a running total runs along time, on bars and lines", () => {
    expect(cumulativeApplies(base({ kind: "line", groupBy: "day" }))).toBe(true);
    expect(cumulativeApplies(base({ kind: "bar", groupBy: "month" }))).toBe(true);
    expect(cumulativeApplies(base({ kind: "bar", groupBy: "category" }))).toBe(false);
    expect(cumulativeApplies(base({ kind: "line", groupBy: "weekday" }))).toBe(false);
    expect(cumulativeApplies(base({ kind: "table", groupBy: "month" }))).toBe(false);
  });

  test("top N folds groups chosen by the data: category, detail, tag", () => {
    for (const groupBy of ["category", "detail", "tag"] as const)
      expect(limitApplies(base({ groupBy }))).toBe(true);
    for (const groupBy of ["day", "month", "year", "weekday"] as const)
      expect(limitApplies(base({ groupBy }))).toBe(false);
  });

  test("picking a kind moves the grouping and metric onto ones it takes", () => {
    const bars = base({ kind: "bar", metric: "difference", groupBy: "category" });
    expect(changeConfig(bars, { kind: "line" })).toMatchObject({
      kind: "line",
      groupBy: "month",
      metric: "difference",
    });
    expect(changeConfig(bars, { kind: "doughnut" })).toMatchObject({
      kind: "doughnut",
      groupBy: "category",
      metric: "expenses",
    });
    expect(changeConfig(bars, { kind: "table" })).toMatchObject({
      kind: "table",
      groupBy: "month",
    });
    // A grouping the new kind takes stays.
    const weekdays = base({ kind: "bar", groupBy: "weekday" });
    expect(changeConfig(weekdays, { kind: "line" }).groupBy).toBe("weekday");
  });

  test("income keeps a category grouping: income has categories too", () => {
    const byCategory = base({ groupBy: "category" });
    expect(changeConfig(byCategory, { metric: "income" }).groupBy).toBe("category");
  });

  test("the draft keeps what doesn't apply, the saved config drops it", () => {
    const draft = base({
      kind: "line",
      groupBy: "day",
      compare: "avg_12_months",
      cumulative: true,
    });
    const asTable = changeConfig(draft, { kind: "table" });
    // Switching back restores the comparison and running total.
    expect(asTable.compare).toBe("avg_12_months");
    expect(asTable.cumulative).toBe(true);
    expect(effectiveConfig(asTable)).toMatchObject({ compare: "none", cumulative: false });
    expect(effectiveConfig(changeConfig(asTable, { kind: "line" }))).toMatchObject({
      compare: "avg_12_months",
      cumulative: true,
    });

    const top = base({ groupBy: "detail", limit: 10 });
    expect(effectiveConfig(changeConfig(top, { groupBy: "month" })).limit).toBeUndefined();
    expect(effectiveConfig(top).limit).toBe(10);
    expect(effectiveConfig(base({ period: "all_time", compare: "previous_period" })).compare).toBe(
      "none",
    );
  });

  test("every default chart and template is already a valid combination", () => {
    for (const config of [
      ...DEFAULT_CHART_CONFIGS.map((c) => c.config),
      ...GALLERY_PRESETS.map((p) => p.config),
      ...TEMPLATES.map((p) => p.config),
      BLANK_CONFIG,
    ]) {
      expect(effectiveConfig(config)).toEqual(config);
    }
  });

  test("every combination the editor can produce is valid and computes", () => {
    const ctx: DashboardContext = {
      today: "2026-11-17",
      dashboard: {
        period: "month",
        compare: "same_period_last_year",
        exclude: { categories: [], tags: [] },
      },
    };
    const rows: LiveTransaction[] = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        hlc: "001763000000000:00000:dev-a",
        deleted: false,
        device: "dev-a",
        type: "expense",
        amount: 120000,
        date: "2026-11-03",
        category: "Groceries",
        detail: "Carrefour",
        note: "",
        tags: ["Istanbul 2026"],
        original_amount: null,
        original_currency: null,
        created_at: "2026-11-03T10:00:00.000Z",
      },
    ];
    let checked = 0;
    for (const kind of KINDS)
      for (const metric of metricsFor(kind))
        for (const groupBy of groupingsFor(kind))
          for (const period of PERIODS)
            for (const compare of COMPARES)
              for (const cumulative of [false, true])
                for (const limit of [undefined, 3]) {
                  const draft = base({ kind, metric, groupBy, period, compare, cumulative });
                  const config = effectiveConfig(limit ? { ...draft, limit } : draft);
                  expect(v.safeParse(chartConfigSchema, config).success).toBe(true);
                  expect(effectiveConfig(config)).toEqual(config);
                  const data = computeChart(config, rows, ctx);
                  expect(data.shape).toBe(kind === "table" ? "table" : "series");
                  if (data.shape === "series" && (kind === "doughnut" || compare === "none"))
                    expect(data.series).toHaveLength(1);
                  checked += 1;
                }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("fields dropped as having no effect really have none in core", () => {
  const ctx: DashboardContext = {
    today: "2026-11-17",
    dashboard: {
      period: "month",
      compare: "same_period_last_year",
      exclude: { categories: [], tags: [] },
    },
  };
  let n = 0;
  const entry = (date: string, units: number, category: string, detail: string) => {
    n += 1;
    return {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      hlc: "001763000000000:00000:dev-a",
      deleted: false as const,
      device: "dev-a",
      type: "expense" as const,
      amount: units * 100,
      date,
      category,
      detail,
      note: "",
      tags: [],
      original_amount: null,
      original_currency: null,
      created_at: `${date}T10:00:00.000Z`,
    };
  };
  const rows: LiveTransaction[] = [
    entry("2024-03-02", 50, "Bills", "Electricity"),
    entry("2025-11-04", 120, "Groceries", "Carrefour"),
    entry("2025-10-09", 30, "Transport", "Taxi"),
    entry("2026-10-12", 70, "Eating out", "Café"),
    entry("2026-11-03", 90, "Groceries", "Carrefour"),
    entry("2026-11-10", 40, "Medical", "Dentist"),
    entry("2026-11-15", 15, "Home", "IKEA"),
  ];
  const same = (a: ChartConfig, b: ChartConfig) =>
    expect(computeChart(a, rows, ctx)).toEqual(computeChart(b, rows, ctx));

  test("compare on a table, and on all_time", () => {
    for (const compare of COMPARES) {
      for (const groupBy of ["day", "month", "year"] as const)
        for (const period of PERIODS)
          same(
            base({ kind: "table", groupBy, period, compare }),
            base({ kind: "table", groupBy, period }),
          );
      for (const kind of ["bar", "line"] as const)
        for (const groupBy of ["month", "category", "weekday"] as const)
          same(
            base({ kind, groupBy, period: "all_time", compare }),
            base({ kind, groupBy, period: "all_time" }),
          );
    }
  });

  test("cumulative on a table", () => {
    for (const groupBy of ["day", "month", "year"] as const)
      same(base({ kind: "table", groupBy, cumulative: true }), base({ kind: "table", groupBy }));
  });

  test("limit on time and weekday groupings", () => {
    for (const kind of ["bar", "line"] as const)
      for (const groupBy of ["day", "month", "year", "weekday"] as const)
        for (const period of PERIODS)
          same(
            base({ kind, groupBy, period, compare: "same_period_last_year", limit: 1 }),
            base({ kind, groupBy, period, compare: "same_period_last_year" }),
          );
  });
});

describe("templates", () => {
  test("the gallery lists the mockup's ten suggestions in its order", () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual([
      "year_over_year",
      "kept_of_income",
      "by_tag",
      "month_pace",
      "trip_total",
      "biggest_changes",
      "top_details",
      "spending_calendar",
      "by_weekday",
      "income_sources",
    ]);
  });

  test("year over year and kept of income are the default charts' configs", () => {
    const named = (name: string) => DEFAULT_CHART_CONFIGS.find((c) => c.name === name)?.config;
    expect(TEMPLATES[0]?.config).toEqual(named("Expenses, this year vs last year") ?? BLANK_CONFIG);
    expect(TEMPLATES[1]?.config).toEqual(named("Kept of income") ?? BLANK_CONFIG);
    const preset = GALLERY_PRESETS.find((p) => p.key === "month_pace");
    expect(TEMPLATES.find((t) => t.key === "month_pace")?.config).toEqual(
      preset?.config ?? BLANK_CONFIG,
    );
  });

  test("a template opens as a draft with its title as the name and its config", () => {
    const draft = newDraft("month_pace", null);
    expect(draft).toEqual({
      name: "Month pace",
      config: GALLERY_PRESETS.find((p) => p.key === "month_pace")?.config ?? BLANK_CONFIG,
    });
    expect(newDraft("year_over_year", null).name).toBe("Year over year");
  });

  test("trip total starts on the latest trip's tag", () => {
    expect(newDraft("trip_total", "Istanbul 2026").config.onlyTags).toEqual(["Istanbul 2026"]);
    expect(newDraft("trip_total", null).config.onlyTags).toEqual([]);
    // Other templates don't filter on it.
    expect(newDraft("top_details", "Istanbul 2026").config.onlyTags).toEqual([]);
  });

  test("blank (or an unknown key) is an unnamed bar chart of expenses", () => {
    expect(newDraft(null, "Istanbul 2026")).toEqual({ name: "", config: BLANK_CONFIG });
    expect(newDraft("nope", null)).toEqual({ name: "", config: BLANK_CONFIG });
    expect(BLANK_CONFIG).toMatchObject({ kind: "bar", metric: "expenses", compare: "none" });
  });

  test("the latest tag is the newest tagged entry's first tag", () => {
    const entry = (date: string, tags: string[], deleted = false) => ({
      date,
      created_at: `${date}T09:00:00.000Z`,
      tags,
      deleted,
    });
    expect(latestTag([])).toBeNull();
    expect(
      latestTag([
        entry("2026-10-02", ["Wedding"]),
        entry("2026-11-03", ["Istanbul 2026", "Flights"]),
        entry("2026-11-10", []),
        entry("2026-11-12", ["Gone"], true),
      ]),
    ).toBe("Istanbul 2026");
  });

  test("a draft is unchanged when its saved form is", () => {
    const a: ChartDraft = { name: "Trips", config: base({ groupBy: "month", limit: 5 }) };
    const b: ChartDraft = { name: "Trips", config: base({ groupBy: "month" }) };
    expect(sameDraft(a, b)).toBe(true);
    expect(sameDraft(a, { ...b, name: "Trips " })).toBe(false);
    expect(sameDraft(a, { ...b, config: base({ groupBy: "day" }) })).toBe(false);
  });
});

describe("exclusions", () => {
  const dashboard = { categories: ["Medical"], tags: ["istanbul 2026"] };

  test("the hint says what the dashboard leaves out", () => {
    expect(dashboardExclusionText(dashboard, "en")).toBe(
      "Currently leaving out Medical and tag istanbul 2026",
    );
    expect(
      dashboardExclusionText({ categories: ["Medical", "Gifts"], tags: ["Wedding"] }, "en"),
    ).toBe("Currently leaving out Medical, Gifts, and tag Wedding");
    expect(dashboardExclusionText({ categories: [], tags: [] }, "en")).toBe(
      "The dashboard leaves nothing out right now",
    );
  });

  test("rows: dashboard exclusions are locked while used, the chart's own are unticked", () => {
    const chart = { categories: ["Gifts"], tags: [] };
    expect(exclusionRows("tags", ["Istanbul 2026", "Wedding"], chart, dashboard, true)).toEqual([
      { name: "Istanbul 2026", on: false, locked: true, note: "dashboard" },
      { name: "Wedding", on: true, locked: false, note: null },
    ]);
    expect(exclusionRows("tags", ["Istanbul 2026"], chart, dashboard, false)).toEqual([
      { name: "Istanbul 2026", on: true, locked: false, note: null },
    ]);
    expect(
      exclusionRows("categories", ["Groceries", "Gifts", "Medical"], chart, dashboard, true),
    ).toEqual([
      { name: "Groceries", on: true, locked: false, note: null },
      { name: "Gifts", on: false, locked: false, note: "here" },
      { name: "Medical", on: false, locked: true, note: "dashboard" },
    ]);
  });

  test("unticking leaves a name out of this chart; ticking it again counts it", () => {
    const none = { categories: [], tags: [] };
    const out = toggleExclusion(none, "categories", "Gifts");
    expect(out).toEqual({ categories: ["Gifts"], tags: [] });
    expect(toggleExclusion(out, "categories", "Gifts")).toEqual(none);
    // Tags match ignoring case.
    expect(toggleExclusion({ ...none, tags: ["Wedding"] }, "tags", "wedding")).toEqual(none);
  });
});

describe("labels", () => {
  test("every option and template has its words in en.json", () => {
    const texts = [
      ...KINDS.map(optionLabel.kind),
      ...METRICS.map(optionLabel.metric),
      ...GROUPINGS.map(optionLabel.groupBy),
      ...PERIODS.map(optionLabel.period),
      ...COMPARES.map(optionLabel.compare),
      ...TEMPLATES.flatMap((tpl) => [templateTitle(tpl.key), templateDescription(tpl.key)]),
    ];
    for (const text of texts) expect(text).not.toMatch(/^(chartEdit|addChart)\./);
    expect(optionLabel.metric("kept_ratio")).toBe("Kept of income");
    expect(optionLabel.compare("same_period_last_year")).toBe("Last year");
  });
});

describe("gallery previews", () => {
  const series = (values: (number | null)[], compare?: (number | null)[]) => ({
    shape: "series" as const,
    labels: values.map((_, i) => String(i)),
    hasOther: false,
    window: { start: "2026-11-01", end: "2026-11-17" },
    partial: true,
    compareWindows: [],
    series: [
      {
        key: "current" as const,
        role: "current" as const,
        values,
        partial: values.map(() => false),
        projected: values.map(() => null),
      },
      ...(compare
        ? [
            {
              key: "compare" as const,
              role: "compare" as const,
              values: compare,
              partial: compare.map(() => false),
              projected: compare.map(() => null),
            },
          ]
        : []),
    ],
  });

  test("a line breaks at missing values and draws the comparison under it", () => {
    const shapes = miniShapes(
      series([10, 20, null, 30, 40], [5, 5, 5, 5, 5]),
      base({ kind: "line", groupBy: "month" }),
    );
    expect(shapes.map((s) => s.type === "polyline" && s.role)).toEqual([
      "compare",
      "current",
      "current",
    ]);
  });

  test("a doughnut's arcs add up to the whole ring", () => {
    const shapes = miniShapes(series([30, 10]), base({ kind: "doughnut" }));
    const lengths = shapes.map((s) => (s.type === "arc" ? Number(s.dash.split(" ")[0]) : 0));
    expect(lengths[0] ?? 0).toBeCloseTo(3 * (lengths[1] ?? 0), 0);
    expect((lengths[0] ?? 0) + (lengths[1] ?? 0)).toBeCloseTo(2 * Math.PI * 19, 0);
  });

  test("list groupings are at most four bars with a tick for the compared value", () => {
    const shapes = miniShapes(series([50, 40, 30, 20, 10], [25, 0, 0, 0, 0]), base({}));
    expect(shapes.filter((s) => s.type === "rect")).toHaveLength(4);
    expect(shapes.filter((s) => s.type === "tick")).toHaveLength(4);
    expect(shapes[0]).toMatchObject({ type: "rect", width: 120 });
  });

  test("nothing to draw gives no shapes", () => {
    expect(miniShapes(series([0, 0]), base({}))).toEqual([]);
    expect(
      miniShapes(
        {
          shape: "table",
          rows: [],
          hasOther: false,
          window: { start: "2026-01-01", end: "2026-01-01" },
        },
        base({ kind: "table", groupBy: "year" }),
      ),
    ).toEqual([]);
  });
});
