import * as v from "valibot";
import { type Migration, migrate } from "./migrate";
import type { Db } from "./ports";

/** `config` key of the id that tells clients which server (and which database) they talk to. */
export const SERVER_ID_KEY = "serverId";

/**
 * `config` key of the purge point: the highest `seq` among tombstones the daily cleanup has
 * deleted. A device pulling from below it may have missed a deletion.
 */
export const PURGE_SEQ_KEY = "purge_seq";

/**
 * Brings the database up to date and returns the serverId, created on the first run and read
 * back on every later one. Safe to run concurrently (two servers on a fresh database).
 */
export async function initDatabase(
  db: Db,
  migrations: readonly Migration[],
): Promise<{ serverId: string }> {
  await migrate(db, migrations);
  await db.run("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", [
    SERVER_ID_KEY,
    crypto.randomUUID(),
  ]);
  const [row] = await db.query<{ value: string }>("SELECT value FROM config WHERE key = ?", [
    SERVER_ID_KEY,
  ]);
  if (!row) throw new Error("serverId missing from config after insert");
  return { serverId: row.value };
}

/** The value stored as JSON under `key`; null when absent or no longer matching `schema`. */
export async function readConfigJson<S extends v.GenericSchema>(
  db: Db,
  key: string,
  schema: S,
): Promise<v.InferOutput<S> | null> {
  const [row] = await db.query<{ value: string }>("SELECT value FROM config WHERE key = ?", [key]);
  if (!row) return null;
  let data: unknown;
  try {
    data = JSON.parse(row.value);
  } catch {
    return null;
  }
  const result = v.safeParse(schema, data);
  return result.success ? result.output : null;
}

/** Stores `value` as JSON under `key`, replacing what was there. */
export async function writeConfigJson(db: Db, key: string, value: unknown): Promise<void> {
  await db.run(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}

/** The purge point, 0 before any purge. */
export async function readPurgeSeq(db: Db): Promise<number> {
  const [row] = await db.query<{ value: string }>("SELECT value FROM config WHERE key = ?", [
    PURGE_SEQ_KEY,
  ]);
  return row ? Number(row.value) : 0;
}
