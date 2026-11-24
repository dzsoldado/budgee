import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  BackupFormatError,
  type BackupRecord,
  backupFileDate,
  backupRecordSchema,
  backupStatusResponseSchema,
  formatHlc,
  latestRecords,
  parseBackup,
} from "../src";

const ID = "6f1d3c2e-9a4b-4c8d-8e7f-0a1b2c3d4e5f";
const HLC = formatHlc({ wall: 1, counter: 0, device: "phone" });
const live = { table: "transactions", id: ID, hlc: HLC, deleted: false, blob: "AAAA" };
const tomb = { table: "categories", id: ID, hlc: HLC, deleted: true };

async function gzip(text: string): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Uint8Array(
    await new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
}

const lines = (...records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

describe("backup records", () => {
  test("a live record carries a blob, a tombstone none; device and seq are not part of it", () => {
    expect(v.is(backupRecordSchema, live)).toBe(true);
    expect(v.is(backupRecordSchema, tomb)).toBe(true);
    expect(v.is(backupRecordSchema, { ...live, blob: undefined })).toBe(false);
    expect(v.is(backupRecordSchema, { ...tomb, blob: "AAAA" })).toBe(false);
    expect(v.is(backupRecordSchema, { ...live, device: "phone" })).toBe(false);
    expect(v.is(backupRecordSchema, { ...live, seq: 1 })).toBe(false);
  });
});

describe("parseBackup", () => {
  test("reads every line of a gzipped JSON Lines file, in order", async () => {
    expect(await parseBackup(await gzip(lines(live, tomb)))).toEqual([live, tomb] as never);
  });

  test("an empty backup has no records; a missing final newline is fine", async () => {
    expect(await parseBackup(await gzip(""))).toEqual([]);
    expect(await parseBackup(await gzip(JSON.stringify(tomb)))).toEqual([tomb] as never);
  });

  test("a file that is not gzip is refused", async () => {
    const plain = new TextEncoder().encode(lines(live));
    await expect(parseBackup(plain)).rejects.toBeInstanceOf(BackupFormatError);
  });

  test("a bad line is refused by its number, without quoting it", async () => {
    for (const bad of ["{not json", JSON.stringify({ ...live, secret: "hunter2" }), "hunter2"]) {
      const file = await gzip(`${lines(live)}${bad}\n`);
      const error = await parseBackup(file).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BackupFormatError);
      expect((error as Error).message).toBe("Line 2 is not a valid backup record");
    }
  });
});

describe("latestRecords", () => {
  test("keeps the highest hlc of each (table, id), whatever the order in the file", () => {
    const hlc = (wall: number) => formatHlc({ wall, counter: 0, device: "phone" });
    const OTHER = "0c9b8a7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
    const record = (fields: object) => fields as BackupRecord;
    const old = record({ ...live, hlc: hlc(1), blob: "OLD" });
    const edited = record({ ...live, hlc: hlc(3), blob: "NEW" });
    const gone = record({ table: "transactions", id: ID, hlc: hlc(2), deleted: true });
    // Same id in another table is another row.
    const category = record({ ...tomb, hlc: hlc(1) });
    const other = record({ ...live, id: OTHER, hlc: hlc(1) });
    expect(latestRecords([old, category, edited, gone, other])).toEqual([edited, category, other]);
    expect(latestRecords([edited, old])).toEqual([edited]);
  });
});

describe("backupFileDate", () => {
  test("reads the day from budgee-YYYY-MM-DD.jsonl.gz, as the browser may rename a download", () => {
    expect(backupFileDate("budgee-2026-11-17.jsonl.gz")).toBe("2026-11-17");
    expect(backupFileDate("budgee-2026-11-17.jsonl (1).gz")).toBe("2026-11-17");
    expect(backupFileDate("budgee-2026-11-17 (2).jsonl.gz")).toBe("2026-11-17");
    expect(backupFileDate("budgee-2026-02-30.jsonl.gz")).toBeUndefined();
    expect(backupFileDate("backup.jsonl.gz")).toBeUndefined();
    expect(backupFileDate("budgee-2026-11-17.csv")).toBeUndefined();
  });
});

describe("backup status", () => {
  test("status response shape", () => {
    const run = {
      at: 1,
      status: "ok",
      error: null,
      file: "budgee-2026-11-17.jsonl.gz",
      envelopes: 3,
      durationMs: 5,
    };
    const status = {
      destination: { kind: "memory", configured: true, connected: true, reconnectNeeded: false },
      lastRun: run,
      lastCleanup: { at: 1, ok: true, error: null, purged: 0, durationMs: 1 },
      files: ["budgee-2026-11-17.jsonl.gz"],
      filesError: null,
      nextRunAt: 2,
    };
    expect(v.is(backupStatusResponseSchema, status)).toBe(true);
    // Runs recorded before retentionError existed read as having none.
    expect(v.parse(backupStatusResponseSchema, status).lastRun?.retentionError).toBeNull();
    expect(
      v.is(backupStatusResponseSchema, { ...status, lastRun: { ...run, retentionError: "quota" } }),
    ).toBe(true);
    // An older server sends no nextRunAt, error codes or retentionError: still a valid status.
    const { nextRunAt: _next, ...withoutNext } = status;
    expect(v.is(backupStatusResponseSchema, withoutNext)).toBe(true);
    const parsed = v.parse(backupStatusResponseSchema, withoutNext);
    expect(parsed.nextRunAt).toBeUndefined();
    expect(parsed.filesErrorCode).toBeNull();
    expect(parsed.lastRun?.errorCode).toBeNull();
    expect(parsed.lastRun?.retentionErrorCode).toBeNull();
    // A code this client does not know yet is kept, for the client to treat as "other".
    expect(
      v.is(backupStatusResponseSchema, {
        ...status,
        filesErrorCode: "brand_new",
        lastRun: { ...run, status: "error", error: "x", errorCode: "brand_new" },
      }),
    ).toBe(true);
    expect(v.is(backupStatusResponseSchema, { ...status, lastRun: { ...run, status: "x" } })).toBe(
      false,
    );
  });
});
