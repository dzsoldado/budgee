// Google OAuth for Drive backups, platform-free: the settings read from the environment, the
// consent URL with a signed `state`, and the token endpoint calls the callback and disconnect
// make. Every Google call goes through an injected fetch.
import { API_BASE, fromBase64Url, toBase64Url } from "@budgee/core";
import * as v from "valibot";
import {
  type ConfigKeys,
  deriveConfigKeys,
  parseConfigKey,
  signText,
  verifyText,
} from "./config-key";
import type { Fetch } from "./ports";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** BackupDestination kind of Google Drive. */
export const GOOGLE_DRIVE_KIND = "google-drive";

/** Only the files and folders this app creates. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Where Google sends the browser back to; register it in the Google Cloud console. */
export const CALLBACK_PATH = "/backups/google/callback";

/** How long a consent page may stay open. */
export const STATE_TTL = 10 * 60 * 1000;

/**
 * `config` key of the nonce of the one connect flow that may finish: each /connect replaces it
 * and the callback deletes it, so a state works once and only the latest flow is live.
 */
export const GOOGLE_OAUTH_PENDING_KEY = "google_oauth_pending";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** PUBLIC_ORIGIN, e.g. `https://budgee.example.com`. */
  publicOrigin: string;
  keys: ConfigKeys;
}

/** The message of every Google endpoint while GoogleConfig is missing. */
export const NOT_CONFIGURED_MESSAGE =
  "Google Drive backups are not set up on this server: set GOOGLE_CLIENT_ID, " +
  "GOOGLE_CLIENT_SECRET, CONFIG_KEY (32 bytes, base64) and PUBLIC_ORIGIN";

/** The environment variables Google Drive backups need. */
export interface GoogleEnv {
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  CONFIG_KEY?: string | undefined;
  PUBLIC_ORIGIN?: string | undefined;
}

function originOf(text: string): string | null {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * GoogleConfig from GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CONFIG_KEY and PUBLIC_ORIGIN; null
 * when one is missing (empty counts as missing) or CONFIG_KEY / PUBLIC_ORIGIN is malformed.
 */
export async function readGoogleConfig(env: GoogleEnv): Promise<GoogleConfig | null> {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = env;
  const rawKey = env.CONFIG_KEY ? parseConfigKey(env.CONFIG_KEY) : null;
  const publicOrigin = env.PUBLIC_ORIGIN ? originOf(env.PUBLIC_ORIGIN) : null;
  if (!clientId || !clientSecret || !rawKey || !publicOrigin) return null;
  return { clientId, clientSecret, publicOrigin, keys: await deriveConfigKeys(rawKey) };
}

export const redirectUri = (google: GoogleConfig) =>
  `${google.publicOrigin}${API_BASE}${CALLBACK_PATH}`;

/** Asks for drive.file with a refresh token: offline access, and consent every time. */
export function consentUrl(google: GoogleConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: redirectUri(google),
    response_type: "code",
    scope: DRIVE_FILE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

// ─── state ──────────────────────────────────────────────────────────────────

const statePayloadSchema = v.strictObject({
  /** Nonce. */
  n: v.string(),
  /** Expiry, ms since the epoch. */
  e: v.number(),
  /** The device that started the flow. */
  d: v.string(),
});

/**
 * `<payload>.<HMAC>`, both base64url: a fresh nonce, the expiry (STATE_TTL from `now`) and the
 * device id. The callback has no device token, so this signature is what authorises it; the
 * nonce is stored as the pending flow (GOOGLE_OAUTH_PENDING_KEY) so the state works once.
 */
export async function createState(
  keys: ConfigKeys,
  deviceId: string,
  now: number,
): Promise<{ state: string; nonce: string }> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ n: nonce, e: now + STATE_TTL, d: deviceId })),
  );
  return { state: `${payload}.${await signText(keys.sign, payload)}`, nonce };
}

export type StateCheck =
  | { ok: true; deviceId: string; nonce: string }
  | { ok: false; reason: "invalid_state" | "expired" };

export async function verifyState(
  keys: ConfigKeys,
  state: string,
  now: number,
): Promise<StateCheck> {
  const invalid = { ok: false, reason: "invalid_state" } as const;
  const parts = state.split(".");
  if (parts.length !== 2) return invalid;
  const [payload, signature] = parts as [string, string];
  if (!(await verifyText(keys.sign, payload, signature))) return invalid;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return invalid;
  }
  const parsed = v.safeParse(statePayloadSchema, data);
  if (!parsed.success) return invalid;
  if (now > parsed.output.e) return { ok: false, reason: "expired" };
  return { ok: true, deviceId: parsed.output.d, nonce: parsed.output.n };
}

// ─── token endpoint ─────────────────────────────────────────────────────────

/** Why connecting failed; the app's Settings gets it as `?drive=error&reason=<code>`. */
export type ConnectFailure =
  | "invalid_state"
  | "expired"
  | "denied"
  | "google_error"
  | "exchange_failed"
  | "no_refresh_token"
  | "missing_scope";

export class ConnectError extends Error {
  override name = "ConnectError";
  readonly reason: ConnectFailure;

  constructor(reason: ConnectFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

const tokenResponseSchema = v.object({
  refresh_token: v.optional(v.string()),
  scope: v.optional(v.string()),
});

/**
 * Trades the callback's code for a refresh token. Throws ConnectError when Google refuses, sends
 * no refresh token, or the user left the Drive scope unticked. Messages never carry a token.
 */
export async function exchangeCode(
  fetch: Fetch,
  google: GoogleConfig,
  code: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: redirectUri(google),
        grant_type: "authorization_code",
      }),
    });
  } catch {
    throw new ConnectError("exchange_failed", "Could not reach Google to finish connecting");
  }
  const data: unknown = await res.json().catch(() => null);
  const parsed = v.safeParse(tokenResponseSchema, data);
  if (!res.ok || !parsed.success) {
    throw new ConnectError("exchange_failed", `Google refused the sign-in (HTTP ${res.status})`);
  }
  const { refresh_token: refreshToken, scope = "" } = parsed.output;
  if (!scope.split(" ").includes(DRIVE_FILE_SCOPE)) {
    throw new ConnectError("missing_scope", "Google Drive access was not granted");
  }
  if (!refreshToken) throw new ConnectError("no_refresh_token", "Google sent no refresh token");
  return refreshToken;
}

/** Revokes the token at Google; best effort, so failures are ignored. */
export async function revokeToken(fetch: Fetch, token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // The connection is gone on our side either way.
  }
}
