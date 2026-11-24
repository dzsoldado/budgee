import { describe, expect, test } from "bun:test";
import { transactionFieldsSchema } from "@budgee/core";
import * as v from "valibot";
import { setMeta } from "../src/db/db";
import { openRepository } from "../src/db/repository";
import { buildDemoTransactions, loadDemo } from "../src/dev/demo";
import { freshDb } from "./helpers";

const TODAY = "2026-11-17";
const rows = buildDemoTransactions(TODAY).map((r) => v.parse(transactionFieldsSchema, r));
const between = (from: string, to: string) => rows.filter((r) => r.date >= from && r.date <= to);
const total = (list: typeof rows, type: "income" | "expense") =>
  list.filter((r) => r.type === type).reduce((s, r) => s + r.amount, 0);

describe("buildDemoTransactions", () => {
  test("every row is valid", () => {
    expect(rows.length).toBeGreaterThan(150);
  });

  test("this month holds the mockup's entries, with its totals", () => {
    const month = between("2026-11-01", TODAY);
    expect(total(month, "income")).toBe(11_000_000);
    expect(total(month, "expense")).toBe(4_446_900);
    expect(month.find((r) => r.detail === "IKEA")).toMatchObject({
      date: "2026-11-14",
      category: "Shopping",
      note: "desk chair",
      amount: 1_850_000,
      original_amount: 12_000,
      original_currency: "EUR",
    });
    expect(month.find((r) => r.detail === "AliExpress")).toMatchObject({
      date: "2026-11-03",
      original_amount: 9_500,
      original_currency: "USD",
    });
    expect(month.filter((r) => r.date === TODAY).map((r) => r.detail)).toEqual([
      "Carrefour",
      "Taxi",
    ]);
  });

  test("the same days last year match the dashboard mockup's comparison", () => {
    const window = between("2025-11-01", "2025-11-17");
    expect(total(window, "income")).toBe(9_820_000);
    const byCategory: Record<string, number> = {};
    for (const r of window.filter((r) => r.type === "expense")) {
      byCategory[r.category] = (byCategory[r.category] ?? 0) + r.amount;
    }
    expect(byCategory).toEqual({
      Medical: 120_000,
      Bills: 390_000,
      Groceries: 560_000,
      Transport: 90_000,
      "Going out": 205_000,
      Home: 3_450_000,
    });
    const income = total(window, "income");
    const kept = Math.round(((income - total(window, "expense")) / income) * 100);
    expect(kept).toBe(51);
  });

  test("covers about 14 months back, with salary every month", () => {
    expect(rows.some((r) => r.date < "2025-10-01")).toBe(true);
    for (let m = 0; m < 15; m++) {
      const month = new Date(Date.UTC(2026, 10 - m, 1)).toISOString().slice(0, 7);
      const salaries = rows.filter((r) => r.category === "Salary" && r.date.startsWith(month));
      expect({ month, salaries: salaries.length }).toEqual({ month, salaries: 1 });
    }
  });

  test("has the Istanbul 2026 trip paid in TRY, at 3.90 for the latest entry", () => {
    const trip = rows.filter((r) => r.tags.includes("Istanbul 2026"));
    expect(trip.filter((r) => r.detail === "Istanbul ferry").length).toBe(3);
    expect(trip.find((r) => r.amount === 280_800)).toMatchObject({
      original_amount: 72_000,
      original_currency: "TRY",
    });
    const tryRows = rows.filter((r) => r.original_currency === "TRY");
    const latest = tryRows.reduce((a, b) => (b.date > a.date ? b : a));
    expect(latest.amount / (latest.original_amount ?? 1)).toBeCloseTo(3.9, 5);
  });

  test("uses three tags", () => {
    expect(new Set(rows.flatMap((r) => r.tags))).toEqual(
      new Set(["Istanbul 2026", "Home office", "Wedding"]),
    );
  });

  test("never dates an entry after today, whatever today is", () => {
    for (const today of ["2026-11-17", "2027-03-05", "2028-02-29", "2026-01-01"]) {
      const built = buildDemoTransactions(today);
      expect(built.filter((r) => r.date > today)).toEqual([]);
      for (const r of built) v.parse(transactionFieldsSchema, r);
    }
  });
});

describe("loadDemo", () => {
  test("loads on a fresh unpaired install, through the repository (dirty rows)", async () => {
    const db = freshDb();
    const repo = await openRepository(db);
    expect(await loadDemo(db, repo, TODAY)).toBe("loaded");
    expect(await db.transactions.count()).toBe(rows.length);
    expect(await db.transactions.where("dirty").equals(0).count()).toBe(0);
  });

  test("refuses when entries already exist or the device is paired", async () => {
    const db = freshDb();
    const repo = await openRepository(db);
    await loadDemo(db, repo, TODAY);
    expect(await loadDemo(db, repo, TODAY)).toBe("not_fresh");
    const paired = freshDb();
    await setMeta(paired, "deviceToken", "token");
    expect(await loadDemo(paired, await openRepository(paired), TODAY)).toBe("paired");
    expect(await paired.transactions.count()).toBe(0);
  });
});
