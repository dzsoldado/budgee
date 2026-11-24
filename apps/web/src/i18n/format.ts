// Intl formatting bound to the settings (locale, main currency, decimals).
import { type AmountDecimals, formatAmount, formatOriginal } from "@budgee/core";
import type { Accessor } from "solid-js";

/** A `YYYY-MM-DD` date as that calendar day: formatted in UTC so no time zone shifts it. */
export function formatPlainDate(
  date: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    Date.UTC(year, month - 1, day),
  );
}

export interface FormatSettings {
  locale: string;
  currency: string;
  decimals: AmountDecimals;
}

export interface MoneyOptions {
  /** Show the main currency code (`DZD 1,500`). */
  withCurrency?: boolean;
  sign?: "auto" | "always" | "never";
}

export interface Formatters {
  money(hundredths: number, options?: MoneyOptions): string;
  /** An amount in another currency, always with 2 decimals (`EUR 120.00`). */
  original(hundredths: number, currency: string): string;
  date(date: string, options: Intl.DateTimeFormatOptions): string;
}

export function createFormatters(settings: Accessor<FormatSettings>): Formatters {
  return {
    money(hundredths, { withCurrency = false, sign = "auto" } = {}) {
      const { locale, currency, decimals } = settings();
      return formatAmount(hundredths, {
        locale,
        decimals,
        sign,
        ...(withCurrency ? { currency } : {}),
      });
    },
    original: (hundredths, currency) => formatOriginal(hundredths, currency, settings().locale),
    date: (date, options) => formatPlainDate(date, settings().locale, options),
  };
}
