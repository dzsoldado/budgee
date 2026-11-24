// Connecting Google Drive through the server, with the real Drive destination against a fake of
// Google's endpoints.
import { afterEach, describe, expect, test } from "bun:test";
import {
  type BackupStatusResponse,
  backupRunResponseSchema,
  backupStatusResponseSchema,
  googleConnectResponseSchema,
} from "@budgee/core";
import * as v from "valibot";
import { googleDrive } from "../adapters/backup/google-drive";
import { GOOGLE_DRIVE_KEY, googleBackup } from "../src/google-backup";
import {
  DRIVE_FILE_SCOPE,
  GOOGLE_OAUTH_PENDING_KEY,
  type GoogleConfig,
  readGoogleConfig,
  STATE_TTL,
} from "../src/google-oauth";
import type { Db } from "../src/ports";
import { errorOf, START, type TestServer, testServer } from "./api-helpers";
import { backupName } from "./daily-helpers";
import { type FakeGoogle, fakeGoogle, GOOGLE_ENV, REFRESH_TOKEN } from "./google-helpers";

const SETTINGS = "https://budgee.example.com/#/settings";
const CALLBACK = "https://budgee.example.com/api/v1/backups/google/callback";

let s: TestServer;
let google: FakeGoogle;
afterEach(() => s.close());

const configOf = async (env: Record<string, string> = GOOGLE_ENV) => {
  const config = await readGoogleConfig(env);
  if (!config) throw new Error("test Google config is incomplete");
  return config;
};

/** A server with Google configured (unless `config` is null), over a fresh fake Google. */
async function googleServer(config: GoogleConfig | null = null) {
  google = fakeGoogle();
  const provider = (db: Db) =>
    googleBackup({
      db,
      google: config,
      drive: (g, refreshToken) =>
        googleDrive({ credentials: g, refreshToken, fetch: google.fetch }),
    });
  s = await testServer(config ? { google: config } : {}, { provider, fetch: google.fetch });
  return s.setup();
}

const status = async (token: string): Promise<BackupStatusResponse> => {
  const res = await s.call("GET", "/backups/status", { token });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(REFRESH_TOKEN);
  expect(text).not.toContain("ya29");
  return v.parse(backupStatusResponseSchema, JSON.parse(text));
};

const backUpNow = async (token: string) => {
  const res = await s.call("POST", "/backups/run", { token });
  expect(res.status).toBe(200);
  return v.parse(backupRunResponseSchema, await res.json());
};

/** Starts connecting; returns the consent URL Google would show. */
const connect = async (token: string) => {
  const res = await s.call("GET", "/backups/google/connect", { token });
  expect(res.status).toBe(200);
  return new URL(v.parse(googleConnectResponseSchema, await res.json()).url);
};

/** Google sending the browser back: `query` as the callback's query string. */
const callback = (query: Record<string, string>) =>
  s.call("GET", `/backups/google/callback?${new URLSearchParams(query)}`);

/** Where the callback sent the browser. */
const redirected = (res: Response) => {
  expect(res.status).toBe(302);
  return res.headers.get("Location");
};

/** The consent page approved: Google hands out `code` and redirects back with it. */
async function approve(token: string, answer: Record<string, string> = {}) {
  const state = (await connect(token)).searchParams.get("state") ?? "";
  const code = `code-${crypto.randomUUID()}`;
  google.codes.set(code, { refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE, ...answer });
  return callback({ code, state, scope: DRIVE_FILE_SCOPE });
}

/** The live OAuth flow's stored nonce, null when none is pending. */
const pendingState = async () =>
  (
    await s.db.query<{ value: string }>("SELECT value FROM config WHERE key = ?", [
      GOOGLE_OAUTH_PENDING_KEY,
    ])
  )[0]?.value ?? null;

const storedConnection = async () =>
  (
    await s.db.query<{ value: string }>("SELECT value FROM config WHERE key = ?", [
      GOOGLE_DRIVE_KEY,
    ])
  )[0]?.value ?? null;

describe("Google Drive not configured", () => {
  test("the endpoints answer not_configured and the status says so", async () => {
    const token = await googleServer(null);
    for (const [method, path, auth] of [
      ["GET", "/backups/google/connect", token],
      ["POST", "/backups/google/disconnect", token],
      ["GET", "/backups/google/callback?code=x&state=y", undefined],
    ] as const) {
      const res = await s.call(method, path, auth ? { token: auth } : {});
      expect(res.status).toBe(503);
      const error = await errorOf(res);
      expect(error.code).toBe("not_configured");
      expect(error.message).toContain("GOOGLE_CLIENT_ID");
    }
    expect((await status(token)).destination).toEqual({
      kind: "google-drive",
      configured: false,
      connected: false,
      reconnectNeeded: false,
    });
    expect(await backUpNow(token)).toMatchObject({ status: "not_configured" });
    expect(google.calls).toEqual([]);
  });
});

describe("connecting Google Drive", () => {
  test("connect and disconnect need a device token; the callback does not", async () => {
    await googleServer(await configOf());
    for (const [method, path] of [
      ["GET", "/backups/google/connect"],
      ["POST", "/backups/google/disconnect"],
    ] as const) {
      expect((await s.call(method, path)).status).toBe(401);
    }
    expect(redirected(await callback({ code: "x", state: "y" }))).toBe(
      `${SETTINGS}?drive=error&reason=invalid_state`,
    );
  });

  test("connect answers the consent URL; the callback stores the token sealed and backups go to Drive", async () => {
    const token = await googleServer(await configOf());
    expect((await status(token)).destination).toEqual({
      kind: "google-drive",
      configured: true,
      connected: false,
      reconnectNeeded: false,
    });

    const consent = await connect(token);
    expect(consent.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(consent.searchParams.get("access_type")).toBe("offline");
    expect(consent.searchParams.get("prompt")).toBe("consent");

    const res = await approve(token);
    expect(redirected(res)).toBe(`${SETTINGS}?drive=connected`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const exchange = google.tokenCalls()[0];
    expect(exchange?.method).toBe("POST");

    const stored = await storedConnection();
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(REFRESH_TOKEN);
    expect(JSON.parse(stored ?? "")).toEqual({
      refreshToken: expect.any(String),
      connectedAt: START,
      reconnectNeeded: false,
    });

    expect((await status(token)).destination).toEqual({
      kind: "google-drive",
      configured: true,
      connected: true,
      reconnectNeeded: false,
    });
    const run = await backUpNow(token);
    expect(run).toMatchObject({ status: "ok", file: backupName(0, START) });
    expect(google.named(backupName(0, START))).toHaveLength(1);
    expect((await status(token)).files).toEqual([backupName(0, START)]);
  });

  test("a failed callback stores nothing and sends Settings the reason", async () => {
    const token = await googleServer(await configOf());
    const state = async () => (await connect(token)).searchParams.get("state") ?? "";
    const reason = async (res: Response) =>
      new URLSearchParams(redirected(res)?.split("?")[1]).get("reason");

    expect(await reason(await callback({ code: "x", state: "nonsense" }))).toBe("invalid_state");
    expect(await reason(await callback({ error: "access_denied", state: await state() }))).toBe(
      "denied",
    );
    expect(await reason(await callback({ error: "server_error", state: await state() }))).toBe(
      "google_error",
    );
    expect(await reason(await callback({ state: await state() }))).toBe("google_error");
    expect(await reason(await callback({ code: "unknown", state: await state() }))).toBe(
      "exchange_failed",
    );
    expect(await reason(await approve(token, { refresh_token: "" }))).toBe("no_refresh_token");
    expect(await reason(await approve(token, { scope: "openid email" }))).toBe("missing_scope");

    const late = await state();
    s.advance(STATE_TTL + 1);
    expect(await reason(await callback({ code: "x", state: late }))).toBe("expired");

    expect(await storedConnection()).toBeNull();
  });

  test("a state works once: a replayed callback is refused before Google is asked", async () => {
    const token = await googleServer(await configOf());
    const state = (await connect(token)).searchParams.get("state") ?? "";
    google.codes.set("first", { refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE });
    expect(redirected(await callback({ code: "first", state }))).toBe(
      `${SETTINGS}?drive=connected`,
    );
    expect(await pendingState()).toBeNull();

    await s.call("POST", "/backups/google/disconnect", { token });
    google.codes.set("second", { refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE });
    const calls = google.tokenCalls().length;
    expect(redirected(await callback({ code: "second", state }))).toBe(
      `${SETTINGS}?drive=error&reason=invalid_state`,
    );
    expect(google.tokenCalls()).toHaveLength(calls);
    expect(await storedConnection()).toBeNull();
  });

  test("only the latest flow is live: starting again retires the earlier state", async () => {
    const token = await googleServer(await configOf());
    const first = (await connect(token)).searchParams.get("state") ?? "";
    const second = (await connect(token)).searchParams.get("state") ?? "";
    google.codes.set("a", { refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE });
    google.codes.set("b", { refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE });
    expect(redirected(await callback({ code: "a", state: first }))).toBe(
      `${SETTINGS}?drive=error&reason=invalid_state`,
    );
    // The refused one did not use up the live state.
    expect(redirected(await callback({ code: "b", state: second }))).toBe(
      `${SETTINGS}?drive=connected`,
    );
  });

  test("a declined consent uses the state up too", async () => {
    const token = await googleServer(await configOf());
    const state = (await connect(token)).searchParams.get("state") ?? "";
    expect(redirected(await callback({ error: "access_denied", state }))).toBe(
      `${SETTINGS}?drive=error&reason=denied`,
    );
    expect(await pendingState()).toBeNull();
    google.codes.set("c", { refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE });
    expect(redirected(await callback({ code: "c", state }))).toBe(
      `${SETTINGS}?drive=error&reason=invalid_state`,
    );
  });

  test("the state names the device: a device revoked meanwhile cannot finish", async () => {
    const token = await googleServer(await configOf());
    const state = (await connect(token)).searchParams.get("state") ?? "";
    await s.db.run("UPDATE devices SET revoked = 1");
    google.codes.set("c", { refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE });
    expect(redirected(await callback({ code: "c", state }))).toBe(
      `${SETTINGS}?drive=error&reason=invalid_state`,
    );
    expect(google.tokenCalls()).toEqual([]);
    expect(await storedConnection()).toBeNull();
  });

  test("a revoked refresh token marks the connection for reconnecting until connected again", async () => {
    const token = await googleServer(await configOf());
    await approve(token);
    google.revokeRefreshToken();

    const run = await backUpNow(token);
    expect(run).toMatchObject({ status: "error", error: expect.stringMatching(/reconnect/i) });
    const broken = await status(token);
    expect(broken.destination).toEqual({
      kind: "google-drive",
      configured: true,
      connected: true,
      reconnectNeeded: true,
    });
    expect(broken.filesError).toMatch(/reconnect/i);
    expect(broken.filesErrorCode).toBe("reconnect");
    expect(broken.lastRun?.errorCode).toBe("reconnect");

    // Known broken: no more calls to Google until the user connects again.
    const calls = google.calls.length;
    await status(token);
    expect(await backUpNow(token)).toMatchObject({ status: "error" });
    expect(google.calls.length).toBe(calls);

    expect(redirected(await approve(token))).toBe(`${SETTINGS}?drive=connected`);
    expect((await status(token)).destination.reconnectNeeded).toBe(false);
    expect(await backUpNow(token)).toMatchObject({ status: "ok" });
  });

  test("disconnect forgets the connection and revokes the token at Google", async () => {
    const token = await googleServer(await configOf());
    await approve(token);
    const res = await s.call("POST", "/backups/google/disconnect", { token });
    expect(res.status).toBe(204);
    expect(google.revoked).toEqual([REFRESH_TOKEN]);
    expect(await storedConnection()).toBeNull();
    expect((await status(token)).destination.connected).toBe(false);
    expect(await backUpNow(token)).toMatchObject({ status: "not_configured" });

    // Disconnecting again is harmless.
    expect((await s.call("POST", "/backups/google/disconnect", { token })).status).toBe(204);
    expect(google.revoked).toEqual([REFRESH_TOKEN]);
  });

  test("a connection sealed with another CONFIG_KEY needs reconnecting", async () => {
    const token = await googleServer(await configOf());
    await approve(token);
    const other = await configOf({
      ...GOOGLE_ENV,
      CONFIG_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
    });
    const provider = googleBackup({
      db: s.db,
      google: other,
      drive: () => {
        throw new Error("unused");
      },
    });

    const error = await provider.open().catch((e: unknown) => e);
    expect((error as Error).name).toBe("ReconnectNeededError");
    expect((error as Error).message).toContain("CONFIG_KEY");
    expect((await provider.status()).reconnectNeeded).toBe(true);
    expect((await status(token)).destination.reconnectNeeded).toBe(true);
  });
});
