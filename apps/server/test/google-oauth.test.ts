import { describe, expect, test } from "bun:test";
import { toBase64, toBase64Url } from "@budgee/core";
import { signText } from "../src/config-key";
import {
  consentUrl,
  createState,
  DRIVE_FILE_SCOPE,
  readGoogleConfig,
  redirectUri,
  STATE_TTL,
  verifyState,
} from "../src/google-oauth";
import { GOOGLE_ENV } from "./google-helpers";

describe("readGoogleConfig", () => {
  test("needs the client id and secret, a 32-byte CONFIG_KEY and PUBLIC_ORIGIN", async () => {
    const google = await readGoogleConfig(GOOGLE_ENV);
    expect(google).toMatchObject({
      clientId: GOOGLE_ENV.GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_ENV.GOOGLE_CLIENT_SECRET,
      publicOrigin: "https://budgee.example.com",
    });
    for (const name of Object.keys(GOOGLE_ENV)) {
      expect(await readGoogleConfig({ ...GOOGLE_ENV, [name]: "" })).toBeNull();
      expect(await readGoogleConfig({ ...GOOGLE_ENV, [name]: undefined })).toBeNull();
    }
    expect(
      await readGoogleConfig({ ...GOOGLE_ENV, CONFIG_KEY: toBase64(new Uint8Array(16)) }),
    ).toBeNull();
    expect(
      await readGoogleConfig({ ...GOOGLE_ENV, PUBLIC_ORIGIN: "budgee.example.com" }),
    ).toBeNull();
    expect(
      await readGoogleConfig({ ...GOOGLE_ENV, PUBLIC_ORIGIN: "ftp://budgee.example.com" }),
    ).toBeNull();
  });

  test("PUBLIC_ORIGIN is reduced to its origin (a trailing slash is harmless)", async () => {
    const google = await readGoogleConfig({
      ...GOOGLE_ENV,
      PUBLIC_ORIGIN: "http://localhost:5173/",
    });
    expect(google?.publicOrigin).toBe("http://localhost:5173");
    expect(google && redirectUri(google)).toBe(
      "http://localhost:5173/api/v1/backups/google/callback",
    );
  });
});

describe("OAuth state and consent URL", () => {
  const NOW = 1_763_337_600_000;

  test("the consent URL asks for drive.file offline, with consent, back to the callback", async () => {
    const google = await readGoogleConfig(GOOGLE_ENV);
    if (!google) throw new Error("config");
    const url = new URL(consentUrl(google, "the-state"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: GOOGLE_ENV.GOOGLE_CLIENT_ID,
      redirect_uri: "https://budgee.example.com/api/v1/backups/google/callback",
      response_type: "code",
      scope: DRIVE_FILE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state: "the-state",
    });
    expect(DRIVE_FILE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
  });

  test("a state verifies for 10 minutes and names the device", async () => {
    const google = await readGoogleConfig(GOOGLE_ENV);
    if (!google) throw new Error("config");
    expect(STATE_TTL).toBe(10 * 60 * 1000);
    const { state, nonce } = await createState(google.keys, "device-1", NOW);
    expect((await createState(google.keys, "device-1", NOW)).nonce).not.toBe(nonce); // fresh
    expect(nonce.length).toBeGreaterThanOrEqual(20);
    const verified = await verifyState(google.keys, state, NOW);
    expect(verified).toEqual({ ok: true, deviceId: "device-1", nonce });
    expect(await verifyState(google.keys, state, NOW + STATE_TTL)).toEqual(verified);
    expect(await verifyState(google.keys, state, NOW + STATE_TTL + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("a state signed with another key, altered or malformed is invalid", async () => {
    const google = await readGoogleConfig(GOOGLE_ENV);
    const other = await readGoogleConfig({
      ...GOOGLE_ENV,
      CONFIG_KEY: toBase64(new Uint8Array(32).fill(1)),
    });
    if (!google || !other) throw new Error("config");
    const { state } = await createState(google.keys, "device-1", NOW);
    const [payload, signature] = state.split(".") as [string, string];
    const forged = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ n: "x", e: NOW + 1e9, d: "device-2" })),
    );
    const invalid = { ok: false, reason: "invalid_state" } as const;

    expect(await verifyState(other.keys, state, NOW)).toEqual(invalid);
    expect(await verifyState(google.keys, `${forged}.${signature}`, NOW)).toEqual(invalid);
    expect(await verifyState(google.keys, payload, NOW)).toEqual(invalid);
    expect(await verifyState(google.keys, "", NOW)).toEqual(invalid);
    expect(await verifyState(google.keys, "a.b.c", NOW)).toEqual(invalid);
    // Correctly signed, but not a state payload.
    const junk = toBase64Url(new TextEncoder().encode('{"d":1}'));
    expect(
      await verifyState(google.keys, `${junk}.${await signText(google.keys.sign, junk)}`, NOW),
    ).toEqual(invalid);
  });
});
