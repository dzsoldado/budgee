// Tags have no table: the list is derived from the transactions. They are trimmed, matched
// case-insensitively and kept in the spelling first used. Rename, merge and delete return the
// changed transactions with their old hlc; the caller assigns a new one when it saves them.

export type TagError = "empty" | "semicolon";

/** A tag that cannot be stored. The message names the rule, never the tag. */
export class InvalidTagError extends Error {
  override name = "InvalidTagError";
  readonly reason: TagError;

  constructor(reason: TagError) {
    super(reason === "empty" ? "A tag cannot be empty" : "A tag cannot contain ';'");
    this.reason = reason;
  }
}

export function normalizeTag(text: string): string {
  return text.trim();
}

/** What two tags are compared by: trimmed, lower case. */
export function tagKey(tag: string): string {
  return normalizeTag(tag).toLowerCase();
}

export function sameTag(a: string, b: string): boolean {
  return tagKey(a) === tagKey(b);
}

/** `;` separates tags in CSV, so a tag cannot contain it. */
export function validateTag(
  text: string,
): { ok: true; tag: string } | { ok: false; error: TagError } {
  const tag = normalizeTag(text);
  if (tag === "") return { ok: false, error: "empty" };
  if (tag.includes(";")) return { ok: false, error: "semicolon" };
  return { ok: true, tag };
}

/** The spelling already in `known` that matches `text`, or `text` trimmed. */
export function canonicalTag(text: string, known: readonly string[]): string {
  const key = tagKey(text);
  return known.find((tag) => tagKey(tag) === key) ?? normalizeTag(text);
}

/** Trimmed, without empties, each tag once in its first spelling. */
export function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    const key = tag.toLowerCase();
    if (tag === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

export interface Tagged {
  tags: readonly string[];
  /** Decides which spelling was used first. */
  created_at?: string;
  deleted?: boolean;
}

/** A deleted row (tombstone): carries no tags and is skipped. */
export interface Deleted {
  deleted: true;
}

/** The live row type of a list that may hold tombstones. */
export type Live<T> = Exclude<T, Deleted>;

const live = <T extends Tagged | Deleted>(rows: readonly T[]) =>
  rows.filter((row) => !row.deleted) as (Live<T> & Tagged)[];

export interface TagCount {
  tag: string;
  /** Live transactions carrying the tag. */
  count: number;
}

/** Every tag in use with its count, in the spelling first used, sorted by name ignoring case. */
export function listTags(transactions: readonly (Tagged | Deleted)[]): TagCount[] {
  const byKey = new Map<string, { tag: string; count: number; since: string | undefined }>();
  for (const t of live(transactions)) {
    for (const tag of uniqueTags(t.tags)) {
      const key = tag.toLowerCase();
      const entry = byKey.get(key);
      if (!entry) {
        byKey.set(key, { tag, count: 1, since: t.created_at });
        continue;
      }
      entry.count += 1;
      if (t.created_at !== undefined && (entry.since === undefined || t.created_at < entry.since)) {
        entry.tag = tag;
        entry.since = t.created_at;
      }
    }
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { tag, count }]) => ({ tag, count }));
}

function validTag(text: string): string {
  const result = validateTag(text);
  if (!result.ok) throw new InvalidTagError(result.error);
  return result.tag;
}

/** Transactions whose tags change, with `edit` applied; unchanged ones are left out. */
function updateTags<T extends Tagged | Deleted>(
  transactions: readonly T[],
  edit: (tags: readonly string[]) => string[],
): Live<T>[] {
  const updated: Live<T>[] = [];
  for (const t of live(transactions)) {
    const tags = edit(t.tags);
    const same = tags.length === t.tags.length && tags.every((tag, i) => tag === t.tags[i]);
    if (!same) updated.push({ ...t, tags });
  }
  return updated;
}

/**
 * On every transaction carrying a tag that matches one of `from`, replaces those tags (and any
 * copy of the target) with `into`, trimmed, kept once where the first of them stood. Throws
 * InvalidTagError when `into` cannot be a tag.
 */
export function mergeTags<T extends Tagged | Deleted>(
  transactions: readonly T[],
  from: readonly string[],
  into: string,
): Live<T>[] {
  const target = validTag(into);
  const sources = new Set(from.map(tagKey));
  const replaced = new Set([...sources, tagKey(target)]);
  return updateTags(transactions, (tags) => {
    if (!tags.some((tag) => sources.has(tagKey(tag)))) return [...tags];
    return uniqueTags(tags.map((tag) => (replaced.has(tagKey(tag)) ? target : tag)));
  });
}

/** Renames `from` (matched ignoring case) to `to`. Throws InvalidTagError on a bad name. */
export function renameTag<T extends Tagged | Deleted>(
  transactions: readonly T[],
  from: string,
  to: string,
): Live<T>[] {
  return mergeTags(transactions, [from], to);
}

/** Removes `tag` (matched ignoring case) from every transaction carrying it. */
export function deleteTag<T extends Tagged | Deleted>(
  transactions: readonly T[],
  tag: string,
): Live<T>[] {
  const key = tagKey(tag);
  return updateTags(transactions, (tags) => tags.filter((t) => tagKey(t) !== key));
}
