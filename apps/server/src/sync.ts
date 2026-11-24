// Push and pull of encrypted envelopes.
import {
  type Envelope,
  PUSH_MAX_BYTES,
  type PullResponse,
  type PushResponse,
  pullQuerySchema,
  pushRequestSchema,
  type TableName,
} from "@budgee/core";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "./app";
import type { AuthEnv } from "./auth";
import { storeEnvelopes } from "./envelopes";
import { limitBody, parseInput, readBody } from "./http";
import { readPurgeSeq } from "./init";

interface EnvelopeRow {
  table: TableName;
  id: string;
  hlc: string;
  deleted: number;
  device: string;
  seq: number;
  blob: string | null;
}

// The acknowledged position for a pull from `?` (since): never past the last seq handed out.
const ACK = "MIN(?, (SELECT value FROM seq_counter WHERE id = 1))";

const toEnvelope = ({ table, id, hlc, deleted, device, seq, blob }: EnvelopeRow): Envelope =>
  deleted
    ? { table, id, hlc, deleted: true, device, seq }
    : { table, id, hlc, deleted: false, device, seq, blob: blob ?? "" };

export function syncRoutes(
  api: Hono<AuthEnv>,
  { db, clock }: AppDeps,
  auth: MiddlewareHandler<AuthEnv>,
) {
  // Auth first, so only paired devices get to send a large body.
  api.post("/sync/push", auth, limitBody(PUSH_MAX_BYTES), async (c) => {
    const { envelopes } = await readBody(c, pushRequestSchema);
    return c.json<PushResponse>(await storeEnvelopes(db, envelopes, clock.now()));
  });

  api.get("/sync/pull", auth, async (c) => {
    const { since, limit } = parseInput(pullQuerySchema, c.req.query());

    // The cleanup job reads this to know what every device has seen. Capped at the last seq handed
    // out, so a client cannot vouch for tombstones it never saw. No write when unchanged.
    await db.run(
      `UPDATE devices SET last_ack_seq = ${ACK} WHERE id = ? AND last_ack_seq <> ${ACK}`,
      [since, c.get("deviceId"), since],
    );

    // A device starting from 0 holds nothing, so purged tombstones cannot matter to it.
    if (since > 0 && since < (await readPurgeSeq(db))) {
      return c.json<PullResponse>({
        envelopes: [],
        nextSeq: 0,
        hasMore: false,
        resetRequired: true,
      });
    }

    // One row more than asked tells whether another page follows.
    const rows = await db.query<EnvelopeRow>(
      `SELECT "table", id, hlc, deleted, device, seq, blob FROM envelopes
       WHERE seq > ? ORDER BY seq LIMIT ?`,
      [since, limit + 1],
    );
    const page = rows.slice(0, limit);
    return c.json<PullResponse>({
      envelopes: page.map(toEnvelope),
      nextSeq: page.at(-1)?.seq ?? since,
      hasMore: rows.length > limit,
      resetRequired: false,
    });
  });
}
