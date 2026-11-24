// ISO 4217 currency codes. The schema checks only the shape (three capital letters); this list
// is for the places a person types or picks a code: the currency picker and CSV import.

/**
 * Current ISO 4217 currencies that people pay in (as of 2026). Fund codes, precious metals,
 * bond units, SDR and the test/no-currency codes (XTS, XXX) are left out.
 */
// biome-ignore format: a compact code table
export const CURRENCIES: readonly string[] = [
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD",
  "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF",
  "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN",
  "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD",
  "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES",
  "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN",
  "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP",
  "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK",
  "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT",
  "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VED", "VES",
  "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
];

/**
 * Codes withdrawn since 2008. Still known, so older records (a 2022 trip in HRK) import and
 * sync, but not offered in the picker.
 */
// biome-ignore format: a compact code table
const WITHDRAWN: readonly string[] = [
  "ANG", "BGN", "BYR", "CUC", "CYP", "EEK", "HRK", "LTL", "LVL", "MRO", "MTL", "SKK", "SLL",
  "STD", "VEF", "ZMK", "ZWL",
];

const KNOWN = new Set([...CURRENCIES, ...WITHDRAWN]);

/** True for a current or recently withdrawn ISO 4217 code, in capitals. */
export function isKnownCurrency(code: string): boolean {
  return KNOWN.has(code);
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

/** The currency's name in `locale` (e.g. "Euro"), or the code when Intl cannot name it. */
export function currencyName(code: string, locale: string): string {
  let names = displayNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: "currency" });
    } catch {
      names = null;
    }
    displayNames.set(locale, names);
  }
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}
