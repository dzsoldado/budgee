import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  formatAmount,
  formatOriginal,
  latestEntryInCurrency,
  parseAmount,
  suggestAmountFromRate,
  sum,
  totals,
} from "../src/money";
import { transactionFieldsSchema } from "../src/schema";

const NBSP = " ";
const MINUS = "−";

const value = (result: ReturnType<typeof parseAmount>) => (result.ok ? result.value : result.error);

describe("parseAmount", () => {
  test("0 decimals: whole units only, separators before 3 digits are grouping", () => {
    expect(value(parseAmount("1500", 0))).toBe(150000);
    expect(value(parseAmount("1,500", 0))).toBe(150000);
    expect(value(parseAmount("1.500", 0))).toBe(150000);
    expect(value(parseAmount("1 500", 0))).toBe(150000);
    expect(value(parseAmount(`1${NBSP}500`, 0))).toBe(150000);
    expect(value(parseAmount("1'500", 0))).toBe(150000);
    expect(value(parseAmount("1,234,567", 0))).toBe(123456700);
    expect(value(parseAmount("0", 0))).toBe(0);
    expect(value(parseAmount(" 42 ", 0))).toBe(4200);
  });

  test("0 decimals: any fraction is rejected", () => {
    expect(value(parseAmount("1,5", 0))).toBe("too_many_decimals");
    expect(value(parseAmount("1.5", 0))).toBe("too_many_decimals");
    expect(value(parseAmount("1500.00", 0))).toBe("too_many_decimals");
  });

  test("1 decimal", () => {
    expect(value(parseAmount("12.5", 1))).toBe(1250);
    expect(value(parseAmount("12,5", 1))).toBe(1250);
    expect(value(parseAmount("12", 1))).toBe(1200);
    expect(value(parseAmount("1,234.5", 1))).toBe(123450);
    expect(value(parseAmount("1.234,5", 1))).toBe(123450);
    expect(value(parseAmount("12.55", 1))).toBe("too_many_decimals");
  });

  test("2 decimals", () => {
    expect(value(parseAmount("12.34", 2))).toBe(1234);
    expect(value(parseAmount("12,34", 2))).toBe(1234);
    expect(value(parseAmount("0.05", 2))).toBe(5);
    expect(value(parseAmount(".5", 2))).toBe(50);
    expect(value(parseAmount("7.", 2))).toBe(700);
    expect(value(parseAmount("120.00", 2))).toBe(12000);
    expect(value(parseAmount("1,234,567.89", 2))).toBe(123456789);
    expect(value(parseAmount("1.234.567,89", 2))).toBe(123456789);
    expect(value(parseAmount("1 234,56", 2))).toBe(123456);
    // Indian grouping: interior groups of 2, last group of 3.
    expect(value(parseAmount("12,34,567.50", 2))).toBe(123456750);
    expect(value(parseAmount("1234.567", 2))).toBe("too_many_decimals");
    expect(value(parseAmount("0.001", 2))).toBe("too_many_decimals");
  });

  test("a single separator before exactly 3 digits is grouping, since decimals never exceed 2", () => {
    expect(value(parseAmount("12.345", 2))).toBe(1234500);
    expect(value(parseAmount("12,345", 2))).toBe(1234500);
  });

  test("rejects empty and malformed input", () => {
    expect(value(parseAmount("", 2))).toBe("empty");
    expect(value(parseAmount("   ", 2))).toBe("empty");
    for (const bad of [
      "abc",
      "-5",
      "+5",
      "1..2",
      "1,,234",
      "1.234.56",
      "1,234.567.8",
      "1.234,567.89",
      "12e3",
      "0x10",
      "Infinity",
      "NaN",
      ".",
      ",",
      "1,23,4",
      "1234,567,890",
      "DZD 15",
    ]) {
      expect([bad, value(parseAmount(bad, 2))]).toEqual([bad, "invalid"]);
    }
  });

  test("rejects amounts beyond safe integers", () => {
    expect(value(parseAmount("999999999999999999", 2))).toBe("too_large");
    expect(value(parseAmount("90071992547409.91", 2))).toBe(9007199254740991);
    expect(value(parseAmount("90071992547409.92", 2))).toBe("too_large");
  });
});

describe("formatAmount", () => {
  const dzd = { currency: "DZD", locale: "en" } as const;

  test("0 decimals rounds half away from zero in integers", () => {
    expect(formatAmount(150000, { ...dzd, decimals: 0 })).toBe(`DZD${NBSP}1,500`);
    expect(formatAmount(150050, { ...dzd, decimals: 0 })).toBe(`DZD${NBSP}1,501`);
    expect(formatAmount(150049, { ...dzd, decimals: 0 })).toBe(`DZD${NBSP}1,500`);
    expect(formatAmount(-150050, { ...dzd, decimals: 0 })).toBe(`${MINUS}DZD${NBSP}1,501`);
  });

  test("1 decimal has no float rounding trap", () => {
    // 1.15 as a float is 1.1499999…; rounding in integers gives 1.2.
    expect(formatAmount(115, { ...dzd, decimals: 1 })).toBe(`DZD${NBSP}1.2`);
    expect(formatAmount(123444, { ...dzd, decimals: 1 })).toBe(`DZD${NBSP}1,234.4`);
    expect(formatAmount(123445, { ...dzd, decimals: 1 })).toBe(`DZD${NBSP}1,234.5`);
  });

  test("2 decimals", () => {
    expect(formatAmount(5, { ...dzd, decimals: 2 })).toBe(`DZD${NBSP}0.05`);
    expect(formatAmount(1299950, { ...dzd, decimals: 2 })).toBe(`DZD${NBSP}12,999.50`);
    expect(formatAmount(9007199254740991, { ...dzd, decimals: 2 })).toBe(
      `DZD${NBSP}90,071,992,547,409.91`,
    );
  });

  test("without a currency it is a plain grouped number (list rows)", () => {
    expect(formatAmount(1850000, { decimals: 0, locale: "en" })).toBe("18,500");
  });

  test("sign: auto shows only minus, always shows + and −, never shows neither; minus is U+2212", () => {
    const o = { decimals: 0, locale: "en" } as const;
    expect(formatAmount(389000, { ...o, sign: "auto" })).toBe("3,890");
    expect(formatAmount(-389000, { ...o, sign: "auto" })).toBe(`${MINUS}3,890`);
    expect(formatAmount(-389000, o)).toBe(`${MINUS}3,890`);
    expect(formatAmount(389000, { ...o, sign: "always" })).toBe("+3,890");
    expect(formatAmount(-389000, { ...o, sign: "always" })).toBe(`${MINUS}3,890`);
    expect(formatAmount(0, { ...o, sign: "always" })).toBe("0");
    expect(formatAmount(-389000, { ...o, sign: "never" })).toBe("3,890");
  });

  test("follows the locale", () => {
    const fr = formatAmount(123456, { currency: "EUR", decimals: 2, locale: "fr" });
    expect(fr).toContain("234,56");
    expect(fr).toContain("EUR");
  });

  test("rejects non-integer hundredths", () => {
    expect(() => formatAmount(1.5, { decimals: 2, locale: "en" })).toThrow(RangeError);
  });
});

describe("formatOriginal", () => {
  test("currency code and always 2 decimals", () => {
    expect(formatOriginal(12000, "EUR")).toBe(`EUR${NBSP}120.00`);
    expect(formatOriginal(9500, "USD")).toBe(`USD${NBSP}95.00`);
    expect(formatOriginal(240000, "TRY")).toBe(`TRY${NBSP}2,400.00`);
    // Even currencies without minor units, since original amounts are entered with 2.
    expect(formatOriginal(12000, "JPY")).toBe(`JPY${NBSP}120.00`);
  });
});

describe("sum", () => {
  test("no float drift", () => {
    // 0.1 + 0.2 in hundredths.
    expect(sum([10, 20])).toBe(30);
    expect(formatAmount(sum([10, 20]), { decimals: 2, locale: "en" })).toBe("0.30");
    expect(sum(Array.from({ length: 1000 }, () => 1))).toBe(1000);
    expect(sum([])).toBe(0);
  });

  test("rejects non-integers and unsafe totals", () => {
    expect(() => sum([1, 0.5])).toThrow(RangeError);
    expect(() => sum([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});

type Entry = Parameters<typeof suggestAmountFromRate>[2][number];
const entry = (fields: Partial<Entry>): Entry => ({
  date: "2026-11-01",
  created_at: "2026-11-01T10:00:00.000Z",
  amount: 100,
  original_amount: null,
  original_currency: null,
  ...fields,
});

describe("suggestAmountFromRate", () => {
  test("uses the rate of the most recent entry in that currency", () => {
    const transactions = [
      entry({
        date: "2026-08-12",
        amount: 280800,
        original_amount: 72000,
        original_currency: "TRY",
      }),
      entry({
        date: "2026-08-01",
        amount: 300000,
        original_amount: 72000,
        original_currency: "TRY",
      }),
      entry({
        date: "2026-11-14",
        amount: 1850000,
        original_amount: 12000,
        original_currency: "EUR",
      }),
      entry({ date: "2026-11-15", amount: 999 }),
    ];
    // 1 TRY = 3.90 DZD: 1,000.00 TRY → 3,900.00 DZD.
    expect(suggestAmountFromRate(100000, "TRY", transactions)).toBe(390000);
    expect(latestEntryInCurrency("TRY", transactions)?.amount).toBe(280800);
  });

  test("on the same date, the later created_at wins", () => {
    const transactions = [
      entry({
        created_at: "2026-11-01T12:00:00.000Z",
        amount: 200,
        original_amount: 100,
        original_currency: "USD",
      }),
      entry({
        created_at: "2026-11-01T09:00:00.000Z",
        amount: 300,
        original_amount: 100,
        original_currency: "USD",
      }),
    ];
    expect(suggestAmountFromRate(1000, "USD", transactions)).toBe(2000);
  });

  test("skips deleted entries and returns null without an earlier entry", () => {
    const transactions = [
      entry({
        date: "2026-11-02",
        amount: 500,
        original_amount: 100,
        original_currency: "USD",
        deleted: true,
      }),
      entry({ date: "2026-11-01", amount: 300, original_amount: 100, original_currency: "USD" }),
    ];
    expect(suggestAmountFromRate(100, "USD", transactions)).toBe(300);
    expect(suggestAmountFromRate(100, "EUR", transactions)).toBeNull();
    expect(suggestAmountFromRate(100, "USD", [])).toBeNull();
  });

  test("rounds to hundredths, half up, exactly for large values", () => {
    const third = [entry({ amount: 100, original_amount: 300, original_currency: "USD" })];
    expect(suggestAmountFromRate(100, "USD", third)).toBe(33);
    expect(suggestAmountFromRate(200, "USD", third)).toBe(67);
    const half = [entry({ amount: 1, original_amount: 2, original_currency: "USD" })];
    expect(suggestAmountFromRate(1, "USD", half)).toBe(1);
    const big = [
      entry({
        amount: 9_000_000_000_000,
        original_amount: 7_000_000_000_000,
        original_currency: "USD",
      }),
    ];
    // 9e12 × 9e12 / 7e12 = 11571428571428.571… → 11571428571429.
    expect(suggestAmountFromRate(9_000_000_000_000, "USD", big)).toBe(11_571_428_571_429);
  });

  test("rounds once, half up, straight to the configured decimals", () => {
    // 2.50 for 100.00, then 99.80 → exactly 2.495.
    const rate = [entry({ amount: 250, original_amount: 10000, original_currency: "EUR" })];
    expect(suggestAmountFromRate(9980, "EUR", rate, 2)).toBe(250); // 2.495 → 2.50
    expect(suggestAmountFromRate(9980, "EUR", rate, 1)).toBe(250); // 2.495 → 2.5
    // Rounding to hundredths first (250) and then to units would give 3.
    expect(suggestAmountFromRate(9980, "EUR", rate, 0)).toBe(200); // 2.495 → 2
    // 2.45 exactly → 2.5 at 1 decimal (a hundredths step first would not change it).
    expect(suggestAmountFromRate(9800, "EUR", rate, 1)).toBe(250);
    // 1.95 → 2.0 (1 decimal), 2 (0 decimals); 1.949… → 1.9 and 2.
    expect(suggestAmountFromRate(7800, "EUR", rate, 1)).toBe(200);
    expect(suggestAmountFromRate(7796, "EUR", rate, 1)).toBe(190);
    expect(suggestAmountFromRate(7796, "EUR", rate, 0)).toBe(200);
    // Half up at 0 decimals: 2.50 exactly → 3.
    expect(suggestAmountFromRate(10000, "EUR", rate, 0)).toBe(300);
  });
});

describe("totals", () => {
  test("income, expenses and difference from amount only", () => {
    const rows = [
      { type: "income" as const, amount: 8500000 },
      { type: "expense" as const, amount: 1850000 },
      { type: "expense" as const, amount: 40000 },
      { type: "expense" as const, amount: 999999, deleted: true },
    ];
    expect(totals(rows)).toEqual({ income: 8500000, expenses: 1890000, difference: 6610000 });
    expect(totals([])).toEqual({ income: 0, expenses: 0, difference: 0 });
  });

  test("original amounts never enter totals", () => {
    const plain = [
      { type: "expense" as const, amount: 1850000, original_amount: null, original_currency: null },
    ];
    const foreign = [
      {
        type: "expense" as const,
        amount: 1850000,
        original_amount: 12000,
        original_currency: "EUR",
      },
    ];
    expect(totals(foreign)).toEqual(totals(plain));
    expect(totals(foreign).expenses).toBe(1850000);
  });
});

describe("original amount and currency", () => {
  const base = {
    type: "expense",
    amount: 1850000,
    date: "2026-11-14",
    category: "Home",
    created_at: "2026-11-14T10:00:00.000Z",
  };
  const ok = (extra: object) => v.safeParse(transactionFieldsSchema, { ...base, ...extra }).success;

  test("are both set or both empty", () => {
    expect(ok({})).toBe(true);
    expect(ok({ original_amount: 12000, original_currency: "EUR" })).toBe(true);
    expect(ok({ original_amount: null, original_currency: null })).toBe(true);
    expect(ok({ original_amount: 12000 })).toBe(false);
    expect(ok({ original_currency: "EUR" })).toBe(false);
    expect(ok({ original_amount: 12000, original_currency: null })).toBe(false);
    expect(ok({ original_amount: null, original_currency: "EUR" })).toBe(false);
  });
});
