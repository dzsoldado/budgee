// What Settings → Backups shows: the destination's state, errors from the backup API, and the
// message for Google sending the browser back to `/#/settings?drive=connected|error&reason=…`.
import { type BackupStatusResponse, SyncError } from "@budgee/core";
import { type MessageKey, t } from "../i18n";

export type BackupState = "not_configured" | "not_connected" | "connected" | "reconnect";

export function backupState(destination: BackupStatusResponse["destination"]): BackupState {
  if (!destination.configured) return "not_configured";
  if (!destination.connected) return "not_connected";
  return destination.reconnectNeeded ? "reconnect" : "connected";
}

/** The query params of Google's return to Settings, removed once read. */
export const DRIVE_PARAMS = ["drive", "reason"] as const;

/** The server's ConnectFailure reasons. */
const RETURN_TEXT: Readonly<Record<string, MessageKey>> = {
  invalid_state: "backups.return.invalidState",
  expired: "backups.return.expired",
  denied: "backups.return.denied",
  google_error: "backups.return.googleError",
  exchange_failed: "backups.return.exchangeFailed",
  no_refresh_token: "backups.return.noRefreshToken",
  missing_scope: "backups.return.missingScope",
};

/**
 * What to tell the user after Google's return; undefined when the route has no `drive`.
 * `connected` is what the status read afterwards says: `drive=connected` is only believed when
 * the server confirms it (anyone can type the param into the address).
 */
export function driveReturn(
  params: { drive?: string | undefined; reason?: string | undefined },
  connected = false,
): { ok: boolean; text: string } | undefined {
  if (!params.drive) return undefined;
  if (params.drive === "connected" && connected) {
    return { ok: true, text: t("backups.return.connected") };
  }
  const reason = params.reason ?? "";
  const key = Object.hasOwn(RETURN_TEXT, reason) ? RETURN_TEXT[reason] : undefined;
  return { ok: false, text: t(key ?? "backups.return.failed") };
}

const FAILURE_TEXT: Readonly<Record<string, MessageKey>> = {
  reconnect: "backups.failure.reconnect",
  refused: "backups.failure.refused",
  not_found: "backups.failure.notFound",
  unavailable: "backups.failure.unavailable",
};

/**
 * A backup failure in plain words, from the server's error code (core BackupErrorCode). The
 * server's message stays out of the UI; an unknown or missing code reads as `other`.
 */
export function backupFailureText(code: string | null | undefined): string {
  const key = code && Object.hasOwn(FAILURE_TEXT, code) ? FAILURE_TEXT[code] : undefined;
  return t(key ?? "backups.failure.other");
}

/** Why a backup API call failed, in words. `host`: the server's host. */
export function backupErrorText(error: unknown, host: string): string {
  if (error instanceof SyncError) {
    if (error.code === "not_configured") return t("backups.notConfiguredHint");
    if (error.kind === "offline") return t("backups.error.offline", { host });
    if (error.kind === "device_revoked") return t("sync.revokedHint");
  }
  return t("backups.error.unknown");
}

const DAY_KEYS: Readonly<Record<number, MessageKey>> = {
  [-1]: "backups.yesterday",
  0: "backups.today",
  1: "backups.tomorrow",
};

/** "Today, 3:00 AM", "Yesterday, …", "Tomorrow, …", else "Nov 15, 3:00 AM", in local time. */
export function formatWhen(at: number, now: number, locale: string): string {
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(at);
  const midnight = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(at) - midnight(now)) / 86_400_000);
  const key = DAY_KEYS[days];
  if (key) return t(key, { time });
  const date = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(new Date(at).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  }).format(at);
  return t("backups.onDate", { date, time });
}
