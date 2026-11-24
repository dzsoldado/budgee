// A default name for this device in the server's device list, from the user agent:
// "Chrome on Windows". The user can change it before pairing and rename it later.
import { t } from "../i18n";

// First match wins: Edge, Opera and Samsung Internet also say "Chrome", Chrome also says "Safari".
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdgA?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

// Android before Linux, iPhone and iPad before macOS ("like Mac OS X").
const SYSTEMS: readonly [RegExp, string][] = [
  [/\bAndroid\b/, "Android"],
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMacintosh\b|\bMac OS X\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const first = (ua: string, list: readonly [RegExp, string][]) =>
  list.find(([pattern]) => pattern.test(ua))?.[1];

export function describeUserAgent(ua: string): { browser?: string; os?: string } {
  const browser = first(ua, BROWSERS);
  const os = first(ua, SYSTEMS);
  return { ...(browser ? { browser } : {}), ...(os ? { os } : {}) };
}

export function defaultDeviceName(ua: string): string {
  const { browser, os } = describeUserAgent(ua);
  if (browser && os) return t("pairing.deviceNameDefault", { browser, os });
  return browser ?? os ?? t("pairing.deviceNameFallback");
}
