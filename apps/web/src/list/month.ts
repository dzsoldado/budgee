// Months as `YYYY-MM`, and the one query the List screen runs: a month's live entries.
import type { LiveTransaction } from "@budgee/core";
import type { BudgeeDb } from "../db/db";
import { formatPlainDate } from "../i18n/format";
import { daysInMonth } from "../lib/date";

/** `YYYY-MM` of a `YYYY-MM-DD` date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  const year = Math.floor(total / 12);
  return `${String(year).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** First and last day of the month, inclusive. */
export function monthRange(month: string): { start: string; end: string } {
  const days = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1);
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}` };
}

/** "November 2026" in `locale`. */
export function monthTitle(month: string, locale: string): string {
  return formatPlainDate(`${month}-01`, locale, { month: "long", year: "numeric" });
}

/**
 * The month's live entries, read through the `date` index. Tombstones carry no `date`, so the
 * index never holds them; the filter only guards the type.
 */
export async function loadMonthEntries(db: BudgeeDb, month: string): Promise<LiveTransaction[]> {
  const { start, end } = monthRange(month);
  const rows = await db.transactions.where("date").between(start, end, true, true).toArray();
  return rows.filter((row): row is LiveTransaction & { dirty: 0 | 1 } => !row.deleted);
}
