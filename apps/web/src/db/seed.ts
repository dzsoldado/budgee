// First-run defaults. Default rows have fixed ids and the lowest hlc (SEED_HLC), so any real
// edit from any device wins over them, and they are not dirty, so a fresh device never pushes
// them.
import {
  DEFAULT_CATEGORIES,
  DEFAULT_CHART_CONFIGS,
  DEFAULT_SETTINGS,
  rowSchemas,
  SEED_DEVICE,
  SEED_HLC,
  type TableName,
  type WithId,
} from "@budgee/core";
import * as v from "valibot";
import { type BudgeeDb, getMeta, setMeta } from "./db";

const DEFAULTS: readonly [TableName, readonly WithId<object>[]][] = [
  ["categories", DEFAULT_CATEGORIES],
  ["settings", DEFAULT_SETTINGS],
  ["chart_configs", DEFAULT_CHART_CONFIGS],
];

/**
 * Seeds the defaults once per device, skipping any row (live or deleted) already here. Every
 * start, a default row still at SEED_HLC (never edited, here or anywhere) takes this version's
 * default values, still at SEED_HLC: every device does the same, so they stay equal. Returns
 * whether this run seeded.
 */
export async function seedDefaults(db: BudgeeDb): Promise<boolean> {
  const scope = [...DEFAULTS.map(([table]) => db.rows(table)), db.meta];
  return db.transaction("rw", scope, async () => {
    const seeded = (await getMeta(db, "seeded")) === true;
    for (const [table, defaults] of DEFAULTS) {
      const rows = db.rows(table);
      for (const fields of defaults) {
        const row = {
          ...v.parse(rowSchemas[table], {
            ...fields,
            hlc: SEED_HLC,
            device: SEED_DEVICE,
            deleted: false,
          }),
          dirty: 0 as const,
        };
        const existing = await rows.get(fields.id);
        if (!existing) {
          if (!seeded) await rows.add(row);
        } else if (existing.hlc === SEED_HLC && JSON.stringify(existing) !== JSON.stringify(row)) {
          await rows.put(row);
        }
      }
    }
    if (seeded) return false;
    await setMeta(db, "seeded", true);
    return true;
  });
}
