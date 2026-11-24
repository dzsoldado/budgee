// The built PWA for the Bun entry, read from a folder (apps/web/dist, or WEB_DIST), with the
// caching and security headers of web.ts.
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Hono } from "hono";
import { getMimeType } from "hono/utils/mime";
import { cacheControlFor, isAppRoute, SECURITY_HEADERS } from "./web";

/** A file of the web build by URL path ("/index.html", "/assets/index-1a2b.js"), or null. */
export type WebFiles = (path: string) => Promise<Blob | null>;

/** The web build in a folder. Paths that resolve outside it are not found. */
export function webFolder(root: string): WebFiles {
  const base = resolve(root);
  return async (path) => {
    const full = resolve(base, `.${path}`);
    if (!full.startsWith(base + sep)) return null;
    try {
      return (await stat(full)).isFile() ? Bun.file(full) : null;
    } catch {
      return null;
    }
  };
}

const send = (path: string, file: Blob) =>
  new Response(file, {
    headers: {
      "Content-Type": getMimeType(path) ?? (file.type || "application/octet-stream"),
      "Cache-Control": cacheControlFor(path),
      ...SECURITY_HEADERS,
    },
  });

/**
 * Serves the PWA for GET requests not answered by routes added before it: a file of the build
 * as is, and index.html for `/` and other paths that do not look like a file (client-side
 * routes). A missing asset or file goes to the app's 404 instead of the page, so a stale script
 * or service worker request never gets HTML.
 */
export function serveWeb(app: Hono, files: WebFiles): void {
  app.get("*", async (c) => {
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      return c.notFound();
    }
    const file = path.endsWith("/") ? null : await files(path);
    if (file) return send(path, file);
    if (!isAppRoute(path)) return c.notFound();
    const index = await files("/index.html");
    return index ? send("/index.html", index) : c.notFound();
  });
}
