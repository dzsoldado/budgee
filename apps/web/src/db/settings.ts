// The settings store: one value per key, read live from the settings table, falling back to
// the defaults for keys with no live row.
import { DEFAULT_SETTINGS, type SettingKey, type SettingValues } from "@budgee/core";
import { type Accessor, createMemo } from "solid-js";
import type { BudgeeDb, LocalRow } from "./db";
import { createLiveQuery } from "./live";

const DEFAULT_VALUES = Object.fromEntries(
  DEFAULT_SETTINGS.map((s) => [s.key, s.value]),
) as SettingValues;

export function settingsFromRows(rows: readonly LocalRow<"settings">[]): SettingValues {
  const values: Record<SettingKey, unknown> = { ...DEFAULT_VALUES };
  for (const row of rows) if (!row.deleted) values[row.key] = row.value;
  return values as SettingValues;
}

export function readSettings(db: BudgeeDb): Promise<SettingValues> {
  return db.settings.toArray().then(settingsFromRows);
}

/** Live settings; `initial` (read before the first render) covers the first query. */
export function createSettings(db: BudgeeDb, initial: SettingValues): Accessor<SettingValues> {
  const rows = createLiveQuery(() => db.settings.toArray());
  return createMemo(() => {
    const current = rows();
    return current ? settingsFromRows(current) : initial;
  });
}
