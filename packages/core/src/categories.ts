// Renaming a category bulk-updates the transactions that use it, so the CSV stays readable
// without lookups. Like the tag helpers, this returns only the changed transactions with their
// old hlc; the caller assigns a new one when it saves them.
import type { Deleted, Live } from "./tags";

interface Categorized {
  type: "income" | "expense";
  category: string;
  deleted?: boolean;
}

/** Transactions of `type` in category `from` (exact name) moved to `to`. */
export function renameCategory<T extends Categorized | Deleted>(
  transactions: readonly T[],
  type: "income" | "expense",
  from: string,
  to: string,
): Live<T>[] {
  const updated: Live<T>[] = [];
  for (const t of transactions) {
    if (t.deleted) continue;
    const row = t as Live<T> & Categorized;
    if (row.type === type && row.category === from && from !== to) {
      updated.push({ ...row, category: to });
    }
  }
  return updated;
}
