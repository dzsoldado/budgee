// Words and numbers for the Dashboard: period titles and navigation, comparison options, series
// names, group labels, chart subtitles and KPI texts. Pure (locale and formatters passed in), so
// they are tested without a browser. All aggregation is in core; this only describes results.
import {
  type ChartConfig,
  type Compare,
  comparisonWindows,
  type DashboardContext,
  type DashboardSettings,
  type DateWindow,
  type Kpi,
  resolvePeriod,
  type SeriesChart,
  type TableChart,
} from "@budgee/core";
import { t } from "../i18n";
import { formatPlainDate } from "../i18n/format";
import { parseIsoDate } from "../lib/date";
import { monthTitle, shiftMonth } from "../list/month";

export type Period = DashboardSettings["period"];

// ─── Period navigation ──────────────────────────────────────────────────────

/** "November 2026" or "2026". `month` is the `YYYY-MM` being viewed. */
export function periodTitle(month: string, period: Period, locale: string): string {
  return period === "month" ? monthTitle(month, locale) : month.slice(0, 4);
}

/** The viewed month moved by one period (a month, or a year in the year view). */
export function shiftPeriod(month: string, period: Period, delta: number): string {
  return shiftMonth(month, period === "month" ? delta : 12 * delta);
}

/** Whether the next period has started (no navigating into the future). */
export function hasNextPeriod(month: string, period: Period, today: string): boolean {
  const next = shiftPeriod(month, period, 1);
  return period === "month" ? next <= today.slice(0, 7) : next.slice(0, 4) <= today.slice(0, 4);
}

// ─── Dates ──────────────────────────────────────────────────────────────────

const utc = (date: string) => parseIsoDate(date).getTime();

/** An inclusive window as a range, "Nov 1 – 17, 2025" in `en` (the locale decides the order). */
export function formatRange(
  window: DateWindow,
  locale: string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
): string {
  const format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
  return window.start === window.end
    ? format.format(utc(window.start))
    : format.formatRange(utc(window.start), utc(window.end));
}

/** Days in an inclusive window. */
export function daysIn(window: DateWindow): number {
  return Math.round((utc(window.end) - utc(window.start)) / 86_400_000) + 1;
}

// ─── Comparison selector ────────────────────────────────────────────────────

export const COMPARE_OPTIONS: readonly Compare[] = [
  "same_period_last_year",
  "previous_period",
  "avg_12_months",
  "none",
];

/** The option's name: "Same days last year", "Previous month", … (its days are said apart). */
export function compareOptionLabel(compare: Compare, period: Period): string {
  switch (compare) {
    case "same_period_last_year":
      return t("dashboard.compareLastYear");
    case "previous_period":
      return period === "month"
        ? t("dashboard.comparePreviousMonth")
        : t("dashboard.comparePreviousYear");
    case "avg_12_months":
      return t("dashboard.compareAverage");
    case "none":
      return t("dashboard.compareNone");
  }
}

/**
 * The days compared, under the selector: "Nov 1 – 17, 2026 against Nov 1 – 17, 2025". In the
 * year view, Same days last year and Previous year name the same days, and say so by naming
 * them. Null without a comparison.
 */
export function compareRangeText(ctx: DashboardContext, locale: string): string | null {
  const period = resolvePeriod("dashboard", ctx);
  const compare = ctx.dashboard.compare;
  const windows = comparisonWindows(period, period.months, compare, !period.partial);
  const [first] = windows;
  if (!first) return null;
  const current = formatRange(period, locale);
  if (windows.length > 1) return t("dashboard.compareRangeAverage", { current });
  return t("dashboard.compareRange", { current, compare: formatRange(first, locale) });
}

// ─── Series names ───────────────────────────────────────────────────────────

const sameMonth = (w: DateWindow) => w.start.slice(0, 7) === w.end.slice(0, 7);
const sameYear = (w: DateWindow) => w.start.slice(0, 4) === w.end.slice(0, 4);

/**
 * Short names for a chart's two series, as its legend says them: years ("2026", "2025") when
 * the windows are the same month or the same year apart; months ("Nov", "Oct") for consecutive
 * months; "12-month average" for the average; else the ranges.
 */
export function seriesNames(
  data: Pick<SeriesChart, "window" | "compareWindows">,
  locale: string,
): { current: string; compare: string } {
  const cur = data.window;
  const [cmp] = data.compareWindows;
  const range = (w: DateWindow) => formatRange(w, locale, { month: "short", year: "numeric" });
  const own = sameMonth(cur)
    ? formatPlainDate(cur.start, locale, { month: "short", year: "numeric" })
    : sameYear(cur)
      ? cur.start.slice(0, 4)
      : range(cur);
  if (cmp === undefined) return { current: own, compare: "" };
  if (data.compareWindows.length > 1) return { current: own, compare: t("dashboard.average12") };
  const years = { current: cur.start.slice(0, 4), compare: cmp.start.slice(0, 4) };
  if (sameMonth(cur) && sameMonth(cmp)) {
    if (cur.start.slice(5, 7) === cmp.start.slice(5, 7)) return years;
    const sameYears = cur.start.slice(0, 4) === cmp.start.slice(0, 4);
    const options: Intl.DateTimeFormatOptions = sameYears
      ? { month: "short" }
      : { month: "short", year: "numeric" };
    return {
      current: formatPlainDate(cur.start, locale, options),
      compare: formatPlainDate(cmp.start, locale, options),
    };
  }
  if (sameYear(cur) && sameYear(cmp)) return years;
  return { current: range(cur), compare: range(cmp) };
}

// ─── Group labels ───────────────────────────────────────────────────────────

type GroupBy = ChartConfig["groupBy"];
/** 2024-01-01 was a Monday: ISO weekday n is 2024-01-0n. */
const weekdayDate = (key: string) => `2024-01-0${key}`;

/**
 * A group key as people read it. `axis` is the short form under a chart (month initials when
 * `narrow`, day numbers); without it, the full form for tooltips and tables. The "Other" bucket
 * is the last label when `hasOther` (never judged by its text: a category can be named Other).
 */
export function groupLabel(
  key: string,
  groupBy: GroupBy,
  locale: string,
  { axis = false, narrow = false, other = false } = {},
): string {
  if (other) return t("dashboard.other");
  switch (groupBy) {
    case "day":
      return axis
        ? String(Number(key.slice(8, 10)))
        : formatPlainDate(key, locale, { day: "numeric", month: "short", year: "numeric" });
    case "month":
      return formatPlainDate(
        `${key}-01`,
        locale,
        axis ? { month: narrow ? "narrow" : "short" } : { month: "long", year: "numeric" },
      );
    case "year":
      return key;
    case "weekday":
      return formatPlainDate(weekdayDate(key), locale, {
        weekday: axis && narrow ? "narrow" : axis ? "short" : "long",
      });
    case "category":
      return key;
    case "detail":
      return key === "" ? t("dashboard.noDetail") : key;
    case "tag":
      return key === "" ? t("dashboard.noTag") : key;
  }
}

export const isTimeGroup = (g: GroupBy) => g === "day" || g === "month" || g === "year";
/** Category-like groups are drawn as horizontal bars, labels at the start of each row. */
export const isListGroup = (g: GroupBy) => !isTimeGroup(g) && g !== "weekday";

// ─── Numbers ────────────────────────────────────────────────────────────────

/** Money in charts and tables switches to thousands from 10,000 (main currency units). */
export const THOUSANDS_FROM = 1_000_000;

export function usesThousands(values: readonly (number | null)[]): boolean {
  return values.some((v) => v !== null && Math.abs(v) >= THOUSANDS_FROM);
}

/** Hundredths in whole thousands of units, half away from zero: 2_345_000 → 23. */
export function toThousands(hundredths: number): number {
  const sign = hundredths < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(hundredths) / 100_000);
}

/** A whole number in `locale`, minus as U+2212. */
export function formatInteger(n: number, locale: string, signAlways = false): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    signDisplay: signAlways ? "exceptZero" : "auto",
  })
    .format(n)
    .replace("-", "−");
}

/** "23k" */
export function formatThousands(hundredths: number, locale: string): string {
  return t("dashboard.thousands", { n: formatInteger(toThousands(hundredths), locale) });
}

/** A fraction as a whole percentage: 0.6 → "60%". */
export function formatPercent(fraction: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 })
    .format(fraction)
    .replace("-", "−");
}

// ─── Subtitles ──────────────────────────────────────────────────────────────

const noFilters = (config: ChartConfig) =>
  config.onlyTags.length === 0 &&
  config.exclude.categories.length === 0 &&
  config.exclude.tags.length === 0;

/** "Same window each year: Jan 1 – Nov 17 · all entries" for a year table; else the window. */
export function tableSubtitle(data: TableChart, config: ChartConfig, locale: string): string {
  const parts: string[] = [];
  const last = data.rows.at(-1);
  if (config.groupBy === "year" && last) {
    const range = formatRange(last.window, locale, { day: "numeric", month: "short" });
    parts.push(t("dashboard.sameWindow", { range }));
  } else {
    parts.push(formatRange(data.window, locale));
  }
  if (!config.useDashboardExclusions && noFilters(config)) parts.push(t("dashboard.allEntries"));
  return parts.join(" · ");
}

/** The current series' partial bucket (the unfinished month of a monthly chart), if any. */
export function partialIndex(data: SeriesChart): number {
  const current = data.series.find((s) => s.role === "current");
  if (!current) return -1;
  return current.partial.findIndex((p, i) => p && current.projected[i] !== null);
}

/**
 * The line under a chart's title: what a value is (per month, in thousands DZD; share of income
 * kept; a running total), then the projection of an unfinished bucket ("Nov projected from 17
 * days"), or, for a list of bars, the days counted and which mark is which period.
 */
export function seriesSubtitle(
  data: SeriesChart,
  config: ChartConfig,
  { locale, currency, thousands }: { locale: string; currency: string; thousands: boolean },
): string {
  const unit =
    config.metric === "kept_ratio"
      ? t("dashboard.unitKept")
      : config.metric === "count"
        ? t("dashboard.unitCount")
        : thousands
          ? t("dashboard.unitThousands", { currency })
          : currency;
  const parts: string[] = [];
  if (isTimeGroup(config.groupBy) || config.groupBy === "weekday") {
    const per = {
      day: "dashboard.perDay",
      month: "dashboard.perMonth",
      year: "dashboard.perYear",
      weekday: "dashboard.perWeekday",
    } as const;
    const what = config.cumulative
      ? t("dashboard.runningTotal")
      : t(per[config.groupBy as keyof typeof per]);
    parts.push(`${what}, ${unit}`);
    if (config.groupBy === "weekday") parts.push(formatRange(data.window, locale));
  } else {
    // Each group's value is written out next to it, so no unit here.
    parts.push(formatRange(data.window, locale));
  }
  const i = partialIndex(data);
  if (i >= 0 && config.kind !== "doughnut") {
    const key = data.labels[i] ?? "";
    const bucketStart = config.groupBy === "month" ? `${key}-01` : `${key}-01-01`;
    const from = bucketStart > data.window.start ? bucketStart : data.window.start;
    parts.push(
      t("dashboard.projectedFrom", {
        bucket: groupLabel(key, config.groupBy, locale, { axis: true }),
        days: daysIn({ start: from, end: data.window.end }),
      }),
    );
  }
  if (isListGroup(config.groupBy) && config.kind === "bar" && data.compareWindows.length > 0) {
    const names = seriesNames(data, locale);
    parts.push(t("dashboard.barAndTick", { current: names.current, compare: names.compare }));
  }
  return parts.join(" · ");
}

// ─── KPI cards ──────────────────────────────────────────────────────────────

export interface KpiText {
  label: string;
  value: string;
  /** "−5%", "−40", "+9 pts"; null when there is nothing to compare. */
  delta: string | null;
  /** "vs 13,650", "vs 803 a day", "vs 51%"; null without a comparison. */
  vs: string | null;
}

export function kpiText(
  kpi: Kpi,
  {
    locale,
    money,
    excluding,
    comparing,
  }: {
    locale: string;
    money: (hundredths: number, signAlways?: boolean) => string;
    /** The dashboard leaves something out: Expenses reads "Expenses (filtered)". */
    excluding: boolean;
    comparing: boolean;
  },
): KpiText {
  const label = {
    expenses: excluding ? t("dashboard.kpiExpensesFiltered") : t("dashboard.kpiExpenses"),
    per_day: t("dashboard.kpiPerDay"),
    income: t("dashboard.kpiIncome"),
    kept_ratio: t("dashboard.kpiKept"),
  }[kpi.key];
  const show = (v: number | null) =>
    v === null
      ? t("dashboard.none")
      : kpi.key === "kept_ratio"
        ? formatPercent(v, locale)
        : money(v);
  let delta: string | null = null;
  if (kpi.delta !== null) {
    if (kpi.deltaKind === "percent")
      delta = `${formatInteger(Math.round(kpi.delta * 100), locale, true)}%`;
    else if (kpi.deltaKind === "points")
      delta = t("dashboard.points", {
        n: formatInteger(Math.round(kpi.delta * 100), locale, true),
      });
    else delta = money(kpi.delta, true);
  }
  let vs: string | null = null;
  if (comparing) {
    vs =
      kpi.key === "per_day" && kpi.compare !== null
        ? t("dashboard.vsPerDay", { value: show(kpi.compare) })
        : t("dashboard.vs", { value: show(kpi.compare) });
  }
  return { label, value: show(kpi.value), delta, vs };
}
