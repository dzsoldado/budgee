// The chart editor's rules: which options go together, the gallery templates, and the rows of
// the "What this chart counts" lists. Pure functions, tested without a browser.
//
// Which combinations are offered is a product rule: core `computeChart` accepts every
// combination the schema allows, but some draw nothing useful. Where a dropped field has no
// effect in core at all, a test says so (compare on tables and all_time, cumulative on tables,
// limit on time and weekday groupings); the others are choices:
// - kind: a line needs an ordered axis (day, month, year, weekday). A doughnut is parts of a
//   whole: groups that aren't time (a time axis has empty future buckets), and only additive,
//   never-negative metrics (expenses, income, count). A table is time rows of income, expenses
//   and kept ratio (day, month, year), whatever the metric. Bars take everything.
// - compare: only bars and lines draw a compared series (core still computes one for a
//   doughnut, which ChartView doesn't draw); all_time has no length to step back by.
// - cumulative: a running total runs along time: day, month or year, on bars and lines. Core
//   would also run it across categories or weekdays, which reads as nothing.
// - limit: folds the groups the data chooses (category, detail, tag).
// The draft keeps a value that stops applying (compare, cumulative, limit), so switching back
// restores it; `effectiveConfig` is what is previewed and saved.
import {
  type ChartConfig,
  chartConfigSchema,
  DEFAULT_CHART_CONFIGS,
  type Exclusions,
  GALLERY_PRESETS,
  sameTag,
} from "@budgee/core";
import * as v from "valibot";
import { type MessageKey, t } from "../i18n";

export type Kind = ChartConfig["kind"];
export type Metric = ChartConfig["metric"];
export type GroupBy = ChartConfig["groupBy"];
export type ChartPeriod = ChartConfig["period"];
export type ChartCompare = ChartConfig["compare"];

export const KINDS: readonly Kind[] = ["bar", "line", "doughnut", "table"];
export const METRICS: readonly Metric[] = [
  "expenses",
  "income",
  "difference",
  "kept_ratio",
  "count",
];
/** In the order ChartEdit.dc.html lists them, with day and year next to month. */
export const GROUPINGS: readonly GroupBy[] = [
  "category",
  "day",
  "month",
  "year",
  "detail",
  "tag",
  "weekday",
];
export const PERIODS: readonly ChartPeriod[] = [
  "dashboard",
  "last_12_months",
  "this_year",
  "all_time",
];
export const COMPARES: readonly ChartCompare[] = [
  "same_period_last_year",
  "previous_period",
  "avg_12_months",
  "none",
];
/** Top N choices; a stored value not in the list is offered too. */
export const LIMITS: readonly number[] = [3, 5, 10, 15, 20];

const isTime = (g: GroupBy) => g === "day" || g === "month" || g === "year";
const isOpen = (g: GroupBy) => g === "category" || g === "detail" || g === "tag";
const isSeries = (kind: Kind) => kind === "bar" || kind === "line";

const TAKES: Record<Kind, (g: GroupBy) => boolean> = {
  bar: () => true,
  line: (g) => isTime(g) || g === "weekday",
  doughnut: (g) => !isTime(g),
  table: isTime,
};

export function groupingsFor(kind: Kind): GroupBy[] {
  return GROUPINGS.filter(TAKES[kind]);
}

export function metricsFor(kind: Kind): Metric[] {
  return kind === "doughnut"
    ? METRICS.filter((m) => m === "expenses" || m === "income" || m === "count")
    : [...METRICS];
}

/** A table shows income, expenses and kept ratio; the metric changes nothing there. */
export const metricApplies = (c: ChartConfig) => c.kind !== "table";
export const compareApplies = (c: ChartConfig) => isSeries(c.kind) && c.period !== "all_time";
export const cumulativeApplies = (c: ChartConfig) => isSeries(c.kind) && isTime(c.groupBy);
export const limitApplies = (c: ChartConfig) => isOpen(c.groupBy);

/** The grouping a kind falls back to when the current one doesn't suit it. */
const FALLBACK: Record<Kind, readonly GroupBy[]> = {
  bar: ["category"],
  line: ["month"],
  doughnut: ["category"],
  table: ["month"],
};

/** `config` with `patch`, then the metric and grouping moved onto ones the kind takes. */
export function changeConfig(config: ChartConfig, patch: Partial<ChartConfig>): ChartConfig {
  const next = { ...config, ...patch };
  if (!metricsFor(next.kind).includes(next.metric)) next.metric = "expenses";
  const groups = groupingsFor(next.kind);
  if (!groups.includes(next.groupBy))
    next.groupBy = FALLBACK[next.kind].find((g) => groups.includes(g)) ?? groups[0] ?? "month";
  return next;
}

/** What is previewed and saved: the draft without what doesn't apply, checked by core. */
export function effectiveConfig(draft: ChartConfig): ChartConfig {
  const { limit, ...fitted } = changeConfig(draft, {});
  const config: ChartConfig = {
    ...fitted,
    compare: compareApplies(fitted) ? fitted.compare : "none",
    cumulative: cumulativeApplies(fitted) ? fitted.cumulative : false,
  };
  if (limit !== undefined && limitApplies(fitted)) config.limit = limit;
  return v.parse(chartConfigSchema, config);
}

// ─── Drafts and templates ───────────────────────────────────────────────────

export interface ChartDraft {
  name: string;
  config: ChartConfig;
}

/** Equal once saved: the same name and the same effective config. */
export function sameDraft(a: ChartDraft, b: ChartDraft): boolean {
  return (
    a.name === b.name &&
    JSON.stringify(effectiveConfig(a.config)) === JSON.stringify(effectiveConfig(b.config))
  );
}

/** "Blank chart": expenses by category over the dashboard's period, nothing compared. */
export const BLANK_CONFIG: ChartConfig = {
  kind: "bar",
  metric: "expenses",
  groupBy: "category",
  period: "dashboard",
  compare: "none",
  cumulative: false,
  onlyTags: [],
  exclude: { categories: [], tags: [] },
  useDashboardExclusions: true,
};

export interface Template {
  /** Also names its title and description in en.json (`addChart.<key>`). */
  key: string;
  config: ChartConfig;
}

function defaultConfig(name: string): ChartConfig {
  const found = DEFAULT_CHART_CONFIGS.find((c) => c.name === name);
  if (!found) throw new Error(`Default chart "${name}" is missing`);
  return found.config;
}

function presetConfig(key: string): ChartConfig {
  const found = GALLERY_PRESETS.find((p) => p.key === key);
  if (!found) throw new Error(`Gallery preset "${key}" is missing`);
  return found.config;
}

/** The Add chart suggestions, in AddChart.dc.html's order: two default charts, then the presets. */
export const TEMPLATES: readonly Template[] = [
  { key: "year_over_year", config: defaultConfig("Expenses, this year vs last year") },
  { key: "kept_of_income", config: defaultConfig("Kept of income") },
  ...[
    "by_tag",
    "month_pace",
    "trip_total",
    "biggest_changes",
    "top_details",
    "spending_calendar",
    "by_weekday",
    "income_sources",
  ].map((key) => ({ key, config: presetConfig(key) })),
];

/** `month_pace` → `monthPace`: en.json keys are camelCase. */
const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export const templateTitle = (key: string) => t(`addChart.${camel(key)}` as MessageKey);
export const templateDescription = (key: string) => t(`addChart.${camel(key)}Hint` as MessageKey);

/** The editor's names for each option. */
export const optionLabel = {
  kind: (kind: Kind) => t(`chartEdit.kinds.${kind}` as MessageKey),
  metric: (metric: Metric) => t(`chartEdit.metrics.${camel(metric)}` as MessageKey),
  groupBy: (groupBy: GroupBy) => t(`chartEdit.groups.${groupBy}` as MessageKey),
  period: (period: ChartPeriod) => t(`chartEdit.periods.${camel(period)}` as MessageKey),
  compare: (compare: ChartCompare) => t(`chartEdit.compares.${camel(compare)}` as MessageKey),
};

/**
 * The editor's starting point for a template (named by its gallery title), or a blank chart
 * for null or an unknown key. Trip total starts on `tripTag`, the latest trip's tag, if any.
 */
export function newDraft(key: string | null, tripTag: string | null): ChartDraft {
  const template = TEMPLATES.find((tpl) => tpl.key === key);
  if (!template) return { name: "", config: BLANK_CONFIG };
  const config =
    template.key === "trip_total" && tripTag !== null
      ? { ...template.config, onlyTags: [tripTag] }
      : template.config;
  return { name: templateTitle(template.key), config };
}

/** An entry row, live or a tombstone (which has none of the fields). */
interface EntryRow {
  deleted: boolean;
  date?: string;
  created_at?: string;
  tags?: readonly string[];
}

/** The newest tagged live entry's first tag: the trip a Trip total most likely means. */
export function latestTag(entries: readonly EntryRow[]): string | null {
  let latest: { date: string; created_at: string; tag: string } | null = null;
  for (const { deleted, date, created_at, tags } of entries) {
    const tag = tags?.[0];
    if (deleted || tag === undefined || date === undefined || created_at === undefined) continue;
    if (!latest || date > latest.date || (date === latest.date && created_at > latest.created_at))
      latest = { date, created_at, tag };
  }
  return latest?.tag ?? null;
}

// ─── What this chart counts ─────────────────────────────────────────────────

export type ExclusionList = keyof Exclusions;

export interface ExclusionRow {
  name: string;
  /** Counted by this chart. */
  on: boolean;
  /** Left out by the dashboard (while the chart uses its exclusions): not changeable here. */
  locked: boolean;
  /** Why it is unticked: left out on the dashboard, or here. */
  note: "dashboard" | "here" | null;
}

const has = (list: ExclusionList, names: readonly string[], name: string) =>
  list === "tags" ? names.some((n) => sameTag(n, name)) : names.includes(name);

export function exclusionRows(
  list: ExclusionList,
  names: readonly string[],
  chart: Exclusions,
  dashboard: Exclusions,
  useDashboard: boolean,
): ExclusionRow[] {
  return names.map((name) => {
    if (useDashboard && has(list, dashboard[list], name))
      return { name, on: false, locked: true, note: "dashboard" };
    if (has(list, chart[list], name)) return { name, on: false, locked: false, note: "here" };
    return { name, on: true, locked: false, note: null };
  });
}

/** Leaves `name` out of the chart, or counts it again when it already was. */
export function toggleExclusion(
  exclude: Exclusions,
  list: ExclusionList,
  name: string,
): Exclusions {
  const current = exclude[list];
  const same = list === "tags" ? sameTag : (a: string, b: string) => a === b;
  return {
    ...exclude,
    [list]: has(list, current, name) ? current.filter((n) => !same(n, name)) : [...current, name],
  };
}

/** The hint under "Use dashboard exclusions": "Currently leaving out Medical and tag Istanbul 2026". */
export function dashboardExclusionText(exclude: Exclusions, locale: string): string {
  const items = [
    ...exclude.categories,
    ...exclude.tags.map((name) => t("chartEdit.tagItem", { name })),
  ];
  if (items.length === 0) return t("chartEdit.dashboardNothing");
  const list = new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
  return t("chartEdit.dashboardLeavingOut", { list });
}
