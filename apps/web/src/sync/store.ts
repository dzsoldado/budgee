// The sync client's local side over Dexie. Pulled rows go through the repository, which owns
// the clock; the rest only reads rows or flips `dirty`, and never fires `onLocalWrite`.
import {
  SEED_HLC,
  SYNCED_TABLES,
  type SyncRow,
  type SyncRowRef,
  type SyncStore,
  type TableName,
} from "@budgee/core";
import { type BudgeeDb, getMeta, type LocalRow, setMeta } from "../db/db";
import type { Repository } from "../db/repository";

/** Groups `items` by table, keeping each one's position in `items`. */
function byTable<R extends { table: TableName }>(items: readonly R[]) {
  const groups = new Map<TableName, { item: R; index: number }[]>();
  items.forEach((item, index) => {
    const group = groups.get(item.table) ?? [];
    group.push({ item, index });
    groups.set(item.table, group);
  });
  return groups;
}

const withoutDirty = <T extends TableName>({ dirty: _dirty, ...row }: LocalRow<T>) => row;

export function createDexieSyncStore(db: BudgeeDb, repo: Repository): SyncStore {
  const tables = SYNCED_TABLES.map((table) => db.rows(table));

  return {
    async state() {
      const [serverId, since] = await Promise.all([
        getMeta(db, "serverId"),
        getMeta(db, "lastPulledSeq"),
      ]);
      return { serverId, since: since ?? 0 };
    },

    async adoptServer(serverId) {
      await db.transaction("rw", [...tables, db.meta], async () => {
        // Untouched defaults (SEED_HLC) stay local, as in storePairing: every device seeds its own.
        for (const table of tables) {
          await table.filter((row) => row.hlc !== SEED_HLC && row.dirty === 0).modify({ dirty: 1 });
        }
        await setMeta(db, "serverId", serverId);
        await setMeta(db, "lastPulledSeq", 0);
      });
    },

    async dirtyRows() {
      return db.transaction("r", tables, async () => {
        const rows: SyncRow[] = [];
        for (const table of SYNCED_TABLES) {
          for (const row of await db.rows(table).where("dirty").equals(1).toArray()) {
            rows.push({ table, row: withoutDirty(row) } as SyncRow);
          }
        }
        return rows;
      });
    },

    async markPushed(refs: readonly SyncRowRef[]) {
      await db.transaction("rw", tables, async () => {
        for (const [table, group] of byTable(refs)) {
          const rows = db.rows(table);
          const current = await rows.bulkGet(group.map(({ item }) => item.id));
          // Only where the row is still the version pushed: an edit made since stays dirty.
          const pushed = group
            .filter(({ item }, i) => current[i]?.hlc === item.hlc && current[i]?.dirty === 1)
            .map(({ item }) => item.id);
          if (pushed.length > 0) await rows.where("id").anyOf(pushed).modify({ dirty: 0 });
        }
      });
    },

    async localHlcs(refs) {
      const hlcs: (string | undefined)[] = new Array(refs.length).fill(undefined);
      await db.transaction("r", tables, async () => {
        for (const [table, group] of byTable(refs)) {
          const rows = await db.rows(table).bulkGet(group.map(({ item }) => item.id));
          group.forEach(({ index }, i) => {
            hlcs[index] = rows[i]?.hlc;
          });
        }
      });
      return hlcs;
    },

    applyPage: (page) => repo.applyRemote(page),

    async wipe() {
      await db.transaction("rw", [...tables, db.meta], async () => {
        // Dirty rows were pushed before the pull, or were edited since: keep them. Untouched
        // defaults (SEED_HLC) may exist only here, as seeds are not pushed and never re-seeded;
        // any copy on the server has a higher hlc and replaces them on the repull.
        for (const table of tables) {
          await table
            .where("dirty")
            .equals(0)
            .and((row) => row.hlc !== SEED_HLC)
            .delete();
        }
        await setMeta(db, "lastPulledSeq", 0);
      });
    },
  };
}
