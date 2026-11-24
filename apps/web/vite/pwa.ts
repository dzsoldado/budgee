// vite-plugin-pwa options: the manifest, and a service worker that precaches the app shell, every
// lazy screen and the fonts, and answers any navigation offline with index.html. A new build's
// worker waits until the user reloads from the "Update available" prompt (shell/UpdatePrompt.tsx).
import type { VitePWAOptions } from "vite-plugin-pwa";
import en from "../src/i18n/en.json" with { type: "json" };

/** --bg of the light and dark Plain Ledger tokens (tokens.css; a test keeps them equal). */
export const THEME_COLORS = { light: "#f5f5fa", dark: "#100f17" } as const;

export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: "prompt",
  // Registered from UpdatePrompt through virtual:pwa-register/solid.
  injectRegister: false,
  includeAssets: ["favicon.svg", "apple-touch-icon.png"],
  manifest: {
    name: en["app.name"],
    short_name: en["app.name"],
    description: en["app.description"],
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME_COLORS.light,
    theme_color: THEME_COLORS.light,
    icons: [
      { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
      { src: "maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  },
  workbox: {
    // .woff2 only: every browser that runs the app takes it over .woff. The icons and the manifest
    // are added by the plugin (includeAssets, manifest icons).
    globPatterns: ["**/*.{html,js,css,woff2}"],
    navigateFallback: "index.html",
    // The API, including the Google OAuth callback the browser navigates to, stays online-only.
    navigateFallbackDenylist: [/^\/api\//],
    cleanupOutdatedCaches: true,
  },
};
