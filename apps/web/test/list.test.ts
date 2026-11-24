import { describe, expect, test } from "bun:test";
import type { LiveTransaction } from "@budgee/core";
import { openRepository } from "../src/db/repository";
import { sortByOrder } from "../src/list/categories";
import {
  EMPTY_FILTER,
  filterEntries,
  isFilterActive,
  type ListFilter,
  withType,
} from "../src/list/filter";
import { dayLabel, groupByDay, sortNewestFirst } from "../src/list/group";
import { loadMonthEntries, monthOf, monthRange, monthTitle, shiftMonth } from "../src/list/month";
import { clearListFilter, listFilter, updateListFilter } from "../src/list/store";
import { expense, freshDb } from "./helpers";

let n = 0;
function entry(fields: Partial<LiveTransaction>): LiveTransaction {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    hlc: "000000000000001:00000:dev",
    device: "dev",
    deleted: false,
    type: "expense",
    amount: 100,
    date: "2026-11-17",
    category: "Groceries",
    detail: "",
    note: "",
    tags: [],
    original_amount: null,
    original_currency: null,
    created_at: "2026-11-17T09:00:00.000Z",
    ...fields,
  };
}

const filter = (patch: Partial<ListFilter>): ListFilter => ({ ...EMPTY_FILTER, ...patch });

describe("months", () => {
  test("monthOf, shiftMonth and monthRange", () => {
    expect(monthOf("2026-11-17")).toBe("2026-11");
    expect(shiftMonth("2026-11", 1)).toBe("2026-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-03", -14)).toBe("2025-01");
    expect(monthRange("2026-11")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(monthRange("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  test("monthTitle uses the locale", () => {
    expect(monthTitle("2026-11", "en")).toBe("November 2026");
    expect(monthTitle("2026-11", "fr")).toBe("novembre 2026");
  });

  test("loadMonthEntries reads one month by date and skips tombstones", async () => {
    const db = freshDb();
    const repo = await openRepository(db);
    const keep = await repo.put("transactions", { ...expense, date: "2026-11-01" });
    await repo.put("transactions", { ...expense, date: "2026-11-30", detail: "last day" });
    await repo.put("transactions", { ...expense, date: "2026-10-31" });
    await repo.put("transactions", { ...expense, date: "2026-12-01" });
    const gone = await repo.put("transactions", { ...expense, date: "2026-11-10" });
    await repo.remove("transactions", gone.id);

    const rows = await loadMonthEntries(db, "2026-11");
    expect(rows.map((r) => r.date).sort()).toEqual(["2026-11-01", "2026-11-30"]);
    expect(rows.every((r) => r.deleted === false)).toBe(true);
    expect(rows.find((r) => r.id === keep.id)?.detail).toBe("Carrefour");
  });
});

describe("filterEntries", () => {
  const groceries = entry({ detail: "Carrefour", tags: ["Home office"] });
  const taxi = entry({ category: "Transport", detail: "Taxi", note: "airport run" });
  const chair = entry({ category: "Home", detail: "IKEA", note: "Desk chair" });
  const salary = entry({ type: "income", category: "Salary" });
  const cafe = entry({ category: "Eating out", detail: "Café", tags: ["istanbul 2026"] });
  const all = [groceries, taxi, chair, salary, cafe];

  test("the empty filter keeps everything and is not active", () => {
    expect(filterEntries(all, EMPTY_FILTER)).toEqual(all);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive(filter({ search: "  " }))).toBe(false);
    expect(isFilterActive(filter({ search: "taxi" }))).toBe(true);
    expect(isFilterActive(filter({ type: "income" }))).toBe(true);
    expect(isFilterActive(filter({ tags: ["x"] }))).toBe(true);
  });

  test("type", () => {
    expect(filterEntries(all, filter({ type: "income" }))).toEqual([salary]);
    expect(filterEntries(all, filter({ type: "expense" }))).toEqual([groceries, taxi, chair, cafe]);
  });

  test("categories: any of the chosen ones, income and expenses alike", () => {
    expect(filterEntries(all, filter({ categories: ["Home"] }))).toEqual([chair]);
    expect(filterEntries(all, filter({ categories: ["Transport", "Salary"] }))).toEqual([
      taxi,
      salary,
    ]);
    expect(isFilterActive(filter({ categories: ["Home"] }))).toBe(true);
  });

  test("tags match ignoring case and surrounding spaces", () => {
    expect(filterEntries(all, filter({ tags: ["Istanbul 2026 "] }))).toEqual([cafe]);
    expect(filterEntries(all, filter({ tags: ["HOME OFFICE", "nope"] }))).toEqual([groceries]);
  });

  test("search looks in detail and note, ignoring case and accents", () => {
    expect(filterEntries(all, filter({ search: "TAXI" }))).toEqual([taxi]);
    expect(filterEntries(all, filter({ search: "airport" }))).toEqual([taxi]);
    expect(filterEntries(all, filter({ search: " desk " }))).toEqual([chair]);
    expect(filterEntries(all, filter({ search: "cafe" }))).toEqual([cafe]);
    expect(filterEntries(all, filter({ search: "groceries" }))).toEqual([]);
  });

  test("amount: more than, less than, equal to; ignored until it parses", () => {
    const small = entry({ amount: 1250 });
    const big = entry({ amount: 150000 });
    const rows = [small, big];
    const amount = (op: "gt" | "lt" | "eq", text: string) => filter({ amount: { op, text } });
    expect(filterEntries(rows, amount("gt", "12.50"))).toEqual([big]);
    expect(filterEntries(rows, amount("lt", "1,500"))).toEqual([small]);
    expect(filterEntries(rows, amount("eq", "1500"))).toEqual([big]);
    expect(filterEntries(rows, amount("eq", "12,5"))).toEqual([small]);
    expect(filterEntries(rows, amount("gt", "1500"))).toEqual([]);
    expect(filterEntries(rows, amount("gt", "abc"))).toEqual(rows);
    expect(isFilterActive(amount("gt", " "))).toBe(false);
    expect(isFilterActive(amount("lt", "-5"))).toBe(false);
    expect(isFilterActive(amount("lt", "0"))).toBe(true);
  });

  test("dimensions combine with and", () => {
    expect(filterEntries(all, filter({ type: "income", categories: ["Home"] }))).toEqual([]);
    expect(
      filterEntries(all, filter({ categories: ["Groceries", "Transport"], search: "a" })),
    ).toEqual([groceries, taxi]);
  });
});

describe("grouping", () => {
  test("sortNewestFirst: date, then created_at, both descending", () => {
    const a = entry({ date: "2026-11-16", created_at: "2026-11-16T10:00:00.000Z" });
    const b = entry({ date: "2026-11-17", created_at: "2026-11-17T08:00:00.000Z" });
    const c = entry({ date: "2026-11-17", created_at: "2026-11-17T12:00:00.000Z" });
    expect(sortNewestFirst([a, b, c])).toEqual([c, b, a]);
  });

  test("groupByDay: newest day first, each with its signed net", () => {
    const groceries = entry({ amount: 324000, created_at: "2026-11-17T20:00:00.000Z" });
    const taxi = entry({ amount: 65000, created_at: "2026-11-17T19:50:00.000Z" });
    const logo = entry({
      type: "income",
      category: "Freelance",
      amount: 2500000,
      date: "2026-11-16",
      created_at: "2026-11-16T20:00:00.000Z",
    });
    const cafe = entry({
      amount: 40000,
      date: "2026-11-16",
      created_at: "2026-11-16T19:50:00.000Z",
    });
    const days = groupByDay([cafe, taxi, logo, groceries]);
    expect(days).toEqual([
      { date: "2026-11-17", net: -389000, entries: [groceries, taxi] },
      { date: "2026-11-16", net: 2460000, entries: [logo, cafe] },
    ]);
  });

  test("dayLabel: Today and Yesterday, else the weekday and date", () => {
    const today = "2026-11-17";
    expect(dayLabel("2026-11-17", today, "en")).toBe("Today · Tue 17 Nov");
    expect(dayLabel("2026-11-16", today, "en")).toBe("Yesterday · Mon 16 Nov");
    expect(dayLabel("2026-11-14", today, "en")).toBe("Sat 14 Nov");
    expect(dayLabel("2026-12-01", "2026-12-02", "en")).toBe("Yesterday · Tue 1 Dec");
  });
});

describe("categories", () => {
  test("live rows by sort, then name (archived kept, deleted dropped)", () => {
    const rows = [
      { id: "t", deleted: false, name: "Transport", sort: 1, archived: false },
      { id: "x", deleted: true },
      { id: "g", deleted: false, name: "Groceries", sort: 0, archived: false },
      { id: "s", deleted: false, name: "Salary", sort: 0, archived: false },
      { id: "b", deleted: false, name: "Bills", sort: 2, archived: true },
    ] as const;
    expect(sortByOrder(rows).map((c) => c.name)).toEqual([
      "Groceries",
      "Salary",
      "Transport",
      "Bills",
    ]);
  });
});

describe("withType", () => {
  const categories = [
    { type: "expense", name: "Groceries" },
    { type: "expense", name: "Transport" },
    { type: "income", name: "Salary" },
  ] as const;

  test("drops chosen categories the new type does not have", () => {
    const chosen = filter({ categories: ["Groceries", "Salary"] });
    expect(withType(chosen, "income", categories)).toEqual({
      type: "income",
      categories: ["Salary"],
    });
    expect(withType(chosen, "expense", categories)).toEqual({
      type: "expense",
      categories: ["Groceries"],
    });
  });

  test("All keeps every chosen category", () => {
    const chosen = filter({ type: "income", categories: ["Salary"] });
    expect(withType(chosen, "all", categories)).toEqual({ type: "all", categories: ["Salary"] });
  });
});

describe("list store", () => {
  test("updateListFilter merges; clearListFilter resets", () => {
    clearListFilter();
    updateListFilter({ type: "expense" });
    updateListFilter({ search: "taxi", tags: ["Trip"] });
    expect(listFilter()).toEqual({
      ...EMPTY_FILTER,
      type: "expense",
      search: "taxi",
      tags: ["Trip"],
    });
    clearListFilter();
    expect(listFilter()).toEqual(EMPTY_FILTER);
    expect(isFilterActive(listFilter())).toBe(false);
  });
});
