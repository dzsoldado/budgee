// The server entry (Docker image and local dev): Bun.serve over a bun:sqlite file, the built PWA
// from disk, and an in-process hourly check that starts the daily run once per UTC day.
// `bun run dev` loads .env.local; Bun also reads .env* from the working directory when started
// directly.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getConnInfo } from "hono/bun";
import { googleDrive } from "../adapters/backup/google-drive";
import { bunSqliteDb } from "../adapters/db/bun-sqlite";
import { migrations } from "../migrations";
import { createApp } from "../src/app";
import { systemClock } from "../src/clock";
import { type DailyDeps, msUntilNextCheck, runDaily, runDailyIfDue } from "../src/daily";
import { weakSetupSecretWarning } from "../src/devices";
import { googleBackup } from "../src/google-backup";
import { NOT_CONFIGURED_MESSAGE, readGoogleConfig } from "../src/google-oauth";
import { initDatabase } from "../src/init";
import type { Clock, Fetch } from "../src/ports";
import { type ClientIp, memoryLimiter } from "../src/rate-limit";
import { serveWeb, type WebFiles, webFolder } from "./static";

type Env = Record<string, string | undefined>;

const DEFAULT_WEB_DIST = join(import.meta.dir, "..", "..", "web", "dist");

/**
 * Runs `check` on every full hour (runDailyIfDue: what is due is recorded in the database, so a
 * restart neither repeats nor skips it), until the returned function is called. A check still
 * running then finishes, but no further check is scheduled.
 */
export function scheduleDaily(clock: Clock, check: () => Promise<unknown>): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const arm = () => {
    timer = setTimeout(async () => {
      try {
        await check();
      } catch (error) {
        console.error("Daily run failed", error);
      }
      if (!stopped) arm();
    }, msUntilNextCheck(clock.now()));
  };
  arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export interface ServerOptions {
  /** The web build to serve; by default the folder WEB_DIST, else apps/web/dist. */
  web?: WebFiles | undefined;
}

/** Where the server listens unless HOST says otherwise: this machine only. */
export const DEFAULT_HOST = "127.0.0.1";

/** Attempts per client IP per minute at POST /setup and /devices/pair together. */
const GUESSES_PER_MINUTE = 10;

/**
 * The client's IP for the rate limit. Behind a reverse proxy that is the only way in
 * (TRUST_PROXY), the first X-Forwarded-For entry, which the proxy sets; otherwise the socket's
 * address, so a client cannot pick its own with that header.
 */
function clientIpFor(env: Env): ClientIp {
  if (env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true") {
    return (c) => c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || undefined;
  }
  return (c) => getConnInfo(c).remote.address;
}

/**
 * Reads HOST, PORT, DATABASE_PATH, WEB_DIST, SETUP_SECRET, CRON_SECRET, TRUST_PROXY, and for
 * Google Drive GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CONFIG_KEY and PUBLIC_ORIGIN (empty means
 * unset), migrates the database and starts serving.
 */
export async function startServer(env: Env, options: ServerOptions = {}) {
  const weakSecret = weakSetupSecretWarning(env.SETUP_SECRET);
  if (weakSecret) console.warn(weakSecret);
  const databasePath = resolve(env.DATABASE_PATH || ".data/budgee.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath, { create: true });
  const db = bunSqliteDb(database);
  const { serverId } = await initDatabase(db, migrations);

  const google = await readGoogleConfig(env);
  if (!google && env.GOOGLE_CLIENT_ID) console.warn(NOT_CONFIGURED_MESSAGE);
  const send: Fetch = (url, init) => fetch(url, init);
  const backup = googleBackup({
    db,
    google,
    drive: (credentials, refreshToken) => googleDrive({ credentials, refreshToken, fetch: send }),
  });
  const dailyDeps: DailyDeps = { db, clock: systemClock, backup };
  const app = createApp({
    db,
    clock: systemClock,
    backup,
    fetch: send,
    config: {
      serverId,
      setupSecret: env.SETUP_SECRET || undefined,
      cronSecret: env.CRON_SECRET || undefined,
      google: google ?? undefined,
    },
    runDaily: () => runDaily(dailyDeps),
    limiter: memoryLimiter({ limit: GUESSES_PER_MINUTE, windowMs: 60_000 }),
    clientIp: clientIpFor(env),
  });

  serveWeb(app, options.web ?? webFolder(env.WEB_DIST || DEFAULT_WEB_DIST));

  const server = Bun.serve({
    hostname: env.HOST || DEFAULT_HOST,
    port: Number(env.PORT || 8787),
    // Bun passes the server as the second argument, which getConnInfo reads.
    fetch: app.fetch,
  });
  const stopDaily = scheduleDaily(systemClock, () => runDailyIfDue(dailyDeps));

  return {
    url: server.url,
    hostname: server.hostname,
    stop() {
      stopDaily();
      server.stop(true);
      database.close();
    },
  };
}

if (import.meta.main) {
  const { url } = await startServer(Bun.env);
  console.log(`API listening on ${url}`);
}
