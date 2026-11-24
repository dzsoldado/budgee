// The Google Drive destination against a fake of Google's endpoints.
import { beforeEach, describe, expect, test } from "bun:test";
import { BACKUP_FOLDER, googleDrive, MULTIPART_MAX } from "../adapters/backup/google-drive";
import { DRIVE_FILE_SCOPE } from "../src/google-oauth";
import { DestinationError, ReconnectNeededError } from "../src/ports";
import {
  driveError,
  type FakeGoogle,
  fakeGoogle,
  GOOGLE_ENV,
  REFRESH_TOKEN,
} from "./google-helpers";

const credentials = {
  clientId: GOOGLE_ENV.GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_ENV.GOOGLE_CLIENT_SECRET,
};

let google: FakeGoogle;
beforeEach(() => {
  google = fakeGoogle();
});

const destination = (refreshToken = REFRESH_TOKEN) =>
  googleDrive({ credentials, refreshToken, fetch: google.fetch });

const bytes = (...values: number[]) => new Uint8Array(values);

describe("Google Drive destination", () => {
  test("is the google-drive kind and uses the drive.file scope's endpoints only", () => {
    expect(destination().kind).toBe("google-drive");
    expect(DRIVE_FILE_SCOPE).toEndWith("/drive.file");
    expect(BACKUP_FOLDER).toBe("budgee-backups");
  });

  test("put creates the budgee-backups folder once, then uploads into it", async () => {
    const drive = destination();
    await drive.put("budgee-2026-11-16.jsonl.gz", bytes(1, 2, 3));
    await drive.put("budgee-2026-11-17.jsonl.gz", bytes(4, 5));

    const [folder, ...more] = google.folders();
    expect(more).toEqual([]);
    expect(folder).toMatchObject({ name: "budgee-backups", parents: ["root"], trashed: false });
    const [file] = google.named("budgee-2026-11-16.jsonl.gz");
    expect(file).toMatchObject({ parents: [folder?.id], mimeType: "application/gzip" });
    expect(file?.content).toEqual(bytes(1, 2, 3));
    expect(google.named("budgee-2026-11-17.jsonl.gz")[0]?.content).toEqual(bytes(4, 5));

    // A later run (a new destination) finds the folder by name instead of creating another.
    await destination().put("budgee-2026-11-18.jsonl.gz", bytes(6));
    expect(google.folders()).toHaveLength(1);
    expect(await destination().list()).toEqual([
      "budgee-2026-11-16.jsonl.gz",
      "budgee-2026-11-17.jsonl.gz",
      "budgee-2026-11-18.jsonl.gz",
    ]);
  });

  test("a trashed folder of the same name is ignored", async () => {
    google.addFile({
      name: BACKUP_FOLDER,
      mimeType: "application/vnd.google-apps.folder",
      trashed: true,
    });
    await destination().put("a.jsonl.gz", bytes(1));
    const live = google.folders().filter((folder) => !folder.trashed);
    expect(live).toHaveLength(1);
    expect(google.named("a.jsonl.gz")[0]?.parents).toEqual([live[0]?.id ?? ""]);
  });

  test("put with an existing name replaces the content of that file, no duplicate", async () => {
    const drive = destination();
    await drive.put("budgee-2026-11-17.jsonl.gz", bytes(1));
    const [first] = google.named("budgee-2026-11-17.jsonl.gz");
    await drive.put("budgee-2026-11-17.jsonl.gz", bytes(2, 2));
    const after = google.named("budgee-2026-11-17.jsonl.gz");
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(first?.id ?? "");
    expect(after[0]?.content).toEqual(bytes(2, 2));
  });

  test("put with duplicates already there keeps the newest, updates it and deletes the rest", async () => {
    await destination().put("seed.jsonl.gz", bytes(0)); // creates the folder
    const [folder] = google.folders();
    const parents = [folder?.id ?? ""];
    const name = "budgee-2026-11-17.jsonl.gz";
    const older = google.addFile({ name, parents, content: bytes(1) });
    const newest = google.addFile({ name, parents, content: bytes(2) });
    const middle = google.addFile({ name, parents, content: bytes(3) });
    middle.modifiedTime = older.modifiedTime; // older than `newest` by modification time
    const elsewhere = google.addFile({ name, parents: ["root"], content: bytes(4) });

    await destination().put(name, bytes(9));
    expect(google.named(name).map((file) => [file.id, file.content])).toEqual([
      [newest.id, bytes(9)],
      [elsewhere.id, bytes(4)],
    ]);
  });

  test("files over 5 MB go up as a resumable upload", async () => {
    const big = new Uint8Array(MULTIPART_MAX + 1).map((_, i) => i % 251);
    const drive = destination();
    await drive.put("big.jsonl.gz", big);
    await drive.put("big.jsonl.gz", big.slice().reverse());

    const uploads = google.calls.filter((call) => call.url.pathname.startsWith("/upload/"));
    expect(uploads.map((call) => [call.method, call.url.searchParams.get("uploadType")])).toEqual([
      ["POST", "resumable"],
      ["PUT", "resumable"],
      ["PATCH", "resumable"],
      ["PUT", "resumable"],
    ]);
    const [file, ...more] = google.named("big.jsonl.gz");
    expect(more).toEqual([]);
    expect(file?.content).toEqual(big.slice().reverse());
    expect(MULTIPART_MAX).toBe(5 * 1024 * 1024);
  });

  test("small files go up as multipart", async () => {
    await destination().put("small.jsonl.gz", new Uint8Array(MULTIPART_MAX));
    const uploads = google.calls.filter((call) => call.url.pathname.startsWith("/upload/"));
    expect(uploads.map((call) => call.url.searchParams.get("uploadType"))).toEqual(["multipart"]);
    expect(google.named("small.jsonl.gz")[0]?.content).toHaveLength(MULTIPART_MAX);
  });

  test("list pages through the folder: each name once, not trashed, not elsewhere", async () => {
    google = fakeGoogle({ maxPageSize: 2 });
    await destination().put("budgee-2026-11-01.jsonl.gz", bytes(1));
    const parents = [google.folders()[0]?.id ?? ""];
    for (const day of ["02", "03", "04", "05"])
      google.addFile({ name: `budgee-2026-11-${day}.jsonl.gz`, parents });
    google.addFile({ name: "budgee-2026-11-05.jsonl.gz", parents }); // a duplicate
    google.addFile({ name: "trashed.jsonl.gz", parents, trashed: true });
    google.addFile({ name: "outside.jsonl.gz", parents: ["root"] });
    google.addFile({ name: "sub", parents, mimeType: "application/vnd.google-apps.folder" });

    expect((await destination().list()).sort()).toEqual([
      "budgee-2026-11-01.jsonl.gz",
      "budgee-2026-11-02.jsonl.gz",
      "budgee-2026-11-03.jsonl.gz",
      "budgee-2026-11-04.jsonl.gz",
      "budgee-2026-11-05.jsonl.gz",
    ]);
    const listCalls = google.calls.filter(
      (call) =>
        call.url.searchParams.has("q") && call.url.searchParams.get("q")?.includes("in parents"),
    );
    expect(listCalls.length).toBeGreaterThan(2);
  });

  test("list and remove before any backup find nothing and create no folder", async () => {
    expect(await destination().list()).toEqual([]);
    await destination().remove("budgee-2026-11-17.jsonl.gz");
    expect(google.folders()).toEqual([]);
  });

  test("remove deletes every file of that name in the folder, and nothing else", async () => {
    const drive = destination();
    await drive.put("budgee-2026-11-16.jsonl.gz", bytes(1));
    await drive.put("budgee-2026-11-17.jsonl.gz", bytes(2));
    const parents = [google.folders()[0]?.id ?? ""];
    google.addFile({ name: "budgee-2026-11-16.jsonl.gz", parents });
    const outside = google.addFile({ name: "budgee-2026-11-16.jsonl.gz", parents: ["root"] });

    await drive.remove("budgee-2026-11-16.jsonl.gz");
    expect(google.named("budgee-2026-11-16.jsonl.gz").map((file) => file.id)).toEqual([outside.id]);
    expect(await drive.list()).toEqual(["budgee-2026-11-17.jsonl.gz"]);
    await drive.remove("never-there.jsonl.gz");
  });

  test("names with quotes and backslashes are escaped in queries", async () => {
    const name = "it's a \\ test.jsonl.gz";
    const drive = destination();
    await drive.put(name, bytes(1));
    await drive.put(name, bytes(2));
    expect(google.named(name).map((file) => file.content)).toEqual([bytes(2)]);
    await drive.remove(name);
    expect(google.named(name)).toEqual([]);
  });

  test("the access token is refreshed once per destination and kept in memory only", async () => {
    const drive = destination();
    await drive.put("a.jsonl.gz", bytes(1));
    await drive.list();
    await drive.remove("a.jsonl.gz");
    expect(google.tokenCalls()).toHaveLength(1);
    const tokens = new Set(google.calls.map((call) => call.token).filter(Boolean));
    expect(tokens.size).toBe(1);
    expect([...tokens][0]).not.toBe(REFRESH_TOKEN);

    await destination().list();
    expect(google.tokenCalls()).toHaveLength(2);
  });

  test("an expired access token is refreshed and the call retried once", async () => {
    const drive = destination();
    await drive.put("a.jsonl.gz", bytes(1));
    google.expireAccessTokens();
    expect(await drive.list()).toEqual(["a.jsonl.gz"]);
    expect(google.tokenCalls()).toHaveLength(2);
  });

  test("a revoked refresh token (invalid_grant) throws ReconnectNeededError", async () => {
    google.revokeRefreshToken();
    const error = await destination()
      .list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReconnectNeededError);
    expect((error as Error).message).toMatch(/reconnect/i);
    expect((error as Error).message).not.toContain(REFRESH_TOKEN);
  });

  test("other token errors are plain errors without secrets", async () => {
    const drive = googleDrive({
      credentials: { ...credentials, clientSecret: "wrong" },
      refreshToken: REFRESH_TOKEN,
      fetch: google.fetch,
    });
    const error = (await drive.list().catch((e: unknown) => e)) as Error;
    expect(error).not.toBeInstanceOf(ReconnectNeededError);
    expect(error.message).toBe("Google sign-in failed: HTTP 401 (invalid_client)");
  });

  test("Drive errors name the step, the HTTP status and Google's reason, never a token", async () => {
    const drive = destination();
    await drive.list(); // gets an access token
    google.setIntercept((call) =>
      call.url.pathname.startsWith("/upload/")
        ? driveError(
            403,
            "storageQuotaExceeded",
            `The user's Drive storage quota has been exceeded. ${call.token}`,
          )
        : undefined,
    );
    const error = (await drive.put("a.jsonl.gz", bytes(1)).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("Google Drive upload failed: HTTP 403 (storageQuotaExceeded)");
    // The status and reason travel as fields too, for Settings to explain without parsing.
    expect(error).toBeInstanceOf(DestinationError);
    expect(error).toMatchObject({ status: 403, reason: "storageQuotaExceeded" });

    google.setIntercept(() => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND www.googleapis.com");
    });
    const network = (await drive.list().catch((e: unknown) => e)) as Error;
    expect(network.message).toMatch(/^Google Drive list failed: /);
    expect(network.message).toContain("ENOTFOUND");
    expect(network).toBeInstanceOf(DestinationError);
    expect(network).toMatchObject({ status: null, reason: null });
  });

  test("a resumable upload never sends the token outside googleapis.com", async () => {
    google.setIntercept((call) =>
      call.url.searchParams.get("uploadType") === "resumable" && call.method === "POST"
        ? new Response(null, { status: 200, headers: { Location: "https://evil.example/upload" } })
        : undefined,
    );
    const error = (await destination()
      .put("big.jsonl.gz", new Uint8Array(MULTIPART_MAX + 1))
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/upload failed/);
    expect(google.calls.some((call) => call.url.hostname === "evil.example")).toBe(false);
  });
});
