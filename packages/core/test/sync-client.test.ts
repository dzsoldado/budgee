import { describe, expect, test } from "bun:test";
import { encryptRow, generateVaultKey } from "../src/crypto";
import { capClockDrift, formatHlc, MAX_CLOCK_DRIFT_MS, parseHlc } from "../src/hlc";
import { type Envelope, PUSH_MAX, PUSH_MAX_BYTES } from "../src/schema";
import {
  batchEnvelopes,
  checkVaultKey,
  createHttpTransport,
  type HttpFetch,
  SyncError,
  type SyncTransport,
} from "../src/sync-client";

const NOW = 1_763_337_600_000;
const HOUR = 60 * 60 * 1000;

describe("capClockDrift", () => {
  test("keeps an hlc up to 24 hours ahead of now", () => {
    const remote = formatHlc({ wall: NOW + 23 * HOUR, counter: 7, device: "phone" });
    expect(capClockDrift(remote, NOW)).toBe(remote);
    const edge = formatHlc({ wall: NOW + MAX_CLOCK_DRIFT_MS, counter: 7, device: "phone" });
    expect(capClockDrift(edge, NOW)).toBe(edge);
  });

  test("caps an hlc further ahead at now + 24 hours", () => {
    const remote = formatHlc({ wall: NOW + 48 * HOUR, counter: 7, device: "phone" });
    expect(parseHlc(capClockDrift(remote, NOW))).toEqual({
      wall: NOW + MAX_CLOCK_DRIFT_MS,
      counter: 0,
      device: "phone",
    });
  });
});

const envelope = (n: number, blobLength = 8): Envelope => ({
  table: "transactions",
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  hlc: formatHlc({ wall: n, counter: 0, device: "phone" }),
  deleted: false,
  device: "phone",
  blob: "A".repeat(blobLength),
});

const bodySize = (batch: Envelope[]) =>
  new TextEncoder().encode(JSON.stringify({ envelopes: batch })).length;

describe("batchEnvelopes", () => {
  test("splits by count", () => {
    const all = Array.from({ length: 1201 }, (_, i) => envelope(i));
    const batches = batchEnvelopes(all, { maxCount: PUSH_MAX, maxBytes: PUSH_MAX_BYTES });
    expect(batches.map((b) => b.length)).toEqual([500, 500, 201]);
    expect(batches.flat()).toEqual(all);
  });

  test("splits by the serialized request size, never above the limit", () => {
    const all = Array.from({ length: 10 }, (_, i) => envelope(i, 300));
    // Two fit in a request, three do not.
    const maxBytes = bodySize(all.slice(0, 3)) - 1;
    const batches = batchEnvelopes(all, { maxCount: PUSH_MAX, maxBytes });
    expect(batches.flat()).toEqual(all);
    for (const batch of batches) expect(bodySize(batch)).toBeLessThanOrEqual(maxBytes);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 2, 2, 2]);
  });

  test("an exact fit stays in one batch", () => {
    const all = Array.from({ length: 4 }, (_, i) => envelope(i, 100));
    const batches = batchEnvelopes(all, { maxCount: PUSH_MAX, maxBytes: bodySize(all) });
    expect(batches).toEqual([all]);
  });

  test("nothing to push, no batches", () => {
    expect(batchEnvelopes([], { maxCount: PUSH_MAX, maxBytes: PUSH_MAX_BYTES })).toEqual([]);
  });
});

describe("createHttpTransport", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const health = { serverId: "srv", version: "0.1.0", serverTime: NOW };

  const capture = (respond: () => Promise<Response> | Response) => {
    const calls: { url: string; init: Parameters<HttpFetch>[1] }[] = [];
    const fetch: HttpFetch = async (url, init) => {
      calls.push({ url, init });
      return respond();
    };
    return { calls, fetch };
  };

  const kindOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(SyncError);
      return (error as SyncError).kind;
    }
    throw new Error("expected a SyncError");
  };

  test("refuses a relative or non-http server URL", () => {
    for (const serverUrl of ["/api", "budgee.example", "ftp://budgee.example"]) {
      expect(() =>
        createHttpTransport({ serverUrl, token: "t", fetch: async () => json(200, {}) }),
      ).toThrow();
    }
  });

  test("calls absolute URLs under /api/v1 with the Bearer token (none on health)", async () => {
    const { calls, fetch } = capture(() => json(200, health));
    const transport = createHttpTransport({
      serverUrl: "https://budgee.example/",
      token: "tok",
      fetch,
    });
    expect(await transport.health()).toEqual(health);
    expect(calls[0]?.url).toBe("https://budgee.example/api/v1/health");
    expect(calls[0]?.init.headers.Authorization).toBeUndefined();

    const push = capture(() => json(200, { accepted: 1, ignored: 0 }));
    const t2 = createHttpTransport({
      serverUrl: "https://budgee.example",
      token: "tok",
      fetch: push.fetch,
    });
    await t2.push({ envelopes: [envelope(1)] });
    expect(push.calls[0]?.url).toBe("https://budgee.example/api/v1/sync/push");
    expect(push.calls[0]?.init.method).toBe("POST");
    expect(push.calls[0]?.init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(push.calls[0]?.init.body ?? "")).toEqual({ envelopes: [envelope(1)] });

    const pull = capture(() =>
      json(200, { envelopes: [], nextSeq: 4, hasMore: false, resetRequired: false }),
    );
    const t3 = createHttpTransport({
      serverUrl: "https://budgee.example",
      token: "tok",
      fetch: pull.fetch,
    });
    await t3.pull({ since: 4, limit: 500 });
    expect(pull.calls[0]?.url).toBe("https://budgee.example/api/v1/sync/pull?since=4&limit=500");
    expect(pull.calls[0]?.init.headers.Authorization).toBe("Bearer tok");
  });

  test("a network failure is offline", async () => {
    const transport = createHttpTransport({
      serverUrl: "https://budgee.example",
      token: "t",
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(await kindOf(transport.health())).toBe("offline");
  });

  test("a request past its timeout is aborted and offline", async () => {
    const transport = createHttpTransport({
      serverUrl: "https://budgee.example",
      token: "t",
      timeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    });
    expect(await kindOf(transport.health())).toBe("offline");
  });

  test("401 device_revoked, other 401s, server errors and bad bodies have their own kinds", async () => {
    const make = (respond: () => Response) =>
      createHttpTransport({
        serverUrl: "https://b.example",
        token: "t",
        fetch: async () => respond(),
      });
    const err = (code: string) => ({ error: { code, message: "x" } });
    expect(await kindOf(make(() => json(401, err("device_revoked"))).pull({ since: 0 }))).toBe(
      "device_revoked",
    );
    expect(await kindOf(make(() => json(401, err("unauthorized"))).pull({ since: 0 }))).toBe(
      "unauthorized",
    );
    expect(await kindOf(make(() => json(500, err("internal"))).pull({ since: 0 }))).toBe("server");
    expect(await kindOf(make(() => new Response("<html>", { status: 502 })).health())).toBe(
      "server",
    );
    expect(await kindOf(make(() => json(200, { nope: true })).health())).toBe("bad_response");
    expect(await kindOf(make(() => new Response("not json", { status: 200 })).health())).toBe(
      "bad_response",
    );
  });
});

describe("checkVaultKey", () => {
  const sealed = async (key: CryptoKey, n: number): Promise<Envelope> => {
    const { table, id, hlc, device } = envelope(n);
    const blob = await encryptRow(key, table, id, hlc, { n });
    return { table, id, hlc, device, deleted: false, blob };
  };
  const tombstone = (n: number): Envelope => {
    const { table, id, hlc, device } = envelope(n);
    return { table, id, hlc, device, deleted: true };
  };
  /** A transport whose pull pages through `envelopes`, `limit` at a time. */
  const serving = (envelopes: Envelope[], limit: number) => {
    const pulls: number[] = [];
    const transport: SyncTransport = {
      health: async () => ({ serverId: "srv", version: "0.1.0", serverTime: NOW }),
      push: async () => ({ accepted: 0, ignored: 0 }),
      async pull({ since }) {
        pulls.push(since);
        const page = envelopes.slice(since, since + limit);
        return {
          envelopes: page,
          nextSeq: since + page.length,
          hasMore: since + page.length < envelopes.length,
          resetRequired: false,
        };
      },
    };
    return { transport, pulls };
  };

  test("matches when the first live row decrypts, reading only as far as that row", async () => {
    const key = await generateVaultKey();
    const { transport, pulls } = serving(
      [tombstone(1), tombstone(2), await sealed(key, 3), await sealed(key, 4)],
      2,
    );
    expect(await checkVaultKey(transport, key)).toBe("matches");
    expect(pulls).toEqual([0, 2]);
  });

  test("a different key is a mismatch", async () => {
    const { transport } = serving([await sealed(await generateVaultKey(), 1)], 500);
    expect(await checkVaultKey(transport, await generateVaultKey())).toBe("mismatch");
  });

  test("a server with no live rows has nothing to check against", async () => {
    expect(await checkVaultKey(serving([], 500).transport, await generateVaultKey())).toBe(
      "no_data",
    );
    const onlyDeleted = serving([tombstone(1), tombstone(2), tombstone(3)], 2);
    expect(await checkVaultKey(onlyDeleted.transport, await generateVaultKey())).toBe("no_data");
    expect(onlyDeleted.pulls).toEqual([0, 2]);
  });

  test("transport failures are thrown as they are", async () => {
    const transport: SyncTransport = {
      ...serving([], 1).transport,
      pull: () => Promise.reject(new SyncError("offline", "down")),
    };
    await expect(checkVaultKey(transport, await generateVaultKey())).rejects.toBeInstanceOf(
      SyncError,
    );
  });
});
