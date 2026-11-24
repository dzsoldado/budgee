import { describe, expect, test } from "bun:test";
import { CURRENCIES, currencyName, isKnownCurrency } from "../src/currencies";

describe("currencies", () => {
  test("the list is sorted, unique ISO 4217 codes", () => {
    expect(CURRENCIES.length).toBeGreaterThan(150);
    expect([...CURRENCIES].sort()).toEqual([...CURRENCIES]);
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length);
    for (const code of CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/);
  });

  test("knows current codes, including recent ones", () => {
    for (const code of [
      "DZD",
      "EUR",
      "USD",
      "TRY",
      "GBP",
      "JPY",
      "XOF",
      "XCG",
      "ZWG",
      "SLE",
      "VES",
    ]) {
      expect([code, isKnownCurrency(code)]).toEqual([code, true]);
    }
  });

  test("knows recently withdrawn codes, so old records still import, but does not offer them", () => {
    for (const code of ["HRK", "BGN", "ANG", "LTL", "VEF"]) {
      expect([code, isKnownCurrency(code)]).toEqual([code, true]);
      expect(CURRENCIES).not.toContain(code);
    }
  });

  test("rejects unknown, lowercase and non-currency codes", () => {
    for (const code of ["ABC", "ZZZ", "eur", "EU", "EURO", "", "XXX", "XTS", "XAU"]) {
      expect([code, isKnownCurrency(code)]).toEqual([code, false]);
    }
  });

  test("display names come from Intl, falling back to the code", () => {
    expect(currencyName("EUR", "en")).toBe("Euro");
    expect(currencyName("DZD", "en")).toContain("Algerian");
    expect(currencyName("ZZZ", "en")).toBe("ZZZ");
    expect(currencyName("EUR", "not a locale!")).toBe("EUR");
  });
});
