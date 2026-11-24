// An in-process server over an in-memory bun:sqlite database, with a clock the test moves.
import { Database } from "bun:sqlite";
import { type Envelope, formatHlc } from "@budgee/core";
import { bunSqliteDb } from "../adapters/db/bun-sqlite";
import { migrations } from "../migrations";
import { type AppDeps, createApp } from "../src/app";
import { staticBackup } from "../src/backup";
import { runDaily } from "../src/daily";
import { initDatabase } from "../src/init";
import type { BackupDestination, BackupProvider, Config, Db, Fetch } from "../src/ports";
import type { ClientIp, RateLimiter } from "../src/rate-limit";

export const SETUP_SECRET = "correct horse battery staple";
export const START = 1_763_337_600_000;

export interface CallOptions {
  token?: string;
  /** Sent as JSON unless it is already a string. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface TestServerOptions {
  /** Defaults to the real daily run over this server's database, clock and destination. */
  runDaily?: AppDeps["runDaily"];
  /** A destination that is always connected; defaults to none (not configured). */
  backup?: BackupDestination | null;
  /** Instead of `backup`: the provider, built over this server's database. */
  provider?: (db: Db) => BackupProvider;
  /** Outbound HTTP; by default any call fails the test. */
  fetch?: Fetch;
  /** The per-IP limit on setup and pairing; none by default. */
  limiter?: RateLimiter;
  /** How the limit finds the client's IP; none by default. */
  clientIp?: ClientIp;
}

const noNetwork: Fetch = (url) => Promise.reject(new Error(`unexpected request to ${url}`));

export async function testServer(config: Partial<Config> = {}, options: TestServerOptions = {}) {
  const database = new Database(":memory:");
  const db = bunSqliteDb(database);
  const { serverId } = await initDatabase(db, migrations);
  let now = START;
  const clock = { now: () => now };
  const backup = options.provider?.(db) ?? staticBackup(options.backup ?? null);
  const app = createApp({
    db,
    clock,
    config: { serverId, setupSecret: SETUP_SECRET, ...config },
    backup,
    fetch: options.fetch ?? noNetwork,
    runDaily: options.runDaily ?? (() => runDaily({ db, clock, backup })),
    limiter: options.limiter,
    clientIp: options.clientIp,
  });

  const call = (method: string, path: string, options: CallOptions = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }
    return app.request(`/api/v1${path}`, { method, headers, ...(body ? { body } : {}) });
  };

  const tokenFrom = async (res: Response) => {
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { token: string }).token;
  };

  /** Claims the server; returns the first device's token. */
  const setup = async (deviceName = "Phone") =>
    tokenFrom(await call("POST", "/setup", { body: { secret: SETUP_SECRET, deviceName } }));

  const invite = async (token: string) => {
    const res = await call("POST", "/devices/invite", { token });
    if (res.status !== 200) throw new Error(`invite failed: ${res.status}`);
    return (await res.json()) as { code: string; expiresAt: number };
  };

  /** Pairs a new device through an invite from `token`'s device; returns the new token. */
  const pair = async (token: string, deviceName = "Laptop") => {
    const { code } = await invite(token);
    return tokenFrom(await call("POST", "/devices/pair", { body: { code, deviceName } }));
  };

  return {
    app,
    db,
    serverId,
    call,
    setup,
    invite,
    pair,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    close: () => database.close(),
  };
}

export type TestServer = Awaited<ReturnType<typeof testServer>>;

export const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

let nextId = 0;
/** A fresh v4-shaped uuid per call, in creation order. */
export const uuid = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

export const liveEnvelope = (id: string, wall: number, blob = `b${wall}`): Envelope => ({
  table: "transactions",
  id,
  hlc: formatHlc({ wall, counter: 0, device: "phone" }),
  deleted: false,
  device: "phone",
  blob: btoa(blob),
});

export const tombstoneEnvelope = (id: string, wall: number): Envelope => ({
  table: "transactions",
  id,
  hlc: formatHlc({ wall, counter: 0, device: "phone" }),
  deleted: true,
  device: "phone",
});
