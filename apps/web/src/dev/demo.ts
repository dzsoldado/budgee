// Dev-only sample data: the mockups' entries (drawn on 17 Nov 2026), placed relative to today,
// plus about 14 months of history so dashboards have something to compare. Only imported
// behind `import.meta.env.DEV`, so production builds leave it out.

import type { BudgeeDb } from "../db/db";
import { getMeta } from "../db/db";
import type { FieldsInputOf, Repository } from "../db/repository";
import { addDays, daysInMonth, parseIsoDate, todayIso, toIsoDate } from "../lib/date";

type DemoTransaction = FieldsInputOf<"transactions"> & { tags: string[] };

interface Spec {
  type: "income" | "expense";
  category: string;
  detail: string;
  /** Main currency units (DZD); may have decimals. */
  amount: number;
  note?: string;
  tags?: string[];
  /** Amount in another currency, in its units, and that currency's code. */
  orig?: [number, string];
}

const exp = (
  category: string,
  detail: string,
  amount: number,
  extra: Partial<Spec> = {},
): Spec => ({
  type: "expense",
  category,
  detail,
  amount,
  ...extra,
});
const inc = (
  category: string,
  detail: string,
  amount: number,
  extra: Partial<Spec> = {},
): Spec => ({
  type: "income",
  category,
  detail,
  amount,
  ...extra,
});

const TRIP = ["Istanbul 2026"];
const HOME_OFFICE = ["Home office"];
const WEDDING = ["Wedding"];

/** The List mockup's month, by days before today (in the order a day lists them). */
const THIS_MONTH: [number, Spec][] = [
  [0, exp("Groceries", "Carrefour", 3240)],
  [0, exp("Transport", "Taxi", 650)],
  [-1, inc("Freelance", "Logo project", 25000, { note: "paid on delivery" })],
  [-1, exp("Going out", "Café", 400)],
  [
    -3,
    exp("Shopping", "IKEA", 18500, {
      note: "desk chair",
      orig: [120, "EUR"],
      tags: HOME_OFFICE,
    }),
  ],
  [-5, exp("Bills", "Electricity", 4180, { note: "Q4 bill" })],
  [-14, exp("Clothing", "AliExpress", 12999, { note: "winter coat", orig: [95, "USD"] })],
  [-15, exp("Medical", "dentist", 4500)],
  [-16, inc("Salary", "", 85000)],
];

/**
 * The same month last year, by days from today's date a year ago. Days 0 to -16 are the
 * Dashboard mockup's comparison (1–17 Nov 2025 against 1–17 Nov 2026); later days fill the
 * rest of that month.
 */
const SAME_MONTH_LAST_YEAR: [number, Spec][] = [
  [-1, exp("Medical", "Pharmacy", 1200)],
  [-2, exp("Groceries", "Carrefour", 3100)],
  [-3, exp("Transport", "Taxi", 900)],
  [-4, exp("Bills", "Electricity", 3900)],
  [-6, exp("Going out", "Restaurant", 1650)],
  [-8, exp("Home", "Washing machine", 34500)],
  [-9, exp("Groceries", "Carrefour", 2500)],
  [-10, inc("Freelance", "Website fixes", 18200)],
  [-12, exp("Going out", "Café", 400)],
  [-16, inc("Salary", "", 80000)],
  [2, exp("Groceries", "Carrefour", 3400)],
  [4, exp("Transport", "Taxi", 700)],
  [5, exp("Bills", "Internet", 2600)],
  [7, exp("Going out", "Café", 450)],
  [9, exp("Groceries", "Carrefour", 3800)],
  [11, exp("Clothing", "Zara", 2900)],
  [13, exp("Home", "Hardware store", 500)],
];

/** Everyday spending per month (thousands), read off the Dashboard mockup's line chart. */
const EVERYDAY_TARGET: Record<number, number> = {
  [-1]: 28,
  [-2]: 27,
  [-3]: 31,
  [-4]: 29,
  [-5]: 30,
  [-6]: 26,
  [-7]: 28,
  [-8]: 27,
  [-9]: 24,
  [-10]: 25,
  [-11]: 35,
  [-13]: 27,
  [-14]: 26,
};

/** A usual month's everyday expenses: day, category, detail, share of the month's total. */
const EVERYDAY: [number, string, string, number][] = [
  [3, "Groceries", "Carrefour", 0.12],
  [5, "Bills", "Internet", 0.07],
  [7, "Transport", "Taxi", 0.025],
  [8, "Going out", "Café", 0.015],
  [10, "Groceries", "Carrefour", 0.12],
  [12, "Bills", "Electricity", 0.1],
  [14, "Transport", "Fuel", 0.08],
  [15, "Going out", "Restaurant", 0.06],
  [17, "Groceries", "Carrefour", 0.095],
  [19, "Medical", "Pharmacy", 0.04],
  [21, "Transport", "Taxi", 0.025],
  [22, "Clothing", "Zara", 0.05],
  [24, "Groceries", "Carrefour", 0.12],
  [26, "Home", "Hardware store", 0.03],
  [27, "Bills", "Phone", 0.035],
  [28, "Going out", "Café", 0.015],
];

const FREELANCE = ["Logo project", "Website fixes", "Translation"];

/** One-offs by month offset and day: big purchases, the trip, a wedding. */
const EXTRAS: [number, number, Spec][] = [
  [-2, 9, exp("Shopping", "Monitor", 24000, { tags: HOME_OFFICE })],
  [-3, 10, exp("Transport", "Flight to Istanbul", 38000, { tags: TRIP })],
  [-3, 11, exp("Going out", "Simit and tea", 702, { orig: [180, "TRY"], tags: TRIP })],
  [-3, 12, exp("Transport", "Istanbul ferry", 2808, { orig: [720, "TRY"], tags: TRIP })],
  [-3, 13, exp("Going out", "Kebab lunch", 3315, { orig: [850, "TRY"], tags: TRIP })],
  [-3, 14, exp("Transport", "Istanbul ferry", 468, { orig: [120, "TRY"], tags: TRIP })],
  [-3, 14, exp("Clothing", "Grand Bazaar", 5850, { orig: [1500, "TRY"], tags: TRIP })],
  [-3, 15, exp("Transport", "Istanbul ferry", 468, { orig: [120, "TRY"], tags: TRIP })],
  [-3, 16, exp("Gifts", "Turkish delight", 2340, { orig: [600, "TRY"], tags: TRIP })],
  [-5, 18, exp("Clothing", "Suit rental", 8000, { tags: WEDDING })],
  [-5, 20, exp("Gifts", "Wedding gift", 15000, { tags: WEDDING })],
  [-8, 16, exp("Transport", "Car repair", 22000)],
  [-11, 20, exp("Gifts", "New Year presents", 15000)],
  [-11, 25, inc("Gifts received", "Family", 10000)],
  [-14, 6, exp("Home", "Sofa", 45000)],
];

const HISTORY_MONTHS = 14;

/** Day `day` (clamped to the month's length) of the month `offset` months from `today`'s. */
function monthDay(today: string, offset: number, day: number): string {
  const t = parseIsoDate(today);
  const year = t.getUTCFullYear();
  const month = t.getUTCMonth() + offset;
  const first = new Date(Date.UTC(year, month, 1));
  const length = daysInMonth(first.getUTCFullYear(), first.getUTCMonth());
  return toIsoDate(new Date(Date.UTC(year, month, Math.min(day, length))));
}

function yearAgo(today: string): string {
  const t = parseIsoDate(today);
  const year = t.getUTCFullYear() - 1;
  const day = Math.min(t.getUTCDate(), daysInMonth(year, t.getUTCMonth()));
  return toIsoDate(new Date(Date.UTC(year, t.getUTCMonth(), day)));
}

const hundredths = (units: number) => Math.round(units * 100);

/** The demo entries for `today` (YYYY-MM-DD), oldest month last; none dated after today. */
export function buildDemoTransactions(today: string): DemoTransaction[] {
  const dated: [string, Spec][] = [];
  for (const [days, spec] of THIS_MONTH) dated.push([addDays(today, days), spec]);
  const lastYear = yearAgo(today);
  for (const [days, spec] of SAME_MONTH_LAST_YEAR) dated.push([addDays(lastYear, days), spec]);

  const thisYear = parseIsoDate(today).getUTCFullYear();
  for (let m = -1; m >= -HISTORY_MONTHS; m--) {
    if (m === -12) continue; // drawn above, to match the mockup's comparison
    const salaryDate = monthDay(today, m, 1);
    const salary = parseIsoDate(salaryDate).getUTCFullYear() === thisYear ? 85000 : 80000;
    dated.push([salaryDate, inc("Salary", "", salary)]);
    if (m % 3 === -1) {
      const detail = FREELANCE[(-m - 1) % FREELANCE.length] ?? "Freelance";
      dated.push([monthDay(today, m, 20), inc("Freelance", detail, 15000 + (-m % 4) * 2000)]);
    }
    const target = (EVERYDAY_TARGET[m] ?? 27) * 1000;
    for (const [day, category, detail, share] of EVERYDAY) {
      dated.push([
        monthDay(today, m, day),
        exp(category, detail, Math.round((target * share) / 10) * 10),
      ]);
    }
  }
  for (const [m, day, spec] of EXTRAS) dated.push([monthDay(today, m, day), spec]);

  // Within a day, entries listed first were made last, so newest-first lists keep their order.
  const perDay = new Map<string, number>();
  return dated
    .filter(([date]) => date <= today)
    .map(([date, s]) => {
      const k = perDay.get(date) ?? 0;
      perDay.set(date, k + 1);
      const createdAt = parseIsoDate(date).getTime() + 20 * 3_600_000 - k * 600_000;
      return {
        type: s.type,
        amount: hundredths(s.amount),
        date,
        category: s.category,
        detail: s.detail,
        note: s.note ?? "",
        tags: s.tags ?? [],
        original_amount: s.orig ? hundredths(s.orig[0]) : null,
        original_currency: s.orig ? s.orig[1] : null,
        created_at: new Date(createdAt).toISOString(),
      };
    });
}

export type DemoResult = "loaded" | "not_fresh" | "paired";

/** Loads the demo entries through the repository, only on a fresh unpaired install. */
export async function loadDemo(
  db: BudgeeDb,
  repo: Repository,
  today: string = todayIso(),
): Promise<DemoResult> {
  if ((await getMeta(db, "deviceToken")) !== undefined) return "paired";
  if ((await db.transactions.count()) > 0) return "not_fresh";
  const rows = buildDemoTransactions(today);
  await repo.write(async (w) => {
    for (const row of rows) await w.put("transactions", row);
  });
  return "loaded";
}

/** `?demo=1` in the address loads the demo, then leaves the address without it. */
export async function loadDemoFromUrl(db: BudgeeDb, repo: Repository): Promise<void> {
  const url = new URL(window.location.href);
  if (url.searchParams.get("demo") !== "1") return;
  const result = await loadDemo(db, repo);
  console.info(`Demo data: ${result}`);
  url.searchParams.delete("demo");
  window.history.replaceState(window.history.state, "", url);
}
