import { describe, expect, test } from "bun:test";
import { createDeviceApi } from "../src/device-api";
import { type HttpFetch, SyncError } from "../src/sync-client";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const device = {
  id: "d1",
  name: "Chrome on Windows",
  createdAt: 1,
  lastSeen: 2,
  revoked: false,
  current: true,
};

function capture(respond: () => Response) {
  const calls: { url: string; init: Parameters<HttpFetch>[1] }[] = [];
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fetch };
}

async function failure(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    return error as SyncError;
  }
  throw new Error("expected a SyncError");
}

describe("createDeviceApi", () => {
  test("setup and pair post without a token and return token and serverId", async () => {
    const { calls, fetch } = capture(() => json(200, { token: "tok", serverId: "srv" }));
    const api = createDeviceApi({ serverUrl: "https://budgee.example", fetch });
    expect(await api.setup({ secret: "s3cret", deviceName: "Pixel" })).toEqual({
      token: "tok",
      serverId: "srv",
    });
    expect(await api.pair({ code: "ABCD1234", deviceName: "Pixel" })).toEqual({
      token: "tok",
      serverId: "srv",
    });
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", "https://budgee.example/api/v1/setup"],
      ["POST", "https://budgee.example/api/v1/devices/pair"],
    ]);
    for (const call of calls) expect(call.init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(calls[0]?.init.body ?? "")).toEqual({
      secret: "s3cret",
      deviceName: "Pixel",
    });
  });

  test("invite, list, rename and revoke send the Bearer token", async () => {
    const responses = [
      json(200, { code: "ABCD1234", expiresAt: 5 }),
      json(200, { devices: [device] }),
      json(200, { ...device, name: "Laptop" }),
      json(200, { ...device, revoked: true }),
      json(200, { ...device, current: false, revoked: true }),
    ];
    const { calls, fetch } = capture(() => responses.shift() ?? json(500, {}));
    const api = createDeviceApi({ serverUrl: "https://budgee.example", token: "tok", fetch });

    expect(await api.invite()).toEqual({ code: "ABCD1234", expiresAt: 5 });
    expect(await api.list()).toEqual([device]);
    expect((await api.rename("d1", "Laptop")).name).toBe("Laptop");
    expect((await api.revoke("d1", { confirmSelf: true })).revoked).toBe(true);
    await api.revoke("d2");

    expect(calls.map((c) => [c.init.method, c.url, c.init.body])).toEqual([
      ["POST", "https://budgee.example/api/v1/devices/invite", undefined],
      ["GET", "https://budgee.example/api/v1/devices", undefined],
      ["PATCH", "https://budgee.example/api/v1/devices/d1", JSON.stringify({ name: "Laptop" })],
      [
        "POST",
        "https://budgee.example/api/v1/devices/d1/revoke",
        JSON.stringify({ confirmSelf: true }),
      ],
      ["POST", "https://budgee.example/api/v1/devices/d2/revoke", JSON.stringify({})],
    ]);
    for (const call of calls) expect(call.init.headers.Authorization).toBe("Bearer tok");
  });

  test("a device id is escaped in the path", async () => {
    const { calls, fetch } = capture(() => json(200, device));
    await createDeviceApi({ serverUrl: "https://b.example", token: "t", fetch }).rename(
      "a/b?c",
      "X",
    );
    expect(calls[0]?.url).toBe("https://b.example/api/v1/devices/a%2Fb%3Fc");
  });

  test("errors keep the server's code and status", async () => {
    const err = (status: number, code: string) =>
      createDeviceApi({
        serverUrl: "https://b.example",
        token: "t",
        fetch: async () => json(status, { error: { code, message: "x" } }),
      });
    const setUp = await failure(err(409, "already_set_up").setup({ secret: "s", deviceName: "n" }));
    expect([setUp.kind, setUp.code, setUp.status]).toEqual(["server", "already_set_up", 409]);
    const wrong = await failure(err(401, "invalid_secret").setup({ secret: "s", deviceName: "n" }));
    expect([wrong.kind, wrong.code]).toEqual(["unauthorized", "invalid_secret"]);
    const code = await failure(err(401, "invalid_code").pair({ code: "x", deviceName: "n" }));
    expect(code.code).toBe("invalid_code");
    const self = await failure(err(409, "confirm_self_required").revoke("d1"));
    expect(self.code).toBe("confirm_self_required");
    const revoked = await failure(err(401, "device_revoked").list());
    expect(revoked.kind).toBe("device_revoked");
  });

  test("unreachable is offline; an unexpected body is bad_response", async () => {
    const offline = createDeviceApi({
      serverUrl: "https://b.example",
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect((await failure(offline.setup({ secret: "s", deviceName: "n" }))).kind).toBe("offline");
    const odd = createDeviceApi({
      serverUrl: "https://b.example",
      token: "t",
      fetch: async () => json(200, { devices: [{ ...device, extra: 1 }] }),
    });
    expect((await failure(odd.list())).kind).toBe("bad_response");
  });

  test("refuses a relative server URL", () => {
    expect(() => createDeviceApi({ serverUrl: "/api", fetch: async () => json(200, {}) })).toThrow(
      TypeError,
    );
  });
});
