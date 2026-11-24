import { afterEach, describe, expect, mock, test } from "bun:test";
import { errorResponseSchema, healthResponseSchema } from "@budgee/core";
import * as v from "valibot";
import pkg from "../package.json";
import { CRON_SECRET_HEADER } from "../src/app";
import { errorOf, START, type TestServer, testServer } from "./api-helpers";

const CRON_SECRET = "cron-secret-for-tests";

let s: TestServer;
afterEach(() => s.close());

describe("GET /health", () => {
  test("returns serverId, version and serverTime without a token", async () => {
    s = await testServer();
    const res = await s.call("GET", "/health");

    expect(res.status).toBe(200);
    expect(v.parse(healthResponseSchema, await res.json())).toEqual({
      serverId: s.serverId,
      version: pkg.version,
      serverTime: START,
    });
  });
});

describe("errors", () => {
  test("an unknown API path or method is a JSON 404", async () => {
    s = await testServer();
    for (const [method, path] of [
      ["GET", "/nope"],
      ["DELETE", "/health"],
      ["GET", "/sync/push"],
    ]) {
      const res = await s.call(method as string, path as string);
      expect(res.status).toBe(404);
      expect(v.parse(errorResponseSchema, await res.json()).error.code).toBe("not_found");
    }
    const outside = await s.app.request("/api/v2/health");
    expect(outside.status).toBe(404);
    expect((await errorOf(outside)).code).toBe("not_found");
  });

  test("an unexpected failure is a JSON 500 that reveals nothing", async () => {
    const spy = mock(console.error).mockImplementation(() => {});
    const original = console.error;
    console.error = spy;
    try {
      s = await testServer(
        { cronSecret: CRON_SECRET },
        {
          runDaily: async () => {
            throw new Error("database password is hunter2");
          },
        },
      );
      const res = await s.call("POST", "/admin/run-daily", {
        headers: { [CRON_SECRET_HEADER]: CRON_SECRET },
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: { code: "internal", message: expect.any(String) },
      });
      expect(text).not.toContain("hunter2");
      expect(spy).toHaveBeenCalled();
    } finally {
      console.error = original;
    }
  });
});

describe("POST /admin/run-daily", () => {
  test("does not exist when CRON_SECRET is not configured", async () => {
    const runDaily = mock(async () => {});
    s = await testServer({}, { runDaily });
    const res = await s.call("POST", "/admin/run-daily", {
      headers: { [CRON_SECRET_HEADER]: "anything" },
    });
    expect(res.status).toBe(404);
    expect(runDaily).not.toHaveBeenCalled();
  });

  test("refuses a missing or wrong CRON_SECRET", async () => {
    const runDaily = mock(async () => {});
    s = await testServer({ cronSecret: CRON_SECRET }, { runDaily });
    for (const headers of [
      {},
      { [CRON_SECRET_HEADER]: "" },
      { [CRON_SECRET_HEADER]: "wrong" },
      { [CRON_SECRET_HEADER]: `${CRON_SECRET}x` },
      { Authorization: `Bearer ${CRON_SECRET}` },
    ]) {
      const res = await s.call("POST", "/admin/run-daily", { headers });
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe("invalid_secret");
    }
    expect(runDaily).not.toHaveBeenCalled();
  });

  test("calls runDaily with the right CRON_SECRET", async () => {
    const runDaily = mock(async () => {});
    s = await testServer({ cronSecret: CRON_SECRET }, { runDaily });
    const res = await s.call("POST", "/admin/run-daily", {
      headers: { [CRON_SECRET_HEADER]: CRON_SECRET },
    });
    expect(res.status).toBe(204);
    expect(runDaily).toHaveBeenCalledTimes(1);
  });
});
