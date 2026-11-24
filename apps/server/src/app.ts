import { API_BASE, type HealthResponse } from "@budgee/core";
import { Hono } from "hono";
import pkg from "../package.json";
import { type AuthEnv, requireDevice } from "./auth";
import { backupRoutes } from "./backup-routes";
import { deviceRoutes } from "./devices";
import { googleRoutes } from "./google-routes";
import { ApiError, errorResponse, notFound } from "./http";
import type { BackupProvider, Clock, Config, Db, Fetch } from "./ports";
import type { ClientIp, RateLimiter } from "./rate-limit";
import { syncRoutes } from "./sync";
import { timingSafeEqual } from "./tokens";

/** Header carrying CRON_SECRET on POST /admin/run-daily. */
export const CRON_SECRET_HEADER = "X-Cron-Secret";

export interface AppDeps {
  db: Db;
  config: Config;
  clock: Clock;
  /** Where backups go, opened for each run. */
  backup: BackupProvider;
  /** Outbound HTTP, for the Google OAuth endpoints. */
  fetch: Fetch;
  /** The daily backup and cleanup, bound to its dependencies by the entry. */
  runDaily: () => Promise<unknown>;
  /** Per-IP limit on /setup and /devices/pair; none means no limit. */
  limiter?: RateLimiter | undefined;
  /** The client's IP, which `limiter` counts by. */
  clientIp?: ClientIp | undefined;
}

/**
 * The API under /api/v1. Unknown /api paths answer a JSON 404 here, so an entry can add static
 * files and an SPA fallback after it without shadowing API errors.
 */
export function createApp(deps: AppDeps) {
  const api = new Hono<AuthEnv>();
  const auth = requireDevice(deps.db, deps.clock);

  api.get("/health", (c) =>
    c.json<HealthResponse>({
      serverId: deps.config.serverId,
      version: pkg.version,
      serverTime: deps.clock.now(),
    }),
  );
  deviceRoutes(api, deps, auth);
  syncRoutes(api, deps, auth);
  backupRoutes(api, deps, auth);
  googleRoutes(api, deps, auth);

  // For hosts without a scheduler. The route does not exist unless CRON_SECRET is set.
  const { cronSecret } = deps.config;
  if (cronSecret) {
    api.post("/admin/run-daily", async (c) => {
      if (!(await timingSafeEqual(c.req.header(CRON_SECRET_HEADER) ?? "", cronSecret))) {
        throw new ApiError(401, "invalid_secret", `Wrong or missing ${CRON_SECRET_HEADER}`);
      }
      await deps.runDaily();
      return c.body(null, 204);
    });
  }

  const app = new Hono();
  app.route(API_BASE, api);
  app.all("/api/*", () => {
    throw notFound();
  });
  app.notFound((c) => errorResponse(c, 404, "not_found", "Not found"));
  app.onError((error, c) => {
    if (error instanceof ApiError) return errorResponse(c, error.status, error.code, error.message);
    console.error(error);
    return errorResponse(c, 500, "internal", "Internal server error");
  });
  return app;
}
