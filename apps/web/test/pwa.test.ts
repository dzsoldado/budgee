// The PWA build settings: colors from the tokens, icons present, dev-only strings left out.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import en from "../src/i18n/en.json";
import { DEV_KEY_PREFIXES, withoutDevMessages } from "../vite/dev-messages";
import { pwaOptions, THEME_COLORS } from "../vite/pwa";

const web = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(web, path), "utf8");

describe("PWA settings", () => {
  test("theme colors are the light and dark --bg tokens, in the manifest and index.html", () => {
    const tokens = read("src/styles/tokens.css");
    const darkAt = tokens.indexOf('[data-theme="dark"]');
    const bg = (css: string) => /--bg:\s*(#[0-9a-f]{6})/.exec(css)?.[1];
    expect(bg(tokens.slice(0, darkAt))).toBe(THEME_COLORS.light);
    expect(bg(tokens.slice(darkAt))).toBe(THEME_COLORS.dark);

    const manifest = pwaOptions.manifest || {};
    expect(manifest.theme_color).toBe(THEME_COLORS.light);
    expect(manifest.background_color).toBe(THEME_COLORS.light);
    const html = read("index.html");
    for (const [scheme, color] of Object.entries(THEME_COLORS)) {
      expect(html).toContain(
        `<meta name="theme-color" content="${color}" media="(prefers-color-scheme: ${scheme})" />`,
      );
    }
  });

  test("a new worker waits for the prompt; the API is never cached or answered offline", () => {
    expect(pwaOptions.registerType).toBe("prompt");
    const workbox = pwaOptions.workbox ?? {};
    expect(workbox.navigateFallback).toBe("index.html");
    const denied = (path: string) => workbox.navigateFallbackDenylist?.some((re) => re.test(path));
    expect(denied("/api/v1/backups/google/callback")).toBe(true);
    expect(denied("/settings")).toBe(false);
    // Only the precached build: no runtime caching of API or other responses.
    expect(workbox.runtimeCaching).toBeUndefined();
  });

  test("every icon the manifest and index.html name is in public/", () => {
    const manifest = pwaOptions.manifest || {};
    const names = [
      ...(manifest.icons ?? []).map((icon) => icon.src),
      ...(pwaOptions.includeAssets as string[]),
    ];
    expect(names.length).toBeGreaterThan(3);
    for (const name of names)
      expect([name, existsSync(join(web, "public", name))]).toEqual([name, true]);
    expect(manifest.icons?.some((icon) => icon.purpose === "maskable")).toBe(true);
  });
});

describe("dev-only strings", () => {
  test("are dropped from the dictionary for production, the rest kept", () => {
    const kept = withoutDevMessages(en);
    expect(kept["dev.demoLoad" as keyof typeof kept]).toBeUndefined();
    expect(kept["gallery.freelance" as keyof typeof kept]).toBeUndefined();
    expect(kept["app.name"]).toBe("Budgee");
    const devKeys = Object.keys(en).filter((key) =>
      DEV_KEY_PREFIXES.some((p) => key.startsWith(p)),
    );
    expect(Object.keys(kept).length).toBe(Object.keys(en).length - devKeys.length);
  });

  test("are used only under src/dev/", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });
    const src = join(web, "src");
    const usesDevKey = (text: string) =>
      DEV_KEY_PREFIXES.some((prefix) => text.includes(`t("${prefix}`));
    const offenders = files(src)
      .filter((path) => /\.tsx?$/.test(path) && !path.startsWith(join(src, "dev")))
      .filter((path) => usesDevKey(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
