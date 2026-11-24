// The per-IP limit on the endpoints that take a guessable secret, as routed by the app, and the
// in-memory limiter the Bun server uses.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Context } from "hono";
import { type ClientIp, memoryLimiter, type RateLimiter } from "../src/rate-limit";
import { errorOf, type TestServer, testServer } from "./api-helpers";

/** A limiter allowing `allowed` calls per key; records the keys it was asked about. */
function limiter(allowed: number) {
  const keys: string[] = [];
  const binding: RateLimiter = {
    async limit({ key }) {
      keys.push(key);
      return { success: keys.filter((k) => k === key).length <= allowed };
    },
  };
  return { binding, keys };
}

/** The client IP as a test header says it; undefined without one. */
const IP_HEADER = "X-Test-Client-IP";
const byHeader: ClientIp = (c: Context) => c.req.header(IP_HEADER);

const IP = "203.0.113.7";
const wrongSetup = { secret: "wrong", deviceName: "Phone" };
const wrongPair = { code: "ABCDEFGH", deviceName: "Laptop" };

let s: TestServer | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const post = (path: string, body: unknown, ip: string | null = IP) => {
  if (!s) throw new Error("no test server");
  return s.call("POST", path, { body, headers: ip === null ? {} : { [IP_HEADER]: ip } });
};

describe("limitGuesses", () => {
  test("answers 429 JSON on POST /setup and /devices/pair once the IP is over the limit", async () => {
    const { binding, keys } = limiter(1);
    s = await testServer({}, { limiter: binding, clientIp: byHeader });
    expect((await post("/setup", wrongSetup)).status).toBe(401);
    const res = await post("/devices/pair", wrongPair);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await errorOf(res)).toEqual({
      code: "rate_limited",
      message: "Too many attempts. Try again in a minute.",
    });
    expect(keys).toEqual([IP, IP]);
  });

  test("percent-encoded and dot-segment spellings of the paths are limited too", async () => {
    const { binding, keys } = limiter(0);
    s = await testServer({}, { limiter: binding, clientIp: byHeader });
    const spellings: [string, unknown][] = [
      ["/%73etup", wrongSetup],
      ["/%64evices/pair", wrongPair],
      ["/devices/%70air", wrongPair],
      ["/devices/../setup", wrongSetup],
      ["/devices/%2e%2e/setup", wrongSetup],
      ["/devices/./pair", wrongPair],
    ];
    for (const [path, body] of spellings) {
      const res = await post(path, body);
      expect([path, res.status]).toEqual([path, 429]);
    }
    expect(keys).toHaveLength(spellings.length);
  });

  test("uses clientIp: each IP has its own count", async () => {
    const { binding } = limiter(1);
    s = await testServer({}, { limiter: binding, clientIp: byHeader });
    expect((await post("/setup", wrongSetup, "198.51.100.1")).status).toBe(401);
    expect((await post("/setup", wrongSetup, "198.51.100.1")).status).toBe(429);
    expect((await post("/setup", wrongSetup, "198.51.100.2")).status).toBe(401);
  });

  test("leaves other endpoints alone without asking the limiter", async () => {
    const { binding, keys } = limiter(0);
    s = await testServer({}, { limiter: binding, clientIp: byHeader });
    expect((await s.call("GET", "/health")).status).toBe(200);
    expect((await post("/devices/invite", {})).status).toBe(401);
    expect((await post("/sync/push", { envelopes: [] })).status).toBe(401);
    expect(keys).toEqual([]);
  });

  test("does nothing without a limiter", async () => {
    s = await testServer({}, { clientIp: byHeader });
    for (let i = 0; i < 5; i++) expect((await post("/setup", wrongSetup)).status).toBe(401);
  });

  test("when clientIp has none, lets the request through and logs once, never one shared bucket", async () => {
    const { binding, keys } = limiter(0);
    s = await testServer({}, { limiter: binding, clientIp: byHeader });
    const logged = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await post("/setup", wrongSetup, null)).status).toBe(401);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    expect(keys).toEqual([]);
  });

  test("lets the request through when the limiter fails", async () => {
    const failing: RateLimiter = {
      limit: async () => {
        throw new Error("rate limiter unavailable");
      },
    };
    s = await testServer({}, { limiter: failing, clientIp: byHeader });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await post("/setup", wrongSetup)).status).toBe(401);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("memoryLimiter", () => {
  const clock = () => {
    let now = 1_000_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  test("memoryLimiter allows 10 calls per key then refuses", async () => {
    const limiter = memoryLimiter({ limit: 10, windowMs: 60_000, now: clock().now });
    for (let i = 0; i < 10; i++) expect((await limiter.limit({ key: "a" })).success).toBe(true);
    expect((await limiter.limit({ key: "a" })).success).toBe(false);
    expect((await limiter.limit({ key: "b" })).success).toBe(true);
  });

  test("memoryLimiter opens again after the window", async () => {
    const time = clock();
    const limiter = memoryLimiter({ limit: 10, windowMs: 60_000, now: time.now });
    for (let i = 0; i < 11; i++) await limiter.limit({ key: "a" });
    time.advance(59_999);
    expect((await limiter.limit({ key: "a" })).success).toBe(false);
    time.advance(1);
    expect((await limiter.limit({ key: "a" })).success).toBe(true);
  });

  test("memoryLimiter forgets ended windows", async () => {
    const time = clock();
    const limiter = memoryLimiter({ limit: 10, windowMs: 60_000, now: time.now });
    for (let i = 0; i < 100; i++) await limiter.limit({ key: `198.51.100.${i}` });
    expect(limiter.size()).toBe(100);
    time.advance(60_000);
    await limiter.limit({ key: "203.0.113.1" });
    expect(limiter.size()).toBe(1);
  });

  test("keeps windows that have not ended, whatever order they started in", async () => {
    const time = clock();
    const limiter = memoryLimiter({ limit: 1, windowMs: 60_000, now: time.now });
    await limiter.limit({ key: "old" });
    time.advance(30_000);
    await limiter.limit({ key: "new" });
    time.advance(30_000); // "old" has ended, "new" has 30 s left
    await limiter.limit({ key: "other" });
    expect(limiter.size()).toBe(2);
    expect((await limiter.limit({ key: "new" })).success).toBe(false);
    expect((await limiter.limit({ key: "old" })).success).toBe(true);
  });
});
