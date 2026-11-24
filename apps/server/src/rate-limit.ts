// Per-IP limit on the endpoints that take a guessable secret without a device token: /setup
// (until the first device) and /devices/pair (one-time codes). Middleware on those routes, so it
// sees every spelling Hono routes there (percent-encoded, dot segments). The Bun entry gives it
// memoryLimiter and the client IP (the socket's, or a trusted proxy's X-Forwarded-For).
import type { Context, MiddlewareHandler } from "hono";
import { errorResponse } from "./http";

/** Counts attempts per key (the client IP) and says whether one more is allowed. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The IP of the client that sent the request, or undefined when it is not known. */
export type ClientIp = (c: Context) => string | undefined;

/**
 * `limit` calls per key in a fixed window of `windowMs` from the key's first call, held in this
 * process. Every call first drops the keys whose window has ended, so the map holds only the keys
 * seen in the last window.
 */
export function memoryLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter & { size(): number } {
  const { limit, windowMs, now = Date.now } = options;
  // In insertion order, which is the order the windows started: the ended ones come first.
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async limit({ key }) {
      const time = now();
      for (const [name, window] of windows) {
        if (time - window.start < windowMs) break;
        windows.delete(name);
      }
      let window = windows.get(key);
      if (!window) {
        window = { start: time, count: 0 };
        windows.set(key, window);
      }
      window.count++;
      return { success: window.count <= limit };
    },
    size: () => windows.size,
  };
}

/**
 * Answers 429 once the caller's IP is over `limiter`'s limit; a no-op without one. Without an
 * IP the request goes through with a warning: one shared bucket would lock everyone out.
 */
export function limitGuesses(
  limiter: RateLimiter | undefined,
  clientIp: ClientIp | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    if (!limiter) return next();
    let ip: string | undefined;
    try {
      ip = clientIp?.(c);
    } catch (error) {
      console.error("Client IP lookup failed", error);
    }
    if (!ip) {
      console.warn("Rate limit skipped: the client IP is not known");
      return next();
    }
    let allowed: boolean;
    try {
      allowed = (await limiter.limit({ key: ip })).success;
    } catch (error) {
      // A limiter failure must not lock the owner out; the secrets are long and short-lived.
      console.error("Rate limiter failed", error);
      allowed = true;
    }
    if (allowed) return next();
    c.header("Retry-After", "60");
    return errorResponse(c, 429, "rate_limited", "Too many attempts. Try again in a minute.");
  };
}
