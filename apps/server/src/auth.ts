import type { MiddlewareHandler } from "hono";
import { ApiError } from "./http";
import type { Clock, Db } from "./ports";
import { sha256Hex } from "./tokens";

/** Hono env of authenticated routes: the id of the calling device. */
export interface AuthEnv {
  Variables: { deviceId: string };
}

// last_seen is written at most this often per device, to keep database writes down.
const LAST_SEEN_RESOLUTION = 60 * 1000;

/**
 * `Authorization: Bearer <device token>`, the scheme name in any case: rejects unknown and
 * revoked tokens, notes last_seen.
 */
export function requireDevice(db: Db, clock: Clock): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const [device] = token
      ? await db.query<{ id: string; revoked: number }>(
          "SELECT id, revoked FROM devices WHERE token_hash = ?",
          [await sha256Hex(token)],
        )
      : [];
    if (!device) throw new ApiError(401, "unauthorized", "Missing or invalid device token");
    if (device.revoked) throw new ApiError(401, "device_revoked", "This device has been revoked");

    const now = clock.now();
    await db.run(
      "UPDATE devices SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen <= ?)",
      [now, device.id, now - LAST_SEEN_RESOLUTION],
    );
    c.set("deviceId", device.id);
    await next();
  };
}
