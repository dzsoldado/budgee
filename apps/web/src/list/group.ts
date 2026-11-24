// Entries by day, newest first, and the dates the List shows ("Today · Tue 17 Nov", "03 Nov").
import { type LiveTransaction, sum } from "@budgee/core";
import { t } from "../i18n";
import { addDays } from "../lib/date";

export interface DayGroup<T extends LiveTransaction = LiveTransaction> {
  date: string;
  /** Income minus expenses that day, in hundredths. */
  net: number;
  entries: T[];
}

/** Newest date first; within a day, the entry made last first. */
export function sortNewestFirst<T extends LiveTransaction>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) =>
    a.date !== b.date
      ? b.date.localeCompare(a.date)
      : b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
  );
}

/** Income positive, expenses negative. */
export const signedAmount = (e: LiveTransaction) => (e.type === "income" ? e.amount : -e.amount);

export function groupByDay<T extends LiveTransaction>(entries: readonly T[]): DayGroup<T>[] {
  const days: DayGroup<T>[] = [];
  for (const entry of sortNewestFirst(entries)) {
    const last = days.at(-1);
    if (last?.date === entry.date) last.entries.push(entry);
    else days.push({ date: entry.date, net: 0, entries: [entry] });
  }
  for (const day of days) day.net = sum(day.entries.map(signedAmount));
  return days;
}

/** The named parts of a plain date in `locale`; the dictionary decides their order. */
function dateParts(
  date: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const parts = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).formatToParts(
    Date.parse(`${date}T00:00:00Z`),
  );
  return Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
}

/** "Tue 17 Nov". */
export function weekdayDate(date: string, locale: string): string {
  return t(
    "list.dayDate",
    dateParts(date, locale, { weekday: "short", day: "numeric", month: "short" }),
  );
}

/** "03 Nov": the desktop table's date column. */
export function shortDate(date: string, locale: string): string {
  return t("list.shortDate", dateParts(date, locale, { day: "2-digit", month: "short" }));
}

export function dayLabel(date: string, today: string, locale: string): string {
  const text = weekdayDate(date, locale);
  if (date === today) return t("list.today", { date: text });
  if (date === addDays(today, -1)) return t("list.yesterday", { date: text });
  return text;
}
