// The local database: the four synced tables (sync columns plus `dirty`) and a `meta` table
// for values that never leave this device.
import type { RowOf, TableName } from "@budgee/core";
import Dexie, { type DexieOptions, type Table } from "dexie";
import type { LiveFileHandle } from "../csv/live-file";

/** 1 while the row has a local change not yet pushed. A number, since IndexedDB can't index booleans. */
export type Dirty = 0 | 1;

/** A synced row as stored here: live or tombstone, plus the local `dirty` flag. */
export type LocalRow<T extends TableName> = RowOf<T> & { dirty: Dirty };

/** Local-only values, by key. */
export interface MetaValues {
  /** This device's id in hlcs; generated once. */
  deviceId: string;
  /** The latest hlc issued or adopted, so the clock survives restarts. */
  hlc: string;
  /** Defaults were seeded on this device. */
  seeded: true;
  /** Absolute server origin, e.g. `https://budgee.example.com`. */
  serverUrl: string;
  deviceToken: string;
  serverId: string;
  vaultKey: CryptoKey;
  /** Last server sequence pulled. */
  lastPulledSeq: number;
  /** When the last sync run finished, in ms since the epoch (shared by every tab). */
  lastSyncAt: number;
  /** The local CSV file kept up to date (a FileSystemFileHandle). */
  csvFile: LiveFileHandle;
}
export type MetaKey = keyof MetaValues;

interface MetaRow<K extends MetaKey = MetaKey> {
  key: K;
  value: MetaValues[K];
}

export class BudgeeDb extends Dexie {
  transactions!: Table<LocalRow<"transactions">, string>;
  categories!: Table<LocalRow<"categories">, string>;
  settings!: Table<LocalRow<"settings">, string>;
  chart_configs!: Table<LocalRow<"chart_configs">, string>;
  meta!: Table<MetaRow, MetaKey>;

  constructor(name = "budgee", options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      transactions: "id, dirty, date",
      categories: "id, dirty",
      settings: "id, dirty",
      chart_configs: "id, dirty",
      meta: "key",
    });
  }

  /** The Dexie table behind a synced table name. */
  rows<T extends TableName>(table: T): Table<LocalRow<T>, string> {
    return this.table(table);
  }
}

export async function getMeta<K extends MetaKey>(
  db: BudgeeDb,
  key: K,
): Promise<MetaValues[K] | undefined> {
  const row = await db.meta.get(key);
  return row?.value as MetaValues[K] | undefined;
}

export async function setMeta<K extends MetaKey>(
  db: BudgeeDb,
  key: K,
  value: MetaValues[K],
): Promise<void> {
  await db.meta.put({ key, value });
}

export async function deleteMeta(db: BudgeeDb, key: MetaKey): Promise<void> {
  await db.meta.delete(key);
}
