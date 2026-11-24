import { afterEach, describe, expect, test } from "bun:test";
import {
  type BackupStatusResponse,
  backupRunResponseSchema,
  backupStatusResponseSchema,
  parseBackup,
} from "@budgee/core";
import * as v from "valibot";
import { memoryBackup } from "../adapters/backup/memory";
import { CRON_SECRET_HEADER } from "../src/app";
import { TOMBSTONE_MAX_AGE } from "../src/cleanup";
import { nextDailyRun } from "../src/daily";
import type { BackupDestination } from "../src/ports";
import {
  errorOf,
  liveEnvelope,
  START,
  type TestServer,
  testServer,
  tombstoneEnvelope,
  uuid,
} from "./api-helpers";
import { backupName, SECRET } from "./daily-helpers";

let s: TestServer;
afterEach(() => s.close());

const status = async (token: string): Promise<BackupStatusResponse> => {
  const res = await s.call("GET", "/backups/status", { token });
  expect(res.status).toBe(200);
  return v.parse(backupStatusResponseSchema, await res.json());
};

const backUpNow = async (token: string) => {
  const res = await s.call("POST", "/backups/run", { token });
  expect(res.status).toBe(200);
  return v.parse(backupRunResponseSchema, await res.json());
};

/** `budgee-YYYY-MM-DD.jsonl.gz` of the test server's start day. */
const TODAY_FILE = backupName(0, START);

describe("backups API", () => {
  test("both endpoints need a device token", async () => {
    s = await testServer();
    for (const [method, path] of [
      ["GET", "/backups/status"],
      ["POST", "/backups/run"],
    ] as const) {
      const res = await s.call(method, path);
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe("unauthorized");
    }
  });

  test("with no destination: not configured, and back up now says so", async () => {
    s = await testServer();
    const token = await s.setup();
    expect(await status(token)).toEqual({
      destination: { kind: null, configured: false, connected: false, reconnectNeeded: false },
      lastRun: null,
      lastCleanup: null,
      files: [],
      filesError: null,
      filesErrorCode: null,
      nextRunAt: nextDailyRun(START),
    });

    const run = await backUpNow(token);
    expect(run).toEqual({
      at: START,
      status: "not_configured",
      error: null,
      file: null,
      envelopes: null,
      durationMs: 0,
      errorCode: null,
      retentionError: null,
      retentionErrorCode: null,
    });
    expect((await status(token)).lastRun).toEqual(run);
  });

  test("back up now writes today's file and shows in the status, newest file first", async () => {
    const backup = memoryBackup([backupName(2, START), backupName(1, START), "readme.txt"]);
    s = await testServer({}, { backup });
    const token = await s.setup();
    const [a, b] = [uuid(), uuid()];
    const push = await s.call("POST", "/sync/push", {
      token,
      body: { envelopes: [liveEnvelope(a, 1), tombstoneEnvelope(b, 1)] },
    });
    expect(push.status).toBe(200);

    const run = await backUpNow(token);
    expect(run).toMatchObject({ status: "ok", file: TODAY_FILE, envelopes: 2 });
    const file = backup.files.get(TODAY_FILE);
    expect(file && (await parseBackup(file)).map((r) => r.id)).toEqual([a, b]);

    expect(await status(token)).toEqual({
      destination: { kind: "memory", configured: true, connected: true, reconnectNeeded: false },
      lastRun: run,
      lastCleanup: null,
      files: ["readme.txt", TODAY_FILE, backupName(1, START), backupName(2, START)],
      filesError: null,
      filesErrorCode: null,
      nextRunAt: nextDailyRun(START),
    });
  });

  test("back up now does not run the cleanup", async () => {
    s = await testServer({}, { backup: memoryBackup() });
    const token = await s.setup();
    await s.call("POST", "/sync/push", {
      token,
      body: { envelopes: [tombstoneEnvelope(uuid(), 1)] },
    });
    await s.call("GET", "/sync/pull?since=1", { token });
    s.advance(TOMBSTONE_MAX_AGE + 1);

    await backUpNow(token);
    expect(await s.db.query("SELECT id FROM envelopes")).toHaveLength(1);
    expect((await status(token)).lastCleanup).toBeNull();
  });

  test("a failing destination is reported in the status and the run, never as a 500", async () => {
    const broken: BackupDestination = {
      kind: "memory",
      put: () => Promise.reject(new Error(`token ${SECRET} expired`)),
      list: () => Promise.reject(new Error(`token ${SECRET} expired`)),
      remove: () => Promise.reject(new Error("nope")),
    };
    s = await testServer({}, { backup: broken });
    const token = await s.setup();

    const run = await backUpNow(token);
    expect(run).toMatchObject({ status: "error", error: expect.stringContaining("expired") });
    const current = await status(token);
    expect(current).toMatchObject({
      destination: { kind: "memory", configured: true, connected: true },
      lastRun: run,
      files: [],
      filesError: expect.stringContaining("expired"),
      filesErrorCode: "other",
    });
    expect(JSON.stringify(current)).not.toContain(SECRET.slice(5));
  });

  test("run-daily backs up and cleans up; the status shows both", async () => {
    const backup = memoryBackup();
    s = await testServer({ cronSecret: "cron" }, { backup });
    const token = await s.setup();
    const res = await s.call("POST", "/admin/run-daily", {
      headers: { [CRON_SECRET_HEADER]: "cron" },
    });
    expect(res.status).toBe(204);

    const current = await status(token);
    expect(current.lastRun).toMatchObject({ status: "ok", file: TODAY_FILE });
    expect(current.lastCleanup).toMatchObject({ ok: true, purged: 0 });
    expect(current.files).toEqual([TODAY_FILE]);
  });
});
