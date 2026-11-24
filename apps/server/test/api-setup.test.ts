import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inviteResponseSchema, setupResponseSchema } from "@budgee/core";
import * as v from "valibot";
import { SETUP_SECRET_MIN_LENGTH, weakSetupSecretWarning } from "../src/devices";
import { sha256Hex } from "../src/tokens";
import { errorOf, SETUP_SECRET, START, type TestServer, testServer } from "./api-helpers";

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding
const TEN_MINUTES = 10 * 60 * 1000;

let s: TestServer;
afterEach(() => s.close());

const deviceRows = () =>
  s.db.query<{ name: string; token_hash: string; created_at: number }>(
    "SELECT name, token_hash, created_at FROM devices ORDER BY created_at, name",
  );

describe("POST /setup", () => {
  beforeEach(async () => {
    s = await testServer();
  });

  test("creates the first device and returns its token once; only the hash is stored", async () => {
    const res = await s.call("POST", "/setup", {
      body: { secret: SETUP_SECRET, deviceName: "Pixel" },
    });

    expect(res.status).toBe(200);
    const body = v.parse(setupResponseSchema, await res.json());
    expect(body.serverId).toBe(s.serverId);
    expect(body.token).toMatch(TOKEN);
    expect(await deviceRows()).toEqual([
      { name: "Pixel", token_hash: await sha256Hex(body.token), created_at: START },
    ]);
    expect(await s.call("GET", "/devices", { token: body.token })).toHaveProperty("status", 200);
  });

  test("refuses once any device exists", async () => {
    await s.setup();
    const res = await s.call("POST", "/setup", {
      body: { secret: SETUP_SECRET, deviceName: "Second" },
    });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("already_set_up");
    expect(await deviceRows()).toHaveLength(1);
  });

  test("two setups racing: exactly one wins", async () => {
    const attempt = (deviceName: string) =>
      s.call("POST", "/setup", { body: { secret: SETUP_SECRET, deviceName } });
    const statuses = (await Promise.all([attempt("A"), attempt("B")])).map((r) => r.status);

    expect(statuses.sort()).toEqual([200, 409]);
    expect(await deviceRows()).toHaveLength(1);
  });

  test("a wrong secret is refused and creates nothing", async () => {
    for (const secret of ["wrong", `${SETUP_SECRET}x`, SETUP_SECRET.slice(0, -1)]) {
      const res = await s.call("POST", "/setup", { body: { secret, deviceName: "Pixel" } });
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe("invalid_secret");
    }
    expect(await deviceRows()).toEqual([]);
  });

  test("an invalid body is refused without echoing it", async () => {
    const res = await s.call("POST", "/setup", {
      body: { secret: "hunter2-is-my-secret", deviceName: "", isAdmin: "yes-please" },
    });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("invalid_request");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("isAdmin");
    expect(text).not.toContain("yes-please");
  });

  test("malformed JSON is refused", async () => {
    const res = await s.call("POST", "/setup", { body: "{not json" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_json");
  });
});

describe("POST /setup without SETUP_SECRET configured", () => {
  test("is disabled", async () => {
    s = await testServer({ setupSecret: undefined });
    const res = await s.call("POST", "/setup", {
      body: { secret: SETUP_SECRET, deviceName: "Pixel" },
    });

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("setup_disabled");
  });
});

describe("pairing", () => {
  let first: string;
  beforeEach(async () => {
    s = await testServer();
    first = await s.setup("Phone");
  });

  const pairWith = (code: string, deviceName = "Laptop") =>
    s.call("POST", "/devices/pair", { body: { code, deviceName } });

  test("an invite needs a device token", async () => {
    const res = await s.call("POST", "/devices/invite");
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("unauthorized");
  });

  test("an invite is an 8-symbol Crockford base32 code, valid 10 minutes, stored hashed", async () => {
    const res = await s.call("POST", "/devices/invite", { token: first });

    expect(res.status).toBe(200);
    const { code, expiresAt } = v.parse(inviteResponseSchema, await res.json());
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(expiresAt).toBe(START + TEN_MINUTES);
    expect(await s.db.query("SELECT code_hash, expires_at, used FROM pairing_codes")).toEqual([
      { code_hash: await sha256Hex(code), expires_at: START + TEN_MINUTES, used: 0 },
    ]);
  });

  test("pairing with the code creates a device with its own token", async () => {
    const { code } = await s.invite(first);
    const res = await pairWith(code, "Laptop");

    expect(res.status).toBe(200);
    const body = v.parse(setupResponseSchema, await res.json());
    expect(body.serverId).toBe(s.serverId);
    expect(body.token).toMatch(TOKEN);
    expect(body.token).not.toBe(first);
    expect((await deviceRows()).map((d) => d.name)).toEqual(["Laptop", "Phone"]);
    expect((await s.call("GET", "/devices", { token: body.token })).status).toBe(200);
  });

  test("a code works once", async () => {
    const { code } = await s.invite(first);
    expect((await pairWith(code, "Laptop")).status).toBe(200);

    const again = await pairWith(code, "Tablet");
    expect(again.status).toBe(401);
    expect((await errorOf(again)).code).toBe("invalid_code");
    expect(await deviceRows()).toHaveLength(2);
  });

  test("a code is valid for 10 minutes", async () => {
    const early = await s.invite(first);
    const late = await s.invite(first);
    s.advance(TEN_MINUTES - 1);
    expect((await pairWith(early.code)).status).toBe(200);
    s.advance(1);
    expect((await pairWith(late.code)).status).toBe(401);
  });

  test("codes are read like Crockford base32: any case, dashes and spaces, I/L as 1, O as 0", async () => {
    const { code } = await s.invite(first);
    const typed = `${code.slice(0, 4).toLowerCase()}- ${code.slice(4)}`
      .replace(/1/g, "l")
      .replace(/0/g, "O");
    expect((await pairWith(typed)).status).toBe(200);
  });

  test("an unknown, used or expired code gets the very same answer", async () => {
    const used = await s.invite(first);
    await pairWith(used.code);
    const expired = await s.invite(first);
    s.advance(TEN_MINUTES);

    const answers = await Promise.all(
      ["ZZZZZZZZ", "not a code at all", used.code, expired.code].map(async (code) => {
        const res = await pairWith(code);
        return { status: res.status, body: await res.text() };
      }),
    );
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]?.status).toBe(401);
  });

  test("two devices racing on one code: exactly one pairs", async () => {
    const { code } = await s.invite(first);
    const statuses = (await Promise.all([pairWith(code, "A"), pairWith(code, "B")])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([200, 401]);
    expect(await deviceRows()).toHaveLength(2);
  });

  test("used and expired codes are cleared out by the next invite", async () => {
    const used = await s.invite(first);
    await pairWith(used.code);
    await s.invite(first);
    s.advance(TEN_MINUTES);
    await s.invite(first);

    expect(await s.db.query("SELECT COUNT(*) AS n FROM pairing_codes")).toEqual([{ n: 1 }]);
  });
});

describe("weakSetupSecretWarning", () => {
  test("warns about a SETUP_SECRET shorter than 32 characters, without showing it", () => {
    const warning = weakSetupSecretWarning("short-secret");
    expect(warning).toContain("SETUP_SECRET");
    expect(warning).toContain(String(SETUP_SECRET_MIN_LENGTH));
    expect(warning).not.toContain("short-secret");
    expect(weakSetupSecretWarning("x".repeat(SETUP_SECRET_MIN_LENGTH - 1))).not.toBeNull();
  });

  test("is quiet for a long secret, or none (setup disabled)", () => {
    expect(SETUP_SECRET_MIN_LENGTH).toBe(32);
    expect(weakSetupSecretWarning("x".repeat(32))).toBeNull();
    expect(weakSetupSecretWarning(undefined)).toBeNull();
    expect(weakSetupSecretWarning("")).toBeNull();
  });
});
