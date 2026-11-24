import { describe, expect, test } from "bun:test";
import { cacheControlFor, IMMUTABLE, isApiPath, isAppRoute, SECURITY_HEADERS } from "../entry/web";

describe("SECURITY_HEADERS", () => {
  test("a strict CSP: own scripts only, no framing, no base or form elsewhere", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp.match(/'unsafe-inline'/g)).toEqual(["'unsafe-inline'"]);
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });
});

describe("isApiPath", () => {
  test("/api itself and everything under /api/", () => {
    for (const path of ["/api", "/api/", "/api/v1/health", "/api/nope"]) {
      expect([path, isApiPath(path)]).toEqual([path, true]);
    }
    for (const path of ["/", "/apis", "/apiary", "/settings/api"]) {
      expect([path, isApiPath(path)]).toEqual([path, false]);
    }
  });
});

describe("cacheControlFor", () => {
  test("hashed assets are immutable; the page, worker and manifest revalidate", () => {
    expect(cacheControlFor("/assets/index-1a2b.js")).toBe(IMMUTABLE);
    for (const path of ["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/pwa-192.png"]) {
      expect([path, cacheControlFor(path)]).toEqual([path, "no-cache"]);
    }
  });
});

describe("isAppRoute", () => {
  test("paths without a file extension, outside /assets/, are the app's routes", () => {
    for (const path of ["/", "/settings", "/settings/devices/", "/pair"]) {
      expect([path, isAppRoute(path)]).toEqual([path, true]);
    }
    for (const path of [
      "/assets/",
      "/assets/x",
      "/favicon.ico",
      "/workbox-old.js",
      "/a.b/c.d",
      "/api",
      "/api/",
      "/api/v1/nope",
    ]) {
      expect([path, isAppRoute(path)]).toEqual([path, false]);
    }
  });
});
