// Restore from a backup file: newest record per row, decrypted with the vault key, merged by hlc
// through the repository with winning rows marked dirty for the next push.
import { describe, expect, test } from "bun:test";
import {
  type BackupRecord,
  type Envelope,
  formatHlc,
  generateVaultKey,
  type RowOf,
  rowSchemas,
  type TableName,
  toEnvelope,
} from "@budgee/core";
import * as v from "valibot";
import { getMeta } from "../src/db/db";
import { type LocalChange, openRepository } from "../src/db/repository";
import { seedDefaults } from "../src/db/seed";
import {
  checkBackupSize,
  countChanges,
  MAX_BACKUP_BYTES,
  RestoreError,
  readBackupFile,
  restoreBackup,
} from "../src/sync/restore";
import { expense, fakeNow, freshDb } from "./helpers";

const NOW = 1_763_370_000_000;
const DAY = 86_400_000;
const FILE = "budgee-2026-11-17.jsonl.gz";

const hlc = (wall: number, device = "laptop") => formatHlc({ wall, counter: 0, device });

type LiveEntry = Extract<RowOf<"transactions">, { deleted: false }>;

const entry = (id: string, wall: number, fields: { detail?: string } = {}) =>
  v.parse(rowSchemas.transactions, {
    ...expense,
    ...fields,
    id,
    hlc: hlc(wall),
    device: "laptop",
    deleted: false,
  }) as LiveEntry;

const recordOf = ({ device: _device, ...envelope }: Envelope): BackupRecord =>
  envelope as BackupRecord;

async function sealed<T extends TableName>(key: CryptoKey, table: T, row: RowOf<T>) {
  return recordOf(await toEnvelope(key, table, row as never));
}

async function gzip(records: readonly BackupRecord[]): Promise<Uint8Array> {
  const text = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function setup() {
  const db = freshDb();
  const clock = fakeNow(NOW);
  const repo = await openRepository(db, { now: clock.now });
  const local: LocalChange[][] = [];
  const remote: LocalChange[][] = [];
  repo.onLocalWrite((changes) => local.push([...changes]));
  repo.onRemoteChange((changes) => remote.push([...changes]));
  return { db, repo, clock, local, remote, key: await generateVaultKey() };
}

describe("readBackupFile", () => {
  test("decrypts the newest record of each row and counts live rows per table", async () => {
    const { key } = await setup();
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const older = await sealed(key, "transactions", entry(a, NOW - 3 * DAY, { detail: "old" }));
    const newer = await sealed(key, "transactions", entry(a, NOW - 2 * DAY, { detail: "new" }));
    const other = await sealed(key, "transactions", entry(b, NOW - 2 * DAY));
    const gone: BackupRecord = {
      table: "transactions",
      id: c,
      hlc: hlc(NOW - DAY),
      deleted: true,
    };
    // The edited row is in the file twice, the newer copy first (it may come either way).
    const contents = await readBackupFile(await gzip([newer, other, older, gone]), FILE, key);

    expect(contents.date).toBe("2026-11-17");
    expect(contents.rows).toHaveLength(3);
    const first = contents.rows.find((r) => r.row.id === a)?.row;
    expect(first).toMatchObject({ detail: "new", hlc: hlc(NOW - 2 * DAY), device: "laptop" });
    expect(contents.rows.find((r) => r.row.id === c)?.row).toEqual({
      id: c,
      hlc: hlc(NOW - DAY),
      device: "laptop",
      deleted: true,
    });
    expect(contents.counts).toEqual({
      transactions: 2,
      categories: 0,
      settings: 0,
      chart_configs: 0,
    });
    expect(contents.deleted).toBe(1);
    expect(contents.clock).toBe(hlc(NOW - DAY));
  });

  test("a file the key does not open is refused as wrong_key", async () => {
    const { key } = await setup();
    const file = await gzip([
      await sealed(key, "transactions", entry(crypto.randomUUID(), NOW - DAY)),
    ]);
    const error = await readBackupFile(file, FILE, await generateVaultKey()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RestoreError);
    expect((error as RestoreError).reason).toBe("wrong_key");
  });

  test("a row that fails after others opened is damage, not a wrong key", async () => {
    const { key } = await setup();
    const good = await sealed(key, "transactions", entry(crypto.randomUUID(), NOW - DAY));
    const bad = await sealed(key, "transactions", entry(crypto.randomUUID(), NOW - DAY));
    // A blob moved to another row no longer authenticates.
    const moved = { ...bad, blob: good.deleted ? "" : good.blob } as BackupRecord;
    const error = await readBackupFile(await gzip([good, moved]), FILE, key).catch(
      (e: unknown) => e,
    );
    expect((error as RestoreError).reason).toBe("damaged");
  });

  test("a file that is not a gzipped backup is refused as not_backup", async () => {
    const { key } = await setup();
    for (const bytes of [
      new TextEncoder().encode("date,amount\n2026-11-17,12\n"),
      await gzip([{ hello: "world" } as unknown as BackupRecord]),
    ]) {
      const error = await readBackupFile(bytes, "export.csv", key).catch((e: unknown) => e);
      expect((error as RestoreError).reason).toBe("not_backup");
    }
  });

  test("a renamed file still restores, without a date", async () => {
    const { key } = await setup();
    const file = await gzip([
      await sealed(key, "transactions", entry(crypto.randomUUID(), NOW - DAY)),
    ]);
    expect((await readBackupFile(file, "my backup.gz", key)).date).toBeUndefined();
  });

  test("a file over the size limit is refused before it is read", async () => {
    const { key } = await setup();
    const file = await gzip([
      await sealed(key, "transactions", entry(crypto.randomUUID(), NOW - DAY)),
    ]);
    expect(MAX_BACKUP_BYTES).toBe(200 * 1024 * 1024);
    expect(() => checkBackupSize(MAX_BACKUP_BYTES)).not.toThrow();
    expect(() => checkBackupSize(MAX_BACKUP_BYTES + 1)).toThrow(RestoreError);
    const error = await readBackupFile(file, FILE, key, file.length - 1).catch((e: unknown) => e);
    expect((error as RestoreError).reason).toBe("too_large");
  });

  test("an empty backup has nothing to restore", async () => {
    const { key } = await setup();
    const contents = await readBackupFile(await gzip([]), FILE, key);
    expect(contents.rows).toEqual([]);
    expect(contents.clock).toBeUndefined();
  });
});

describe("restoreBackup", () => {
  test("merges by hlc: older local rows are replaced and written dirty; newer local edits stay", async () => {
    const { db, repo, clock, key, local, remote } = await setup();
    const kept = await repo.put("transactions", { ...expense, detail: "edited here" });
    const stale = entry(crypto.randomUUID(), NOW - 5 * DAY, { detail: "stale" });
    await db.transactions.put({ ...stale, dirty: 0 });
    const missing = entry(crypto.randomUUID(), NOW - 2 * DAY, { detail: "only in backup" });
    local.length = 0;

    const file = await gzip([
      await sealed(key, "transactions", entry(kept.id, NOW - DAY, { detail: "from backup" })),
      await sealed(key, "transactions", { ...stale, detail: "restored", hlc: hlc(NOW - DAY) }),
      await sealed(key, "transactions", missing),
    ]);
    const contents = await readBackupFile(file, FILE, key);
    expect(await countChanges(db, contents.rows)).toEqual({ changes: 2, deletions: 0 });

    expect(await restoreBackup(repo, contents)).toEqual({ applied: 2, total: 3 });
    expect(await db.transactions.get(kept.id)).toMatchObject({
      detail: "edited here",
      hlc: kept.hlc,
    });
    expect(await db.transactions.get(stale.id)).toMatchObject({
      detail: "restored",
      hlc: hlc(NOW - DAY),
      device: "laptop",
      dirty: 1,
    });
    expect(await db.transactions.get(missing.id)).toEqual({ ...missing, dirty: 1 });
    // Not a local write: that would schedule a second sync after the one the screen starts.
    expect(local).toEqual([]);
    expect(remote).toHaveLength(1);
    expect(remote[0]).toHaveLength(2);
    expect(await getMeta(db, "lastPulledSeq")).toBeUndefined();

    // Restoring the same file again changes nothing.
    expect(await countChanges(db, contents.rows)).toEqual({ changes: 0, deletions: 0 });
    expect(await restoreBackup(repo, contents)).toEqual({ applied: 0, total: 3 });

    // The clock moved past the restored rows: an edit now sorts after them.
    clock.set(NOW - 10 * DAY);
    const edit = await repo.update("transactions", missing.id, { detail: "after restore" });
    expect(edit.hlc > hlc(NOW - DAY)).toBe(true);
  });

  test("a tombstone in the backup deletes an older local row; a later local edit survives it", async () => {
    const { db, repo, key } = await setup();
    const old = entry(crypto.randomUUID(), NOW - 5 * DAY);
    await db.transactions.put({ ...old, dirty: 0 });
    const mine = await repo.put("transactions", expense);
    const tombstones: BackupRecord[] = [old.id, mine.id].map((id) => ({
      table: "transactions",
      id,
      hlc: hlc(NOW - DAY),
      deleted: true,
    }));
    const contents = await readBackupFile(await gzip(tombstones), FILE, key);
    // Two tombstones in the file; only the one beating its local row deletes anything.
    expect(contents.deleted).toBe(2);
    expect(await countChanges(db, contents.rows)).toEqual({ changes: 1, deletions: 1 });
    expect(await restoreBackup(repo, contents)).toEqual({ applied: 1, total: 2 });
    expect(await db.transactions.get(old.id)).toEqual({
      id: old.id,
      hlc: hlc(NOW - DAY),
      device: "laptop",
      deleted: true,
      dirty: 1,
    });
    expect(await db.transactions.get(mine.id)).toMatchObject({ deleted: false });
  });

  test("a tombstone for a row this device never had is skipped: not counted, written or pushed", async () => {
    const { db, repo, key } = await setup();
    const never: BackupRecord = {
      table: "transactions",
      id: crypto.randomUUID(),
      hlc: hlc(NOW - DAY),
      deleted: true,
    };
    const contents = await readBackupFile(await gzip([never]), FILE, key);
    expect(await countChanges(db, contents.rows)).toEqual({ changes: 0, deletions: 0 });
    expect(await restoreBackup(repo, contents)).toEqual({ applied: 0, total: 1 });
    expect(await db.transactions.get(never.id)).toBeUndefined();
    expect(await db.transactions.where("dirty").equals(1).count()).toBe(0);
  });

  test("restored categories replace untouched seeded defaults", async () => {
    const { db, repo, key } = await setup();
    await seedDefaults(db);
    const seeded = await db.categories.toArray();
    const groceries = seeded.find((row) => !row.deleted && row.name === "Groceries");
    if (!groceries || groceries.deleted) throw new Error("no seeded Groceries category");
    const { dirty: _dirty, ...fields } = groceries;
    const renamed = { ...fields, name: "Food", hlc: hlc(NOW - DAY) };
    const contents = await readBackupFile(
      await gzip([await sealed(key, "categories", renamed)]),
      FILE,
      key,
    );
    expect(contents.counts.categories).toBe(1);
    await restoreBackup(repo, contents);
    expect(await db.categories.get(groceries.id)).toMatchObject({ name: "Food", dirty: 1 });
  });

  test("a clock far in the future in the backup does not drag this device's clock along", async () => {
    const { db, repo, key } = await setup();
    const future = entry(crypto.randomUUID(), NOW + 30 * DAY);
    const contents = await readBackupFile(
      await gzip([await sealed(key, "transactions", future)]),
      FILE,
      key,
    );
    await restoreBackup(repo, contents);
    const persisted = (await getMeta(db, "hlc")) ?? "";
    expect(persisted < hlc(NOW + 2 * DAY)).toBe(true);
  });
});
