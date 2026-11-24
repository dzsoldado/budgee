// Platform adapters: small interfaces in front of what differs between the web build and a
// later native (e.g. Capacitor) build.
import type { BackupApi, DeviceApi, SyncTransport } from "@budgee/core";
import type { MetaKey, MetaValues } from "../db/db";

/** Local-only values (server URL, device token, vault key, last pulled seq…). */
export interface StorageAdapter {
  get<K extends MetaKey>(key: K): Promise<MetaValues[K] | undefined>;
  set<K extends MetaKey>(key: K, value: MetaValues[K]): Promise<void>;
  delete(key: MetaKey): Promise<void>;
  /** Asks the platform to keep local data from being evicted; true when granted. */
  persist(): Promise<boolean>;
}

export interface OutgoingFile {
  name: string;
  /** Media type, e.g. `text/csv`. */
  type: string;
  data: Blob | string;
}

export interface FileExportAdapter {
  /** Saves the file where the user keeps downloads. */
  save(file: OutgoingFile): Promise<void>;
}

export interface ShareAdapter {
  /** Whether files can be handed to the system share sheet. */
  canShareFiles(): boolean;
  /** Opens the share sheet; false when the user cancels. */
  shareFile(file: OutgoingFile, title?: string): Promise<boolean>;
}

export interface SyncTransportConfig {
  /** Absolute server origin, never a relative path. */
  serverUrl: string;
  deviceToken: string;
}

export interface DeviceApiConfig {
  /** Absolute server origin. */
  serverUrl: string;
  /** Absent before setup or pairing, which need none. */
  deviceToken?: string;
}

/** The sync API calls the sync client makes (core `SyncTransport`). */
export type { SyncTransport };

export interface Platform {
  storage: StorageAdapter;
  fileExport: FileExportAdapter;
  share: ShareAdapter;
  createSyncTransport(config: SyncTransportConfig): SyncTransport;
  /** Setup, pairing and the device list (core `DeviceApi`). */
  createDeviceApi(config: DeviceApiConfig): DeviceApi;
  /** Backup status, back up now and the Google Drive connection (core `BackupApi`). */
  createBackupApi(config: SyncTransportConfig): BackupApi;
}
