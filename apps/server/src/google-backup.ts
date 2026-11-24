// The Google Drive connection: the refresh token, sealed with CONFIG_KEY, in the `config` table,
// and the BackupProvider that opens the Drive destination from it for each run.
import * as v from "valibot";
import { openSecret, SecretError, sealSecret } from "./config-key";
import { GOOGLE_DRIVE_KIND, type GoogleConfig } from "./google-oauth";
import { readConfigJson, writeConfigJson } from "./init";
import {
  type BackupDestination,
  type BackupProvider,
  type Db,
  ReconnectNeededError,
} from "./ports";

/** `config` key of the Drive connection. */
export const GOOGLE_DRIVE_KEY = "google_drive";

/** Associated data of the sealed refresh token. */
const TOKEN_PURPOSE = "google_drive.refresh_token";

const connectionSchema = v.strictObject({
  /** sealSecret output: base64(IV + ciphertext + tag). */
  refreshToken: v.string(),
  connectedAt: v.number(),
  /** Set when Google refused the token: the user has to connect again. */
  reconnectNeeded: v.boolean(),
});
type Connection = v.InferOutput<typeof connectionSchema>;

const REVOKED_MESSAGE =
  "Google Drive access was revoked or has expired: reconnect Google Drive in Settings";

export function readConnection(db: Db): Promise<Connection | null> {
  return readConfigJson(db, GOOGLE_DRIVE_KEY, connectionSchema);
}

/** Stores a new connection, replacing any earlier one (and its reconnect flag). */
export async function saveConnection(
  db: Db,
  google: GoogleConfig,
  refreshToken: string,
  now: number,
): Promise<void> {
  const connection: Connection = {
    refreshToken: await sealSecret(google.keys.seal, TOKEN_PURPOSE, refreshToken),
    connectedAt: now,
    reconnectNeeded: false,
  };
  await writeConfigJson(db, GOOGLE_DRIVE_KEY, connection);
}

/** The refresh token of a stored connection. Throws SecretError if CONFIG_KEY changed. */
export function openRefreshToken(google: GoogleConfig, connection: Connection): Promise<string> {
  return openSecret(google.keys.seal, TOKEN_PURPOSE, connection.refreshToken);
}

export async function deleteConnection(db: Db): Promise<void> {
  await db.run("DELETE FROM config WHERE key = ?", [GOOGLE_DRIVE_KEY]);
}

/**
 * Flags the connection as needing a reconnect, only if it still holds `sealed`: a connection
 * made again meanwhile is left alone.
 */
async function markReconnectNeeded(db: Db, sealed: string): Promise<void> {
  await db.run(
    `UPDATE config SET value = json_set(value, '$.reconnectNeeded', json('true'))
     WHERE key = ? AND json_extract(value, '$.refreshToken') = ?`,
    [GOOGLE_DRIVE_KEY, sealed],
  );
}

export interface GoogleBackupDeps {
  db: Db;
  /** Null when the server is not configured for Google Drive. */
  google: GoogleConfig | null;
  /** The Drive destination for a refresh token (adapters/backup/google-drive in the entries). */
  drive: (google: GoogleConfig, refreshToken: string) => BackupDestination;
}

/**
 * Google Drive, opened from the stored connection when a run or the status needs it. A
 * destination call that finds the token revoked flags the connection; once flagged, `open`
 * throws ReconnectNeededError without calling Google until the user connects again.
 */
export function googleBackup({ db, google, drive }: GoogleBackupDeps): BackupProvider {
  return {
    async open() {
      if (!google) return null;
      const connection = await readConnection(db);
      if (!connection) return null;
      if (connection.reconnectNeeded) throw new ReconnectNeededError(REVOKED_MESSAGE);

      let refreshToken: string;
      try {
        refreshToken = await openRefreshToken(google, connection);
      } catch (error) {
        if (!(error instanceof SecretError)) throw error;
        await markReconnectNeeded(db, connection.refreshToken);
        throw new ReconnectNeededError(
          "The Google Drive connection was saved with another CONFIG_KEY: reconnect Google Drive in Settings",
        );
      }

      const destination = drive(google, refreshToken);
      const flagRevoked = async <T>(result: Promise<T>): Promise<T> => {
        try {
          return await result;
        } catch (error) {
          if (error instanceof ReconnectNeededError) {
            await markReconnectNeeded(db, connection.refreshToken);
          }
          throw error;
        }
      };
      return {
        kind: destination.kind,
        put: (name, bytes) => flagRevoked(destination.put(name, bytes)),
        list: () => flagRevoked(destination.list()),
        remove: (name) => flagRevoked(destination.remove(name)),
      };
    },

    async status() {
      const connection = google ? await readConnection(db) : null;
      return {
        kind: GOOGLE_DRIVE_KIND,
        configured: google !== null,
        connected: connection !== null,
        reconnectNeeded: connection?.reconnectNeeded ?? false,
      };
    },
  };
}
