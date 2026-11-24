import { describe, expect, test } from "bun:test";
import { type BackupStatusResponse, SyncError } from "@budgee/core";
import en from "../src/i18n/en.json";
import {
  backupErrorText,
  backupFailureText,
  backupState,
  DRIVE_PARAMS,
  driveReturn,
  formatWhen,
} from "../src/sync/backups";

const destination = (over: Partial<BackupStatusResponse["destination"]> = {}) => ({
  kind: "google-drive",
  configured: true,
  connected: false,
  reconnectNeeded: false,
  ...over,
});

describe("driveReturn: Google sending the browser back to /#/settings?drive=…", () => {
  test("nothing to say without a drive param", () => {
    expect(driveReturn({})).toBeUndefined();
    expect(driveReturn({ reason: "denied" })).toBeUndefined();
  });

  test("connected, once the status confirms it; otherwise the general failure", () => {
    expect(driveReturn({ drive: "connected" }, true)).toEqual({
      ok: true,
      text: en["backups.return.connected"],
    });
    expect(driveReturn({ drive: "connected" }, false)).toEqual({
      ok: false,
      text: en["backups.return.failed"],
    });
  });

  test("each failure reason the server sends has its own message", () => {
    const reasons = [
      "invalid_state",
      "expired",
      "denied",
      "google_error",
      "exchange_failed",
      "no_refresh_token",
      "missing_scope",
    ];
    const texts = reasons.map((reason) => driveReturn({ drive: "error", reason }));
    for (const text of texts) expect(text?.ok).toBe(false);
    expect(new Set(texts.map((x) => x?.text)).size).toBe(reasons.length);
    for (const text of texts) expect(Object.values(en)).toContain(text?.text ?? "");
    expect(driveReturn({ drive: "error", reason: "denied" })?.text).toBe(
      en["backups.return.denied"],
    );
  });

  test("an unknown reason, a missing one or an unknown drive value gets the general message", () => {
    const general = { ok: false, text: en["backups.return.failed"] };
    expect(driveReturn({ drive: "error", reason: "<script>" })).toEqual(general);
    expect(driveReturn({ drive: "error" })).toEqual(general);
    expect(driveReturn({ drive: "maybe" })).toEqual(general);
    // A reason that is an Object.prototype key is not a message key.
    expect(driveReturn({ drive: "error", reason: "constructor" })).toEqual(general);
  });

  test("the params to remove from the address afterwards", () => {
    expect(DRIVE_PARAMS).toEqual(["drive", "reason"]);
  });
});

describe("backupFailureText", () => {
  test("explains each kind in plain words, never the server's raw message", () => {
    const codes = ["reconnect", "refused", "not_found", "unavailable", "other"];
    const texts = codes.map(backupFailureText);
    expect(new Set(texts).size).toBe(codes.length);
    for (const text of texts) {
      expect(Object.values(en)).toContain(text);
      expect(text).not.toMatch(/HTTP|\d{3}/);
    }
    expect(backupFailureText("refused")).toBe(en["backups.failure.refused"]);
  });

  test("a missing code (older server) or one this app doesn't know reads as other", () => {
    const other = en["backups.failure.other"];
    expect(backupFailureText(null)).toBe(other);
    expect(backupFailureText(undefined)).toBe(other);
    expect(backupFailureText("brand_new")).toBe(other);
    expect(backupFailureText("toString")).toBe(other);
  });
});

describe("backupState", () => {
  test("one state per destination", () => {
    expect(backupState(destination({ configured: false }))).toBe("not_configured");
    expect(backupState(destination())).toBe("not_connected");
    expect(backupState(destination({ connected: true }))).toBe("connected");
    expect(backupState(destination({ connected: true, reconnectNeeded: true }))).toBe("reconnect");
  });
});

describe("backupErrorText", () => {
  test("names the server's state, or what to do", () => {
    const notConfigured = new SyncError("server", "x", { status: 503, code: "not_configured" });
    expect(backupErrorText(notConfigured, "b.example")).toBe(en["backups.notConfiguredHint"]);
    expect(backupErrorText(new SyncError("offline", "x"), "b.example")).toBe(
      en["backups.error.offline"].replace("{host}", "b.example"),
    );
    expect(backupErrorText(new SyncError("device_revoked", "x"), "b.example")).toBe(
      en["sync.revokedHint"],
    );
    expect(backupErrorText(new Error("boom"), "b.example")).toBe(en["backups.error.unknown"]);
  });
});

describe("formatWhen", () => {
  const at = (local: string) => new Date(local).getTime();
  const now = at("2026-11-17T12:00:00");
  test("today, yesterday and tomorrow by local calendar day, else the date", () => {
    expect(formatWhen(at("2026-11-17T03:00:00"), now, "en")).toBe("Today, 3:00 AM");
    expect(formatWhen(at("2026-11-16T23:59:00"), now, "en")).toBe("Yesterday, 11:59 PM");
    expect(formatWhen(at("2026-11-18T03:00:00"), now, "en")).toBe("Tomorrow, 3:00 AM");
    expect(formatWhen(at("2026-11-12T03:00:00"), now, "en")).toBe("Nov 12, 3:00 AM");
    expect(formatWhen(at("2025-11-12T03:00:00"), now, "en")).toBe("Nov 12, 2025, 3:00 AM");
  });
});
