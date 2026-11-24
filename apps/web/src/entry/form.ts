// The Add / edit form as typed, and its conversion to transaction fields. Amounts are typed
// text until save, when they are parsed into hundredths and the result is checked with the
// core schema.
import {
  type AmountDecimals,
  formatAmount,
  isKnownCurrency,
  isValidDate,
  type LiveTransaction,
  type ParseAmountResult,
  parseAmount,
  type RateEntry,
  suggestAmountFromRate,
  type TransactionFields,
  transactionFieldsSchema,
} from "@budgee/core";
import * as v from "valibot";
import type { MessageKey } from "../i18n";
import type { TranslateParams } from "../i18n/translator";
import { addTag } from "./suggest";

export type EntryType = "income" | "expense";

export interface EntryForm {
  type: EntryType;
  /** The main-currency amount as typed, in the configured decimals. */
  amount: string;
  /** "Paid in another currency" is on. */
  foreign: boolean;
  /** As typed, always 2 decimals. */
  originalAmount: string;
  /** ISO code, or "" before one is chosen. */
  originalCurrency: string;
  date: string;
  /** From the type's list; "" before one is chosen. */
  category: string;
  detail: string;
  tags: string[];
  /** A tag still being typed; added on save. */
  tagDraft: string;
  note: string;
}

export type EntryField =
  | "amount"
  | "originalAmount"
  | "originalCurrency"
  | "date"
  | "category"
  | "tags"
  | "form";

export interface FieldError {
  key: MessageKey;
  params?: TranslateParams;
}
export type EntryErrors = Partial<Record<EntryField, FieldError>>;

export function emptyForm(date: string): EntryForm {
  return {
    type: "expense",
    amount: "",
    foreign: false,
    originalAmount: "",
    originalCurrency: "",
    date,
    category: "",
    detail: "",
    tags: [],
    tagDraft: "",
    note: "",
  };
}

/** Hundredths as input text: the configured decimals, the locale's separators, no sign. */
export function amountText(hundredths: number, decimals: AmountDecimals, locale: string): string {
  return formatAmount(hundredths, { decimals, locale, sign: "never" });
}

export function formFromTransaction(
  tx: LiveTransaction,
  display: { decimals: AmountDecimals; locale: string },
): EntryForm {
  const foreign = tx.original_amount !== null && tx.original_currency !== null;
  return {
    type: tx.type,
    amount: amountText(tx.amount, display.decimals, display.locale),
    foreign,
    originalAmount: foreign ? amountText(tx.original_amount ?? 0, 2, display.locale) : "",
    originalCurrency: foreign ? (tx.original_currency ?? "") : "",
    date: tx.date,
    category: tx.category,
    detail: tx.detail,
    tags: [...tx.tags],
    tagDraft: "",
    note: tx.note,
  };
}

export function sameForm(a: EntryForm, b: EntryForm): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The main amount for `originalAmount` at the rate of the latest entry in `currency`, as input
 * text rounded once (half up) to the configured decimals; null with no earlier entry in that
 * currency.
 */
export function suggestedAmountText(
  originalAmount: number,
  currency: string,
  entries: readonly RateEntry[],
  decimals: AmountDecimals,
  locale: string,
): string | null {
  const suggested = suggestAmountFromRate(originalAmount, currency, entries, decimals);
  return suggested === null ? null : amountText(suggested, decimals, locale);
}

export interface PrefillInput {
  form: Pick<EntryForm, "amount" | "foreign" | "originalAmount" | "originalCurrency">;
  /** The user typed the main amount (or it was loaded), so the rate never overwrites it. */
  typed: boolean;
  /** Past entries for the rate; undefined until they have loaded. */
  entries: readonly RateEntry[] | undefined;
  decimals: AmountDecimals;
  locale: string;
}

/**
 * The main amount text the rate gives, or null to leave the amount as it is. While the amount
 * isn't the user's, it follows the original pair: a pair with no suggestion (empty or invalid
 * original amount, no rate, switch off) clears it, so a stale prefill never stays.
 */
export function prefillAmount(input: PrefillInput): string | null {
  if (input.typed || input.entries === undefined) return null;
  const { amount, foreign, originalAmount, originalCurrency } = input.form;
  const original = foreign ? parseAmount(originalAmount, 2) : null;
  const suggested =
    original?.ok && original.value > 0 && originalCurrency !== ""
      ? suggestedAmountText(
          original.value,
          originalCurrency,
          input.entries,
          input.decimals,
          input.locale,
        )
      : null;
  const next = suggested ?? "";
  return next === amount ? null : next;
}

/** A valid amount re-written with grouping in the configured decimals ("6000" → "6,000"). */
export function normalizeAmountText(text: string, decimals: AmountDecimals, locale: string) {
  const parsed = parseAmount(text, decimals);
  return parsed.ok ? amountText(parsed.value, decimals, locale) : text;
}

/** One unit of `currency` in the main currency at the latest entry's rate ("3.90"). */
export function rateText(
  currency: string,
  entries: readonly RateEntry[],
  locale: string,
): string | null {
  const perUnit = suggestAmountFromRate(100, currency, entries);
  return perUnit === null ? null : amountText(perUnit, 2, locale);
}

export interface BuildContext {
  decimals: AmountDecimals;
  /** Now for a new entry; the stored value when editing. */
  createdAt: string;
  /** Tags in use, for the spelling of a tag still being typed. */
  knownTags: readonly string[];
  /**
   * The loaded entry's amount and its text: while the text is unchanged, the stored amount is
   * kept, even when it has more decimals than are configured now.
   */
  initial?: { text: string; amount: number } | undefined;
}

function amountError(result: ParseAmountResult, decimals: AmountDecimals): FieldError | null {
  if (result.ok) return result.value === 0 ? { key: "entry.errorAmountZero" } : null;
  switch (result.error) {
    case "empty":
      return { key: "entry.errorAmountEmpty" };
    case "invalid":
      return { key: "entry.errorAmountInvalid" };
    case "too_large":
      return { key: "entry.errorAmountLarge" };
    case "too_many_decimals":
      return decimals === 0
        ? { key: "entry.errorAmountWhole" }
        : { key: "entry.errorAmountDecimals", params: { count: decimals } };
  }
}

const SCHEMA_FIELDS: Partial<Record<string, EntryField>> = {
  amount: "amount",
  date: "date",
  category: "category",
  tags: "tags",
  original_amount: "originalAmount",
  original_currency: "originalCurrency",
};

/** The transaction fields for the form, or every field that needs fixing. */
export function buildEntry(
  form: EntryForm,
  ctx: BuildContext,
): { ok: true; fields: TransactionFields } | { ok: false; errors: EntryErrors } {
  const errors: EntryErrors = {};

  const parsedAmount = parseAmount(form.amount, ctx.decimals);
  const keepInitial = ctx.initial !== undefined && form.amount === ctx.initial.text;
  const amountProblem = keepInitial ? null : amountError(parsedAmount, ctx.decimals);
  if (amountProblem) errors.amount = amountProblem;
  const amount = keepInitial
    ? (ctx.initial?.amount ?? 0)
    : parsedAmount.ok
      ? parsedAmount.value
      : 0;

  let original: { amount: number; currency: string } | null = null;
  if (form.foreign) {
    const parsed = parseAmount(form.originalAmount, 2);
    const problem = amountError(parsed, 2);
    if (problem) errors.originalAmount = problem;
    const currency = form.originalCurrency;
    if (!isKnownCurrency(currency)) errors.originalCurrency = { key: "entry.errorCurrency" };
    if (parsed.ok) original = { amount: parsed.value, currency };
  }

  if (!isValidDate(form.date)) errors.date = { key: "entry.errorDate" };
  if (form.category === "") errors.category = { key: "entry.errorCategory" };

  let tags = form.tags;
  if (form.tagDraft.trim() !== "") {
    const added = addTag(form.tags, form.tagDraft, ctx.knownTags);
    if (added.ok) tags = added.tags;
    else errors.tags = { key: "entry.errorTagSemicolon" };
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const result = v.safeParse(transactionFieldsSchema, {
    type: form.type,
    amount,
    date: form.date,
    category: form.category,
    detail: form.detail.trim(),
    note: form.note.trim(),
    tags,
    original_amount: original?.amount ?? null,
    original_currency: original?.currency ?? null,
    created_at: ctx.createdAt,
  });
  if (result.success) return { ok: true, fields: result.output };
  for (const issue of result.issues) {
    const key = issue.path?.[0]?.key;
    const field = (typeof key === "string" && SCHEMA_FIELDS[key]) || "form";
    errors[field] ??= { key: "entry.errorForm" };
  }
  return { ok: false, errors };
}
