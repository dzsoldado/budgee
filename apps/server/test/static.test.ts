// The built PWA as the Bun entry serves it, from a folder.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serveWeb, webFolder } from "../entry/static";
import { IMMUTABLE, SECURITY_HEADERS } from "../entry/web";

const securityHeadersOf = (response: Response) =>
  Object.fromEntries(
    Object.keys(SECURITY_HEADERS).map((name) => [name, response.headers.get(name)]),
  );

const INDEX = "<!doctype html><title>Budgee</title>";
const FILES: Record<string, string> = {
  "index.html": INDEX,
  "sw.js": "self.sw = 1",
  "manifest.webmanifest": "{}",
  "assets/app-1a2b.js": "console.log(1)",
  "assets/index-3c4d.css": "body{}",
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "budgee-static-"));
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(dir, "web", name, ".."), { recursive: true });
    writeFileSync(join(dir, "web", name), text);
  }
  writeFileSync(join(dir, "secret.txt"), "outside");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("serveWeb from a folder", () => {
  const app = () => {
    const hono = new Hono();
    hono.get("/api/*", (c) => c.json({ api: true }));
    serveWeb(hono, webFolder(join(dir, "web")));
    hono.notFound((c) => c.json({ error: { code: "not_found" } }, 404));
    return hono;
  };
  const get = (path: string) => app().request(path);

  test("serves files with their type; hashed assets are immutable, the rest revalidate", async () => {
    const asset = await get("/assets/app-1a2b.js");
    expect([asset.status, await asset.text()]).toEqual([200, "console.log(1)"]);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);

    for (const [path, type] of [
      ["/sw.js", "javascript"],
      ["/index.html", "text/html"],
      ["/manifest.webmanifest", "manifest+json"],
    ] as const) {
      const res = await get(path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers.get("content-type")).toContain(type);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("client routes get index.html, not cached", async () => {
    for (const path of ["/", "/settings", "/settings/devices/", "/pair"]) {
      const res = await get(path);
      expect([path, res.status, await res.text()]).toEqual([path, 200, INDEX]);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("the page and every file carry the security headers", async () => {
    for (const path of ["/", "/settings", "/index.html", "/sw.js", "/assets/app-1a2b.js"]) {
      expect([path, securityHeadersOf(await get(path))]).toEqual([path, { ...SECURITY_HEADERS }]);
    }
  });

  test("a missing asset or file is a 404, never the app", async () => {
    for (const path of ["/assets/gone-9z9z.js", "/assets/", "/workbox-old.js", "/favicon.ico"]) {
      const res = await get(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: { code: "not_found" } });
    }
  });

  test("paths outside the build are not served", async () => {
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await get(path);
      expect(await res.text()).not.toContain("outside");
    }
  });

  test("API routes registered first keep their paths", async () => {
    expect(await (await get("/api/v1/health")).json()).toEqual({ api: true });
  });
});
