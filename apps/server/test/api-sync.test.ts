import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BLOB_MAX_LENGTH,
  type Envelope,
  PUSH_MAX,
  PUSH_MAX_BYTES,
  type PullResponse,
  pullResponseSchema,
  pushResponseSchema,
} from "@budgee/core";
import * as v from "valibot";
import { PURGE_SEQ_KEY } from "../src/init";
import {
  errorOf,
  liveEnvelope,
  type TestServer,
  testServer,
  tombstoneEnvelope,
  uuid,
} from "./api-helpers";

let s: TestServer;
let token: string;

beforeEach(async () => {
  s = await testServer();
  token = await s.setup();
});
afterEach(() => s.close());

const push = (envelopes: unknown, as = token) =>
  s.call("POST", "/sync/push", { token: as, body: { envelopes } });

const pushOk = async (envelopes: Envelope[]) => {
  const res = await push(envelopes);
  expect(res.status).toBe(200);
  return v.parse(pushResponseSchema, await res.json());
};

const pull = async (query: string, as = token): Promise<PullResponse> => {
  const res = await s.call("GET", `/sync/pull?${query}`, { token: as });
  expect(res.status).toBe(200);
  return v.parse(pullResponseSchema, await res.json());
};

/** Pulls page by page like a client does, from `since` until hasMore is false. */
const pullAll = async (since: number, limit: number) => {
  const pages: PullResponse[] = [];
  let cursor = since;
  for (;;) {
    const page = await pull(`since=${cursor}&limit=${limit}`);
    pages.push(page);
    cursor = page.nextSeq;
    if (!page.hasMore) return pages;
  }
};

describe("POST /sync/push", () => {
  test("needs a device token", async () => {
    const res = await s.call("POST", "/sync/push", { body: { envelopes: [] } });
    expect(res.status).toBe(401);
  });

  test("stores only newer envelopes and counts accepted and ignored", async () => {
    const [a, b] = [uuid(), uuid()];
    expect(await pushOk([liveEnvelope(a, 200), liveEnvelope(b, 100)])).toEqual({
      accepted: 2,
      ignored: 0,
    });
    expect(
      await pushOk([liveEnvelope(a, 100), liveEnvelope(a, 200, "same"), tombstoneEnvelope(b, 300)]),
    ).toEqual({ accepted: 1, ignored: 2 });

    const { envelopes } = await pull("since=0");
    expect(envelopes.map((e) => [e.id, e.deleted])).toEqual([
      [a, false],
      [b, true],
    ]);
    expect(envelopes[0]).toMatchObject({ blob: btoa("b200") });
  });

  test("stored envelopes get seqs above every earlier one: a pull from the last cursor sees exactly them", async () => {
    const [a, b, c] = [uuid(), uuid(), uuid()];
    let cursor = 0;
    for (const [envelopes, expected] of [
      [
        [liveEnvelope(a, 100), liveEnvelope(b, 100)],
        [a, b],
      ],
      [[liveEnvelope(a, 200)], [a]],
      [[liveEnvelope(a, 150)], []], // ignored
      [
        [tombstoneEnvelope(b, 300), liveEnvelope(c, 100)],
        [b, c],
      ],
    ] as const) {
      await pushOk([...envelopes]);
      const page = await pull(`since=${cursor}`);
      expect(page.envelopes.map((e) => e.id)).toEqual([...expected]);
      cursor = page.nextSeq;
    }
    expect((await pull("since=0")).envelopes.map((e) => e.id)).toEqual([a, b, c]);
  });

  test("an empty push is fine", async () => {
    expect(await pushOk([])).toEqual({ accepted: 0, ignored: 0 });
  });

  test(`refuses more than ${PUSH_MAX} envelopes, unknown fields and oversized blobs, storing nothing`, async () => {
    const many = Array.from({ length: PUSH_MAX + 1 }, () => liveEnvelope(uuid(), 100));
    const ok = liveEnvelope(uuid(), 100);
    for (const envelopes of [
      many,
      [ok, { ...liveEnvelope(uuid(), 100), amount: 4200 }],
      [ok, { ...liveEnvelope(uuid(), 100), blob: "A".repeat(BLOB_MAX_LENGTH + 4) }],
      [ok, { ...tombstoneEnvelope(uuid(), 100), blob: "AAAA" }],
      [ok, { ...liveEnvelope(uuid(), 100), table: "devices" }],
    ]) {
      const res = await push(envelopes);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_request");
    }
    const extra = await s.call("POST", "/sync/push", {
      token,
      body: { envelopes: [], force: true },
    });
    expect(extra.status).toBe(400);
    expect((await pull("since=0")).envelopes).toEqual([]);
  });

  test(`refuses a body over ${PUSH_MAX_BYTES} bytes with 413`, async () => {
    const body = JSON.stringify({ envelopes: [], pad: "x".repeat(PUSH_MAX_BYTES) });
    const res = await s.call("POST", "/sync/push", { token, body });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("payload_too_large");

    const withLength = await s.call("POST", "/sync/push", {
      token,
      body,
      headers: { "Content-Length": String(body.length) },
    });
    expect(withLength.status).toBe(413);
  });

  test("a full push of 500 typical envelopes fits under the body limit", async () => {
    const envelopes = Array.from({ length: PUSH_MAX }, () =>
      liveEnvelope(uuid(), 100, "x".repeat(600)),
    );
    expect(JSON.stringify({ envelopes }).length).toBeLessThan(PUSH_MAX_BYTES);
    expect(await pushOk(envelopes)).toEqual({ accepted: PUSH_MAX, ignored: 0 });
  });
});

describe("GET /sync/pull", () => {
  test("needs a device token", async () => {
    expect((await s.call("GET", "/sync/pull?since=0")).status).toBe(401);
  });

  test("paged pull returns every envelope exactly once, in seq order", async () => {
    const ids = Array.from({ length: 7 }, () => uuid());
    await pushOk(ids.slice(0, 4).map((id) => liveEnvelope(id, 100)));
    await pushOk([tombstoneEnvelope(ids[1] as string, 200), liveEnvelope(ids[0] as string, 200)]);
    await pushOk(ids.slice(4).map((id) => liveEnvelope(id, 100)));

    const pages = await pullAll(0, 3);
    const all = pages.flatMap((p) => p.envelopes);
    expect(pages.map((p) => [p.envelopes.length, p.hasMore])).toEqual([
      [3, true],
      [3, true],
      [1, false],
    ]);
    expect(all.map((e) => e.id).sort()).toEqual([...ids].sort());
    const seqs = all.map((e) => e.seq ?? 0);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(pages.at(-1)?.nextSeq).toBe(seqs.at(-1));
    expect(pages.every((p) => !p.resetRequired)).toBe(true);
    // Moved rows come out once, at their new seq; the tombstone has no blob.
    const tomb = all.find((e) => e.id === ids[1]);
    expect(tomb).toEqual({ ...tombstoneEnvelope(ids[1] as string, 200), seq: expect.any(Number) });
  });

  test("a page exactly at the limit says hasMore only when more exist", async () => {
    await pushOk([liveEnvelope(uuid(), 1), liveEnvelope(uuid(), 1)]);
    const page = await pull("since=0&limit=2");
    expect(page.hasMore).toBe(false);
    expect(page.envelopes).toHaveLength(2);
  });

  test("pulling from the end returns nothing and keeps the cursor", async () => {
    await pushOk([liveEnvelope(uuid(), 1)]);
    const { nextSeq } = await pull("since=0");
    expect(await pull(`since=${nextSeq}`)).toEqual({
      envelopes: [],
      nextSeq,
      hasMore: false,
      resetRequired: false,
    });
  });

  test("records since as the device's acknowledged position", async () => {
    const laptop = await s.pair(token, "Laptop");
    await pushOk(Array.from({ length: 10 }, (_, i) => liveEnvelope(uuid(), i + 1)));
    const acks = () =>
      s.db.query<{ name: string; last_ack_seq: number }>(
        "SELECT name, last_ack_seq FROM devices ORDER BY name",
      );
    await pull("since=0", laptop);
    await pull("since=8", laptop);
    expect(await acks()).toEqual([
      { name: "Laptop", last_ack_seq: 8 },
      { name: "Phone", last_ack_seq: 0 },
    ]);
    await pull("since=7");
    await pull("since=3", laptop);
    expect(await acks()).toEqual([
      { name: "Laptop", last_ack_seq: 3 },
      { name: "Phone", last_ack_seq: 7 },
    ]);
  });

  test("an acknowledged position never goes past the last seq handed out", async () => {
    // Otherwise a buggy client could vouch for tombstones it never saw, and the cleanup would
    // purge them from under it.
    await pushOk([liveEnvelope(uuid(), 1), tombstoneEnvelope(uuid(), 1)]);
    await pull("since=999");
    const ack = async () =>
      (await s.db.query<{ last_ack_seq: number }>("SELECT last_ack_seq FROM devices"))[0];
    expect(await ack()).toEqual({ last_ack_seq: 2 });
    await pushOk([liveEnvelope(uuid(), 1)]);
    await pull("since=999");
    expect(await ack()).toEqual({ last_ack_seq: 3 });
  });

  test("answers resetRequired when since is older than the purge point", async () => {
    const [a, b, c] = [uuid(), uuid(), uuid()];
    await pushOk([liveEnvelope(a, 1), tombstoneEnvelope(b, 1), liveEnvelope(c, 1)]);
    // What the daily cleanup does (Task 8): purge the tombstone, record its seq.
    const [tomb] = await s.db.query<{ seq: number }>("SELECT seq FROM envelopes WHERE id = ?", [b]);
    await s.db.batch([
      { sql: "DELETE FROM envelopes WHERE id = ?", params: [b] },
      {
        sql: "INSERT INTO config (key, value) VALUES (?, ?)",
        params: [PURGE_SEQ_KEY, String(tomb?.seq)],
      },
    ]);
    const purgeSeq = tomb?.seq ?? 0;

    expect(await pull(`since=${purgeSeq - 1}`)).toEqual({
      envelopes: [],
      nextSeq: 0,
      hasMore: false,
      resetRequired: true,
    });
    // A device that saw the purged tombstone, or one starting empty, carries on normally.
    expect((await pull(`since=${purgeSeq}`)).resetRequired).toBe(false);
    const fresh = await pull("since=0");
    expect(fresh.resetRequired).toBe(false);
    expect(fresh.envelopes.map((e) => e.id)).toEqual([a, c]);
  });

  test("refuses a bad query", async () => {
    for (const query of [
      "",
      "since=-1",
      "since=x",
      "since=0&limit=0",
      "since=0&limit=501",
      "since=0&x=1",
    ]) {
      const res = await s.call("GET", `/sync/pull?${query}`, { token });
      expect([query, res.status]).toEqual([query, 400]);
      expect((await errorOf(res)).code).toBe("invalid_request");
    }
  });
});
