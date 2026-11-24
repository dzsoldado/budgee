// Spec "Required tests: Entries": the Bun entry starts, serves the PWA and answers /health;
// run-daily refuses a wrong CRON_SECRET.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthResponseSchema } from "@budgee/core";
import * as v from "valibot";
import { scheduleDaily, startServer } from "../entry/bun";
import { webFolder } from "../entry/static";
import { IMMUTABLE, SECURITY_HEADERS } from "../entry/web";
import { CRON_SECRET_HEADER } from "../src/app";

const INDEX = "<!doctype html><title>Budgee</title>";
const SETUP = "a-setup-secret-of-32-characters!";
let dir: string;
let env: Record<string, string>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "budgee-entry-"));
  const web = join(dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), INDEX);
  writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
  env = {
    PORT: "0",
    DATABASE_PATH: join(dir, "data", "budgee.sqlite"),
    WEB_DIST: web,
    SETUP_SECRET: SETUP,
    CRON_SECRET: "cron",
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("starts, serves the PWA with SPA fallback, answers /health and keeps its serverId", async () => {
  const first = await startServer(env);
  let serverId: string;
  try {
    const get = (path: string, init?: RequestInit) => fetch(new URL(path, first.url), init);

    const health = await get("/api/v1/health");
    expect(health.status).toBe(200);
    serverId = v.parse(healthResponseSchema, await health.json()).serverId;

    for (const path of ["/", "/settings/devices", "/pair"]) {
      const page = await get(path);
      expect([path, page.status, await page.text()]).toEqual([path, 200, INDEX]);
      expect(page.headers.get("content-type")).toContain("text/html");
    }
    const asset = await get("/assets/app.js");
    expect(await asset.text()).toBe("console.log(1)");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);
    expect((await get("/")).headers.get("cache-control")).toBe("no-cache");
    // A missing asset is a 404, not the app.
    expect((await get("/assets/gone.js")).status).toBe(404);

    for (const path of ["/", "/settings", "/assets/app.js"]) {
      const res = await get(path);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect([path, name, res.headers.get(name)]).toEqual([path, name, value]);
      }
    }

    // API paths never fall back to the app, /api itself included.
    for (const path of ["/api/v1/nope", "/api"]) {
      const missing = await get(path, { headers: { Accept: "text/html" } });
      expect([path, missing.status]).toEqual([path, 404]);
      expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
    }

    const setup = await get("/api/v1/setup", {
      method: "POST",
      body: JSON.stringify({ secret: SETUP, deviceName: "Phone" }),
    });
    expect(setup.status).toBe(200);
  } finally {
    first.stop();
  }

  // Same database file: migrations already applied, same serverId, the device is still there.
  const second = await startServer(env);
  try {
    const health = await fetch(new URL("/api/v1/health", second.url));
    expect(((await health.json()) as { serverId: string }).serverId).toBe(serverId);
    const setup = await fetch(new URL("/api/v1/setup", second.url), {
      method: "POST",
      body: JSON.stringify({ secret: SETUP, deviceName: "Again" }),
    });
    expect(setup.status).toBe(409);
  } finally {
    second.stop();
  }
});

test("listens on 127.0.0.1 unless HOST says otherwise", async () => {
  const local = await startServer(env);
  try {
    expect(local.url.hostname).toBe("127.0.0.1");
  } finally {
    local.stop();
  }
  const any = await startServer({ ...env, HOST: "0.0.0.0" });
  try {
    expect(any.hostname).toBe("0.0.0.0");
    const health = await fetch(`http://127.0.0.1:${any.url.port}/api/v1/health`);
    expect(health.status).toBe(200);
  } finally {
    any.stop();
  }
});

test("run-daily refuses a wrong CRON_SECRET and accepts the right one", async () => {
  const server = await startServer(env);
  try {
    const runDaily = (secret: string) =>
      fetch(new URL("/api/v1/admin/run-daily", server.url), {
        method: "POST",
        headers: { [CRON_SECRET_HEADER]: secret },
      });
    expect((await runDaily("wrong")).status).toBe(401);
    expect((await runDaily("cron")).status).toBe(204);
  } finally {
    server.stop();
  }
});

test("without CRON_SECRET, run-daily does not exist", async () => {
  const { CRON_SECRET: _, ...rest } = env;
  const server = await startServer({ ...rest, CRON_SECRET: "" });
  try {
    const res = await fetch(new URL("/api/v1/admin/run-daily", server.url), {
      method: "POST",
      headers: { [CRON_SECRET_HEADER]: "" },
    });
    expect(res.status).toBe(404);
  } finally {
    server.stop();
  }
});

test("serves the web build it is given, instead of WEB_DIST", async () => {
  const other = join(dir, "other-web");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "index.html"), "<p>other</p>");
  const server = await startServer(
    { ...env, DATABASE_PATH: join(dir, "other.sqlite") },
    { web: webFolder(other) },
  );
  try {
    expect(await (await fetch(new URL("/settings", server.url))).text()).toBe("<p>other</p>");
  } finally {
    server.stop();
  }
});

test("warns at start about a SETUP_SECRET shorter than 32 characters", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const short = await startServer({ ...env, SETUP_SECRET: "short" });
    short.stop();
    expect(warn.mock.calls.map(String).join("\n")).toContain("SETUP_SECRET is shorter than 32");
    warn.mockClear();
    const long = await startServer(env);
    long.stop();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

describe("rate limit on setup and pairing", () => {
  const pair = (url: URL, forwardedFor: string) =>
    fetch(new URL("/api/v1/devices/pair", url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
      body: JSON.stringify({ code: "ABCDEFGH", deviceName: "Laptop" }),
    });

  test("TRUST_PROXY off ignores X-Forwarded-For", async () => {
    const server = await startServer({ ...env, DATABASE_PATH: join(dir, "limit-off.sqlite") });
    try {
      for (let i = 1; i <= 10; i++) {
        expect([i, (await pair(server.url, `198.51.100.${i}`)).status]).toEqual([i, 401]);
      }
      const res = await pair(server.url, "198.51.100.11");
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
    } finally {
      server.stop();
    }
  });

  test("TRUST_PROXY on keys by X-Forwarded-For", async () => {
    const server = await startServer({
      ...env,
      DATABASE_PATH: join(dir, "limit-on.sqlite"),
      TRUST_PROXY: "1",
    });
    try {
      for (let i = 1; i <= 10; i++) {
        expect([i, (await pair(server.url, "203.0.113.1")).status]).toEqual([i, 401]);
      }
      expect((await pair(server.url, "203.0.113.1, 10.0.0.1")).status).toBe(429);
      expect((await pair(server.url, "203.0.113.2")).status).toBe(401);
    } finally {
      server.stop();
    }
  });
});

describe("scheduleDaily", () => {
  const HOUR = 60 * 60 * 1000;
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
    expect(condition()).toBe(true);
  };

  test("checks on every full hour", async () => {
    let now = 5 * HOUR - 3; // 3 ms before a full hour
    const seen: number[] = [];
    const stop = scheduleDaily({ now: () => now }, async () => {
      seen.push(now);
      now += HOUR; // the next check is again 3 ms away
    });
    try {
      await waitFor(() => seen.length >= 2);
    } finally {
      stop();
    }
    expect(seen.slice(0, 2)).toEqual([5 * HOUR - 3, 6 * HOUR - 3]);
  });

  test("stopped during a check, it does not check again", async () => {
    let now = 5 * HOUR - 3;
    let checks = 0;
    let finish = () => {};
    const stop = scheduleDaily({ now: () => now }, () => {
      checks++;
      now += HOUR;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await waitFor(() => checks === 1);
    stop(); // e.g. the server shutting down, about to close the database
    finish();
    await Bun.sleep(50);
    expect(checks).toBe(1);
  });
});
