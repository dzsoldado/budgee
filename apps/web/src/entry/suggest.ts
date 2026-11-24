// Suggestions for the Add / edit form, all derived from past entries: details, recently used
// currencies and tags.
import {
  canonicalTag,
  type LiveTransaction,
  sameTag,
  type TagCount,
  type TagError,
  tagKey,
  validateTag,
} from "@budgee/core";

type Entry = Pick<
  LiveTransaction,
  "type" | "detail" | "date" | "created_at" | "original_currency" | "deleted"
>;

/** Newest first: date, then created_at. */
const newer = (a: Entry, b: Entry) =>
  a.date !== b.date ? a.date > b.date : a.created_at > b.created_at;

export interface DetailSuggestion {
  /** In its most recent spelling. */
  detail: string;
  /** Live entries of the type with this detail (ignoring case). */
  count: number;
}

/**
 * Past details of `type` starting with `typed` (ignoring case), most used first, then most
 * recent. The text exactly as typed is not suggested back.
 */
export function detailSuggestions(
  entries: readonly Entry[],
  type: "income" | "expense",
  typed: string,
  limit = 5,
): DetailSuggestion[] {
  const prefix = typed.trim().toLowerCase();
  if (prefix === "") return [];
  const byKey = new Map<string, { detail: string; count: number; latest: Entry }>();
  for (const e of entries) {
    if (e.deleted || e.type !== type) continue;
    const detail = e.detail.trim();
    const key = detail.toLowerCase();
    if (key === "" || key === prefix || !key.startsWith(prefix)) continue;
    const found = byKey.get(key);
    if (!found) byKey.set(key, { detail, count: 1, latest: e });
    else {
      found.count += 1;
      if (newer(e, found.latest)) {
        found.latest = e;
        found.detail = detail;
      }
    }
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        (newer(a.latest, b.latest) ? -1 : newer(b.latest, a.latest) ? 1 : 0) ||
        a.detail.localeCompare(b.detail),
    )
    .slice(0, limit)
    .map(({ detail, count }) => ({ detail, count }));
}

/** Currencies paid in before, most recently used first, leaving out the main currency. */
export function recentCurrencies(entries: readonly Entry[], main: string): string[] {
  const latest = new Map<string, Entry>();
  for (const e of entries) {
    const code = e.original_currency;
    if (e.deleted || !code || code === main) continue;
    const found = latest.get(code);
    if (!found || newer(e, found)) latest.set(code, e);
  }
  return [...latest.entries()]
    .sort(([, a], [, b]) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0))
    .map(([code]) => code);
}

/** Known tags starting with `typed` (ignoring case), not chosen yet, most used first. */
export function tagSuggestions(
  known: readonly TagCount[],
  typed: string,
  chosen: readonly string[],
  limit = 5,
): TagCount[] {
  const prefix = tagKey(typed);
  if (prefix === "") return [];
  return known
    .filter(({ tag }) => tagKey(tag).startsWith(prefix) && !chosen.some((c) => sameTag(c, tag)))
    .sort((a, b) => b.count - a.count || tagKey(a.tag).localeCompare(tagKey(b.tag)))
    .slice(0, limit);
}

/**
 * `chosen` with `text` added: trimmed, in the spelling already in use, once. Adding a tag
 * already chosen (in any case) changes nothing.
 */
export function addTag(
  chosen: readonly string[],
  text: string,
  known: readonly string[],
): { ok: true; tags: string[] } | { ok: false; error: TagError } {
  const valid = validateTag(text);
  if (!valid.ok) return valid;
  if (chosen.some((c) => sameTag(c, valid.tag))) return { ok: true, tags: [...chosen] };
  return { ok: true, tags: [...chosen, canonicalTag(valid.tag, known)] };
}
