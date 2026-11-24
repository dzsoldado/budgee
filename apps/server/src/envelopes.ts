import type { Envelope } from "@budgee/core";
import type { Db, Statement } from "./ports";

// Reserves one number per envelope of the push with a single counter write; envelope i then
// takes `counter - n + 1 + i`. Running in the same batch as the upserts makes the whole push
// atomic on every SQLite engine without an interactive transaction. An ignored envelope still
// uses up its number: seq has gaps but never goes back.
const RESERVE_SEQ = "UPDATE seq_counter SET value = value + ? WHERE id = 1";

// Stores the envelope only if the row is new or the incoming hlc is higher (plain text order).
// updated_at is the server time of the store, which the tombstone cleanup goes by.
const UPSERT = `INSERT INTO envelopes ("table", id, hlc, deleted, device, seq, blob, updated_at)
VALUES (?, ?, ?, ?, ?, (SELECT value FROM seq_counter WHERE id = 1) - ?, ?, ?)
ON CONFLICT ("table", id) DO UPDATE SET
  hlc = excluded.hlc, deleted = excluded.deleted, device = excluded.device,
  seq = excluded.seq, blob = excluded.blob, updated_at = excluded.updated_at
WHERE excluded.hlc > envelopes.hlc`;

export interface StoreResult {
  accepted: number;
  /** Not newer than the row the server already holds. */
  ignored: number;
}

/**
 * Upserts the envelopes in one batch, in order. Each stored envelope gets a new `seq` above every
 * earlier one and `now` (server clock, ms) as its `updated_at`; the envelope's own `seq`
 * field, if any, is ignored.
 */
export async function storeEnvelopes(
  db: Db,
  envelopes: readonly Envelope[],
  now: number,
): Promise<StoreResult> {
  const n = envelopes.length;
  if (n === 0) return { accepted: 0, ignored: 0 };

  const statements: Statement[] = [
    { sql: RESERVE_SEQ, params: [n] },
    ...envelopes.map((e, i) => ({
      sql: UPSERT,
      // seq = counter - (n - 1 - i)
      params: [
        e.table,
        e.id,
        e.hlc,
        e.deleted ? 1 : 0,
        e.device,
        n - 1 - i,
        e.deleted ? null : e.blob,
        now,
      ],
    })),
  ];
  const results = await db.batch(statements);
  const accepted = results.slice(1).filter((r) => r.changes > 0).length;
  return { accepted, ignored: n - accepted };
}
