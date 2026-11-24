// The List filter: type, categories, tags, amount and text. Within a dimension
// any chosen value matches; dimensions combine with "and". Empty means "any".
import { type LiveTransaction, parseAmount, tagKey } from "@budgee/core";

export type TypeFilter = "all" | "income" | "expense";

export type AmountOp = "gt" | "lt" | "eq";

/** A comparison with the main-currency amount; ignored while `text` isn't a valid amount. */
export interface AmountCondition {
  op: AmountOp;
  /** As typed, so it reads back unchanged; parsed with up to 2 decimals. */
  text: string;
}

export interface ListFilter {
  type: TypeFilter;
  categories: readonly string[];
  /** Matched ignoring case, like tags everywhere. */
  tags: readonly string[];
  amount: AmountCondition;
  /** Looked up in detail and note, ignoring case and accents. */
  search: string;
}

export const EMPTY_FILTER: ListFilter = {
  type: "all",
  categories: [],
  tags: [],
  amount: { op: "gt", text: "" },
  search: "",
};

/** The amount in hundredths, or null when the text is empty or not an amount. */
export function amountBound(condition: AmountCondition): number | null {
  const parsed = parseAmount(condition.text, 2);
  return parsed.ok ? parsed.value : null;
}

function compare(amount: number, op: AmountOp, bound: number): boolean {
  if (op === "gt") return amount > bound;
  if (op === "lt") return amount < bound;
  return amount === bound;
}

/** Lower case without accents, so "cafe" finds "Café". */
export function searchKey(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function isFilterActive(filter: ListFilter): boolean {
  return (
    filter.type !== "all" ||
    filter.categories.length > 0 ||
    filter.tags.length > 0 ||
    amountBound(filter.amount) !== null ||
    filter.search.trim() !== ""
  );
}

export function filterEntries<T extends LiveTransaction>(
  entries: readonly T[],
  filter: ListFilter,
): T[] {
  const categories = new Set(filter.categories);
  const tags = new Set(filter.tags.map(tagKey));
  const bound = amountBound(filter.amount);
  const text = searchKey(filter.search.trim());
  return entries.filter(
    (e) =>
      (filter.type === "all" || e.type === filter.type) &&
      (categories.size === 0 || categories.has(e.category)) &&
      (tags.size === 0 || e.tags.some((tag) => tags.has(tagKey(tag)))) &&
      (bound === null || compare(e.amount, filter.amount.op, bound)) &&
      (text === "" || searchKey(e.detail).includes(text) || searchKey(e.note).includes(text)),
  );
}

/**
 * The patch for a type change: chosen categories that the new type doesn't have are dropped,
 * so the picker never counts choices it no longer shows.
 */
export function withType(
  filter: ListFilter,
  type: TypeFilter,
  categories: readonly { type: "income" | "expense"; name: string }[],
): Pick<ListFilter, "type" | "categories"> {
  if (type === "all") return { type, categories: filter.categories };
  const names = new Set(categories.filter((c) => c.type === type).map((c) => c.name));
  return { type, categories: filter.categories.filter((name) => names.has(name)) };
}
