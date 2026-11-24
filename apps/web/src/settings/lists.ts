// Settings → Categories and Tags. Each change is one repository write: the list rows and the
// entries that use them commit together, or not at all. Rows are read inside the
// write, so the checks see what is stored at that moment.
import {
  type DashboardSettings,
  deleteTag,
  mergeTags,
  normalizeTag,
  renameCategory,
  renameTag,
  SETTING_IDS,
  sameTag,
  tagKey,
} from "@budgee/core";
import type { BudgeeDb, LocalRow } from "../db/db";
import type { FieldsInputOf, LiveRowOf, Repository, Writer } from "../db/repository";
import { sortByOrder } from "../list/categories";

export type EntryType = "income" | "expense";

/** A live category row. */
export type ListItem = LiveRowOf<"categories">;

export type ListErrorReason =
  /** The name is empty after trimming. */
  | "empty"
  /** Another category of the type has the name, in any case. */
  | "taken"
  /** A category of the other type has the name, in any case: names are unique across types. */
  | "takenByIncome"
  | "takenByExpense"
  /** The row (or the merge target) is gone, e.g. deleted on another device. */
  | "missing"
  /** Live entries use it, so it can only be merged or archived. */
  | "inUse"
  /** It is the type's only active category; entries need one to choose. */
  | "last";

export class ListError extends Error {
  override name = "ListError";
  readonly reason: ListErrorReason;

  constructor(reason: ListErrorReason) {
    super(`List change refused: ${reason}`);
    this.reason = reason;
  }
}

/** The live categories of `type` in Settings order. */
export function categoriesOfType<T extends { deleted: boolean }>(
  rows: readonly T[],
  type: EntryType,
) {
  return sortByOrder(rows).filter((row) => (row as { type?: string }).type === type);
}

export type NameCheck = { ok: true; name: string } | { ok: false; error: "empty" | "taken" };

/** Trimmed and unique (ignoring case) among `rows`; `exceptId` may keep its own name. */
export function checkName(
  text: string,
  rows: readonly { id: string; name: string }[],
  exceptId?: string,
): NameCheck {
  const name = text.trim();
  if (name === "") return { ok: false, error: "empty" };
  const key = name.toLowerCase();
  const taken = rows.some((row) => row.id !== exceptId && row.name.toLowerCase() === key);
  return taken ? { ok: false, error: "taken" } : { ok: true, name };
}

interface Categorized {
  type: EntryType;
  category: string;
  deleted?: boolean;
}

/** Live entries of `type` filed under `name`. */
export function usage(
  transactions: readonly (Categorized | { deleted: true })[],
  type: EntryType,
  name: string,
): number {
  let count = 0;
  for (const t of transactions) {
    if (t.deleted) continue;
    const row = t as Categorized;
    if (row.type === type && row.category === name) count += 1;
  }
  return count;
}

/** Saves rows changed by a core helper: same id, new hlc, dirty. */
async function saveEntries(w: Writer, rows: readonly LocalRow<"transactions">[]): Promise<void> {
  for (const row of rows) {
    if (row.deleted) continue;
    const { id, hlc: _hlc, device: _device, deleted: _deleted, dirty: _dirty, ...fields } = row;
    await w.put("transactions", fields, id);
  }
}

const readType = async (db: BudgeeDb, type: EntryType): Promise<ListItem[]> =>
  categoriesOfType(await db.categories.toArray(), type) as ListItem[];

/** Throws when a category of the other type (archived too) already has `name`. */
async function checkOtherType(db: BudgeeDb, type: EntryType, name: string): Promise<void> {
  const other = type === "expense" ? "income" : "expense";
  if (checkName(name, await readType(db, other)).ok) return;
  throw new ListError(other === "income" ? "takenByIncome" : "takenByExpense");
}

function find(rows: readonly ListItem[], id: string): ListItem {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new ListError("missing");
  return row;
}

/** Removing (or archiving) `row` would leave its type without an active category. */
export function isLastActive(
  rows: readonly { id: string; archived: boolean }[],
  row: { id: string; archived: boolean },
): boolean {
  return !row.archived && !rows.some((r) => r.id !== row.id && !r.archived);
}

/** Adds a category at the end of its type's list. */
export function addItem(
  db: BudgeeDb,
  repo: Repository,
  type: EntryType,
  text: string,
): Promise<ListItem> {
  return repo.write(async (w) => {
    const rows = await readType(db, type);
    const checked = checkName(text, rows);
    if (!checked.ok) throw new ListError(checked.error);
    await checkOtherType(db, type, checked.name);
    const sort = Math.max(-1, ...rows.map((r) => r.sort)) + 1;
    const fields: FieldsInputOf<"categories"> = { type, name: checked.name, sort, archived: false };
    return w.put("categories", fields);
  });
}

/** Renames a row and the entries filed under it; returns how many entries changed. */
export function renameItem(
  db: BudgeeDb,
  repo: Repository,
  type: EntryType,
  id: string,
  text: string,
): Promise<number> {
  return repo.write(async (w) => {
    const rows = await readType(db, type);
    const row = find(rows, id);
    const checked = checkName(text, rows, id);
    if (!checked.ok) throw new ListError(checked.error);
    if (checked.name === row.name) return 0;
    await checkOtherType(db, type, checked.name);
    const changed = renameCategory(await db.transactions.toArray(), type, row.name, checked.name);
    await saveEntries(w, changed);
    await w.update("categories", id, { name: checked.name });
    await patchNames(db, w, "categories", { from: row.name, to: checked.name });
    return changed.length;
  });
}

/** Files the source's entries under the target, then deletes the source; returns the count. */
export function mergeItem(
  db: BudgeeDb,
  repo: Repository,
  type: EntryType,
  sourceId: string,
  targetId: string,
): Promise<number> {
  return repo.write(async (w) => {
    const rows = await readType(db, type);
    const source = find(rows, sourceId);
    const target = find(rows, targetId);
    if (source.id === target.id) throw new ListError("missing");
    if (isLastActive(rows, source)) throw new ListError("last");
    const changed = renameCategory(await db.transactions.toArray(), type, source.name, target.name);
    await saveEntries(w, changed);
    await w.remove("categories", source.id);
    await patchNames(db, w, "categories", { from: source.name, to: target.name });
    return changed.length;
  });
}

/** Deletes a row no live entry uses. */
export function deleteItem(
  db: BudgeeDb,
  repo: Repository,
  type: EntryType,
  id: string,
): Promise<void> {
  return repo.write(async (w) => {
    const rows = await readType(db, type);
    const row = find(rows, id);
    if (usage(await db.transactions.toArray(), type, row.name) > 0) throw new ListError("inUse");
    if (isLastActive(rows, row)) throw new ListError("last");
    await w.remove("categories", id);
    await patchNames(db, w, "categories", { from: row.name, to: null });
  });
}

/** Archived rows are not offered for new entries; entries keep them. */
export function setArchived(
  db: BudgeeDb,
  repo: Repository,
  type: EntryType,
  id: string,
  archived: boolean,
): Promise<void> {
  return repo.write(async (w) => {
    const rows = await readType(db, type);
    const row = find(rows, id);
    if (row.archived === archived) return;
    if (archived && isLastActive(rows, row)) throw new ListError("last");
    await w.update("categories", id, { archived });
  });
}

/** Moves a category one place up (-1) or down (1) and renumbers its type's `sort` from 0. */
export function moveItem(
  db: BudgeeDb,
  repo: Repository,
  type: EntryType,
  id: string,
  delta: -1 | 1,
): Promise<void> {
  return repo.write(async (w) => {
    const rows = await readType(db, type);
    const from = rows.findIndex((r) => r.id === id);
    const to = from + delta;
    const moving = rows[from];
    const other = rows[to];
    if (!moving || !other) return;
    rows[from] = other;
    rows[to] = moving;
    for (const [sort, row] of rows.entries()) {
      if (row.sort !== sort) await w.update("categories", row.id, { sort });
    }
  });
}

// ─── Names stored elsewhere: dashboard exclusions and chart configs ────────

export type ReferenceList = "categories" | "tags";

/** `from` becomes `to` (null: dropped). */
export interface NameChange {
  from: string;
  to: string | null;
}

/**
 * `names` with the change applied, each name once (in the first spelling for tags), or null
 * when nothing changes. Names matching `to` take its spelling, like the tag helpers do.
 */
export function renameInNames(
  names: readonly string[],
  change: NameChange,
  same: (a: string, b: string) => boolean = (a, b) => a === b,
): string[] | null {
  if (!names.some((name) => same(name, change.from))) return null;
  const result: string[] = [];
  const add = (name: string) => {
    if (!result.some((kept) => same(kept, name))) result.push(name);
  };
  const { to } = change;
  for (const name of names) {
    if (same(name, change.from)) {
      if (to !== null) add(to);
    } else add(to !== null && same(name, to) ? to : name);
  }
  const unchanged = result.length === names.length && result.every((n, i) => n === names[i]);
  return unchanged ? null : result;
}

/**
 * Applies a name change to the dashboard's exclusions and to every chart's exclusions (and, for
 * a tag rename or merge, its `onlyTags`), in the caller's write. Only rows that change are written.
 */
async function patchNames(
  db: BudgeeDb,
  w: Writer,
  list: ReferenceList,
  change: NameChange,
): Promise<void> {
  const same = list === "tags" ? sameTag : undefined;
  const dashboard = await db.settings.get(SETTING_IDS.dashboard);
  if (dashboard && !dashboard.deleted && dashboard.key === "dashboard") {
    const value: DashboardSettings = dashboard.value;
    const names = renameInNames(value.exclude[list], change, same);
    if (names) {
      await w.put("settings", {
        key: "dashboard",
        value: { ...value, exclude: { ...value.exclude, [list]: names } },
      });
    }
  }
  for (const chart of await db.chart_configs.toArray()) {
    if (chart.deleted) continue;
    const { config } = chart;
    const exclude = renameInNames(config.exclude[list], change, same);
    // A deleted tag stays in `onlyTags`: an emptied list would make the chart count every entry,
    // so it shows nothing for the tag instead.
    const onlyTags =
      list === "tags" && change.to !== null ? renameInNames(config.onlyTags, change, same) : null;
    if (!exclude && !onlyTags) continue;
    await w.update("chart_configs", chart.id, {
      config: {
        ...config,
        exclude: { ...config.exclude, [list]: exclude ?? config.exclude[list] },
        onlyTags: onlyTags ?? config.onlyTags,
      },
    });
  }
}

// ─── Tags ───────────────────────────────────────────────────────────────────

/** Live charts limited (`onlyTags`) to `tag`, matched ignoring case. */
export function chartsFilteringOn(
  charts: readonly LocalRow<"chart_configs">[],
  tag: string,
): number {
  return charts.filter((c) => !c.deleted && c.config.onlyTags.some((t) => sameTag(t, tag))).length;
}

/** Another tag in `tags` that `to` would collide with (same key, not `from`), if any. */
export function tagCollision(
  tags: readonly string[],
  from: string,
  to: string,
): string | undefined {
  const key = tagKey(to);
  return tags.find((tag) => tagKey(tag) === key && key !== tagKey(from));
}

async function retag(
  db: BudgeeDb,
  repo: Repository,
  edit: (rows: readonly LocalRow<"transactions">[]) => LocalRow<"transactions">[],
  change: () => NameChange,
): Promise<number> {
  return repo.write(async (w) => {
    const changed = edit(await db.transactions.toArray());
    await saveEntries(w, changed);
    await patchNames(db, w, "tags", change());
    return changed.length;
  });
}

/** Renames a tag on every entry; throws InvalidTagError on an empty name or one with `;`. */
export const renameTagEverywhere = (db: BudgeeDb, repo: Repository, from: string, to: string) =>
  retag(
    db,
    repo,
    (rows) => renameTag(rows, from, to),
    () => ({ from, to: normalizeTag(to) }),
  );

/** Replaces `from` with `into` (kept in its spelling) on every entry. */
export const mergeTagInto = (db: BudgeeDb, repo: Repository, from: string, into: string) =>
  retag(
    db,
    repo,
    (rows) => mergeTags(rows, [from], into),
    () => ({ from, to: normalizeTag(into) }),
  );

/** Takes the tag off every entry; the entries stay. */
export const removeTag = (db: BudgeeDb, repo: Repository, tag: string) =>
  retag(
    db,
    repo,
    (rows) => deleteTag(rows, tag),
    () => ({ from: tag, to: null }),
  );
