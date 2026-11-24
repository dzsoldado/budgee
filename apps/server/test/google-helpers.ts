// Google settings for tests, and a fake of the Google endpoints the server calls: the OAuth token
// and revoke endpoints and the part of Drive REST v3 the destination uses.
import { toBase64 } from "@budgee/core";
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from "../src/google-oauth";
import type { Fetch } from "../src/ports";

export const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret",
  CONFIG_KEY: toBase64(new Uint8Array(32).fill(9)),
  PUBLIC_ORIGIN: "https://budgee.example.com",
};

/** Token-shaped, so a leak would be caught (and safeErrorMessage would redact it). */
export const REFRESH_TOKEN = "1//0gRefreshTokenAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_FILES = "https://www.googleapis.com/upload/drive/v3/files";

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  createdTime: number;
  modifiedTime: number;
  content: Uint8Array;
}

export interface FakeCall {
  method: string;
  url: URL;
  /** The bearer token sent, if any. */
  token: string | null;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const driveError = (status: number, reason: string, message: string) =>
  json({ error: { code: status, message, errors: [{ reason, message }] } }, status);

/** Bytes as a string of char codes 0–255, and back: multipart bodies hold binary data. */
const toBinary = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
};
const fromBinary = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));

function parseMultipart(contentType: string, body: Uint8Array) {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error("multipart without boundary");
  const parts = toBinary(body)
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const split = part.indexOf("\r\n\r\n");
      return { headers: part.slice(0, split), body: part.slice(split + 4, -2) };
    });
  const [meta, media] = parts;
  if (!meta || !media || parts.length !== 2) throw new Error("expected two parts");
  if (!/application\/json/.test(meta.headers)) throw new Error("metadata part is not JSON");
  return { metadata: JSON.parse(meta.body) as Partial<FakeFile>, content: fromBinary(media.body) };
}

/** Evaluates the subset of Drive's query language the destination writes. */
function matches(file: FakeFile, q: string): boolean {
  const unquote = (text: string) => text.replace(/\\(.)/g, "$1");
  return q.split(" and ").every((clause) => {
    const name = /^name = '((?:[^'\\]|\\.)*)'$/.exec(clause);
    if (name) return file.name === unquote(name[1] ?? "");
    const mime = /^mimeType (=|!=) '([^']*)'$/.exec(clause);
    if (mime) return (file.mimeType === mime[2]) === (mime[1] === "=");
    const parent = /^'((?:[^'\\]|\\.)*)' in parents$/.exec(clause);
    if (parent) return file.parents.includes(unquote(parent[1] ?? ""));
    if (clause === "trashed = false") return !file.trashed;
    throw new Error(`fake Drive cannot read the clause: ${clause}`);
  });
}

export interface FakeGoogleOptions {
  /** Largest page files.list returns, whatever pageSize asks for. */
  maxPageSize?: number;
}

export function fakeGoogle({ maxPageSize = 1000 }: FakeGoogleOptions = {}) {
  const files = new Map<string, FakeFile>();
  const calls: FakeCall[] = [];
  const refreshTokens = new Set([REFRESH_TOKEN]);
  const accessTokens = new Set<string>();
  /** Authorisation codes the consent page handed out, and what exchanging each one gives. */
  const codes = new Map<string, Record<string, string>>();
  const revoked: string[] = [];
  const sessions = new Map<string, { method: string; id?: string; metadata: Partial<FakeFile> }>();
  let next = 0;
  let clock = 0;
  /** Answers a request before the fake does, when it returns a response. */
  let intercept: ((call: FakeCall) => Response | undefined) | null = null;

  const newId = (prefix: string) => `${prefix}${String(++next).padStart(4, "0")}`;

  function addFile(file: Partial<FakeFile> & { name: string }): FakeFile {
    const now = ++clock;
    const created: FakeFile = {
      id: newId("file"),
      mimeType: "application/gzip",
      parents: ["root"],
      trashed: false,
      createdTime: now,
      modifiedTime: now,
      content: new Uint8Array(),
      ...file,
    };
    files.set(created.id, created);
    return created;
  }

  async function token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    if (form.get("client_id") !== GOOGLE_ENV.GOOGLE_CLIENT_ID)
      return json({ error: "invalid_client" }, 401);
    if (form.get("client_secret") !== GOOGLE_ENV.GOOGLE_CLIENT_SECRET) {
      return json({ error: "invalid_client" }, 401);
    }
    const grant = form.get("grant_type");
    if (grant === "refresh_token") {
      if (!refreshTokens.has(form.get("refresh_token") ?? "")) {
        return json(
          { error: "invalid_grant", error_description: "Token has been expired or revoked." },
          400,
        );
      }
      const access = `ya29.a0AccessToken${newId("x")}ZpQ7mN2vR8sT1uW4yX6z`;
      accessTokens.add(access);
      return json({ access_token: access, expires_in: 3599, token_type: "Bearer" });
    }
    if (grant === "authorization_code") {
      const answer = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!answer) return json({ error: "invalid_grant", error_description: "Bad Request" }, 400);
      if (answer.refresh_token) refreshTokens.add(answer.refresh_token);
      return json({
        access_token: "ya29.unused",
        expires_in: 3599,
        token_type: "Bearer",
        ...answer,
      });
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  function list(url: URL): Response {
    const q = url.searchParams.get("q") ?? "";
    const orderBy = url.searchParams.get("orderBy") ?? "";
    const [field, direction] = orderBy.split(" ") as [string, string | undefined];
    const key = field === "modifiedTime" ? "modifiedTime" : "createdTime";
    const found = [...files.values()]
      .filter((file) => matches(file, q))
      .sort((a, b) => (direction === "desc" ? b[key] - a[key] : a[key] - b[key]));
    const start = Number(url.searchParams.get("pageToken") ?? 0);
    const size = Math.min(Number(url.searchParams.get("pageSize") ?? 100), maxPageSize);
    const page = found.slice(start, start + size);
    return json({
      files: page.map((file) => ({
        id: file.id,
        name: file.name,
        createdTime: new Date(file.createdTime).toISOString(),
        modifiedTime: new Date(file.modifiedTime).toISOString(),
      })),
      ...(start + size < found.length ? { nextPageToken: String(start + size) } : {}),
    });
  }

  function write(
    method: string,
    id: string | undefined,
    metadata: Partial<FakeFile>,
    content: Uint8Array,
  ) {
    if (method === "POST")
      return json({ id: addFile({ ...metadata, name: metadata.name ?? "", content }).id });
    const file = id ? files.get(id) : undefined;
    if (!file) return driveError(404, "notFound", `File not found: ${id}.`);
    Object.assign(file, metadata, { content, modifiedTime: ++clock });
    return json({ id: file.id });
  }

  async function drive(request: Request, call: FakeCall): Promise<Response> {
    if (!call.token || !accessTokens.has(call.token)) {
      return json(
        {
          error: {
            code: 401,
            message: "Request had invalid authentication credentials.",
            status: "UNAUTHENTICATED",
          },
        },
        401,
      );
    }
    const { url, method } = call;
    const path = url.origin + url.pathname;
    const id = path.startsWith(`${DRIVE_FILES}/`)
      ? path.slice(DRIVE_FILES.length + 1)
      : path.startsWith(`${UPLOAD_FILES}/`)
        ? path.slice(UPLOAD_FILES.length + 1)
        : undefined;

    if (path === DRIVE_FILES && method === "GET") return list(url);
    if (path === DRIVE_FILES && method === "POST") {
      const metadata = (await request.json()) as Partial<FakeFile>;
      return json({ id: addFile({ ...metadata, name: metadata.name ?? "" }).id });
    }
    if (id && path.startsWith(DRIVE_FILES) && method === "DELETE") {
      if (!files.delete(id)) return driveError(404, "notFound", `File not found: ${id}.`);
      return new Response(null, { status: 204 });
    }
    if (path.startsWith(UPLOAD_FILES)) {
      const type = url.searchParams.get("uploadType");
      const upload = url.searchParams.get("upload_id");
      if (upload && method === "PUT") {
        const session = sessions.get(upload);
        if (!session) return driveError(404, "notFound", "No such upload session");
        sessions.delete(upload);
        const content = new Uint8Array(await request.arrayBuffer());
        return write(session.method, session.id, session.metadata, content);
      }
      if (type === "multipart") {
        const body = new Uint8Array(await request.arrayBuffer());
        const { metadata, content } = parseMultipart(
          request.headers.get("Content-Type") ?? "",
          body,
        );
        return write(method, id, metadata, content);
      }
      if (type === "resumable") {
        const session = newId("session");
        sessions.set(session, {
          method,
          ...(id ? { id } : {}),
          metadata: (await request.json()) as Partial<FakeFile>,
        });
        return new Response(null, {
          status: 200,
          headers: { Location: `${UPLOAD_FILES}?uploadType=resumable&upload_id=${session}` },
        });
      }
    }
    return driveError(400, "badRequest", `fake Drive does not handle ${method} ${path}`);
  }

  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization");
    const call: FakeCall = {
      method: request.method,
      url,
      token: auth?.replace(/^Bearer /, "") ?? null,
    };
    calls.push(call);
    const intercepted = intercept?.(call);
    if (intercepted) return intercepted;
    if (request.url === GOOGLE_TOKEN_URL) return token(request);
    if (request.url === GOOGLE_REVOKE_URL) {
      const revokedToken = new URLSearchParams(await request.text()).get("token") ?? "";
      revoked.push(revokedToken);
      refreshTokens.delete(revokedToken);
      return new Response(null, { status: 200 });
    }
    return drive(request, call);
  };

  return {
    fetch,
    files,
    calls,
    codes,
    revoked,
    addFile,
    /** Files that are not folders, by name. */
    named: (name: string) =>
      [...files.values()].filter((file) => file.name === name && file.mimeType !== FOLDER_MIME),
    folders: () => [...files.values()].filter((file) => file.mimeType === FOLDER_MIME),
    /** Calls to the token endpoint. */
    tokenCalls: () => calls.filter((call) => call.url.href === GOOGLE_TOKEN_URL),
    /** Every access token handed out stops working, as after an hour. */
    expireAccessTokens: () => accessTokens.clear(),
    /** The user removed the app's access in their Google account. */
    revokeRefreshToken: (token = REFRESH_TOKEN) => refreshTokens.delete(token),
    setIntercept(handler: ((call: FakeCall) => Response | undefined) | null) {
      intercept = handler;
    },
  };
}

export type FakeGoogle = ReturnType<typeof fakeGoogle>;
export { driveError, FOLDER_MIME };
