// Dashboard filters and aggregation: periods, comparison windows, exclusions, grouping, KPI
// cards. Pure functions; "today" is always passed in. Dates stay `YYYY-MM-DD` strings and all
// date math is UTC arithmetic on the plain date, so the device's time zone never shifts a day.
// Only `amount` (main currency, hundredths) is summed; original amounts never enter totals.
import type {
  ChartConfig,
  Compare,
  DashboardSettings,
  Exclusions,
  LiveTransaction,
  TransactionRow,
} from "./schema";
import { listTags, tagKey, uniqueTags } from "./tags";

// ─── Plain-date arithmetic ──────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const ymd = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

function parts(date: string): [number, number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

/** Days since 1970-01-01. */
function dayNumber(date: string): number {
  const [y, m, d] = parts(date);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

function fromDayNumber(n: number): string {
  const t = new Date(n * DAY_MS);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function daysInMonth(y: number, m: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
}

/** Moves by whole months, clamping the day to the target month (31 Mar − 1 → 28 Feb). */
function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return ymd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
function monthEnd(date: string): string {
  const [y, m] = parts(date);
  return ymd(y, m, daysInMonth(y, m));
}

/** Days in an inclusive window; 0 when it is empty (end before start). */
function dayCount(w: DateWindow): number {
  return Math.max(0, dayNumber(w.end) - dayNumber(w.start) + 1);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. 1970-01-01 was a Thursday. */
function isoWeekday(date: string): number {
  return ((((dayNumber(date) + 3) % 7) + 7) % 7) + 1;
}

// ─── Periods ────────────────────────────────────────────────────────────────

/** Inclusive `YYYY-MM-DD` bounds. Empty when `end` is before `start`. */
export interface DateWindow {
  start: string;
  end: string;
}

export interface DashboardContext {
  /** `YYYY-MM-DD`. Always injected, so results never depend on the clock. */
  today: string;
  /** The dashboard's view (month or year), comparison and exclusions. */
  dashboard: DashboardSettings;
  /** A day inside the month or year the dashboard shows (its navigation); defaults to today. */
  ref?: string;
}

export interface ResolvedPeriod {
  /** First day of the period. */
  start: string;
  /** Last day counted: the period's last day, or today while the period is unfinished. */
  end: string;
  /** The period's natural last day; a time chart's axis runs to here. */
  fullEnd: string;
  /** Unfinished: counted only up to today. */
  partial: boolean;
  /** Length in months, what `previous_period` steps back by; null for all_time (no comparison). */
  months: number | null;
}

/**
 * The window a chart period covers. Entries dated after today are never counted.
 * - `dashboard`: the month or year being viewed (`ctx.ref`, at most today).
 * - `last_12_months`: the current calendar month and the 11 before it.
 * - `this_year`: 1 January to 31 December of today's year.
 * - `all_time`: `earliest` (the first entry) to today.
 * - `month` / `year`: the month `periodRef` (`YYYY-MM`) names, or its year (at most today's;
 *   today's month or year without one).
 */
export function resolvePeriod(
  period: ChartConfig["period"],
  ctx: DashboardContext,
  earliest: string = ctx.today,
  periodRef?: string,
): ResolvedPeriod {
  const today = ctx.today;
  const span = (start: string, fullEnd: string, months: number | null): ResolvedPeriod => {
    const end = fullEnd < today ? fullEnd : today;
    return { start, end, fullEnd, partial: end < fullEnd, months };
  };
  const yearOf = (date: string) => date.slice(0, 4);
  switch (period) {
    case "dashboard": {
      // A day after today shows the current period, so the window is never inverted.
      const ref = ctx.ref !== undefined && ctx.ref < today ? ctx.ref : today;
      return ctx.dashboard.period === "month"
        ? span(monthStart(ref), monthEnd(ref), 1)
        : span(`${yearOf(ref)}-01-01`, `${yearOf(ref)}-12-31`, 12);
    }
    case "last_12_months":
      return span(addMonths(monthStart(today), -11), monthEnd(today), 12);
    case "this_year":
      return span(`${yearOf(today)}-01-01`, `${yearOf(today)}-12-31`, 12);
    case "all_time":
      return span(earliest < today ? earliest : today, today, null);
    case "month":
    case "year": {
      const ref = periodRef !== undefined && `${periodRef}-01` < today ? `${periodRef}-01` : today;
      return period === "month"
        ? span(monthStart(ref), monthEnd(ref), 1)
        : span(`${yearOf(ref)}-01-01`, `${yearOf(ref)}-12-31`, 12);
    }
  }
}

export interface ComparisonWindow extends DateWindow {
  /** How many months before the compared window this one lies. */
  monthsBack: number;
}

/**
 * The windows a period is compared with: one for `previous_period` and
 * `same_period_last_year`, twelve (one per previous month, averaged) for `avg_12_months`,
 * none for `none` or a period without a length (`all_time`).
 *
 * Each is the window moved back by whole months, with a day that does not exist in the target
 * month clamped (29 Feb → 28 Feb). An unfinished period keeps the same number of days
 * (1–17 Nov 2026 with 1–17 Nov 2025; 1 Jan – 28 Feb 2025 with 1 Jan – 28 Feb 2024). A whole
 * period (`wholePeriod`: the window ends on its period's last day) is compared with the whole
 * earlier period: all of September with all of August, all of February 2025 with all of
 * February 2024.
 */
export function comparisonWindows(
  window: DateWindow,
  periodMonths: number | null,
  compare: Compare,
  wholePeriod: boolean,
): ComparisonWindow[] {
  if (compare === "none" || periodMonths === null) return [];
  const back = (monthsBack: number): ComparisonWindow => {
    const end = addMonths(window.end, -monthsBack);
    return {
      start: addMonths(window.start, -monthsBack),
      end: wholePeriod ? monthEnd(end) : end,
      monthsBack,
    };
  };
  switch (compare) {
    case "previous_period":
      return [back(periodMonths)];
    case "same_period_last_year":
      return [back(12)];
    case "avg_12_months":
      return Array.from({ length: 12 }, (_, i) => back(i + 1));
  }
}

const plainWindow = ({ start, end }: DateWindow): DateWindow => ({ start, end });

/**
 * The earliest date the KPI cards and `charts` read, comparisons included, so a caller can load
 * only entries from there on; null when one of them needs every entry (all_time).
 */
export function dataStart(charts: readonly ChartConfig[], ctx: DashboardContext): string | null {
  const needs: Pick<ChartConfig, "period" | "compare" | "periodRef">[] = [
    { period: "dashboard", compare: ctx.dashboard.compare },
    ...charts,
  ];
  let start: string | null = null;
  for (const { period, compare, periodRef } of needs) {
    if (period === "all_time") return null;
    const p = resolvePeriod(period, ctx, ctx.today, periodRef);
    for (const w of [p, ...comparisonWindows(p, p.months, compare, false)])
      if (start === null || w.start < start) start = w.start;
  }
  return start;
}

// ─── Filters ────────────────────────────────────────────────────────────────

export type ChartFilter = Pick<ChartConfig, "exclude" | "useDashboardExclusions" | "onlyTags">;

const NO_EXCLUSIONS: Exclusions = { categories: [], tags: [] };

/**
 * Live entries a chart counts: deleted rows dropped; the chart's exclusions plus, unless it
 * opts out, the dashboard-wide ones; and with `onlyTags`, only entries carrying one of them.
 * An entry is left out when its category or any of its tags is excluded. Tags
 * match case-insensitively, like everywhere else.
 */
export function filterTransactions(
  transactions: readonly TransactionRow[],
  filter: ChartFilter,
  dashboardExclude: Exclusions,
): LiveTransaction[] {
  const dashboard = filter.useDashboardExclusions ? dashboardExclude : NO_EXCLUSIONS;
  const categories = new Set([...filter.exclude.categories, ...dashboard.categories]);
  const tags = new Set([...filter.exclude.tags, ...dashboard.tags].map(tagKey));
  const only = new Set(filter.onlyTags.map(tagKey));
  return transactions.filter(
    (t): t is LiveTransaction =>
      !t.deleted &&
      !categories.has(t.category) &&
      !t.tags.some((tag) => tags.has(tagKey(tag))) &&
      (only.size === 0 || t.tags.some((tag) => only.has(tagKey(tag)))),
  );
}

// ─── Aggregates and metrics ─────────────────────────────────────────────────

/** Integer sums for a group (hundredths and entries). */
interface Agg {
  income: number;
  expenses: number;
  count: number;
}

const emptyAgg = (): Agg => ({ income: 0, expenses: 0, count: 0 });

function addTo(agg: Agg, t: LiveTransaction): void {
  if (t.type === "income") agg.income += t.amount;
  else agg.expenses += t.amount;
  agg.count += 1;
}

const plus = (a: Agg, b: Agg): Agg => ({
  income: a.income + b.income,
  expenses: a.expenses + b.expenses,
  count: a.count + b.count,
});

const times = (a: Agg, k: number): Agg => ({
  income: a.income * k,
  expenses: a.expenses * k,
  count: a.count * k,
});

/** n / d in integers, rounded half up like money.ts (d > 0). */
function roundDiv(n: number, d: number): number {
  const q = Math.floor(n / d);
  return q + ((n - q * d) * 2 >= d ? 1 : 0);
}

/** Share of income not spent; null without income (never NaN or Infinity). */
const keptRatio = (a: Agg): number | null =>
  a.income > 0 ? (a.income - a.expenses) / a.income : null;

/**
 * The metric of `a / den` (`den` > 1 for an average or a projection: sums stay integers and
 * are divided once). Money in whole hundredths, `kept_ratio` as a fraction (0.6 = 60%,
 * negative when more was spent than earned, null without income), `count` as a number of
 * entries (fractional once averaged or projected).
 */
function metricValue(metric: ChartConfig["metric"], a: Agg, den = 1): number | null {
  switch (metric) {
    case "expenses":
      return roundDiv(a.expenses, den);
    case "income":
      return roundDiv(a.income, den);
    case "difference":
      return roundDiv(a.income, den) - roundDiv(a.expenses, den);
    case "kept_ratio":
      return keptRatio(a);
    case "count":
      return a.count / den;
  }
}

// ─── Grouping ───────────────────────────────────────────────────────────────

type GroupBy = ChartConfig["groupBy"];
type TimeGroupBy = "day" | "month" | "year";
const isTimeGroup = (g: GroupBy): g is TimeGroupBy => g === "day" || g === "month" || g === "year";
/** Groupings whose groups are chosen by the data, so `limit` can fold some into "Other". */
const isOpenGroup = (g: GroupBy) => !isTimeGroup(g) && g !== "weekday";

/** The label of the group `limit` folds the remaining groups into (always last). */
export const OTHER_LABEL = "Other";
const WEEKDAYS = ["1", "2", "3", "4", "5", "6", "7"];

interface Bucket extends DateWindow {
  key: string;
}

/** Every day, month or year bucket from `start` to `end`. */
function timeBuckets(groupBy: TimeGroupBy, start: string, end: string): Bucket[] {
  const buckets: Bucket[] = [];
  if (groupBy === "day") {
    for (let d = dayNumber(start); d <= dayNumber(end); d++) {
      const date = fromDayNumber(d);
      buckets.push({ key: date, start: date, end: date });
    }
  } else if (groupBy === "month") {
    for (let m = monthStart(start); m <= end; m = addMonths(m, 1)) {
      buckets.push({ key: m.slice(0, 7), start: m, end: monthEnd(m) });
    }
  } else {
    for (let y = parts(start)[0]; y <= parts(end)[0]; y++) {
      buckets.push({ key: pad(y, 4), start: `${pad(y, 4)}-01-01`, end: `${pad(y, 4)}-12-31` });
    }
  }
  return buckets;
}

/**
 * The groups an entry counts in. Time groups use `date`, the entry's date moved into the
 * compared window. An entry counts in each of its tags; one without tags or detail is in "".
 */
function groupKeys(t: LiveTransaction, groupBy: GroupBy, date: string): string[] {
  switch (groupBy) {
    case "day":
      return [date];
    case "month":
      return [date.slice(0, 7)];
    case "year":
      return [date.slice(0, 4)];
    case "weekday":
      return [String(isoWeekday(t.date))];
    case "category":
      return [t.category];
    case "detail":
      return [t.detail];
    case "tag": {
      const keys = uniqueTags(t.tags).map(tagKey);
      return keys.length > 0 ? keys : [""];
    }
  }
}

interface Entry {
  t: LiveTransaction;
  keys: string[];
}

/** Entries inside the windows, with their groups; compared entries move forward into place. */
function entriesIn(
  rows: readonly LiveTransaction[],
  windows: readonly ComparisonWindow[],
  groupBy: GroupBy,
): Entry[] {
  const entries: Entry[] = [];
  for (const w of windows) {
    for (const t of rows) {
      if (t.date < w.start || t.date > w.end) continue;
      const date = w.monthsBack === 0 ? t.date : addMonths(t.date, w.monthsBack);
      entries.push({ t, keys: groupKeys(t, groupBy, date) });
    }
  }
  return entries;
}

function sumByKey(entries: readonly Entry[]): Map<string, Agg> {
  const sums = new Map<string, Agg>();
  for (const { t, keys } of entries) {
    for (const key of keys) {
      const agg = sums.get(key) ?? emptyAgg();
      sums.set(key, agg);
      addTo(agg, t);
    }
  }
  return sums;
}

/** Entries in any of `keys`, each counted once (an entry with two folded tags is one entry). */
function sumOfKeys(entries: readonly Entry[], keys: ReadonlySet<string>): Agg {
  const agg = emptyAgg();
  for (const e of entries) if (e.keys.some((k) => keys.has(k))) addTo(agg, e.t);
  return agg;
}

/** An unfinished time bucket's value times `num` / `den` covers the whole bucket. */
interface Projection {
  num: number;
  den: number;
}

interface Groups {
  labels: string[];
  hasOther: boolean;
  /** Per label; null for a time bucket that starts after the counted window. */
  current: (Agg | null)[];
  /** Per label, summed over the compared windows; null without a comparison. */
  compare: Agg[] | null;
  /** The number of compared windows: `compare` divided by it is the compared value. */
  compareDen: number;
  /** Per label: how to scale an unfinished time bucket to the whole bucket; else null. */
  projection: (Projection | null)[];
  /** Per label: the days its current value covers. */
  windows: DateWindow[];
  compareWindows: ComparisonWindow[];
}

function group(
  config: ChartConfig,
  rows: readonly LiveTransaction[],
  period: ResolvedPeriod,
  compare: Compare,
  rankBy: ChartConfig["metric"],
  tagLabels: ReadonlyMap<string, string>,
): Groups {
  const { groupBy } = config;
  const window: DateWindow = { start: period.start, end: period.end };
  const current = entriesIn(rows, [{ ...window, monthsBack: 0 }], groupBy);
  const currentSums = sumByKey(current);

  if (isTimeGroup(groupBy)) {
    // The axis covers the whole period; a comparison covers its whole period too, so last
    // year's line runs to December while this year's stops today.
    const buckets = timeBuckets(groupBy, period.start, period.fullEnd);
    const compareWindows = comparisonWindows(
      { start: period.start, end: period.fullEnd },
      period.months,
      compare,
      true,
    );
    const compareSums =
      compareWindows.length > 0 ? sumByKey(entriesIn(rows, compareWindows, groupBy)) : null;
    return {
      labels: buckets.map((b) => b.key),
      hasOther: false,
      current: buckets.map((b) =>
        b.start > window.end ? null : (currentSums.get(b.key) ?? emptyAgg()),
      ),
      compare: compareSums && buckets.map((b) => compareSums.get(b.key) ?? emptyAgg()),
      compareDen: Math.max(1, compareWindows.length),
      projection: buckets.map((b) => {
        if (b.start > window.end || window.end >= b.end) return null;
        const from = b.start > window.start ? b.start : window.start;
        return {
          num: dayCount({ start: from, end: b.end }),
          den: dayCount({ start: from, end: window.end }),
        };
      }),
      windows: buckets.map((b) => ({
        start: b.start > window.start ? b.start : window.start,
        end: b.end < window.end ? b.end : window.end,
      })),
      compareWindows,
    };
  }

  const compareWindows = comparisonWindows(window, period.months, compare, !period.partial);
  const compared = entriesIn(rows, compareWindows, groupBy);
  const compareDen = Math.max(1, compareWindows.length);
  const compareSums = sumByKey(compared);

  let keys =
    groupBy === "weekday" ? WEEKDAYS : [...new Set([...currentSums.keys(), ...compareSums.keys()])];
  if (groupBy !== "weekday") {
    const rank = (sums: Map<string, Agg>, key: string, den: number) =>
      metricValue(rankBy, sums.get(key) ?? emptyAgg(), den) ?? Number.NEGATIVE_INFINITY;
    keys.sort(
      (a, b) =>
        rank(currentSums, b, 1) - rank(currentSums, a, 1) ||
        rank(compareSums, b, compareDen) - rank(compareSums, a, compareDen) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
  }
  let other: { current: Agg; compare: Agg } | null = null;
  if (config.limit !== undefined && isOpenGroup(groupBy) && keys.length > config.limit) {
    const folded = new Set(keys.slice(config.limit));
    keys = keys.slice(0, config.limit);
    other = { current: sumOfKeys(current, folded), compare: sumOfKeys(compared, folded) };
  }
  const label = (key: string) => (groupBy === "tag" ? (tagLabels.get(key) ?? key) : key);
  const at = (sums: Map<string, Agg>) => keys.map((k) => sums.get(k) ?? emptyAgg());
  const labels = keys.map(label);
  return {
    labels: other ? [...labels, OTHER_LABEL] : labels,
    hasOther: other !== null,
    current: other ? [...at(currentSums), other.current] : at(currentSums),
    compare:
      compareWindows.length === 0
        ? null
        : other
          ? [...at(compareSums), other.compare]
          : at(compareSums),
    compareDen,
    projection: (other ? [...keys, ""] : keys).map(() => null),
    windows: (other ? [...keys, ""] : keys).map(() => window),
    compareWindows,
  };
}

// ─── Charts ─────────────────────────────────────────────────────────────────

export interface ChartSeries {
  key: "current" | "compare";
  /** `compare` is drawn in the neutral comparison gray. */
  role: "current" | "compare";
  /**
   * One per label: money in hundredths, `kept_ratio` as a fraction, `count` as a number.
   * null where there is no value: a time bucket after today, or a kept ratio without income.
   */
  values: (number | null)[];
  /** Per label: the value covers only part of its bucket (draw it dashed). */
  partial: boolean[];
  /** Per label: a partial value projected over its whole bucket at the same pace; else null. */
  projected: (number | null)[];
}

export interface SeriesChart {
  shape: "series";
  /**
   * Group keys: `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, ISO weekday "1" (Monday) … "7" (Sunday), or a
   * category, detail or tag ("" for none). With `hasOther`, the last is "Other".
   */
  labels: string[];
  hasOther: boolean;
  /** The current series, then the comparison when there is one. */
  series: ChartSeries[];
  /** The days counted. */
  window: DateWindow;
  /** The period is unfinished (it runs to today). */
  partial: boolean;
  /** The compared windows (twelve for the 12-month average); empty without a comparison. */
  compareWindows: DateWindow[];
}

export interface TableRow {
  label: string;
  /** The days this row counts. */
  window: DateWindow;
  income: number;
  expenses: number;
  /** null without income. */
  keptRatio: number | null;
  /** This year's row in a year table; the unfinished bucket in another time table. */
  current: boolean;
}

export interface TableChart {
  shape: "table";
  rows: TableRow[];
  hasOther: boolean;
  window: DateWindow;
}

export type ChartData = SeriesChart | TableChart;

/** Values of `aggs / den` per label; `projection` only applies to the current series. */
function series(
  role: ChartSeries["role"],
  aggs: readonly (Agg | null)[],
  config: ChartConfig,
  den: number,
  projection: readonly (Projection | null)[],
): ChartSeries {
  const values: (number | null)[] = [];
  const projected: (number | null)[] = [];
  let running = emptyAgg();
  aggs.forEach((agg, i) => {
    const p = projection[i] ?? null;
    if (agg === null) {
      values.push(null);
      projected.push(null);
      return;
    }
    const before = config.cumulative ? running : emptyAgg();
    if (config.cumulative) running = plus(running, agg);
    values.push(metricValue(config.metric, config.cumulative ? running : agg, den));
    // before + agg × num / den, as one fraction divided once.
    projected.push(
      p === null
        ? null
        : metricValue(config.metric, plus(times(before, p.den), times(agg, p.num)), den * p.den),
    );
  });
  return { key: role, role, values, partial: projection.map((p) => p !== null), projected };
}

/** Only the entries a metric is about, so an expenses chart has no income-only groups. */
function relevantTo(metric: ChartConfig["metric"], rows: readonly LiveTransaction[]) {
  if (metric === "expenses") return rows.filter((t) => t.type === "expense");
  if (metric === "income") return rows.filter((t) => t.type === "income");
  return rows;
}

/** Tag key → the spelling first used. */
function tagSpellings(transactions: readonly TransactionRow[]): Map<string, string> {
  return new Map(listTags(transactions).map(({ tag }) => [tagKey(tag), tag]));
}

/** Filtered live entries up to today: an entry dated later counts once its day arrives. */
function countedRows(
  transactions: readonly TransactionRow[],
  filter: ChartFilter,
  ctx: DashboardContext,
): LiveTransaction[] {
  return filterTransactions(transactions, filter, ctx.dashboard.exclude).filter(
    (t) => t.date <= ctx.today,
  );
}

function earliestDate(rows: readonly LiveTransaction[], fallback: string): string {
  let earliest = fallback;
  for (const t of rows) if (t.date < earliest) earliest = t.date;
  return earliest;
}

/**
 * Filters and groups transactions for one chart config. Series charts get labels and a
 * current series, plus a comparison series when `compare` applies (never for all_time).
 * Time groupings (day, month, year) span the whole period with null after today, flag the
 * unfinished bucket as partial and project it; other groupings compare the same days.
 * A table gets income, expenses and kept ratio per row; grouped by year, each year counts the
 * same window (1 January to the period's last counted day, e.g. 1 Jan – 17 Nov).
 */
export function computeChart(
  config: ChartConfig,
  transactions: readonly TransactionRow[],
  ctx: DashboardContext,
): ChartData {
  const rows = countedRows(transactions, config, ctx);
  const period = resolvePeriod(config.period, ctx, earliestDate(rows, ctx.today), config.periodRef);
  const window = { start: period.start, end: period.end };
  const tagLabels = tagSpellings(transactions);

  if (config.kind === "table") {
    if (config.groupBy === "year")
      return { shape: "table", rows: yearRows(rows, period), hasOther: false, window };
    const g = group(config, rows, period, "none", config.metric, tagLabels);
    const tableRows: TableRow[] = [];
    g.current.forEach((agg, i) => {
      if (agg === null) return;
      tableRows.push({
        label: g.labels[i] ?? "",
        window: g.windows[i] ?? window,
        income: agg.income,
        expenses: agg.expenses,
        keptRatio: keptRatio(agg),
        current: g.projection[i] !== null && g.projection[i] !== undefined,
      });
    });
    return { shape: "table", rows: tableRows, hasOther: g.hasOther, window };
  }

  const g = group(
    config,
    relevantTo(config.metric, rows),
    period,
    config.compare,
    config.metric,
    tagLabels,
  );
  const result: ChartSeries[] = [series("current", g.current, config, 1, g.projection)];
  if (g.compare) {
    const none = g.compare.map(() => null);
    result.push(series("compare", g.compare, config, g.compareDen, none));
  }
  return {
    shape: "series",
    labels: g.labels,
    hasOther: g.hasOther,
    series: result,
    window,
    partial: period.partial,
    compareWindows: g.compareWindows.map(plainWindow),
  };
}

/** One row per year of the period, each counting 1 January to the same day as the period's end. */
function yearRows(rows: readonly LiveTransaction[], period: ResolvedPeriod): TableRow[] {
  const [firstYear] = parts(period.start);
  const [lastYear, endMonth, endDay] = parts(period.end);
  const result: TableRow[] = [];
  for (let y = firstYear; y <= lastYear; y++) {
    const window = {
      start: ymd(y, 1, 1),
      end: ymd(y, endMonth, Math.min(endDay, daysInMonth(y, endMonth))),
    };
    const agg = emptyAgg();
    for (const t of rows) if (t.date >= window.start && t.date <= window.end) addTo(agg, t);
    result.push({
      label: pad(y, 4),
      window,
      income: agg.income,
      expenses: agg.expenses,
      keptRatio: keptRatio(agg),
      current: y === lastYear,
    });
  }
  return result;
}

// ─── KPI cards ──────────────────────────────────────────────────────────────

export type KpiKey = "expenses" | "per_day" | "income" | "kept_ratio";

export interface Kpi {
  key: KpiKey;
  /** Hundredths for money, a fraction for `kept_ratio`; null when there is nothing to show. */
  value: number | null;
  /** The compared value (averaged for the 12-month average); null without one. */
  compare: number | null;
  /**
   * `percent`: (value − compare) / compare as a fraction (−0.05 = −5%), null when compare is 0;
   * `amount`: value − compare in hundredths; `points`: value − compare as a fraction (0.09 =
   * +9 pts). null when either side is missing.
   */
  delta: number | null;
  deltaKind: "percent" | "amount" | "points";
}

export interface Kpis {
  window: DateWindow;
  partial: boolean;
  compareWindows: DateWindow[];
  /** Expenses, Per day, Income, Kept of income. */
  cards: Kpi[];
}

/**
 * The four KPI cards for the dashboard's period with its comparison and exclusions. Per day
 * is expenses over the days counted (17 for 1–17 Nov); for the 12-month average it is the
 * compared expenses over all the compared days.
 */
export function computeKpis(transactions: readonly TransactionRow[], ctx: DashboardContext): Kpis {
  const rows = countedRows(
    transactions,
    { exclude: NO_EXCLUSIONS, useDashboardExclusions: true, onlyTags: [] },
    ctx,
  );
  const period = resolvePeriod("dashboard", ctx);
  const window = { start: period.start, end: period.end };
  const windows = comparisonWindows(window, period.months, ctx.dashboard.compare, !period.partial);

  const total = (ws: readonly DateWindow[]) => {
    const agg = emptyAgg();
    for (const w of ws)
      for (const t of rows) if (t.date >= w.start && t.date <= w.end) addTo(agg, t);
    return agg;
  };
  const cur = total([window]);
  const days = dayCount(window);
  // Summed over the compared windows; divided once by their number (or their days).
  const cmp = windows.length > 0 ? total(windows) : null;
  const n = windows.length;
  const cmpDays = windows.reduce((sum, w) => sum + dayCount(w), 0);
  const perDay = (expenses: number, d: number) => (d > 0 ? roundDiv(expenses, d) : null);

  const card = (
    key: KpiKey,
    value: number | null,
    compare: number | null,
    deltaKind: Kpi["deltaKind"],
  ): Kpi => {
    let delta: number | null = null;
    if (value !== null && compare !== null) {
      if (deltaKind !== "percent") delta = value - compare;
      else if (compare !== 0) delta = (value - compare) / compare;
    }
    return { key, value, compare, delta, deltaKind };
  };
  return {
    window,
    partial: period.partial,
    compareWindows: windows.map(plainWindow),
    cards: [
      card("expenses", cur.expenses, cmp && roundDiv(cmp.expenses, n), "percent"),
      card("per_day", perDay(cur.expenses, days), cmp && perDay(cmp.expenses, cmpDays), "amount"),
      card("income", cur.income, cmp && roundDiv(cmp.income, n), "percent"),
      card("kept_ratio", keptRatio(cur), cmp && keptRatio(cmp), "points"),
    ],
  };
}
