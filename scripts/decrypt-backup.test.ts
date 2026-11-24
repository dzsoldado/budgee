// `bun run decrypt-backup`: from a backup the server generated to a plain CSV.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSqliteDb } from "../apps/server/adapters/db/bun-sqlite";
import { migrations } from "../apps/server/migrations";
import { buildBackup } from "../apps/server/src/backup";
import { storeEnvelopes } from "../apps/server/src/envelopes";
import { initDatabase } from "../apps/server/src/init";
import {
  type BackupRecord,
  type Envelope,
  exportKey,
  formatHlc,
  generateVaultKey,
  type RowInputOf,
  toEnvelope,
  toRecoveryKey,
} from "../packages/core/src";
import { decryptBackup } from "./decrypt-backup";

const SCRIPT = join(import.meta.dir, "decrypt-backup.ts");
const hlc = (wall: number, device = "phone") => formatHlc({ wall, counter: 0, device });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const transaction = (
  n: number,
  wall: number,
  fields: Partial<RowInputOf<"transactions">> = {},
): RowInputOf<"transactions"> => ({
  id: id(n),
  hlc: hlc(wall),
  deleted: false,
  device: "phone",
  type: "expense",
  amount: 4500,
  date: "2026-11-02",
  category: "Groceries",
  detail: "Carrefour",
  created_at: "2026-11-02T10:00:00.000Z",
  ...fields,
});

let dir: string;
let recoveryKey: string;
let otherKey: string;
let backupFile: string;

const EXPECTED = [
  "date,type,amount,category,detail,note,tags,original_amount,original_currency",
  "2026-11-01,income,2500,Salary,,,,,",
  '2026-11-02,expense,45,Groceries,"Carrefour, Paris","said ""hi""",weekly;home,,',
  "2026-11-05,expense,28.5,Transport,Istanbul,,,1000,TRY",
  "",
].join("\r\n");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "budgee-decrypt-"));
  const key = await generateVaultKey();
  recoveryKey = await toRecoveryKey(await exportKey(key));
  otherKey = await toRecoveryKey(await exportKey(await generateVaultKey()));

  const database = new Database(":memory:");
  const db = bunSqliteDb(database);
  await initDatabase(db, migrations);
  const store = async (rows: RowInputOf<"transactions">[]) =>
    storeEnvelopes(
      db,
      await Promise.all(rows.map((row) => toEnvelope(key, "transactions", row))),
      1,
    );

  await store([
    transaction(1, 1, { detail: "first version" }),
    transaction(2, 1, {
      type: "income",
      category: "Salary",
      detail: "",
      amount: 250000,
      date: "2026-11-01",
    }),
    transaction(3, 1, {
      amount: 2850,
      date: "2026-11-05",
      category: "Transport",
      detail: "Istanbul",
      original_amount: 100000,
      original_currency: "TRY",
    }),
    transaction(4, 1, { detail: "deleted later" }),
  ]);
  await store([
    // Edited: the newer version replaces the first.
    transaction(1, 2, { detail: "Carrefour, Paris", note: 'said "hi"', tags: ["weekly", "home"] }),
    // Deleted: a tombstone.
    { id: id(4), hlc: hlc(2), deleted: true, device: "phone" },
  ]);
  await storeEnvelopes(db, [await toEnvelope(key, "categories", category(9))], 1);

  backupFile = join(dir, "budgee-2026-11-17.jsonl.gz");
  writeFileSync(backupFile, (await buildBackup(db)).bytes);
  database.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const category = (n: number): RowInputOf<"categories"> => ({
  id: id(n),
  hlc: hlc(1),
  deleted: false,
  device: "phone",
  type: "expense",
  name: "Groceries",
  sort: 0,
  archived: false,
});

/** A backup record from an envelope: no device or seq. */
const recordOf = ({ device: _, seq: __, ...rest }: Envelope): BackupRecord => rest;

const gzip = async (records: BackupRecord[]) =>
  new Uint8Array(
    await new Response(
      new Blob([records.map((r) => `${JSON.stringify(r)}\n`).join("")])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

describe("decryptBackup", () => {
  test("turns a backup into the simple CSV of live transactions, by date", async () => {
    expect(await decryptBackup(readFileSync(backupFile), recoveryKey)).toBe(EXPECTED);
  });

  test("a row in the file twice counts once, at its highest hlc, whatever the order", async () => {
    const key = await generateVaultKey();
    const v1 = await toEnvelope(key, "transactions", transaction(1, 1, { detail: "old" }));
    const v2 = await toEnvelope(key, "transactions", transaction(1, 2, { detail: "new" }));
    const gone = await toEnvelope(key, "transactions", transaction(2, 1, { detail: "was here" }));
    const tombstone: BackupRecord = {
      table: "transactions",
      id: id(2),
      hlc: hlc(3),
      deleted: true,
    };
    const text = await decryptBackup(
      await gzip([recordOf(v2), recordOf(gone), recordOf(v1), tombstone]),
      await toRecoveryKey(await exportKey(key)),
    );
    expect(
      text
        .split("\r\n")
        .slice(1, -1)
        .map((line) => line.split(",")[4]),
    ).toEqual(["new"]);
  });

  test("a wrong recovery key is refused clearly", async () => {
    const error = (await decryptBackup(readFileSync(backupFile), otherKey).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.message).toBe("Wrong recovery key, or the backup file is damaged");
    const typo = (await decryptBackup(
      readFileSync(backupFile),
      `${recoveryKey.slice(0, -1)}${recoveryKey.endsWith("0") ? "1" : "0"}`,
    ).catch((e: unknown) => e)) as Error;
    expect(typo.message).toMatch(/checksum|recovery key/i);
  });

  test("the key is checked even when there is no live transaction", async () => {
    const key = await generateVaultKey();
    const bytes = await gzip([recordOf(await toEnvelope(key, "categories", category(1)))]);
    expect(await decryptBackup(bytes, await toRecoveryKey(await exportKey(key)))).toBe(
      `${EXPECTED.split("\r\n")[0]}\r\n`,
    );
    await expect(decryptBackup(bytes, otherKey)).rejects.toThrow("Wrong recovery key");
  });
});

describe("the decrypt-backup command", () => {
  const { BUDGEE_RECOVERY_KEY: _, ...baseEnv } = process.env;
  const runWith = (options: { env?: Record<string, string>; stdin?: string }, args: string[]) => {
    // --no-env-file: no .env from the working directory changes what the command sees.
    const result = Bun.spawnSync([process.execPath, "--no-env-file", SCRIPT, ...args], {
      env: { ...baseEnv, ...options.env },
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  const run = (...args: string[]) => runWith({}, args);

  test("writes the CSV to stdout, or to --out", () => {
    expect(run(backupFile, "--key", recoveryKey)).toEqual({
      code: 0,
      stdout: EXPECTED,
      stderr: "",
    });
    const out = join(dir, "out.csv");
    expect(run(backupFile, "--key", recoveryKey, "--out", out)).toMatchObject({
      code: 0,
      stdout: "",
    });
    expect(readFileSync(out, "utf8")).toBe(EXPECTED);
  });

  test("takes the key from stdin with --key-stdin, keeping it out of the command line", () => {
    expect(runWith({ stdin: `${recoveryKey}\n` }, [backupFile, "--key-stdin"])).toEqual({
      code: 0,
      stdout: EXPECTED,
      stderr: "",
    });
    expect(runWith({ stdin: "\n" }, [backupFile, "--key-stdin"])).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("no recovery key on stdin"),
    });
  });

  test("takes the key from BUDGEE_RECOVERY_KEY when no option gives one", () => {
    expect(runWith({ env: { BUDGEE_RECOVERY_KEY: recoveryKey } }, [backupFile])).toEqual({
      code: 0,
      stdout: EXPECTED,
      stderr: "",
    });
    // An option wins over the environment.
    expect(
      runWith({ env: { BUDGEE_RECOVERY_KEY: recoveryKey } }, [backupFile, "--key", otherKey]),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining("Wrong recovery key") });
  });

  test("--key and --key-stdin together are a usage error", () => {
    expect(
      runWith({ stdin: recoveryKey }, [backupFile, "--key", recoveryKey, "--key-stdin"]),
    ).toMatchObject({ code: 2, stderr: expect.stringContaining("Usage:") });
  });

  test("a wrong key fails with a clear message and writes nothing", () => {
    const out = join(dir, "wrong.csv");
    const result = run(backupFile, "--key", otherKey, "--out", out);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "decrypt-backup: Wrong recovery key, or the backup file is damaged\n",
    });
    expect(existsSync(out)).toBe(false);
  });

  test("usage errors and unreadable files exit non-zero", () => {
    expect(run(backupFile)).toMatchObject({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining("Usage:"),
    });
    expect(run("--key", recoveryKey)).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Usage:"),
    });
    expect(run(backupFile, "--key", recoveryKey, "--bogus")).toMatchObject({ code: 2 });
    expect(run(join(dir, "missing.gz"), "--key", recoveryKey)).toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("cannot read"),
    });
    const notGzip = join(dir, "plain.txt");
    writeFileSync(notGzip, "hello");
    expect(run(notGzip, "--key", recoveryKey)).toMatchObject({
      code: 1,
      stderr: "decrypt-backup: Backup is not a gzip file\n",
    });
  });
});
