// `bun run decrypt-backup <file> [--key <recovery key> | --key-stdin] [--out <file.csv>]`: a backup
// file (budgee-YYYY-MM-DD.jsonl.gz) to a plain CSV of the live transactions, without the app. The
// recovery key comes from --key, from stdin with --key-stdin, or from BUDGEE_RECOVERY_KEY; --key
// is the shortest but leaves the key in the shell history. The CSV goes to stdout, or to --out;
// nothing is written unless the whole file decrypts.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DecryptError,
  exportCsv,
  fromEnvelope,
  fromRecoveryKey,
  importKey,
  type LiveTransaction,
  latestRecords,
  parseBackup,
  parseHlc,
} from "../packages/core/src";

/** Where the recovery key comes from when neither --key nor --key-stdin is given. */
export const KEY_ENV = "BUDGEE_RECOVERY_KEY";

const USAGE = [
  "Usage: bun run decrypt-backup <file.jsonl.gz> [--key <key> | --key-stdin] [--out <file.csv>]",
  "The recovery key: --key (stays in your shell history), --key-stdin (read from stdin), or the",
  `${KEY_ENV} environment variable.`,
].join("\n");

const byDate = (a: LiveTransaction, b: LiveTransaction) =>
  a.date.localeCompare(b.date) ||
  a.created_at.localeCompare(b.created_at) ||
  a.id.localeCompare(b.id);

/**
 * The simple CSV of the live transactions in a backup, oldest date first. Throws with a clear
 * message on a malformed recovery key, a wrong one, or a damaged file. The key is checked on the
 * first live row of any table, so it is checked even when there is no live transaction.
 */
export async function decryptBackup(bytes: Uint8Array, recoveryKey: string): Promise<string> {
  const key = await importKey(await fromRecoveryKey(recoveryKey));
  const rows: LiveTransaction[] = [];
  let keyChecked = false;
  for (const record of latestRecords(await parseBackup(bytes))) {
    if (record.deleted || (keyChecked && record.table !== "transactions")) continue;
    // Backups leave out the device column; the hlc ends with it.
    const envelope = { ...record, device: parseHlc(record.hlc).device };
    let row: Awaited<ReturnType<typeof fromEnvelope>>;
    try {
      row = await fromEnvelope(key, envelope);
    } catch (error) {
      if (!keyChecked && error instanceof DecryptError && error.reason === "failed") {
        throw new Error("Wrong recovery key, or the backup file is damaged");
      }
      throw error;
    }
    keyChecked = true;
    if (record.table === "transactions") rows.push(row as LiveTransaction);
  }
  return exportCsv(rows.sort(byDate), "simple");
}

class UsageError extends Error {}

export interface Io {
  env: Record<string, string | undefined>;
  /** All of stdin, for --key-stdin. */
  readStdin(): Promise<string>;
}

const realIo: Io = { env: process.env, readStdin: () => Bun.stdin.text() };

/** Runs the command; returns the exit code (0 ok, 1 failed, 2 usage). */
export async function main(argv: readonly string[], io: Io = realIo): Promise<number> {
  try {
    let parsed: ReturnType<
      typeof parseArgs<{
        options: {
          key: { type: "string" };
          "key-stdin": { type: "boolean" };
          out: { type: "string" };
        };
        allowPositionals: true;
      }>
    >;
    try {
      parsed = parseArgs({
        args: [...argv],
        options: {
          key: { type: "string" },
          "key-stdin": { type: "boolean" },
          out: { type: "string" },
        },
        allowPositionals: true,
      });
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    const { values, positionals } = parsed;
    const [file, ...extra] = positionals;
    if (!file || extra.length > 0) throw new UsageError("one backup file is required");
    if (values.key !== undefined && values["key-stdin"]) {
      throw new UsageError("give the key with --key or --key-stdin, not both");
    }
    let key = values.key ?? io.env[KEY_ENV];
    if (values["key-stdin"]) {
      key = (await io.readStdin()).trim();
      if (!key) throw new UsageError("no recovery key on stdin");
    }
    if (!key) throw new UsageError(`a recovery key is required (--key, --key-stdin or ${KEY_ENV})`);

    let bytes: Uint8Array;
    try {
      bytes = readFileSync(file);
    } catch {
      throw new Error(`cannot read ${file}`);
    }
    const csv = await decryptBackup(bytes, key);
    if (values.out) writeFileSync(values.out, csv);
    else process.stdout.write(csv);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      process.stderr.write(`decrypt-backup: ${message}\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`decrypt-backup: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
