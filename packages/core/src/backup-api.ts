// Backups in Settings over HTTP (spec "Backups"): the status, "back up now", and connecting or
// disconnecting Google Drive. Every call sends this device's token. Throws SyncError, whose
// `code` is the server's error code (`not_configured` without Google settings on the server).
import * as v from "valibot";
import {
  type BackupRunResponse,
  type BackupStatusResponse,
  backupRunResponseSchema,
  backupStatusResponseSchema,
  googleConnectResponseSchema,
} from "./schema";
import { createApiRequest, type HttpFetch, SyncError } from "./sync-client";

/** "Back up now" builds and uploads the whole file before answering. */
export const BACKUP_RUN_TIMEOUT_MS = 180_000;

export interface BackupApi {
  status(): Promise<BackupStatusResponse>;
  /** Backs up now (no cleanup) and answers with the attempt. */
  run(): Promise<BackupRunResponse>;
  /** The Google consent page to open; Google then returns to `/#/settings?drive=…`. */
  connect(): Promise<string>;
  disconnect(): Promise<void>;
}

export interface BackupApiOptions {
  /** Absolute server origin (http or https). */
  serverUrl: string;
  token: string;
  fetch: HttpFetch;
  timeoutMs?: number;
  /** For `run`; BACKUP_RUN_TIMEOUT_MS by default. */
  runTimeoutMs?: number;
}

/** Where Google's consent page lives; the app sends the whole window there. */
export const GOOGLE_CONSENT_HOST = "accounts.google.com";

/**
 * The consent URL, if it is Google's https page. The app navigates to it, so anything else
 * (`javascript:`, `data:`, another host) from a hostile or broken server must never be used.
 */
export function checkConsentUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    url = new URL("about:blank");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== GOOGLE_CONSENT_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    throw new SyncError("bad_response", "The server's Google consent URL is not Google's");
  }
  return url.href;
}

/** A 204: no body at all. */
const noContent = v.undefined();

export function createBackupApi({
  runTimeoutMs = BACKUP_RUN_TIMEOUT_MS,
  ...options
}: BackupApiOptions): BackupApi {
  const request = createApiRequest(options);
  const slow = createApiRequest({ ...options, timeoutMs: runTimeoutMs });
  return {
    status: () => request(backupStatusResponseSchema, "GET", "/backups/status"),
    run: () => slow(backupRunResponseSchema, "POST", "/backups/run"),
    connect: async () =>
      checkConsentUrl(
        (await request(googleConnectResponseSchema, "GET", "/backups/google/connect")).url,
      ),
    disconnect: () => request(noContent, "POST", "/backups/google/disconnect"),
  };
}
