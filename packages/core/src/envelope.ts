// Rows ⇄ envelopes. Only the sync columns travel in the clear; the user fields are encrypted
// into `blob`. Tombstones carry no blob and need no key.
import * as v from "valibot";
import { decryptRow, encryptRow } from "./crypto";
import { type Envelope, fieldSchemas, rowSchemas, type TableName } from "./schema";

export type RowOf<T extends TableName> = v.InferOutput<(typeof rowSchemas)[T]>;
export type RowInputOf<T extends TableName> = v.InferInput<(typeof rowSchemas)[T]>;

/**
 * Where a row failed and which check failed, never what it held. Valibot issues carry the raw
 * input (and default messages quote it), which would put decrypted data into logs.
 */
export interface RowIssue {
  /** Dotted field path; `?` stands for an unknown key, whose name is data too. */
  path: string;
  /** `schema`: wrong type or shape; `validation`: a check or action failed. */
  kind: "schema" | "validation" | "transformation";
  /** Valibot schema or action name, e.g. `number`, `strict_object`, `check`, `min_value`. */
  type: string;
  /** What the schema expected, from the schema itself (e.g. `number`); null for checks. */
  expected: string | null;
}

function toRowIssue(issue: v.BaseIssue<unknown>): RowIssue {
  const path = (issue.path ?? [])
    .map((item) => (item.origin === "key" ? "?" : String(item.key)))
    .join(".");
  return { path, kind: issue.kind, type: issue.type, expected: issue.expected };
}

/** A row that does not satisfy its table's schema: before encrypting, or after decrypting. */
export class InvalidRowError extends Error {
  override name = "InvalidRowError";
  readonly table: TableName;
  readonly issues: readonly RowIssue[];

  constructor(table: TableName, issues: readonly v.BaseIssue<unknown>[]) {
    const safe = issues.map(toRowIssue);
    const summary = safe
      .map((i) => {
        const what = i.kind === "schema" ? "invalid_type" : i.type;
        return `${i.path || "(row)"}: ${what}${i.expected ? ` (expected ${i.expected})` : ""}`;
      })
      .join("; ");
    super(`Invalid ${table} row: ${summary}`);
    this.table = table;
    this.issues = safe;
  }
}

function parse(schema: v.GenericSchema, table: TableName, input: unknown): unknown {
  const result = v.safeParse(schema, input);
  if (!result.success) throw new InvalidRowError(table, result.issues);
  return result.output;
}

interface SyncColumns {
  id: string;
  hlc: string;
  deleted: boolean;
  device: string;
}

/** Validates the row (filling schema defaults), then encrypts its fields. Throws InvalidRowError. */
export async function toEnvelope<T extends TableName>(
  key: CryptoKey,
  table: T,
  row: RowInputOf<T>,
): Promise<Envelope> {
  const parsed = parse(rowSchemas[table], table, row) as SyncColumns & Record<string, unknown>;
  const { id, hlc, deleted, device, ...fields } = parsed;
  if (deleted) return { table, id, hlc, deleted: true, device };
  const blob = await encryptRow(key, table, id, hlc, fields);
  return { table, id, hlc, deleted: false, device, blob };
}

/**
 * The row an envelope holds; `seq` is dropped. Throws DecryptError when the blob does not
 * decrypt (wrong key, moved, modified) and InvalidRowError when the decrypted fields fail the
 * table's field schema.
 */
export async function fromEnvelope<T extends TableName>(
  key: CryptoKey,
  envelope: Envelope & { table: T },
): Promise<RowOf<T>> {
  const { table, id, hlc, device } = envelope;
  if (envelope.deleted) {
    return parse(rowSchemas[table], table, { id, hlc, deleted: true, device }) as RowOf<T>;
  }
  const fields = parse(fieldSchemas[table], table, await decryptRow(key, envelope)) as object;
  // The row schema adds the cross-column checks (a settings row's id must match its key).
  return parse(rowSchemas[table], table, {
    ...fields,
    id,
    hlc,
    deleted: false,
    device,
  }) as RowOf<T>;
}
