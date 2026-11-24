import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deviceListResponseSchema, deviceSchema } from "@budgee/core";
import * as v from "valibot";
import { errorOf, START, type TestServer, testServer } from "./api-helpers";

let s: TestServer;
let phone: string;
let laptop: string;

beforeEach(async () => {
  s = await testServer();
  phone = await s.setup("Phone");
  s.advance(1000);
  laptop = await s.pair(phone, "Laptop");
});
afterEach(() => s.close());

const list = async (token: string) => {
  const res = await s.call("GET", "/devices", { token });
  expect(res.status).toBe(200);
  return v.parse(deviceListResponseSchema, await res.json()).devices;
};

const idOf = async (name: string) => {
  const device = (await list(phone)).find((d) => d.name === name);
  if (!device) throw new Error(`no device ${name}`);
  return device.id;
};

describe("auth", () => {
  test("a missing, malformed or unknown token is refused", async () => {
    for (const headers of [
      {},
      { Authorization: "" },
      { Authorization: phone },
      { Authorization: `Basic ${phone}` },
      { Authorization: "Bearer " },
      { Authorization: `Bearer ${phone}x` },
    ]) {
      const res = await s.call("GET", "/devices", { headers });
      expect(res.status).toBe(401);
      expect(await errorOf(res)).toEqual({
        code: "unauthorized",
        message: expect.any(String),
      });
    }
  });

  test("the Bearer scheme name is case-insensitive", async () => {
    for (const scheme of ["Bearer", "bearer", "BEARER", "bEaReR"]) {
      const res = await s.call("GET", "/devices", {
        headers: { Authorization: `${scheme} ${phone}` },
      });
      expect([scheme, res.status]).toEqual([scheme, 200]);
    }
  });

  test("every authenticated request updates last_seen, written at most once a minute", async () => {
    const lastSeen = async () =>
      (await s.db.query<{ name: string; last_seen: number | null }>(
        "SELECT name, last_seen FROM devices ORDER BY name",
      )) as { name: string; last_seen: number | null }[];
    // Setup and pairing count as a sighting; the invite 1 s after setup was within the minute.
    expect(await lastSeen()).toEqual([
      { name: "Laptop", last_seen: START + 1000 },
      { name: "Phone", last_seen: START },
    ]);

    s.advance(60_000);
    await s.call("GET", "/devices", { token: laptop });
    const first = s.now();
    s.advance(59_999);
    await s.call("GET", "/devices", { token: laptop });
    expect((await lastSeen())[0]).toEqual({ name: "Laptop", last_seen: first });

    s.advance(1);
    await s.call("GET", "/devices", { token: laptop });
    expect((await lastSeen())[0]).toEqual({ name: "Laptop", last_seen: s.now() });
  });
});

describe("GET /devices", () => {
  test("lists every device, oldest first, with the caller marked current", async () => {
    const fromPhone = await list(phone);
    expect(fromPhone).toEqual([
      {
        id: expect.any(String),
        name: "Phone",
        createdAt: START,
        lastSeen: START,
        revoked: false,
        current: true,
      },
      {
        id: expect.any(String),
        name: "Laptop",
        createdAt: START + 1000,
        lastSeen: START + 1000,
        revoked: false,
        current: false,
      },
    ]);
    expect((await list(laptop)).map((d) => [d.name, d.current])).toEqual([
      ["Phone", false],
      ["Laptop", true],
    ]);
  });
});

describe("PATCH /devices/:id", () => {
  test("renames a device and returns it", async () => {
    const id = await idOf("Laptop");
    const res = await s.call("PATCH", `/devices/${id}`, { token: phone, body: { name: "Work" } });

    expect(res.status).toBe(200);
    expect(v.parse(deviceSchema, await res.json())).toMatchObject({
      id,
      name: "Work",
      current: false,
    });
    expect((await list(phone)).map((d) => d.name)).toEqual(["Phone", "Work"]);
  });

  test("an unknown id is 404, an invalid name 400", async () => {
    const unknown = await s.call("PATCH", "/devices/nope", { token: phone, body: { name: "X" } });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe("not_found");

    const id = await idOf("Laptop");
    for (const body of [{ name: "" }, { name: "x".repeat(101) }, { name: "X", revoked: false }]) {
      const res = await s.call("PATCH", `/devices/${id}`, { token: phone, body });
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /devices/:id/revoke", () => {
  test("a revoked device is refused from then on and stays listed as revoked", async () => {
    const id = await idOf("Laptop");
    const res = await s.call("POST", `/devices/${id}/revoke`, { token: phone });

    expect(res.status).toBe(200);
    expect(v.parse(deviceSchema, await res.json())).toMatchObject({ id, revoked: true });

    for (const [method, path] of [
      ["GET", "/devices"],
      ["POST", "/devices/invite"],
      ["GET", "/sync/pull?since=0"],
      ["POST", "/sync/push"],
    ] as const) {
      const body = method === "POST" ? { envelopes: [] } : undefined;
      const refused = await s.call(method, path, { token: laptop, body });
      expect(refused.status).toBe(401);
      expect((await errorOf(refused)).code).toBe("device_revoked");
    }
    expect((await list(phone)).map((d) => [d.name, d.revoked])).toEqual([
      ["Phone", false],
      ["Laptop", true],
    ]);
  });

  test("revoking the calling device must be confirmed explicitly", async () => {
    const id = await idOf("Phone");

    const unconfirmed = await s.call("POST", `/devices/${id}/revoke`, { token: phone });
    expect(unconfirmed.status).toBe(409);
    expect((await errorOf(unconfirmed)).code).toBe("confirm_self_required");
    expect((await s.call("GET", "/devices", { token: phone })).status).toBe(200);

    const confirmed = await s.call("POST", `/devices/${id}/revoke`, {
      token: phone,
      body: { confirmSelf: true },
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ id, revoked: true, current: true });
    expect((await s.call("GET", "/devices", { token: phone })).status).toBe(401);
  });

  test("the last device not revoked is refused with 409 last_device and keeps working", async () => {
    expect(
      (await s.call("POST", `/devices/${await idOf("Laptop")}/revoke`, { token: phone })).status,
    ).toBe(200);
    const id = await idOf("Phone");
    const refused = await s.call("POST", `/devices/${id}/revoke`, {
      token: phone,
      body: { confirmSelf: true },
    });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toEqual({ code: "last_device", message: expect.any(String) });
    expect((await list(phone)).map((d) => [d.name, d.revoked])).toEqual([
      ["Phone", false],
      ["Laptop", true],
    ]);
  });

  test("a pairing code made before a revoke no longer pairs", async () => {
    const { code } = await s.invite(phone);
    expect(
      (await s.call("POST", `/devices/${await idOf("Laptop")}/revoke`, { token: phone })).status,
    ).toBe(200);
    const pair = await s.call("POST", "/devices/pair", { body: { code, deviceName: "Tablet" } });
    expect(pair.status).toBe(401);
    expect((await errorOf(pair)).code).toBe("invalid_code");
  });

  test("an unknown id is 404 and an invalid body 400", async () => {
    const unknown = await s.call("POST", "/devices/nope/revoke", { token: phone });
    expect(unknown.status).toBe(404);

    const id = await idOf("Laptop");
    const bad = await s.call("POST", `/devices/${id}/revoke`, {
      token: phone,
      body: { confirmSelf: false },
    });
    expect(bad.status).toBe(400);
  });
});
