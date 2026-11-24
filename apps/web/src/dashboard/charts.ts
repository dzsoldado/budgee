// Saved charts (chart_configs): add, save, remove and reorder, each one repository write. Rows
// are read inside the write, so sorts are worked out from what is stored at that moment.
import type { ChartConfig, LiveChartConfig } from "@budgee/core";
import type { BudgeeDb } from "../db/db";
import type { LiveRowOf, Repository } from "../db/repository";
import { t } from "../i18n";

/** Dashboard order: sort, then name, then id, so ties left by two devices still settle. */
export const byChartOrder = (a: LiveChartConfig, b: LiveChartConfig) =>
  a.sort - b.sort || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);

/** Live charts in dashboard order. */
export async function liveCharts(db: BudgeeDb): Promise<LiveChartConfig[]> {
  const rows = await db.chart_configs.toArray();
  return rows.filter((row): row is typeof row & LiveChartConfig => !row.deleted).sort(byChartOrder);
}

export interface ChartFields {
  name: string;
  config: ChartConfig;
}

/** The chart was deleted (here or on another device) while it was being edited. */
export class SaveChartError extends Error {
  override name = "SaveChartError";
}

/** Adds a chart after the last one (sort = last + 1). */
export function addChart(
  db: BudgeeDb,
  repo: Repository,
  fields: ChartFields,
): Promise<LiveRowOf<"chart_configs">> {
  return repo.write(async (w) => {
    const rows = await liveCharts(db);
    const sort = rows.reduce((max, row) => Math.max(max, row.sort), -1) + 1;
    return w.put("chart_configs", { ...fields, sort });
  });
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const EXCLUSION_LISTS = ["categories", "tags"] as const;

/**
 * Saves an edited chart where it stands. A chart deleted meanwhile is not brought back
 * (SaveChartError). `base` is the config the editor loaded: names in each exclusion list and in
 * `onlyTags` that Settings renamed meanwhile (here or on another device) stay renamed unless the
 * editor changed that list; anything else changed meanwhile is overwritten: the last save wins.
 */
export function saveChart(
  db: BudgeeDb,
  repo: Repository,
  id: string,
  fields: ChartFields,
  base?: ChartConfig,
): Promise<LiveRowOf<"chart_configs">> {
  return repo.write(async (w) => {
    const current = await db.chart_configs.get(id);
    if (!current || current.deleted) throw new SaveChartError("Chart is gone");
    const config = { ...fields.config, exclude: { ...fields.config.exclude } };
    if (base) {
      for (const list of EXCLUSION_LISTS) {
        if (sameJson(config.exclude[list], base.exclude[list])) {
          config.exclude[list] = current.config.exclude[list];
        }
      }
      if (sameJson(config.onlyTags, base.onlyTags)) config.onlyTags = current.config.onlyTags;
    }
    return w.update("chart_configs", id, { name: fields.name, config });
  });
}

/** Removes a chart from the dashboard (a tombstone, so other devices remove it too). */
export function removeChart(repo: Repository, id: string): Promise<void> {
  return repo.remove("chart_configs", id);
}

/**
 * Moves a chart one place up (-1) or down (1). Every chart then takes its position as its sort,
 * which also closes gaps and ties; only rows whose sort changed are written, in one write.
 * Resolves false when there was nothing to move (already at that end, or gone).
 */
export function moveChart(
  db: BudgeeDb,
  repo: Repository,
  id: string,
  delta: -1 | 1,
): Promise<boolean> {
  return repo.write(async (w) => {
    const rows = await liveCharts(db);
    const from = rows.findIndex((r) => r.id === id);
    const moving = rows[from];
    const other = rows[from + delta];
    if (from < 0 || !moving || !other) return false;
    rows[from] = other;
    rows[from + delta] = moving;
    for (const [sort, row] of rows.entries()) {
      if (row.sort !== sort) await w.update("chart_configs", row.id, { sort });
    }
    return true;
  });
}

/**
 * What a move says to screen readers: the chart's new place, worked out from the order before
 * the move (the live list may not have caught up yet); null when it can't move that way.
 */
export function moveAnnouncement(
  order: readonly string[],
  id: string,
  delta: -1 | 1,
  name: string,
): string | null {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return null;
  return t("dashboard.moved", { name, position: to + 1, total: order.length });
}
