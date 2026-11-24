// What a fresh install starts with. Default rows have fixed ids, so two devices that both
// seed defaults (e.g. used unpaired before pairing) converge on the same rows when they sync.
import { formatHlc } from "./hlc";
import {
  type CategoryFields,
  type ChartConfig,
  type ChartConfigFields,
  SETTING_IDS,
  type SettingFields,
} from "./schema";

export type WithId<T> = { id: string } & T;

/** Device id stamped on seeded default rows. */
export const SEED_DEVICE = "seed";
/**
 * The lowest hlc there is, for seeded default rows: any real edit, from any device, wins over
 * it, and two devices that seed the same defaults hold equal hlcs, so neither applies.
 */
export const SEED_HLC = formatHlc({ wall: 0, counter: 0, device: SEED_DEVICE });

const fixedId = (group: string, n: number) =>
  `00000000-0000-4000-8000-${group}${String(n).padStart(8, "0")}`;

const EXPENSE_CATEGORIES = [
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
];
const INCOME_CATEGORIES = ["Salary", "Freelance", "Gifts received"];

// Income ids start at 101 so a longer expense list never shifts them.
const categoryRows = (type: "income" | "expense", names: string[], firstId: number) =>
  names.map((name, sort) => ({
    id: fixedId("0001", firstId + sort),
    type,
    name,
    sort,
    archived: false,
  }));

export const DEFAULT_CATEGORIES: readonly WithId<CategoryFields>[] = [
  ...categoryRows("expense", EXPENSE_CATEGORIES, 1),
  ...categoryRows("income", INCOME_CATEGORIES, 101),
];

const DEFAULT_SETTING_FIELDS: SettingFields[] = [
  { key: "currency", value: "DZD" },
  { key: "decimals", value: 0 },
  { key: "locale", value: "en" },
  { key: "theme", value: "system" },
  {
    key: "dashboard",
    value: {
      period: "month",
      compare: "same_period_last_year",
      exclude: { categories: [], tags: [] },
    },
  },
];

export const DEFAULT_SETTINGS: readonly WithId<SettingFields>[] = DEFAULT_SETTING_FIELDS.map(
  (s) => ({ id: SETTING_IDS[s.key], ...s }),
);

/** A complete ChartConfig: the given fields over the schema defaults. */
function chart(
  fields: Pick<ChartConfig, "kind" | "metric" | "groupBy" | "period"> & Partial<ChartConfig>,
): ChartConfig {
  return {
    compare: "none",
    cumulative: false,
    onlyTags: [],
    exclude: { categories: [], tags: [] },
    useDashboardExclusions: true,
    ...fields,
  };
}

const DEFAULT_CHARTS: { name: string; config: ChartConfig }[] = [
  {
    name: "Expenses, this year vs last year",
    config: chart({
      kind: "line",
      metric: "expenses",
      groupBy: "month",
      period: "this_year",
      compare: "same_period_last_year",
    }),
  },
  {
    name: "By category vs last year",
    config: chart({
      kind: "bar",
      metric: "expenses",
      groupBy: "category",
      period: "dashboard",
      compare: "same_period_last_year",
    }),
  },
  {
    name: "Kept of income",
    config: chart({
      kind: "line",
      metric: "kept_ratio",
      groupBy: "month",
      period: "last_12_months",
    }),
  },
  {
    // A table shows income, expenses and kept ratio per year, whatever `metric` says. It
    // counts all entries, so the dashboard's exclusions leave it alone.
    name: "Year by year",
    config: chart({
      kind: "table",
      metric: "expenses",
      groupBy: "year",
      period: "all_time",
      useDashboardExclusions: false,
    }),
  },
];

export const DEFAULT_CHART_CONFIGS: readonly WithId<ChartConfigFields>[] = DEFAULT_CHARTS.map(
  (c, sort) => ({ id: fixedId("0004", sort + 1), name: c.name, sort, config: c.config }),
);

export interface GalleryPreset {
  /** Stable key, e.g. for translated titles and descriptions. */
  key: string;
  /** Default chart name when the preset is added. */
  name: string;
  config: ChartConfig;
}

/** The Add-chart gallery templates, besides the default charts. */
export const GALLERY_PRESETS: readonly GalleryPreset[] = [
  {
    key: "month_pace",
    name: "Month pace",
    config: chart({
      kind: "line",
      metric: "expenses",
      groupBy: "day",
      period: "dashboard",
      compare: "avg_12_months",
      cumulative: true,
    }),
  },
  {
    key: "by_tag",
    name: "By tag",
    config: chart({
      kind: "bar",
      metric: "expenses",
      groupBy: "tag",
      period: "last_12_months",
      useDashboardExclusions: false,
    }),
  },
  {
    key: "trip_total",
    name: "Trip total",
    // The trip's tag is picked in the editor (onlyTags); dashboards usually exclude it.
    config: chart({
      kind: "doughnut",
      metric: "expenses",
      groupBy: "category",
      period: "all_time",
      useDashboardExclusions: false,
    }),
  },
  {
    key: "biggest_changes",
    name: "Biggest changes",
    config: chart({
      kind: "bar",
      metric: "expenses",
      groupBy: "category",
      period: "dashboard",
      compare: "same_period_last_year",
      limit: 5,
    }),
  },
  {
    key: "top_details",
    name: "Top details",
    config: chart({
      kind: "bar",
      metric: "expenses",
      groupBy: "detail",
      period: "dashboard",
      limit: 10,
    }),
  },
  {
    key: "by_weekday",
    name: "By weekday",
    config: chart({
      kind: "bar",
      metric: "expenses",
      groupBy: "weekday",
      period: "last_12_months",
    }),
  },
  {
    key: "spending_calendar",
    name: "Spending calendar",
    config: chart({ kind: "bar", metric: "expenses", groupBy: "day", period: "dashboard" }),
  },
  {
    key: "income_sources",
    name: "Income sources",
    config: chart({
      kind: "bar",
      metric: "income",
      groupBy: "category",
      period: "last_12_months",
    }),
  },
];

/**
 * Every default row's id. Devices seed these locally, so a deleted default's tombstone must stay
 * on the server for good: once purged, a device paired later would push its seed back.
 */
export const SEED_IDS: readonly string[] = [
  ...DEFAULT_CATEGORIES,
  ...DEFAULT_SETTINGS,
  ...DEFAULT_CHART_CONFIGS,
].map((row) => row.id);
