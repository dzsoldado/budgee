import type { BackupStatusResponse } from "@budgee/core";
import type { GoogleConfig } from "./google-oauth";

export interface Config {
  serverId: string;
  /** SETUP_SECRET: enables POST /setup while no device exists. */
  setupSecret?: string | undefined;
  /** CRON_SECRET: enables POST /admin/run-daily. */
  cronSecret?: string | undefined;
  /** Google Drive OAuth; unset when GOOGLE_*, CONFIG_KEY or PUBLIC_ORIGIN is missing. */
  google?: GoogleConfig | undefined;
}

/** Outbound HTTP: the platform's `fetch`, or a fake in tests. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** Values bound to `?` placeholders and read back from columns. Booleans are stored as 0/1. */
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface Statement {
  /** One SQLite statement with positional `?` placeholders. */
  sql: string;
  params?: readonly SqlValue[];
}

export interface RunResult {
  /** Rows inserted, updated or deleted by the statement. */
  changes: number;
}

/**
 * The server database: SQLite dialect, async, no interactive transactions.
 * Anything that must be atomic goes into one `batch`.
 */
export interface Db {
  /** Runs one statement and returns its rows. */
  query<T = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** Runs one write statement. */
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  /** Runs the statements in order as one transaction: all of them apply, or none. */
  batch(statements: readonly Statement[]): Promise<RunResult[]>;
}

/** Where backup files go (Google Drive by default). Retention is applied through `list` and `remove`. */
export interface BackupDestination {
  /** What it is, for Settings, e.g. `google-drive`. */
  readonly kind: string;
  /**
   * Creates or overwrites the file `name`. Errors from every call end up in the status Settings
   * shows, so their messages must not carry tokens or other secrets.
   */
  put(name: string, bytes: Uint8Array): Promise<void>;
  /** Names of the backup files currently stored. */
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

/**
 * A destination call that failed: `status` is the HTTP status (null when the destination could
 * not be reached), `reason` the provider's short machine-readable code, if any. The message is
 * for logs and admins; Settings explains the failure from `status` and `reason`.
 */
export class DestinationError extends Error {
  override name = "DestinationError";
  readonly status: number | null;
  readonly reason: string | null;

  constructor(message: string, status: number | null, reason: string | null) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Thrown by a destination whose stored authorisation stopped working (access revoked or
 * expired): retrying cannot help, so Settings asks to connect again.
 */
export class ReconnectNeededError extends Error {
  override name = "ReconnectNeededError";
}

/** The connection as Settings shows it. */
export type DestinationStatus = BackupStatusResponse["destination"];

/** Opens the backup destination lazily, for one run or one status read. */
export interface BackupProvider {
  /**
   * The destination, or null when none is connected or the server is not configured for one.
   * Throws ReconnectNeededError when the stored connection is known to be broken.
   */
  open(): Promise<BackupDestination | null>;
  status(): Promise<DestinationStatus>;
}
