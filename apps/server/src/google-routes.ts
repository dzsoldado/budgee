// Settings → Connect Google Drive: the OAuth flow runs through the server, which keeps the
// refresh token. The app opens the consent URL from /connect; Google sends the browser back to
// /callback, which answers with a redirect to the app's Settings.
import type { GoogleConnectResponse } from "@budgee/core";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "./app";
import type { AuthEnv } from "./auth";
import { SecretError } from "./config-key";
import {
  deleteConnection,
  openRefreshToken,
  readConnection,
  saveConnection,
} from "./google-backup";
import {
  CALLBACK_PATH,
  ConnectError,
  type ConnectFailure,
  consentUrl,
  createState,
  exchangeCode,
  GOOGLE_OAUTH_PENDING_KEY,
  NOT_CONFIGURED_MESSAGE,
  revokeToken,
  verifyState,
} from "./google-oauth";
import { ApiError } from "./http";
import { writeConfigJson } from "./init";

export function googleRoutes(
  api: Hono<AuthEnv>,
  { db, clock, config, fetch }: AppDeps,
  auth: MiddlewareHandler<AuthEnv>,
) {
  const requireGoogle = () => {
    if (!config.google) throw new ApiError(503, "not_configured", NOT_CONFIGURED_MESSAGE);
    return config.google;
  };

  api.get("/backups/google/connect", auth, async (c) => {
    const google = requireGoogle();
    const { state, nonce } = await createState(google.keys, c.get("deviceId"), clock.now());
    // Replaces any earlier flow's nonce: only the latest consent page can finish.
    await writeConfigJson(db, GOOGLE_OAUTH_PENDING_KEY, { nonce });
    return c.json<GoogleConnectResponse>({ url: consentUrl(google, state) });
  });

  /** Deletes the pending flow if it is `nonce`'s; true when it was, so a state works once. */
  const takePending = async (nonce: string) =>
    (
      await db.run("DELETE FROM config WHERE key = ? AND json_extract(value, '$.nonce') = ?", [
        GOOGLE_OAUTH_PENDING_KEY,
        nonce,
      ])
    ).changes === 1;

  // A browser redirect from Google, without the device token: the signed state authorises it.
  api.get(CALLBACK_PATH, async (c) => {
    const google = requireGoogle();
    // The URL holds the authorisation code: keep it out of caches and Referer headers.
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const back = (query: string) => c.redirect(`${google.publicOrigin}/#/settings?${query}`, 302);
    const fail = (reason: ConnectFailure) => back(`drive=error&reason=${reason}`);

    const state = await verifyState(google.keys, c.req.query("state") ?? "", clock.now());
    if (!state.ok) return fail(state.reason);
    // Used up whatever happens next, a declined consent included.
    if (!(await takePending(state.nonce))) return fail("invalid_state");
    const [device] = await db.query<{ revoked: number }>(
      "SELECT revoked FROM devices WHERE id = ?",
      [state.deviceId],
    );
    if (!device || device.revoked) return fail("invalid_state");

    const error = c.req.query("error");
    if (error) return fail(error === "access_denied" ? "denied" : "google_error");
    const code = c.req.query("code");
    if (!code) return fail("google_error");
    try {
      const refreshToken = await exchangeCode(fetch, google, code);
      await saveConnection(db, google, refreshToken, clock.now());
    } catch (failure) {
      if (failure instanceof ConnectError) return fail(failure.reason);
      throw failure;
    }
    return back("drive=connected");
  });

  api.post("/backups/google/disconnect", auth, async (c) => {
    const google = requireGoogle();
    const connection = await readConnection(db);
    await deleteConnection(db);
    if (connection) {
      try {
        await revokeToken(fetch, await openRefreshToken(google, connection));
      } catch (error) {
        // Sealed with another CONFIG_KEY: nothing to revoke with.
        if (!(error instanceof SecretError)) throw error;
      }
    }
    return c.body(null, 204);
  });
}
