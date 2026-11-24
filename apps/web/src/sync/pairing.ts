// Joining a server (spec "Pairing and auth"): the first device claims it with the setup secret
// and creates the vault key; others pair with a one-time code and receive the key from the
// pairing link or a recovery key. What a paired device keeps lives in `meta`; local entries stay
// when the pairing is forgotten. Secrets are never logged.
import {
  checkVaultKey,
  type Device,
  exportKey,
  generateVaultKey,
  SEED_HLC,
  SYNCED_TABLES,
  SyncError,
  toRecoveryKey,
} from "@budgee/core";
import { type BudgeeDb, deleteMeta, type MetaKey, setMeta } from "../db/db";
import { type MessageKey, t } from "../i18n";
import type { Platform } from "../platform/types";
import { readPairing } from "./controller";

/**
 * `check_failed`: the key check could not reach the server. `unverified`: the server has no rows
 * to check the key against and the user chose not to go on. `save_failed`: this device could not
 * keep the pairing. The last three revoke the new device again.
 */
export type PairingProblem =
  | "invalid_url"
  | "other_server"
  | "key_mismatch"
  | "check_failed"
  | "unverified"
  | "save_failed";

export class PairingError extends Error {
  override name = "PairingError";
  readonly reason: PairingProblem;

  constructor(reason: PairingProblem) {
    super(reason);
    this.reason = reason;
  }
}

/** The origin of an absolute http(s) address; throws PairingError("invalid_url"). */
export function serverOrigin(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new PairingError("invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new PairingError("invalid_url");
  return url.origin;
}

export interface StoredPairing {
  serverUrl: string;
  deviceToken: string;
  serverId: string;
  vaultKey: CryptoKey;
}

/** Everything a pairing keeps, and the sync position that belongs to it. */
const PAIRING_KEYS: readonly MetaKey[] = [
  "serverUrl",
  "deviceToken",
  "vaultKey",
  "serverId",
  "lastPulledSeq",
  "lastSyncAt",
];

/**
 * Keeps a new pairing and queues every local row for the first push (rows pushed to an earlier
 * server included), in one transaction. Untouched defaults (SEED_HLC) stay local: every device
 * seeds its own. With the serverId already known, the first sync does not re-queue them.
 */
export async function storePairing(db: BudgeeDb, pairing: StoredPairing): Promise<void> {
  const tables = SYNCED_TABLES.map((table) => db.rows(table));
  await db.transaction("rw", [...tables, db.meta], async () => {
    for (const table of tables) {
      await table.filter((row) => row.hlc !== SEED_HLC && row.dirty === 0).modify({ dirty: 1 });
    }
    for (const key of PAIRING_KEYS) await deleteMeta(db, key);
    await setMeta(db, "serverUrl", pairing.serverUrl);
    await setMeta(db, "deviceToken", pairing.deviceToken);
    await setMeta(db, "vaultKey", pairing.vaultKey);
    await setMeta(db, "serverId", pairing.serverId);
    await setMeta(db, "lastPulledSeq", 0);
  });
}

/** Forgets the server on this device only: entries, settings and the clock stay. */
export async function forgetPairing(db: BudgeeDb): Promise<void> {
  await db.transaction("rw", db.meta, async () => {
    for (const key of PAIRING_KEYS) await deleteMeta(db, key);
  });
}

/** The recovery key text (Crockford groups) for a vault key. */
export async function recoveryKeyOf(key: CryptoKey): Promise<string> {
  return toRecoveryKey(await exportKey(key));
}
export interface PairingDeps {
  db: BudgeeDb;
  platform: Pick<Platform, "createDeviceApi" | "createSyncTransport">;
  /** Keeps the pairing; `storePairing` unless a test swaps it. */
  save?: (db: BudgeeDb, pairing: StoredPairing) => Promise<void>;
}

/**
 * The server accepted this device but the pairing could not be kept here (local storage failed).
 * `pending` holds everything needed to try saving again, in memory only: the server is already
 * claimed, so running setup again would be refused.
 */
export class PairingSaveError extends Error {
  override name = "PairingSaveError";
  readonly pending: StoredPairing;

  constructor(pending: StoredPairing, options?: ErrorOptions) {
    super("The pairing could not be saved on this device", options);
    this.pending = pending;
  }
}

/**
 * First device: claims the server with its setup secret and keeps the vault key (a new one, or a
 * restored one), created before the server is asked, so a claimed server always has a key here.
 * Returns the key, for the recovery key screen. Throws PairingSaveError when only the local save
 * failed; `storePairing(db, error.pending)` tries again.
 */
export async function setUpServer(
  { db, platform, save = storePairing }: PairingDeps,
  input: { serverUrl: string; secret: string; deviceName: string; vaultKey?: CryptoKey },
): Promise<CryptoKey> {
  const serverUrl = serverOrigin(input.serverUrl);
  const vaultKey = input.vaultKey ?? (await generateVaultKey());
  const { token, serverId } = await platform
    .createDeviceApi({ serverUrl })
    .setup({ secret: input.secret, deviceName: input.deviceName });
  const pending = { serverUrl, deviceToken: token, serverId, vaultKey };
  try {
    await save(db, pending);
  } catch (cause) {
    throw new PairingSaveError(pending, { cause });
  }
  return vaultKey;
}

/**
 * Another device: pairs with a one-time code and keeps `vaultKey`. `serverId` (from a pairing
 * link) must be the server's, checked before the code is spent.
 *
 * `checkKey` (a typed recovery key): the key must open the server's rows before anything is kept,
 * so no row encrypted with a wrong key ever reaches the server. A server with no rows cannot
 * confirm the key: `confirmUnverified` asks the user whether to go on. Whenever the new device
 * cannot be kept (wrong key, declined, the check could not run, or the local save failed twice),
 * it is revoked again, best effort, and a PairingError says why.
 */
export async function pairWithCode(
  { db, platform, save = storePairing }: PairingDeps,
  input: {
    serverUrl: string;
    code: string;
    deviceName: string;
    vaultKey: CryptoKey;
    serverId?: string;
    checkKey?: boolean;
    confirmUnverified?: () => Promise<boolean>;
  },
): Promise<void> {
  const serverUrl = serverOrigin(input.serverUrl);
  if (input.serverId !== undefined) {
    const health = await platform.createSyncTransport({ serverUrl, deviceToken: "" }).health();
    if (health.serverId !== input.serverId) throw new PairingError("other_server");
  }
  const { token, serverId } = await platform
    .createDeviceApi({ serverUrl })
    .pair({ code: input.code, deviceName: input.deviceName });
  const giveUp = async (reason: PairingProblem): Promise<never> => {
    await revokeSelf(platform.createDeviceApi({ serverUrl, deviceToken: token }));
    throw new PairingError(reason);
  };

  if (input.checkKey) {
    let result: Awaited<ReturnType<typeof checkVaultKey>>;
    try {
      result = await checkVaultKey(
        platform.createSyncTransport({ serverUrl, deviceToken: token }),
        input.vaultKey,
      );
    } catch {
      return giveUp("check_failed");
    }
    if (result === "mismatch") return giveUp("key_mismatch");
    if (result === "no_data" && !(await input.confirmUnverified?.())) return giveUp("unverified");
  }

  const pairing = { serverUrl, deviceToken: token, serverId, vaultKey: input.vaultKey };
  try {
    await save(db, pairing);
  } catch {
    try {
      await save(db, pairing);
    } catch {
      return giveUp("save_failed");
    }
  }
}

/**
 * Takes this device off the server (best effort) and forgets the pairing here; entries stay. For
 * a restored key that turns out not to match the server's data.
 */
export async function unpair({ db, platform }: PairingDeps): Promise<void> {
  const pairing = await readPairing(db);
  if (pairing) await revokeSelf(platform.createDeviceApi(pairing));
  await forgetPairing(db);
}

/** Best effort: a device left behind only shows in the list, where it can be revoked. */
async function revokeSelf(api: ReturnType<Platform["createDeviceApi"]>): Promise<void> {
  try {
    const self = (await api.list()).find((device) => device.current);
    if (self) await api.revoke(self.id, { confirmSelf: true });
  } catch {
    // Nothing more to do; the error the user sees says what went wrong.
  }
}

/**
 * Whether `device` can be revoked: the server refuses to revoke the last device not revoked, as
 * setup only runs on a server without devices and nobody could get back in.
 */
export const canRevoke = (devices: readonly Device[], device: Device) =>
  !device.revoked && devices.some((other) => !other.revoked && other.id !== device.id);

const PROBLEM_TEXT: Record<Exclude<PairingProblem, "other_server">, MessageKey> = {
  invalid_url: "pairing.error.invalidUrl",
  key_mismatch: "pairing.error.keyMismatch",
  check_failed: "pairing.error.checkFailed",
  unverified: "pairing.error.unverified",
  save_failed: "pairing.error.saveFailedPair",
};

/** What went wrong while connecting or pairing, in words. `host`: the server's host. */
export function pairingErrorText(error: unknown, host: string): string {
  if (error instanceof PairingSaveError) return t("pairing.error.saveFailed");
  if (error instanceof PairingError) {
    if (error.reason === "other_server") return t("pairing.error.otherServer", { host });
    return t(PROBLEM_TEXT[error.reason]);
  }
  if (error instanceof SyncError) {
    switch (error.code) {
      case "invalid_secret":
        return t("pairing.error.invalidSecret");
      case "already_set_up":
        return t("pairing.error.alreadySetUp");
      case "setup_disabled":
        return t("pairing.error.setupDisabled");
      case "invalid_code":
        return t("pairing.error.invalidCode");
      case "last_device":
        return t("devices.lastDeviceError");
      case "rate_limited":
        return t("pairing.error.rateLimited");
    }
    if (error.kind === "offline") return t("pairing.error.offline", { host });
    if (error.kind === "bad_response" || error.status === 404 || error.status === 405) {
      return t("pairing.error.notBudgee", { host });
    }
    if (error.kind === "device_revoked") return t("sync.revokedHint");
  }
  return t("pairing.error.unknown");
}

/**
 * Whether a new pairing may start: not while one runs, nor while a claimed pairing waits to be
 * saved here (pairing again would let a second device in). Also gates switching the sign-in mode.
 */
export const canPair = (state: { busy: boolean; pending: unknown }) =>
  !state.busy && state.pending === undefined;

/**
 * A yes/no question a pairing waits on (`ask`, e.g. "use a key the server can't check?").
 * `answer` settles it; `dismiss` answers no, for a screen that goes away with it open, so the
 * spent device is revoked rather than left waiting. Asking again declines a stale question.
 * `onOpen` tells the UI when to show or hide it.
 */
export function createQuestion(onOpen: (open: boolean) => void) {
  let settle: ((go: boolean) => void) | undefined;
  const answer = (go: boolean) => {
    const current = settle;
    if (!current) return;
    settle = undefined;
    onOpen(false);
    current(go);
  };
  return {
    ask(): Promise<boolean> {
      answer(false);
      return new Promise<boolean>((resolve) => {
        settle = resolve;
        onOpen(true);
      });
    },
    answer,
    dismiss: () => answer(false),
    get open() {
      return settle !== undefined;
    },
  };
}
