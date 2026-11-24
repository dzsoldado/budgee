import { describe, expect, test } from "bun:test";
import { BACKUP_RUN_TIMEOUT_MS, createBackupApi } from "../src/backup-api";
import { type HttpFetch, SyncError } from "../src/sync-client";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const run = {
  at: 1,
  status: "ok",
  error: null,
  file: "budgee-2026-11-17.jsonl.gz",
  envelopes: 3,
  durationMs: 5,
  retentionError: null,
};
const status = {
  destination: { kind: "google-drive", configured: true, connected: true, reconnectNeeded: false },
  lastRun: run,
  lastCleanup: null,
  files: ["budgee-2026-11-17.jsonl.gz"],
  filesError: null,
  nextRunAt: 2,
};

function capture(...responses: Response[]) {
  const calls: { url: string; init: Parameters<HttpFetch>[1] }[] = [];
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no response left");
    return next;
  };
  return { calls, fetch };
}

describe("createBackupApi", () => {
  test("status, run, connect and disconnect send the Bearer token", async () => {
    const { calls, fetch } = capture(
      json(200, status),
      json(200, run),
      json(200, { url: "https://accounts.google.com/o/oauth2/v2/auth?state=s" }),
      new Response(null, { status: 204 }),
    );
    const api = createBackupApi({ serverUrl: "https://budgee.example", token: "tok", fetch });
    // Codes an older server leaves out read as null.
    const codes = { errorCode: null, retentionErrorCode: null };
    expect(await api.status()).toEqual({
      ...status,
      lastRun: { ...run, ...codes },
      filesErrorCode: null,
    } as never);
    expect(await api.run()).toEqual({ ...run, ...codes } as never);
    expect(await api.connect()).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=s");
    expect(await api.disconnect()).toBeUndefined();
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["GET", "https://budgee.example/api/v1/backups/status"],
      ["POST", "https://budgee.example/api/v1/backups/run"],
      ["GET", "https://budgee.example/api/v1/backups/google/connect"],
      ["POST", "https://budgee.example/api/v1/backups/google/disconnect"],
    ]);
    for (const call of calls) expect(call.init.headers.Authorization).toBe("Bearer tok");
  });

  test("a backup run may take minutes; other calls keep the usual timeout", async () => {
    expect(BACKUP_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    let aborted = 0;
    const fetch: HttpFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted++;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const api = createBackupApi({
      serverUrl: "https://budgee.example",
      token: "tok",
      fetch,
      timeoutMs: 10,
      runTimeoutMs: 40,
    });
    const started = Date.now();
    await expect(api.status()).rejects.toMatchObject({ kind: "offline" });
    expect(Date.now() - started).toBeLessThan(35);
    const runStarted = Date.now();
    await expect(api.run()).rejects.toMatchObject({ kind: "offline" });
    expect(Date.now() - runStarted).toBeGreaterThanOrEqual(35);
    expect(aborted).toBe(2);
  });

  test("connect accepts only Google's https consent page: anything else is a bad response", async () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://evil",
      "http://accounts.google.com/o/oauth2/v2/auth",
      "https://evil.example/o/oauth2/v2/auth",
      "https://accounts.google.com.evil.example/",
      "https://accounts.google.com@evil.example/",
    ]) {
      const { fetch } = capture(json(200, { url }));
      const api = createBackupApi({ serverUrl: "https://budgee.example", token: "tok", fetch });
      const error = await api.connect().catch((e: unknown) => e);
      expect([url, error instanceof SyncError && error.kind]).toEqual([url, "bad_response"]);
    }
    const { fetch } = capture(
      json(200, { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }),
    );
    const api = createBackupApi({ serverUrl: "https://budgee.example", token: "tok", fetch });
    expect(await api.connect()).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1");
  });

  test("not_configured comes back as a SyncError with the server's code", async () => {
    const { fetch } = capture(
      json(503, { error: { code: "not_configured", message: "set GOOGLE_CLIENT_ID" } }),
    );
    const api = createBackupApi({ serverUrl: "https://budgee.example", token: "tok", fetch });
    const error = await api.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(error).toMatchObject({ kind: "server", code: "not_configured", status: 503 });
  });

  test("a disconnect answered with a body is a bad response", async () => {
    const { fetch } = capture(json(200, { ok: true }));
    const api = createBackupApi({ serverUrl: "https://budgee.example", token: "tok", fetch });
    await expect(api.disconnect()).rejects.toMatchObject({ kind: "bad_response" });
  });
});
