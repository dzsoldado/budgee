// Keeps the developer tools' strings (Settings → Developer, the component gallery) out of the
// production bundle: those screens exist only in dev builds, so their keys are dropped from
// en.json when building.
import type { Plugin } from "vite";

/** Key prefixes used only by src/dev/. */
export const DEV_KEY_PREFIXES = ["dev.", "gallery."] as const;

export function withoutDevMessages(dict: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dict).filter(([key]) => !DEV_KEY_PREFIXES.some((p) => key.startsWith(p))),
  );
}

export function stripDevMessages(): Plugin {
  return {
    name: "budgee:strip-dev-messages",
    apply: "build",
    // Before Vite's JSON plugin turns the file into a module.
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]src[\\/]i18n[\\/][a-z-]+\.json$/.test(id.split("?")[0] ?? "")) return null;
      return { code: JSON.stringify(withoutDevMessages(JSON.parse(code))), map: null };
    },
  };
}
