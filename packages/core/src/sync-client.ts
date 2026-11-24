// One sync run on a client (spec "One sync run"), platform-free: the HTTP calls and the local
// storage are injected. 1. health, and a new serverId marks every row dirty; 2. push dirty rows
// in batches, clearing dirty only where the hlc is unchanged; 3. pull page by page, applying
// rows whose hlc wins and saving `nextSeq` with each page; 4. on resetRequired, wipe and pull
// from 0. A blob that does not decrypt stops the run with an error.
import * as v from "valibot";
import { DecryptError, decryptRow } from "./crypto";
import { fromEnvelope, InvalidRowError, type RowOf, toEnvelope } from "./envelope";
import { capClockDrift } from "./hlc";
import { shouldApply } from "./merge";
import {
  API_BASE,
  BLOB_MAX_LENGTH,
  type Envelope,
  errorResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  PULL_LIMIT,
  PUSH_MAX,
  PUSH_MAX_BYTES,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  pullResponseSchema,
  pushResponseSchema,
  type TableName,
} from "./schema";

// ─── errors ─────────────────────────────────────────────────────────────────

/**
 * - `offline`: the server could not be reached (network failure or timeout).
 * - `unauthorized`: the server does not know this device's token.
 * - `device_revoked`: this device was removed; syncing stops until it is paired again.
 * - `server`: the server answered with an error status.
 * - `bad_response`: the server's answer did not match the API.
 * - `decrypt`: a pulled blob did not decrypt (wrong vault key or tampering).
 * - `invalid_row`: a row failed its table's schema (pulled after decrypting, or local).
 * - `row_too_large`: a local row encrypts to a blob larger than the server accepts.
 * - `internal`: anything else, e.g. local storage failing.
 */
export type SyncErrorKind =
  | "offline"
  | "unauthorized"
  | "device_revoked"
  | "server"
  | "bad_response"
  | "decrypt"
  | "invalid_row"
  | "row_too_large"
  | "internal";

export interface SyncFailure {
  kind: SyncErrorKind;
  /** For logs and tooltips; never row contents or secrets. */
  message: string;
  /** The row at fault, for the row kinds. */
  table?: TableName;
  id?: string;
}

export class SyncError extends Error {
  override name = "SyncError";
  readonly kind: SyncErrorKind;
  readonly table: TableName | undefined;
  readonly id: string | undefined;
  /** The HTTP status of a server error answer. */
  readonly status: number | undefined;
  /** The server's error `code` (e.g. `invalid_code`, `already_set_up`), when it sent one. */
  readonly code: string | undefined;

  constructor(
    kind: SyncErrorKind,
    message: string,
    options: ErrorOptions & { table?: TableName; id?: string; status?: number; code?: string } = {},
  ) {
    super(message, options);
    this.kind = kind;
    this.table = options.table;
    this.id = options.id;
    this.status = options.status;
    this.code = options.code;
  }

  toFailure(): SyncFailure {
    return {
      kind: this.kind,
      message: this.message,
      ...(this.table ? { table: this.table } : {}),
      ...(this.id ? { id: this.id } : {}),
    };
  }
}

// ─── ports ──────────────────────────────────────────────────────────────────

/** The sync API calls. Implementations throw SyncError. */
export interface SyncTransport {
  health(): Promise<HealthResponse>;
  push(request: PushRequest): Promise<PushResponse>;
  pull(query: { since: number; limit?: number }): Promise<PullResponse>;
}

/** A synced row (live or tombstone) and its table, without local flags. */
export interface SyncRow<T extends TableName = TableName> {
  table: T;
  row: RowOf<T>;
}

export interface SyncRowRef {
  table: TableName;
  id: string;
  hlc: string;
}

export interface PulledPage {
  /** Decrypted rows whose hlc beat the local row when the page was read. */
  rows: readonly SyncRow[];
  /** The hlc for the local clock to receive (the page's highest, drift-capped); undefined if empty. */
  clock: string | undefined;
  /** The page's `nextSeq`, to save as the next pull's `since`. */
  since: number;
}

/** The local side of a sync. */
export interface SyncStore {
  /** The serverId last synced with (undefined before the first sync) and the last pulled seq. */
  state(): Promise<{ serverId: string | undefined; since: number }>;
  /** A server not synced with before: mark every row dirty, save `serverId`, set since to 0. */
  adoptServer(serverId: string): Promise<void>;
  /** Every row with a change not yet pushed. */
  dirtyRows(): Promise<SyncRow[]>;
  /** Clears dirty on each row whose hlc still equals the pushed one, in one transaction. */
  markPushed(rows: readonly SyncRowRef[]): Promise<void>;
  /** The local hlc of each row, undefined where there is none. */
  localHlcs(rows: readonly { table: TableName; id: string }[]): Promise<(string | undefined)[]>;
  /**
   * In one transaction: writes each row whose hlc still beats the local one (not dirty), has
   * the local clock receive `clock`, and saves `since`. Returns how many rows were written.
   */
  applyPage(page: PulledPage): Promise<number>;
  /** resetRequired: removes every synced row that is not dirty and sets since to 0. */
  wipe(): Promise<void>;
}

// ─── push batches ───────────────────────────────────────────────────────────

const encoder = new TextEncoder();
/** `{"envelopes":[]}`: the push body around the envelopes. */
const PUSH_WRAPPER_BYTES = 16;

/**
 * Splits envelopes into push requests of at most `maxCount` envelopes and `maxBytes` of
 * serialized JSON body each, keeping their order.
 */
export function batchEnvelopes(
  envelopes: readonly Envelope[],
  { maxCount = PUSH_MAX, maxBytes = PUSH_MAX_BYTES } = {},
): Envelope[][] {
  const batches: Envelope[][] = [];
  let batch: Envelope[] = [];
  let bytes = PUSH_WRAPPER_BYTES;
  for (const envelope of envelopes) {
    const size = encoder.encode(JSON.stringify(envelope)).length;
    // A comma before every envelope but the first.
    const added = batch.length === 0 ? size : size + 1;
    if (batch.length > 0 && (batch.length >= maxCount || bytes + added > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = PUSH_WRAPPER_BYTES;
    }
    bytes += batch.length === 0 ? size : size + 1;
    batch.push(envelope);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// ─── one run ────────────────────────────────────────────────────────────────

export interface SyncOptions {
  transport: SyncTransport;
  store: SyncStore;
  /** The vault key. */
  key: CryptoKey;
  /** Wall time in ms, for the clock drift cap. */
  now?: () => number;
}

export interface SyncResult {
  /** `synced`: the run finished; `offline`: the server could not be reached; `error`: see `error`. */
  status: "synced" | "offline" | "error";
  /** Envelopes sent. */
  pushed: number;
  /** Envelopes received. */
  pulled: number;
  /** Pulled rows written locally (the rest were older than what this device holds). */
  applied: number;
  /** The server answered resetRequired, so local rows were wiped and pulled again. */
  reset: boolean;
  /** The serverId differed from the stored one, so every row was pushed again. */
  serverChanged: boolean;
  error?: SyncFailure;
}

const rowError = (kind: SyncErrorKind, ref: { table: TableName; id: string }, error: Error) =>
  new SyncError(kind, `${ref.table}/${ref.id}: ${error.message}`, {
    table: ref.table,
    id: ref.id,
    cause: error,
  });

async function decode(key: CryptoKey, envelope: Envelope): Promise<SyncRow> {
  try {
    return { table: envelope.table, row: await fromEnvelope(key, envelope) };
  } catch (error) {
    if (error instanceof DecryptError) throw rowError("decrypt", envelope, error);
    if (error instanceof InvalidRowError) throw rowError("invalid_row", envelope, error);
    throw error;
  }
}

/** Runs the four steps once. Never throws: failures come back in the result. */
export async function runSync({
  transport,
  store,
  key,
  now = Date.now,
}: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = {
    status: "synced",
    pushed: 0,
    pulled: 0,
    applied: 0,
    reset: false,
    serverChanged: false,
  };
  // A local row that cannot be pushed is reported, but does not hold back the others.
  let skipped: SyncError | undefined;

  try {
    // 1. Health; a different serverId means a reset or new server, which needs a full copy.
    const { serverId } = await transport.health();
    if ((await store.state()).serverId !== serverId) {
      await store.adoptServer(serverId);
      result.serverChanged = true;
    }

    // 2. Push dirty rows.
    const envelopes: Envelope[] = [];
    for (const { table, row } of await store.dirtyRows()) {
      let envelope: Envelope;
      try {
        envelope = await toEnvelope(key, table, row);
      } catch (error) {
        if (!(error instanceof InvalidRowError)) throw error;
        skipped ??= rowError("invalid_row", { table, id: row.id }, error);
        continue;
      }
      if (!envelope.deleted && envelope.blob.length > BLOB_MAX_LENGTH) {
        skipped ??= new SyncError(
          "row_too_large",
          `${table}/${row.id} is ${envelope.blob.length} characters encrypted, over the ${BLOB_MAX_LENGTH} the server accepts`,
          { table, id: row.id },
        );
        continue;
      }
      envelopes.push(envelope);
    }
    for (const batch of batchEnvelopes(envelopes)) {
      await transport.push({ envelopes: batch });
      await store.markPushed(batch.map(({ table, id, hlc }) => ({ table, id, hlc })));
      result.pushed += batch.length;
    }

    // 3 and 4. Pull until done; on resetRequired wipe and start over from 0.
    let { since } = await store.state();
    for (;;) {
      const page = await transport.pull({ since, limit: PULL_LIMIT });
      if (page.resetRequired) {
        if (since === 0 || result.reset) {
          throw new SyncError("bad_response", "The server asked for a reset of a pull from 0");
        }
        await store.wipe();
        result.reset = true;
        since = 0;
        continue;
      }
      if (page.nextSeq < since || (page.hasMore && page.nextSeq === since)) {
        throw new SyncError(
          "bad_response",
          `The server's nextSeq ${page.nextSeq} does not move past ${since}`,
        );
      }
      result.pulled += page.envelopes.length;

      const locals = await store.localHlcs(page.envelopes);
      const winners = page.envelopes.filter((envelope, i) => {
        const hlc = locals[i];
        return shouldApply(hlc === undefined ? undefined : { hlc }, envelope);
      });
      const rows = await Promise.all(winners.map((envelope) => decode(key, envelope)));
      let highest: string | undefined;
      for (const { hlc } of page.envelopes)
        if (highest === undefined || hlc > highest) highest = hlc;

      result.applied += await store.applyPage({
        rows,
        clock: highest === undefined ? undefined : capClockDrift(highest, now()),
        since: page.nextSeq,
      });
      since = page.nextSeq;
      if (!page.hasMore) break;
    }
  } catch (error) {
    const failure =
      error instanceof SyncError
        ? error.toFailure()
        : {
            kind: "internal" as const,
            message: error instanceof Error ? error.message : String(error),
          };
    return { ...result, status: failure.kind === "offline" ? "offline" : "error", error: failure };
  }

  if (skipped) return { ...result, status: "error", error: skipped.toFailure() };
  return result;
}

// ─── vault key check ────────────────────────────────────────────────────────

/**
 * Whether `key` opens the server's data, before this device pushes anything with it (a key typed
 * in from a recovery key, say). Pulls from 0 up to the first live envelope and decrypts it.
 * `no_data`: the server holds no live rows, so any key fits. Transport failures are thrown.
 */
export async function checkVaultKey(
  transport: SyncTransport,
  key: CryptoKey,
): Promise<"matches" | "mismatch" | "no_data"> {
  let since = 0;
  for (;;) {
    const page = await transport.pull({ since, limit: PULL_LIMIT });
    const live = page.envelopes.find((envelope) => !envelope.deleted);
    if (live && !live.deleted) {
      try {
        await decryptRow(key, live);
        return "matches";
      } catch (error) {
        if (error instanceof DecryptError) return "mismatch";
        throw error;
      }
    }
    if (!page.hasMore || page.nextSeq <= since) return "no_data";
    since = page.nextSeq;
  }
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

/** The part of `fetch` the API clients use. */
export type HttpFetch = (
  url: string,
  init: {
    method: "GET" | "POST" | "PATCH";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface HttpTransportOptions {
  /** Absolute server origin (http or https), never a relative path. */
  serverUrl: string;
  /** The device token, sent as `Authorization: Bearer`. */
  token: string;
  fetch: HttpFetch;
  /** Per request, including reading the body; then the request counts as offline. */
  timeoutMs?: number;
}

export const SYNC_TIMEOUT_MS = 30_000;

export type ApiRequest = <S extends v.GenericSchema>(
  schema: S,
  method: "GET" | "POST" | "PATCH",
  path: string,
  options?: { auth?: boolean; body?: unknown },
) => Promise<v.InferOutput<S>>;

/**
 * JSON requests under `<serverUrl>/api/v1`, answers checked against `schema`. Throws SyncError:
 * `offline` when unreachable, `unauthorized` / `device_revoked` on 401, `server` on other error
 * statuses (each with the server's error `code` and the `status`), `bad_response` otherwise.
 * Throws TypeError at once for a server URL that is not absolute http or https.
 */
export function createApiRequest({
  serverUrl,
  token,
  fetch,
  timeoutMs = SYNC_TIMEOUT_MS,
}: Omit<HttpTransportOptions, "token"> & { token?: string | undefined }): ApiRequest {
  let base: URL;
  try {
    base = new URL(serverUrl);
  } catch (cause) {
    throw new TypeError("The server URL must be absolute", { cause });
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new TypeError("The server URL must be http or https");
  }
  const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}${API_BASE}`;

  return async (schema, method, path, { auth = true, body } = {}) => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth) {
      if (!token) throw new SyncError("unauthorized", `${method} ${path} needs a device token`);
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await fetch(`${root}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      status = response.status;
      text = await response.text();
    } catch (cause) {
      const what = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : "failed";
      throw new SyncError("offline", `${method} ${path} ${what}`, { cause });
    } finally {
      clearTimeout(timer);
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (status < 200 || status > 299) {
      const parsed = v.safeParse(errorResponseSchema, data);
      const code = parsed.success ? parsed.output.error.code : undefined;
      const message = `${method} ${path} answered ${status}${code ? ` (${code})` : ""}`;
      const kind: SyncErrorKind =
        status !== 401 ? "server" : code === "device_revoked" ? "device_revoked" : "unauthorized";
      throw new SyncError(kind, message, { status, ...(code ? { code } : {}) });
    }
    const parsed = v.safeParse(schema, data);
    if (!parsed.success) {
      throw new SyncError("bad_response", `${method} ${path} answered with an unexpected body`);
    }
    return parsed.output;
  };
}

/** The sync API over HTTP. Throws SyncError with the kind of failure. */
export function createHttpTransport(options: HttpTransportOptions): SyncTransport {
  const request = createApiRequest(options);
  return {
    health: () => request(healthResponseSchema, "GET", "/health", { auth: false }),
    push: (body) => request(pushResponseSchema, "POST", "/sync/push", { body }),
    pull: ({ since, limit = PULL_LIMIT }) =>
      request(pullResponseSchema, "GET", `/sync/pull?since=${since}&limit=${limit}`),
  };
}
