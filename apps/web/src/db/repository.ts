// The single write path for synced tables. Every write is validated with the core schemas,
// stamped with an hlc from this device's persisted clock, and marked dirty for the next push.
// Deletes leave tombstones. All clock access goes through here, including `applyRemote`, the
// sync client's path for pulled rows.
import {
  capClockDrift,
  createClock,
  type fieldSchemas,
  InvalidRowError,
  type PulledPage,
  type RowOf,
  rowSchemas,
  SETTING_IDS,
  type SettingKey,
  type SettingValues,
  SYNCED_TABLES,
  type SyncRow,
  shouldApply,
  type TableName,
} from "@budgee/core";
import * as v from "valibot";
import { type BudgeeDb, type Dirty, getMeta, type LocalRow, setMeta } from "./db";

/** What callers pass to `put`: the table's user fields, schema defaults may be left out. */
export type FieldsInputOf<T extends TableName> = v.InferInput<(typeof fieldSchemas)[T]>;
export type LiveRowOf<T extends TableName> = Extract<RowOf<T>, { deleted: false }>;

export interface LocalChange {
  table: TableName;
  id: string;
}
export type LocalWriteListener = (changes: readonly LocalChange[]) => void;
export type RemoteChangeListener = (changes: readonly LocalChange[]) => void;

/** Writes inside one transaction. Await only these (or other Dexie) calls inside `write`. */
export interface Writer {
  /** Creates (new random id) or replaces a row. Settings rows always use their key's id. */
  put<T extends TableName>(table: T, fields: FieldsInputOf<T>, id?: string): Promise<LiveRowOf<T>>;
  /** Merges `patch` into a live row. Throws when the row is missing or deleted. */
  update<T extends TableName>(
    table: T,
    id: string,
    patch: Partial<FieldsInputOf<T>>,
  ): Promise<LiveRowOf<T>>;
  /** Turns a live row into a tombstone; does nothing when it is missing or already deleted. */
  remove(table: TableName, id: string): Promise<void>;
  /**
   * Writes a whole row from elsewhere (a CSV row with an id) with its own hlc and device, dirty,
   * when its hlc beats the local row's: it merges like a synced row. The clock receives the
   * highest merged hlc, capped at now + 24h. Resolves whether the row was written.
   */
  merge<T extends TableName>(table: T, row: RowOf<T>): Promise<boolean>;
}

export interface Repository extends Writer {
  readonly deviceId: string;
  /** Runs `fn` in one transaction: every change commits, or none does. */
  write<R>(fn: (writer: Writer) => Promise<R>): Promise<R>;
  setSetting<K extends SettingKey>(key: K, value: SettingValues[K]): Promise<LiveRowOf<"settings">>;
  /** Called after each committed write with its changes, e.g. to schedule a sync. */
  onLocalWrite(listener: LocalWriteListener): () => void;
  /**
   * Sync only: in one transaction, writes each pulled row whose hlc still beats the local row
   * (with its remote hlc and device, not dirty), has the clock receive `page.clock` and saves
   * `page.since` as the last pulled seq. Rows must be decrypted before: a Dexie transaction
   * cannot await Web Crypto. Returns how many rows were written. Fires `onRemoteChange`, never
   * `onLocalWrite`.
   */
  applyRemote(page: PulledPage): Promise<number>;
  /** Called after `applyRemote` wrote rows. */
  onRemoteChange(listener: RemoteChangeListener): () => void;
  /**
   * Restore from a backup: like `applyRemote`, in one transaction writes each row whose hlc
   * beats the local row, keeping its hlc and device, but marked dirty so the next sync pushes
   * it (which seeds a fresh server). A tombstone for a row this device never had is skipped:
   * there is nothing to delete. The clock receives `clock`, capped at now + 24h. The pulled seq
   * is left alone. Fires `onRemoteChange`, not `onLocalWrite`: the caller starts the one sync
   * (a local write would schedule another). Returns how many rows were written.
   */
  applyRestore(rows: readonly SyncRow[], clock: string | undefined): Promise<number>;
}

export interface RepositoryOptions {
  /** Wall time in ms. */
  now?: () => number;
}

const DEVICE_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

/** 12 random base32 characters (60 bits). */
function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => DEVICE_ID_ALPHABET[b & 31]).join("");
}

function validate<T extends TableName>(table: T, input: unknown): RowOf<T> {
  const result = v.safeParse(rowSchemas[table], input);
  if (!result.success) throw new InvalidRowError(table, result.issues);
  return result.output as RowOf<T>;
}

export async function openRepository(
  db: BudgeeDb,
  options: RepositoryOptions = {},
): Promise<Repository> {
  const { deviceId, lastHlc } = await db.transaction("rw", db.meta, async () => {
    let id = await getMeta(db, "deviceId");
    if (id === undefined) {
      id = newDeviceId();
      await setMeta(db, "deviceId", id);
    }
    return { deviceId: id, lastHlc: await getMeta(db, "hlc") };
  });
  const now = options.now ?? Date.now;
  const clock = createClock(deviceId, now, lastHlc);
  const listeners = new Set<LocalWriteListener>();
  const remoteListeners = new Set<RemoteChangeListener>();
  const scope = [...SYNCED_TABLES.map((table) => db.rows(table)), db.meta];

  const notify = (
    to: ReadonlySet<(changes: readonly LocalChange[]) => void>,
    changes: readonly LocalChange[],
  ) => {
    for (const listener of to) {
      try {
        listener(changes);
      } catch (error) {
        console.error("Repository listener failed", error);
      }
    }
  };

  /** Inside a transaction: adopt the persisted hlc, which other tabs may have moved on. */
  const adoptPersisted = async () => {
    const persisted = await getMeta(db, "hlc");
    if (persisted !== undefined && persisted > (clock.last() ?? "")) clock.receive(persisted);
    return persisted;
  };
  /** Inside a transaction: persist the clock if it moved past `persisted`. */
  const persistClock = async (persisted: string | undefined) => {
    const last = clock.last();
    if (last !== undefined && (persisted === undefined || last > persisted)) {
      await setMeta(db, "hlc", last);
    }
  };

  async function write<R>(fn: (writer: Writer) => Promise<R>): Promise<R> {
    const changes: LocalChange[] = [];
    /** The highest hlc `merge` wrote, for the clock to receive. */
    let merged: string | undefined;

    const writer: Writer = {
      async put(table, fields, id) {
        const rowId =
          table === "settings"
            ? SETTING_IDS[(fields as { key: SettingKey }).key]
            : (id ?? crypto.randomUUID());
        const row = validate(table, {
          ...fields,
          id: rowId,
          hlc: clock.tick(),
          device: deviceId,
          deleted: false,
        }) as LiveRowOf<typeof table>;
        await db.rows(table).put({ ...row, dirty: 1 });
        changes.push({ table, id: rowId });
        return row;
      },
      async update(table, id, patch) {
        const current = await db.rows(table).get(id);
        if (!current || current.deleted) throw new Error(`${table} row not found: ${id}`);
        const {
          id: _id,
          hlc: _hlc,
          device: _device,
          deleted: _deleted,
          dirty: _dirty,
          ...fields
        } = current;
        // A live row's fields plus the patch; `put` validates the result.
        const merged = { ...fields, ...patch } as unknown as FieldsInputOf<typeof table>;
        return writer.put(table, merged, id);
      },
      async remove(table, id) {
        const current = await db.rows(table).get(id);
        if (!current || current.deleted) return;
        const tombstone = { id, hlc: clock.tick(), device: deviceId, deleted: true } as const;
        await db.rows(table).put({ ...validate(table, tombstone), dirty: 1 });
        changes.push({ table, id });
      },
      async merge(table, input) {
        const row = validate(table, input);
        if (!shouldApply(await db.rows(table).get(row.id), row)) return false;
        await db.rows(table).put({ ...row, dirty: 1 } as LocalRow<typeof table>);
        changes.push({ table, id: row.id });
        if (merged === undefined || row.hlc > merged) merged = row.hlc;
        return true;
      },
    };

    const result = await db.transaction("rw", scope, async () => {
      // Every tab shares this database and device id but keeps its own clock, so adopt the
      // persisted hlc first: an edit here then always sorts after the other tabs' edits.
      // Read-write transactions on `meta` run one at a time, across tabs too.
      const persisted = await adoptPersisted();
      const value = await fn(writer);
      if (merged !== undefined) {
        const capped = capClockDrift(merged, now());
        if (capped > (clock.last() ?? "")) clock.receive(capped);
      }
      if (changes.length > 0) await persistClock(persisted);
      return value;
    });
    if (changes.length > 0) notify(listeners, changes);
    return result;
  }

  /**
   * Writes the rows that beat the local ones (with `restoring`, not tombstones of rows absent
   * here), has the clock receive `remote`; then `after`. One read and one write per table.
   */
  async function merge(
    rows: readonly SyncRow[],
    remote: string | undefined,
    { dirty, restoring = false }: { dirty: Dirty; restoring?: boolean },
    after?: () => Promise<void>,
  ): Promise<LocalChange[]> {
    const changes: LocalChange[] = [];
    await db.transaction("rw", scope, async () => {
      for (const table of SYNCED_TABLES) {
        // The newest of each id, should one come twice.
        const newest = new Map<string, SyncRow["row"]>();
        for (const { row } of rows.filter((r) => r.table === table)) {
          const seen = newest.get(row.id);
          if (!seen || row.hlc > seen.hlc) newest.set(row.id, row);
        }
        const incoming = [...newest.values()];
        if (incoming.length === 0) continue;
        const locals = await db.rows(table).bulkGet(incoming.map((row) => row.id));
        // A local edit made since the rows were read may have a higher hlc by now.
        const winners = incoming.filter((row, i) => {
          const local = locals[i];
          if (restoring && !local && row.deleted) return false;
          return shouldApply(local, row);
        });
        if (winners.length === 0) continue;
        await db
          .rows(table)
          .bulkPut(winners.map((row) => ({ ...row, dirty }) as LocalRow<typeof table>));
        for (const row of winners) changes.push({ table, id: row.id });
      }
      const persisted = await adoptPersisted();
      if (remote !== undefined && remote > (clock.last() ?? "")) clock.receive(remote);
      await persistClock(persisted);
      await after?.();
    });
    return changes;
  }

  async function applyRemote({ rows, clock: remote, since }: PulledPage): Promise<number> {
    // The sync client caps `remote` at now + 24h (capClockDrift), so a device whose clock is
    // days fast cannot drag this clock along.
    const changes = await merge(rows, remote, { dirty: 0 }, () =>
      setMeta(db, "lastPulledSeq", since),
    );
    if (changes.length > 0) notify(remoteListeners, changes);
    return changes.length;
  }

  async function applyRestore(rows: readonly SyncRow[], remote: string | undefined) {
    const capped = remote === undefined ? undefined : capClockDrift(remote, now());
    const changes = await merge(rows, capped, { dirty: 1, restoring: true });
    if (changes.length > 0) notify(remoteListeners, changes);
    return changes.length;
  }

  return {
    deviceId,
    write,
    put: (table, fields, id) => write((w) => w.put(table, fields, id)),
    update: (table, id, patch) => write((w) => w.update(table, id, patch)),
    remove: (table, id) => write((w) => w.remove(table, id)),
    merge: (table, row) => write((w) => w.merge(table, row)),
    setSetting: (key, value) =>
      write((w) => w.put("settings", { key, value } as FieldsInputOf<"settings">)),
    onLocalWrite(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyRemote,
    onRemoteChange(listener) {
      remoteListeners.add(listener);
      return () => remoteListeners.delete(listener);
    },
    applyRestore,
  };
}
