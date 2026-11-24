// Google Drive as a BackupDestination: Drive REST v3 over `fetch` only, no SDK. Scope drive.file: the app sees only what it created, here a `budgee-backups`
// folder found or created by name. The access token comes from the refresh token and lives in
// this object only, so for one run.
import { GOOGLE_DRIVE_KIND, GOOGLE_TOKEN_URL } from "../../src/google-oauth";
import {
  type BackupDestination,
  DestinationError,
  type Fetch,
  ReconnectNeededError,
} from "../../src/ports";
import { safeErrorMessage } from "../../src/redact";

export const BACKUP_FOLDER = "budgee-backups";
/** Largest file sent as one multipart request; bigger ones use a resumable upload. */
export const MULTIPART_MAX = 5 * 1024 * 1024;

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_MIME = "application/gzip";
const PAGE_SIZE = 1000;

export interface GoogleDriveOptions {
  credentials: { clientId: string; clientSecret: string };
  refreshToken: string;
  fetch: Fetch;
}

interface DriveFile {
  id: string;
  name: string;
}

/** A query string literal: backslashes and single quotes escaped. */
const literal = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** Google's short machine-readable code from an error body, never its free-text message. */
function reasonOf(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  const candidates =
    typeof error === "string"
      ? [error]
      : [
          (error as { errors?: { reason?: unknown }[] } | undefined)?.errors?.[0]?.reason,
          (error as { status?: unknown } | undefined)?.status,
        ];
  const reason = candidates.find(
    (value) => typeof value === "string" && /^[A-Za-z_]{1,64}$/.test(value),
  );
  return (reason as string | undefined) ?? null;
}

const failure = (step: string, status: number, reason: string | null) =>
  new DestinationError(
    `${step} failed: HTTP ${status}${reason ? ` (${reason})` : ""}`,
    status,
    reason,
  );

/** The destination could not be reached at all. */
const unreachable = (step: string, error: unknown) =>
  new DestinationError(`${step} failed: ${safeErrorMessage(error)}`, null, null);

export function googleDrive({
  credentials,
  refreshToken,
  fetch,
}: GoogleDriveOptions): BackupDestination {
  let accessToken: string | null = null;
  let folderId: string | null = null;

  async function refresh(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });
    } catch (error) {
      throw unreachable("Google sign-in", error);
    }
    if (!res.ok) {
      const reason = reasonOf(await res.json().catch(() => null));
      if (reason === "invalid_grant") {
        throw new ReconnectNeededError(
          "Google Drive access was revoked or has expired: reconnect Google Drive in Settings",
        );
      }
      throw failure("Google sign-in", res.status, reason);
    }
    const token = ((await res.json().catch(() => null)) as { access_token?: unknown } | null)
      ?.access_token;
    if (typeof token !== "string" || token === "") {
      throw new Error("Google sign-in failed: no access token in the answer");
    }
    accessToken = token;
    return token;
  }

  /**
   * One Drive request with the access token. A 401 means the token expired: it is refreshed and
   * the request sent once more. Answers other than 2xx (and `allow`) throw an error naming `step`.
   */
  async function call(
    step: string,
    url: string,
    init: RequestInit = {},
    allow?: number,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${accessToken ?? (await refresh())}`);
      let res: Response;
      try {
        res = await fetch(url, { ...init, headers });
      } catch (error) {
        throw unreachable(`Google Drive ${step}`, error);
      }
      if (res.status === 401 && attempt === 0) {
        accessToken = null;
        continue;
      }
      if (res.ok || res.status === allow) return res;
      const reason = reasonOf(await res.json().catch(() => null));
      throw failure(`Google Drive ${step}`, res.status, reason);
    }
  }

  /** Every file matching `q`, across pages, in `orderBy` order. */
  async function search(step: string, q: string, orderBy = "createdTime"): Promise<DriveFile[]> {
    const found: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        orderBy,
        spaces: "drive",
        pageSize: String(PAGE_SIZE),
        fields: "nextPageToken,files(id,name)",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = (await (await call(step, `${FILES}?${params}`)).json()) as {
        files?: DriveFile[];
        nextPageToken?: string;
      };
      found.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return found;
  }

  /** The backup folder's id (the oldest, if there are several); created when `create`. */
  async function folder(create: boolean): Promise<string | null> {
    if (folderId) return folderId;
    const q = `name = ${literal(BACKUP_FOLDER)} and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const [existing] = await search("folder lookup", q);
    if (existing) {
      folderId = existing.id;
    } else if (create) {
      const res = await call("folder creation", `${FILES}?fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: BACKUP_FOLDER, mimeType: FOLDER_MIME }),
      });
      folderId = ((await res.json()) as DriveFile).id;
    }
    return folderId;
  }

  /** Files named `name` in the folder, most recently modified first. */
  const filesNamed = (parent: string, name: string, step: string) =>
    search(
      step,
      `name = ${literal(name)} and ${literal(parent)} in parents and mimeType != '${FOLDER_MIME}' and trashed = false`,
      "modifiedTime desc",
    );

  const deleteFile = (id: string) =>
    // 404: already gone, which is what was wanted.
    call("delete", `${FILES}/${encodeURIComponent(id)}`, { method: "DELETE" }, 404);

  /** Creates (POST) or replaces the content of (PATCH) a file. */
  async function upload(
    method: "POST" | "PATCH",
    url: string,
    metadata: object,
    bytes: Uint8Array,
  ) {
    if (bytes.length <= MULTIPART_MAX) {
      const boundary = `budgee-${crypto.randomUUID()}`;
      const encoder = new TextEncoder();
      const head = encoder.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\nContent-Type: ${FILE_MIME}\r\n\r\n`,
      );
      const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
      const body = new Uint8Array(head.length + bytes.length + tail.length);
      body.set(head);
      body.set(bytes, head.length);
      body.set(tail, head.length + bytes.length);
      await call("upload", `${url}?uploadType=multipart&fields=id`, {
        method,
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      return;
    }
    const start = await call("upload", `${url}?uploadType=resumable&fields=id`, {
      method,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": FILE_MIME,
        "X-Upload-Content-Length": String(bytes.length),
      },
      body: JSON.stringify(metadata),
    });
    // The session URL carries the token on the next request, so it must be Google's own.
    const session = start.headers.get("Location");
    if (!session || new URL(session).origin !== new URL(UPLOAD).origin) {
      throw new Error("Google Drive upload failed: no upload session from Google");
    }
    await call("upload", session, {
      method: "PUT",
      headers: { "Content-Type": FILE_MIME },
      body: new Uint8Array(bytes),
    });
  }

  return {
    kind: GOOGLE_DRIVE_KIND,

    async put(name, bytes) {
      const parent = (await folder(true)) as string;
      const [newest, ...duplicates] = await filesNamed(parent, name, "lookup");
      if (newest) {
        await upload("PATCH", `${UPLOAD}/${encodeURIComponent(newest.id)}`, {}, bytes);
      } else {
        await upload("POST", UPLOAD, { name, parents: [parent], mimeType: FILE_MIME }, bytes);
      }
      for (const file of duplicates) await deleteFile(file.id);
    },

    async list() {
      const parent = await folder(false);
      if (!parent) return [];
      const q = `${literal(parent)} in parents and mimeType != '${FOLDER_MIME}' and trashed = false`;
      return [...new Set((await search("list", q)).map((file) => file.name))];
    },

    async remove(name) {
      const parent = await folder(false);
      if (!parent) return;
      for (const file of await filesNamed(parent, name, "lookup")) await deleteFile(file.id);
    },
  };
}
