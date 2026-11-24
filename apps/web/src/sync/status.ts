// What the sync indicators show (the List pill, the sidebar card, Settings). The sync
// controller drives the signal; `describeSync` turns it into text for a given moment.
import type { SyncErrorKind, SyncFailure } from "@budgee/core";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import { type MessageKey, t } from "../i18n";

export type SyncStatus =
  | { kind: "not_paired" }
  | { kind: "syncing"; lastSyncAt: number | undefined }
  | { kind: "synced"; at: number }
  | { kind: "offline"; lastSyncAt: number | undefined }
  | { kind: "error"; error: SyncFailure; lastSyncAt: number | undefined }
  /** The server revoked this device: syncing stops until it is paired again. */
  | { kind: "revoked" };

const [syncStatus, setSyncStatus] = createSignal<SyncStatus>({ kind: "not_paired" });

export { setSyncStatus, syncStatus };

// The one polite live region (in the Shell) reads this. Only changes worth hearing go here: a
// sync the user asked for, going offline or back, a failure, this device being removed. Never
// the relative-time ticks or a quiet background sync.
const [announcement, setAnnouncement] = createSignal("");
let announceTimer: ReturnType<typeof setTimeout> | undefined;

export { announcement };

/** Says `text` in the live region; cleared first so the same words are announced again. */
export function announce(text: string) {
  setAnnouncement("");
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => setAnnouncement(text), 100);
}

/**
 * What to announce when a run settles on `next` after `previous` (the last settled status,
 * undefined at app open); undefined for nothing. `manual`: the user asked for this sync.
 */
export function announcementFor(
  previous: SyncStatus | undefined,
  next: SyncStatus,
  manual: boolean,
): string | undefined {
  switch (next.kind) {
    case "synced":
      if (previous?.kind === "offline") return t("sync.announce.backOnline");
      if (manual || previous?.kind === "error") return t("sync.announce.synced");
      return undefined;
    case "offline":
      return manual || (previous !== undefined && previous.kind !== "offline")
        ? t("sync.announce.offline")
        : undefined;
    case "error":
      return manual || previous?.kind !== "error" || previous.error.kind !== next.error.kind
        ? t("sync.announce.failed", { reason: failureText(next.error) })
        : undefined;
    case "revoked":
      return manual || previous?.kind !== "revoked" ? t("sync.revokedHint") : undefined;
    default:
      return undefined;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A clock for relative times, ticking while the calling component lives. */
export function createNow(intervalMs = 15_000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), intervalMs);
  onCleanup(() => clearInterval(timer));
  return now;
}

/**
 * How long ago `at` was: `short` for the pill ("3 min ago"), `long` for screen readers and
 * tooltips ("3 minutes ago", from Intl.RelativeTimeFormat in the app's language).
 */
export function timeAgo(at: number, now: number, locale: string): { short: string; long: string } {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return { short: t("sync.justNow"), long: t("sync.justNow") };
  const [n, unit, key]: [number, Intl.RelativeTimeFormatUnit, MessageKey] =
    elapsed < HOUR
      ? [Math.floor(elapsed / MINUTE), "minute", "sync.minutesAgo"]
      : elapsed < DAY
        ? [Math.floor(elapsed / HOUR), "hour", "sync.hoursAgo"]
        : [Math.floor(elapsed / DAY), "day", "sync.daysAgo"];
  const long = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "long" });
  return { short: t(key, { n }), long: long.format(-n, unit) };
}

const ERROR_TEXT: Record<SyncErrorKind, MessageKey> = {
  offline: "sync.offlineHint",
  unauthorized: "sync.error.unauthorized",
  device_revoked: "sync.revokedHint",
  server: "sync.error.server",
  bad_response: "sync.error.badResponse",
  decrypt: "sync.error.decrypt",
  invalid_row: "sync.error.invalidRow",
  row_too_large: "sync.error.rowTooLarge",
  internal: "sync.error.internal",
};

/** Why a sync failed, in words; row errors name the table and id. */
export const failureText = (error: SyncFailure) =>
  t(ERROR_TEXT[error.kind], { table: error.table ?? "", id: error.id ?? "" });

export interface SyncView {
  /** A sync can be started (paired and not revoked); otherwise the indicator leads to Settings. */
  canSync: boolean;
  syncing: boolean;
  dot: "on" | "off" | "error";
  /** The pill's text ("3 min ago"). */
  short: string;
  /** The status line ("Synced 3 min ago"). */
  label: string;
  /** More about the state (the error's reason, when it last synced); undefined when none. */
  note: string | undefined;
  /** The control's accessible name ("Sync now. Synced 3 minutes ago"). */
  action: string;
}

export function describeSync(status: SyncStatus, now: number, locale: string): SyncView {
  const lastSynced = (at: number | undefined) =>
    at === undefined ? undefined : t("sync.lastSynced", { ago: timeAgo(at, now, locale).long });
  const syncNow = (state: string) => t("sync.actionSyncNow", { state });

  switch (status.kind) {
    case "not_paired":
      return {
        canSync: false,
        syncing: false,
        dot: "off",
        short: t("sync.notPaired"),
        label: t("sync.notPaired"),
        note: t("sync.notPairedHint"),
        action: t("sync.notPairedAction"),
      };
    case "syncing":
      return {
        canSync: true,
        syncing: true,
        dot: "on",
        short: t("sync.syncing"),
        label: t("sync.syncing"),
        note: lastSynced(status.lastSyncAt),
        // Keeps "Sync now" in the name while busy (label in name: the buttons say "Sync now").
        action: syncNow(t("sync.syncing")),
      };
    case "synced": {
      const ago = timeAgo(status.at, now, locale);
      return {
        canSync: true,
        syncing: false,
        dot: "on",
        short: ago.short,
        label: t("sync.syncedAgo", { ago: ago.short }),
        note: undefined,
        action: syncNow(t("sync.syncedAgo", { ago: ago.long })),
      };
    }
    case "offline": {
      const note = lastSynced(status.lastSyncAt) ?? t("sync.offlineHint");
      return {
        canSync: true,
        syncing: false,
        dot: "off",
        short: t("sync.offline"),
        label: t("sync.offline"),
        note,
        action: syncNow(t("sync.stateWithNote", { state: t("sync.offline"), note })),
      };
    }
    case "error": {
      const note = failureText(status.error);
      return {
        canSync: true,
        syncing: false,
        dot: "error",
        short: t("sync.failed"),
        label: t("sync.failed"),
        note,
        action: syncNow(t("sync.stateWithNote", { state: t("sync.failed"), note })),
      };
    }
    case "revoked":
      return {
        canSync: false,
        syncing: false,
        dot: "error",
        short: t("sync.revokedShort"),
        label: t("sync.revoked"),
        note: t("sync.revokedHint"),
        action: t("sync.revokedAction"),
      };
  }
}

/** The dot's classes for a view. */
export const dotClass = (view: SyncView) =>
  view.dot === "on"
    ? "status-dot"
    : view.dot === "off"
      ? "status-dot status-dot-off"
      : "status-dot status-dot-error";
