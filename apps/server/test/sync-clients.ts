// Simulated sync clients for end-to-end tests: the core sync engine with the real crypto and
// HTTP transport, over an in-memory store, talking to an in-process server.
import {
  createClock,
  createHttpTransport,
  type HlcClock,
  type HttpFetch,
  type RowOf,
  rowSchemas,
  runSync,
  SEED_HLC,
  type SyncResult,
  type SyncRow,
  type SyncRowRef,
  type SyncStore,
  shouldApply,
  type TableName,
} from "@budgee/core";
import * as v from "valibot";
import type { TestServer } from "./api-helpers";

interface StoredRow {
  table: TableName;
  row: RowOf<TableName>;
  dirty: boolean;
}

const keyOf = (table: TableName, id: string) => `${table}:${id}`;

/** What a device keeps locally, like the web app's Dexie tables and meta. */
export class MemoryStore implements SyncStore {
  rows = new Map<string, StoredRow>();
  serverId: string | undefined;
  since = 0;
  clock: HlcClock;

  constructor(
    readonly deviceId: string,
    readonly now: () => number,
    last?: string,
  ) {
    this.clock = createClock(deviceId, () => this.now(), last);
  }

  // ─── local edits (what the repository does) ───

  put(table: TableName, fields: Record<string, unknown>, id: string = crypto.randomUUID()) {
    const row = v.parse(rowSchemas[table], {
      ...fields,
      id,
      hlc: this.clock.tick(),
      device: this.deviceId,
      deleted: false,
    }) as RowOf<TableName>;
    this.rows.set(keyOf(table, id), { table, row, dirty: true });
    return row;
  }

  remove(table: TableName, id: string) {
    const row = { id, hlc: this.clock.tick(), device: this.deviceId, deleted: true as const };
    this.rows.set(keyOf(table, id), { table, row, dirty: true });
  }

  get(table: TableName, id: string) {
    return this.rows.get(keyOf(table, id));
  }

  /** Every row as `table:id` → row, without local flags, for comparing devices. */
  data() {
    return Object.fromEntries(
      [...this.rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, s]) => [k, s.row]),
    );
  }

  dirtyKeys() {
    return [...this.rows.entries()].filter(([, s]) => s.dirty).map(([k]) => k);
  }

  /** A copy as it is now, e.g. an old backup of this device's storage. */
  snapshot(): MemoryStore {
    const copy = new MemoryStore(this.deviceId, this.now, this.clock.last());
    copy.rows = new Map([...this.rows].map(([k, s]) => [k, structuredClone(s)]));
    copy.serverId = this.serverId;
    copy.since = this.since;
    return copy;
  }

  // ─── SyncStore ───

  async state() {
    return { serverId: this.serverId, since: this.since };
  }

  async adoptServer(serverId: string) {
    for (const stored of this.rows.values()) stored.dirty = true;
    this.serverId = serverId;
    this.since = 0;
  }

  async dirtyRows(): Promise<SyncRow[]> {
    return [...this.rows.values()]
      .filter((s) => s.dirty)
      .map(({ table, row }) => ({ table, row: structuredClone(row) }));
  }

  async markPushed(refs: readonly SyncRowRef[]) {
    for (const { table, id, hlc } of refs) {
      const stored = this.rows.get(keyOf(table, id));
      if (stored && stored.row.hlc === hlc) stored.dirty = false;
    }
  }

  async localHlcs(refs: readonly { table: TableName; id: string }[]) {
    return refs.map(({ table, id }) => this.rows.get(keyOf(table, id))?.row.hlc);
  }

  async applyPage(page: { rows: readonly SyncRow[]; clock: string | undefined; since: number }) {
    let applied = 0;
    for (const { table, row } of page.rows) {
      const local = this.rows.get(keyOf(table, row.id));
      if (!shouldApply(local?.row, row)) continue;
      this.rows.set(keyOf(table, row.id), { table, row, dirty: false });
      applied++;
    }
    if (page.clock !== undefined && page.clock > (this.clock.last() ?? "")) {
      this.clock.receive(page.clock);
    }
    this.since = page.since;
    return applied;
  }

  async wipe() {
    for (const [k, stored] of this.rows) {
      if (!stored.dirty && stored.row.hlc !== SEED_HLC) this.rows.delete(k);
    }
    this.since = 0;
  }
}

export interface ClientOptions {
  token: string;
  key: CryptoKey;
  deviceId: string;
  /** Wall time of this device; defaults to the server's clock. */
  now?: () => number;
  /** Runs before each request reaches the server (e.g. to edit mid-sync or count pushes). */
  onRequest?: (url: string, init: Parameters<HttpFetch>[1]) => void | Promise<void>;
}

export const SERVER_URL = "http://budgee.test";

export interface TestClient {
  store: MemoryStore;
  /** The vault key this device holds; tests may swap it. */
  key: CryptoKey;
  /** One sync run, over this device's store or another (e.g. an old snapshot of it). */
  sync(over?: MemoryStore): Promise<SyncResult>;
  /** Points this device at another server (a redeploy), with its new token. */
  moveTo(next: TestServer, nextToken: string): void;
}

/** A device: its store and a `sync()` that runs the core engine against `server`. */
export function testClient(server: TestServer, options: ClientOptions): TestClient {
  const now = options.now ?? server.now;
  const store = new MemoryStore(options.deviceId, now);
  let target = server;
  let token = options.token;
  const client: TestClient = {
    store,
    key: options.key,
    sync(over = client.store) {
      const fetch: HttpFetch = async (url, init) => {
        await options.onRequest?.(url, init);
        return target.app.request(url, init);
      };
      const transport = createHttpTransport({ serverUrl: SERVER_URL, token, fetch });
      return runSync({ transport, store: over, key: client.key, now });
    },
    moveTo(next: TestServer, nextToken: string) {
      target = next;
      token = nextToken;
    },
  };
  return client;
}
