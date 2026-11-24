import type { SettingValues } from "@budgee/core";
import type { Accessor } from "solid-js";
import { createMediaQuery } from "./lib/media";

export type ThemeSetting = SettingValues["theme"];
export type ResolvedTheme = "light" | "dark";

export function resolveTheme(setting: ThemeSetting, systemDark: boolean): ResolvedTheme {
  if (setting === "system") return systemDark ? "dark" : "light";
  return setting;
}

/** Whether the system prefers dark, updated live. Call inside a component or root. */
export function createSystemDark(): Accessor<boolean> {
  return createMediaQuery("(prefers-color-scheme: dark)");
}

/**
 * Sets `data-theme` on <html>, which selects the token set in tokens.css, and gives the browser
 * bar (theme-color) that set's --bg.
 */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  // Before the stylesheet applies there is no --bg: keep index.html's colors.
  if (!bg) return;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", bg);
  }
}
