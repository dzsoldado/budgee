// Money is always an integer number of hundredths. Parsing and arithmetic never touch floats;
// formatting rounds in integers and hands Intl an exact decimal string.

/** Decimals shown and accepted for the main currency. Original amounts always use 2. */
export type AmountDecimals = 0 | 1 | 2;

export type ParseAmountError = "empty" | "invalid" | "too_many_decimals" | "too_large";
export type ParseAmountResult =
  | { ok: true; value: number }
  | { ok: false; error: ParseAmountError };

const fail = (error: ParseAmountError): ParseAmountResult => ({ ok: false, error });

/**
 * Parses a typed amount into hundredths, whatever the user's locale. Rules:
 * - Spaces (any Unicode space) and apostrophes are grouping and are dropped.
 * - With both `.` and `,`, the last one is the decimal separator and the other is grouping.
 * - With only one of them, appearing several times, it is grouping (`1,234,567`).
 * - With only one of them, appearing once: it is grouping when it has exactly 3 digits after
 *   it and 1–3 digits (not starting with 0) before it (`1.500` = 1500, since no configured
 *   decimals ever reach 3); otherwise it is the decimal separator (`12,5`, `1234.567`).
 * - Grouping must look like grouping: first group 1–3 digits not starting with 0, middle
 *   groups 2–3 digits (Indian `12,34,567`), last group exactly 3.
 * - No sign, exponent or currency symbol; more fraction digits than `decimals` is an error.
 * The result may be 0; whether an amount must be positive is the schema's call.
 */
export function parseAmount(input: string, decimals: AmountDecimals): ParseAmountResult {
  const trimmed = input.trim();
  if (trimmed === "") return fail("empty");
  const text = trimmed.replace(/[\s'’]/g, "");
  if (!/^[\d.,]+$/.test(text)) return fail("invalid");
  const parts = splitDecimal(text);
  if (!parts) return fail("invalid");
  if (parts.fraction.length > decimals) return fail("too_many_decimals");
  const value = Number(parts.integer + parts.fraction.padEnd(2, "0"));
  return Number.isSafeInteger(value) ? { ok: true, value } : fail("too_large");
}

const FIRST_GROUP = /^[1-9]\d{0,2}$/;

function splitDecimal(text: string): { integer: string; fraction: string } | null {
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  let decimalAt = -1;
  let grouping: "." | "," | null = null;

  if (lastDot !== -1 && lastComma !== -1) {
    const separator = lastDot > lastComma ? "." : ",";
    decimalAt = Math.max(lastDot, lastComma);
    if (text.indexOf(separator) !== decimalAt) return null;
    grouping = separator === "." ? "," : ".";
  } else if (lastDot !== -1 || lastComma !== -1) {
    const separator = lastDot !== -1 ? "." : ",";
    const at = text.indexOf(separator);
    const before = text.slice(0, at);
    const after = text.slice(at + 1);
    if (at !== text.lastIndexOf(separator)) grouping = separator;
    else if (after.length === 3 && FIRST_GROUP.test(before)) grouping = separator;
    else decimalAt = at;
  }

  const integerText = decimalAt === -1 ? text : text.slice(0, decimalAt);
  const fraction = decimalAt === -1 ? "" : text.slice(decimalAt + 1);
  const integer = grouping ? ungroup(integerText, grouping) : integerText;
  if (integer === null || !/^\d*$/.test(integer) || !/^\d*$/.test(fraction)) return null;
  if (integer === "" && fraction === "") return null;
  return { integer, fraction };
}

function ungroup(text: string, separator: string): string | null {
  if (!text.includes(separator)) return text;
  const groups = text.split(separator);
  const last = groups.length - 1;
  const valid = groups.every((group, i) =>
    i === 0
      ? FIRST_GROUP.test(group)
      : i === last
        ? /^\d{3}$/.test(group)
        : /^\d{2,3}$/.test(group),
  );
  return valid ? groups.join("") : null;
}

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe integer`);
}

export interface FormatAmountOptions {
  /** ISO code, shown as the code (`DZD 1,500`). Omit for a plain number (list rows). */
  currency?: string;
  decimals: AmountDecimals;
  locale: string;
  /** `auto`: minus only; `always`: `+` and `−` (none for zero); `never`: no sign. */
  sign?: "auto" | "always" | "never";
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(locale: string, currency: string | undefined, decimals: number, sign: string) {
  const cacheKey = `${locale}|${currency ?? ""}|${decimals}|${sign}`;
  let format = formatters.get(cacheKey);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      ...(currency ? { style: "currency", currency, currencyDisplay: "code" } : {}),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay: sign === "always" ? "exceptZero" : sign === "never" ? "never" : "auto",
    });
    formatters.set(cacheKey, format);
  }
  return format;
}

/** Formats hundredths for display, rounded half away from zero to `decimals`. Minus is U+2212. */
export function formatAmount(
  hundredths: number,
  { currency, decimals, locale, sign = "auto" }: FormatAmountOptions,
): string {
  assertSafeInteger(hundredths, "Amount");
  const unit = 10 ** (2 - decimals);
  const magnitude = Math.abs(hundredths);
  const remainder = magnitude % unit;
  const rounded = (magnitude - remainder) / unit + (remainder * 2 >= unit ? 1 : 0);
  const digits = String(rounded).padStart(decimals + 1, "0");
  const cut = digits.length - decimals;
  const exact = decimals ? `${digits.slice(0, cut)}.${digits.slice(cut)}` : digits;
  const signed = hundredths < 0 && rounded !== 0 ? `-${exact}` : exact;
  return formatter(locale, currency, decimals, sign)
    .formatToParts(signed as Intl.StringNumericLiteral)
    .map((part) => (part.type === "minusSign" ? "−" : part.value))
    .join("");
}

/** An original amount with its own code and always 2 decimals, e.g. `EUR 120.00`. */
export function formatOriginal(hundredths: number, currency: string, locale = "en"): string {
  return formatAmount(hundredths, { currency, decimals: 2, locale, sign: "never" });
}

/** Integer sum of hundredths; throws instead of losing precision. */
export function sum(amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) {
    assertSafeInteger(amount, "Amount");
    total += amount;
    assertSafeInteger(total, "Total");
  }
  return total;
}

export interface TotalsEntry {
  type: "income" | "expense";
  amount: number;
  deleted?: boolean;
}

export interface Totals {
  income: number;
  expenses: number;
  /** Income minus expenses. */
  difference: number;
}

/** Totals in the main currency. Only `amount` counts; original amounts never enter totals. */
export function totals(entries: readonly TotalsEntry[]): Totals {
  const live = entries.filter((e) => !e.deleted);
  const income = sum(live.filter((e) => e.type === "income").map((e) => e.amount));
  const expenses = sum(live.filter((e) => e.type === "expense").map((e) => e.amount));
  return { income, expenses, difference: income - expenses };
}

export interface RateEntry {
  date: string;
  created_at: string;
  amount: number;
  original_amount: number | null;
  original_currency: string | null;
  deleted?: boolean;
}

/** The most recent live entry paid in `currency` (latest date, then latest created_at). */
export function latestEntryInCurrency<T extends RateEntry>(
  currency: string,
  entries: readonly T[],
): T | undefined {
  let latest: T | undefined;
  for (const entry of entries) {
    if (entry.deleted || entry.original_currency !== currency || !entry.original_amount) continue;
    if (
      !latest ||
      entry.date > latest.date ||
      (entry.date === latest.date && entry.created_at > latest.created_at)
    ) {
      latest = entry;
    }
  }
  return latest;
}

/**
 * The main-currency amount for `originalAmount` (hundredths of `currency`) at the rate of the
 * most recent entry in that currency (`amount / original_amount`), in hundredths, rounded
 * once, half up, to `decimals` (the configured main-currency decimals; 2 = hundredths). Null
 * when there is no earlier entry in that currency.
 */
export function suggestAmountFromRate(
  originalAmount: number,
  currency: string,
  entries: readonly RateEntry[],
  decimals: AmountDecimals = 2,
): number | null {
  assertSafeInteger(originalAmount, "Original amount");
  const latest = latestEntryInCurrency(currency, entries);
  if (!latest?.original_amount) return null;
  const original = BigInt(originalAmount);
  const amount = BigInt(latest.amount);
  // Hundredths per step of the configured decimals: 100, 10 or 1.
  const unit = 10n ** BigInt(2 - decimals);
  const divisor = BigInt(latest.original_amount) * unit;
  return Number(((2n * original * amount + divisor) / (2n * divisor)) * unit);
}
