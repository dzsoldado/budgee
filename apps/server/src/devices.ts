// Setup, pairing and the device list for Settings.
import {
  type Device,
  type DeviceListResponse,
  type InviteResponse,
  PAIRING_CODE_TTL_MS,
  type PairResponse,
  pairRequestSchema,
  renameDeviceRequestSchema,
  revokeDeviceRequestSchema,
  type SetupResponse,
  setupRequestSchema,
} from "@budgee/core";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "./app";
import type { AuthEnv } from "./auth";
import { ApiError, limitBody, notFound, readBody, SMALL_BODY_MAX } from "./http";
import type { Db } from "./ports";
import { limitGuesses } from "./rate-limit";
import {
  newPairingCode,
  normalizePairingCode,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from "./tokens";

interface DeviceRow {
  id: string;
  name: string;
  created_at: number;
  last_seen: number | null;
  revoked: number;
}

const DEVICE_COLUMNS = "id, name, created_at, last_seen, revoked";

const toDevice = (row: DeviceRow, caller: string): Device => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastSeen: row.last_seen,
  revoked: row.revoked === 1,
  current: row.id === caller,
});

async function loadDevice(db: Db, id: string, caller: string): Promise<Device> {
  const [row] = await db.query<DeviceRow>(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ?`, [
    id,
  ]);
  if (!row) throw notFound();
  return toDevice(row, caller);
}

/** Shorter SETUP_SECRETs get a startup warning: /setup is public until the first device. */
export const SETUP_SECRET_MIN_LENGTH = 32;

/** The startup warning for a short SETUP_SECRET (never the secret itself), or null. */
export function weakSetupSecretWarning(secret: string | undefined): string | null {
  if (!secret || secret.length >= SETUP_SECRET_MIN_LENGTH) return null;
  return `SETUP_SECRET is shorter than ${SETUP_SECRET_MIN_LENGTH} characters: anyone who guesses it before your first device sets up the server owns it. Use a long random value (see .env.example).`;
}

/**
 * Revokes a device unless it is the last one not revoked: /setup only runs on a server without
 * devices, so revoking the last one would lock everyone out for good. The check and the write are
 * one statement, so racing revokes cannot leave none. A revoke also drops every pairing code, so a
 * code shown on (or copied from) a revoked device cannot let a new device in. Returns whether the
 * device is revoked now (false: refused, or no such device).
 */
export async function revokeDevice(db: Db, id: string): Promise<boolean> {
  await db.batch([
    {
      sql: `UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0
        AND EXISTS (SELECT 1 FROM devices WHERE revoked = 0 AND id <> ?)`,
      params: [id, id],
    },
    {
      sql: "DELETE FROM pairing_codes WHERE EXISTS (SELECT 1 FROM devices WHERE id = ? AND revoked = 1)",
      params: [id],
    },
  ]);
  const [row] = await db.query<{ revoked: number }>("SELECT revoked FROM devices WHERE id = ?", [
    id,
  ]);
  return row?.revoked === 1;
}

// Same answer whether the code is unknown, used or expired, so guessing learns nothing.
const invalidCode = () =>
  new ApiError(401, "invalid_code", "Pairing code is invalid or has expired");

export function deviceRoutes(
  api: Hono<AuthEnv>,
  { db, clock, config, limiter, clientIp }: AppDeps,
  auth: MiddlewareHandler<AuthEnv>,
) {
  const small = limitBody(SMALL_BODY_MAX);
  // First on the two routes that take a guessable secret, before any database work.
  const guesses = limitGuesses(limiter, clientIp);

  /** A new device's token and the start of its INSERT … SELECT; the caller appends a WHERE. */
  const insertDevice = async (name: string) => {
    const token = randomToken();
    const now = clock.now();
    return {
      token,
      sql: "INSERT INTO devices (id, name, token_hash, created_at, last_seen) SELECT ?, ?, ?, ?, ?",
      params: [crypto.randomUUID(), name, await sha256Hex(token), now, now],
    };
  };

  api.post("/setup", guesses, small, async (c) => {
    const { secret, deviceName } = await readBody(c, setupRequestSchema);
    if (!config.setupSecret) {
      throw new ApiError(403, "setup_disabled", "Setup is not enabled: SETUP_SECRET is not set");
    }
    if (!(await timingSafeEqual(secret, config.setupSecret))) {
      throw new ApiError(401, "invalid_secret", "Wrong setup secret");
    }
    const device = await insertDevice(deviceName);
    // One statement, so two racing setups cannot both see an empty table.
    const { changes } = await db.run(
      `${device.sql} WHERE NOT EXISTS (SELECT 1 FROM devices)`,
      device.params,
    );
    if (changes === 0) {
      throw new ApiError(409, "already_set_up", "Server already set up: pair from a device");
    }
    return c.json<SetupResponse>({ token: device.token, serverId: config.serverId });
  });

  api.post("/devices/invite", auth, async (c) => {
    const code = newPairingCode();
    const now = clock.now();
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    await db.batch([
      { sql: "DELETE FROM pairing_codes WHERE used = 1 OR expires_at <= ?", params: [now] },
      {
        sql: "INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)",
        params: [await sha256Hex(code), expiresAt],
      },
    ]);
    return c.json<InviteResponse>({ code, expiresAt });
  });

  api.post("/devices/pair", guesses, small, async (c) => {
    const body = await readBody(c, pairRequestSchema);
    const code = normalizePairingCode(body.code);
    if (code === null) throw invalidCode();

    const valid = "code_hash = ? AND used = 0 AND expires_at > ?";
    const validParams = [await sha256Hex(code), clock.now()];
    const device = await insertDevice(body.deviceName);
    // Both statements test the code in the same transaction: the device exists exactly when the
    // code was consumed, and a second use (even a racing one) finds it used.
    const [inserted] = await db.batch([
      {
        sql: `${device.sql} WHERE EXISTS (SELECT 1 FROM pairing_codes WHERE ${valid})`,
        params: [...device.params, ...validParams],
      },
      { sql: `UPDATE pairing_codes SET used = 1 WHERE ${valid}`, params: validParams },
    ]);
    if (!inserted?.changes) throw invalidCode();
    return c.json<PairResponse>({ token: device.token, serverId: config.serverId });
  });

  api.get("/devices", auth, async (c) => {
    const rows = await db.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM devices ORDER BY created_at, id`,
    );
    const caller = c.get("deviceId");
    return c.json<DeviceListResponse>({ devices: rows.map((row) => toDevice(row, caller)) });
  });

  api.patch("/devices/:id", auth, small, async (c) => {
    const { name } = await readBody(c, renameDeviceRequestSchema);
    const id = c.req.param("id");
    const { changes } = await db.run("UPDATE devices SET name = ? WHERE id = ?", [name, id]);
    if (changes === 0) throw notFound();
    return c.json<Device>(await loadDevice(db, id, c.get("deviceId")));
  });

  api.post("/devices/:id/revoke", auth, small, async (c) => {
    const { confirmSelf } = await readBody(c, revokeDeviceRequestSchema, { optional: true });
    const id = c.req.param("id");
    const device = await loadDevice(db, id, c.get("deviceId"));
    if (device.current && !confirmSelf) {
      throw new ApiError(
        409,
        "confirm_self_required",
        "This is the device making the request: send confirmSelf: true to revoke it",
      );
    }
    if (!(await revokeDevice(db, id))) {
      throw new ApiError(
        409,
        "last_device",
        "This is the only device left: pair another device before revoking it",
      );
    }
    return c.json<Device>({ ...device, revoked: true });
  });
}
