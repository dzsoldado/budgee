import { describe, expect, test } from "bun:test";
import type { LiveTransaction } from "@budgee/core";
import {
  amountText,
  buildEntry,
  type EntryForm,
  emptyForm,
  formFromTransaction,
  normalizeAmountText,
  prefillAmount,
  rateText,
  sameForm,
  suggestedAmountText,
} from "../src/entry/form";
import { addTag, detailSuggestions, recentCurrencies, tagSuggestions } from "../src/entry/suggest";

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

const CREATED = "2026-11-17T10:00:00.000Z";
const form = (patch: Partial<EntryForm>): EntryForm => ({
  ...emptyForm("2026-11-17"),
  category: "Transport",
  amount: "2,808",
  ...patch,
});
const ctx = { decimals: 0 as const, createdAt: CREATED, knownTags: [] as string[] };

describe("buildEntry", () => {
  test("an expense in the main currency, trimmed, in hundredths", () => {
    const result = buildEntry(form({ detail: "  Taxi ", note: " late " }), ctx);
    expect(result).toEqual({
      ok: true,
      fields: {
        type: "expense",
        amount: 280800,
        date: "2026-11-17",
        category: "Transport",
        detail: "Taxi",
        note: "late",
        tags: [],
        original_amount: null,
        original_currency: null,
        created_at: CREATED,
      },
    });
  });

  test("a new form starts without a category, and income needs one too", () => {
    expect(emptyForm("2026-11-17").category).toBe("");
    const income = buildEntry(form({ type: "income", category: "" }), ctx);
    expect(income.ok ? undefined : income.errors.category?.key).toBe("entry.errorCategory");
    const salary = buildEntry(form({ type: "income", category: "Salary" }), ctx);
    expect(salary.ok && salary.fields.category).toBe("Salary");
  });

  test("the original pair: always 2 decimals; switched off means none", () => {
    const on = buildEntry(
      form({ foreign: true, originalAmount: "720.00", originalCurrency: "TRY" }),
      ctx,
    );
    expect(on.ok && [on.fields.original_amount, on.fields.original_currency]).toEqual([
      72000,
      "TRY",
    ]);
    const off = buildEntry(
      form({ foreign: false, originalAmount: "720.00", originalCurrency: "TRY" }),
      ctx,
    );
    expect(off.ok && [off.fields.original_amount, off.fields.original_currency]).toEqual([
      null,
      null,
    ]);
  });

  test("amount errors: empty, invalid, zero, too many decimals", () => {
    const errorOf = (amount: string, decimals: 0 | 1 | 2 = 0) => {
      const result = buildEntry(form({ amount }), { ...ctx, decimals });
      return result.ok ? undefined : result.errors.amount?.key;
    };
    expect(errorOf("")).toBe("entry.errorAmountEmpty");
    expect(errorOf("12a")).toBe("entry.errorAmountInvalid");
    expect(errorOf("0")).toBe("entry.errorAmountZero");
    expect(errorOf("12.5")).toBe("entry.errorAmountWhole");
    // At 0 decimals the blur leaves "1234.5" as typed (it does not parse), and Save refuses it.
    expect(normalizeAmountText("1234.5", 0, "en")).toBe("1234.5");
    expect(errorOf("1234.5")).toBe("entry.errorAmountWhole");
    expect(errorOf("12.55", 1)).toBe("entry.errorAmountDecimals");
    expect(errorOf("12.5", 1)).toBeUndefined();
  });

  test("every missing field is reported at once", () => {
    const result = buildEntry(
      form({
        amount: "",
        category: "",
        date: "",
        foreign: true,
        originalAmount: "",
        originalCurrency: "",
      }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      "amount",
      "category",
      "date",
      "originalAmount",
      "originalCurrency",
    ]);
    expect(result.errors.originalAmount?.key).toBe("entry.errorAmountEmpty");
    expect(result.errors.originalCurrency?.key).toBe("entry.errorCurrency");
  });

  test("a tag being typed is added on save, in the known spelling; ';' is refused", () => {
    const known = { ...ctx, knownTags: ["Istanbul 2026"] };
    const saved = buildEntry(form({ tags: ["Trip"], tagDraft: " istanbul 2026 " }), known);
    expect(saved.ok && saved.fields.tags).toEqual(["Trip", "Istanbul 2026"]);
    const refused = buildEntry(form({ tagDraft: "a;b" }), known);
    expect(refused.ok ? undefined : refused.errors.tags?.key).toBe("entry.errorTagSemicolon");
  });

  test("an unchanged amount keeps the stored value, even off the configured decimals", () => {
    const initial = { text: "2,809", amount: 280850 };
    const kept = buildEntry(form({ amount: "2,809" }), { ...ctx, initial });
    expect(kept.ok && kept.fields.amount).toBe(280850);
    const edited = buildEntry(form({ amount: "2,810" }), { ...ctx, initial });
    expect(edited.ok && edited.fields.amount).toBe(281000);
  });
});

describe("form round trip", () => {
  test("formFromTransaction fills the form for editing", () => {
    const tx = entry({
      amount: 280800,
      detail: "Istanbul ferry",
      tags: ["Istanbul 2026"],
      original_amount: 72000,
      original_currency: "TRY",
      created_at: "2026-08-12T10:00:00.000Z",
    });
    const f = formFromTransaction(tx, { decimals: 0, locale: "en" });
    expect(f).toEqual({
      type: "expense",
      amount: "2,808",
      foreign: true,
      originalAmount: "720.00",
      originalCurrency: "TRY",
      date: "2026-11-17",
      category: "Groceries",
      detail: "Istanbul ferry",
      tags: ["Istanbul 2026"],
      tagDraft: "",
      note: "",
    });
    const rebuilt = buildEntry(f, { ...ctx, createdAt: tx.created_at });
    expect(rebuilt.ok && rebuilt.fields.created_at).toBe(tx.created_at);
    expect(rebuilt.ok && rebuilt.fields.amount).toBe(280800);
  });

  test("amountText follows the decimals and locale", () => {
    expect(amountText(280850, 2, "en")).toBe("2,808.50");
    expect(amountText(280850, 0, "en")).toBe("2,809");
    // French groups with a narrow no-break space, which parseAmount reads back.
    expect(amountText(280850, 2, "fr")).toBe("2 808,50");
  });

  test("sameForm compares every field, tags included", () => {
    const a = form({ tags: ["x"] });
    expect(sameForm(a, { ...a, tags: ["x"] })).toBe(true);
    expect(sameForm(a, { ...a, tags: ["y"] })).toBe(false);
    expect(sameForm(a, { ...a, note: "n" })).toBe(false);
  });
});

describe("rate prefill", () => {
  const history = [
    entry({ amount: 46800, original_amount: 12000, original_currency: "TRY", date: "2026-08-14" }),
    entry({ amount: 280800, original_amount: 72000, original_currency: "TRY", date: "2026-08-12" }),
    entry({
      amount: 1850000,
      original_amount: 12000,
      original_currency: "EUR",
      date: "2026-11-14",
    }),
  ];

  test("suggestedAmountText uses the latest entry's rate, rounded to the decimals", () => {
    expect(suggestedAmountText(72000, "TRY", history, 0, "en")).toBe("2,808");
    // 33.33 TRY × 3.9 = 129.987 → 129.99 (2 decimals) or 130 (0)
    expect(suggestedAmountText(3333, "TRY", history, 2, "en")).toBe("129.99");
    expect(suggestedAmountText(3333, "TRY", history, 0, "en")).toBe("130");
    expect(suggestedAmountText(72000, "USD", history, 0, "en")).toBeNull();
  });

  test("suggestedAmountText rounds once: 2.495 is 2 at 0 decimals, 2.5 at 1, 2.50 at 2", () => {
    const rate = [entry({ amount: 250, original_amount: 10000, original_currency: "EUR" })];
    expect(suggestedAmountText(9980, "EUR", rate, 0, "en")).toBe("2");
    expect(suggestedAmountText(9980, "EUR", rate, 1, "en")).toBe("2.5");
    expect(suggestedAmountText(9980, "EUR", rate, 2, "en")).toBe("2.50");
    expect(suggestedAmountText(10000, "EUR", rate, 0, "en")).toBe("3");
  });

  test("rateText: one unit in the main currency, 2 decimals", () => {
    expect(rateText("TRY", history, "en")).toBe("3.90");
    expect(rateText("EUR", history, "en")).toBe("154.17");
    expect(rateText("USD", history, "en")).toBeNull();
  });
});

describe("prefillAmount", () => {
  const rate = [entry({ amount: 250, original_amount: 10000, original_currency: "EUR" })];
  const base = {
    form: form({ amount: "", foreign: true, originalAmount: "99.80", originalCurrency: "EUR" }),
    typed: false,
    entries: rate,
    locale: "en",
  };

  test("fills the untouched amount at each decimals setting", () => {
    expect(prefillAmount({ ...base, decimals: 0 })).toBe("2");
    expect(prefillAmount({ ...base, decimals: 1 })).toBe("2.5");
    expect(prefillAmount({ ...base, decimals: 2 })).toBe("2.50");
  });

  test("leaves a typed amount, and waits for the entries to load", () => {
    expect(prefillAmount({ ...base, decimals: 0, typed: true })).toBeNull();
    expect(prefillAmount({ ...base, decimals: 0, entries: undefined })).toBeNull();
  });

  test("no change when the amount already matches", () => {
    expect(prefillAmount({ ...base, decimals: 0, form: { ...base.form, amount: "2" } })).toBeNull();
  });

  test("clears a prefilled amount the original no longer supports", () => {
    const prefilled = { ...base.form, amount: "2" };
    const clear = (patch: Partial<EntryForm>) =>
      prefillAmount({ ...base, decimals: 0, form: { ...prefilled, ...patch } });
    expect(clear({ originalAmount: "" })).toBe("");
    expect(clear({ originalAmount: "abc" })).toBe("");
    expect(clear({ originalCurrency: "USD" })).toBe("");
    expect(clear({ foreign: false })).toBe("");
    // Nothing to clear.
    expect(
      prefillAmount({ ...base, decimals: 0, form: { ...base.form, foreign: false } }),
    ).toBeNull();
  });
});

describe("normalizeAmountText", () => {
  test("groups a valid amount in the configured decimals and locale; leaves the rest", () => {
    expect(normalizeAmountText("6000", 0, "en")).toBe("6,000");
    expect(normalizeAmountText(" 1234.5 ", 2, "en")).toBe("1,234.50");
    expect(normalizeAmountText("1234,5", 1, "fr")).toBe("1 234,5");
    expect(normalizeAmountText("12.5", 0, "en")).toBe("12.5");
    expect(normalizeAmountText("abc", 0, "en")).toBe("abc");
    expect(normalizeAmountText("", 0, "en")).toBe("");
  });
});

describe("suggestions", () => {
  test("details of the same type by frequency, then recency, prefix ignoring case", () => {
    const entries = [
      entry({ detail: "Istanbul ferry", date: "2026-08-12" }),
      entry({ detail: "istanbul ferry", date: "2026-08-14" }),
      entry({ detail: "Istanbul ferry", date: "2026-08-15" }),
      entry({ detail: "Istanbul taxi", date: "2026-08-16" }),
      entry({ detail: "Isla", date: "2026-08-10" }),
      entry({ detail: "Is income", type: "income" }),
      entry({ detail: "IKEA" }),
      { ...entry({ detail: "Is deleted" }), deleted: true } as unknown as LiveTransaction,
    ];
    const got = detailSuggestions(entries, "expense", "is");
    expect(got).toEqual([
      { detail: "Istanbul ferry", count: 3 },
      { detail: "Istanbul taxi", count: 1 },
      { detail: "Isla", count: 1 },
    ]);
    expect(detailSuggestions(entries, "expense", "")).toEqual([]);
    // The exact text typed is not suggested back.
    expect(detailSuggestions(entries, "expense", "isla")).toEqual([]);
  });

  test("recentCurrencies: distinct, newest first, without the main currency", () => {
    const entries = [
      entry({ original_amount: 1, original_currency: "TRY", date: "2026-08-12" }),
      entry({ original_amount: 1, original_currency: "EUR", date: "2026-11-14" }),
      entry({ original_amount: 1, original_currency: "TRY", date: "2026-08-15" }),
      entry({ original_amount: 1, original_currency: "USD", date: "2026-11-03" }),
      entry({ original_amount: 1, original_currency: "DZD", date: "2026-11-15" }),
    ];
    expect(recentCurrencies(entries, "DZD")).toEqual(["EUR", "USD", "TRY"]);
  });

  test("tagSuggestions: prefix ignoring case, not chosen, most used first", () => {
    const known = [
      { tag: "Home office", count: 2 },
      { tag: "Istanbul 2026", count: 8 },
      { tag: "istanbul old", count: 1 },
      { tag: "Wedding", count: 4 },
    ];
    expect(tagSuggestions(known, "is", [])).toEqual([
      { tag: "Istanbul 2026", count: 8 },
      { tag: "istanbul old", count: 1 },
    ]);
    expect(tagSuggestions(known, "IS", ["ISTANBUL 2026"])).toEqual([
      { tag: "istanbul old", count: 1 },
    ]);
    expect(tagSuggestions(known, "", [])).toEqual([]);
  });

  test("addTag: trims, keeps the known spelling, dedupes, refuses ';' and empties", () => {
    const known = ["Istanbul 2026"];
    expect(addTag([], " istanbul 2026 ", known)).toEqual({ ok: true, tags: ["Istanbul 2026"] });
    expect(addTag(["Istanbul 2026"], "ISTANBUL 2026", known)).toEqual({
      ok: true,
      tags: ["Istanbul 2026"],
    });
    expect(addTag(["A"], "New one", known)).toEqual({ ok: true, tags: ["A", "New one"] });
    expect(addTag([], "a;b", known)).toEqual({ ok: false, error: "semicolon" });
    expect(addTag([], "  ", known)).toEqual({ ok: false, error: "empty" });
  });
});
