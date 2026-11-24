// The pairing link (orchestrator ruling): `<origin>/#/pair?c=<code>&k=<vault key>&s=<serverId>`.
// Everything sits in the URL fragment, which browsers never send to a server, so the vault key
// travels from screen to camera and never through the server.
//
// The link's origin is the server this device would sync with, so a link is used only when it
// is this app's own origin (app and API share one origin): a pasted or scanned link for another
// server could otherwise send every entry there. Plain http only on localhost.
import { fromBase64Url, toBase64Url } from "@budgee/core";

export interface PairingLink {
  /** The app's origin, which serves the API too. */
  origin: string;
  /** The one-time pairing code from /devices/invite. */
  code: string;
  /** The vault key's 32 raw bytes. */
  key: Uint8Array;
  serverId: string;
}

/**
 * `other_origin`: made for another origin than this app's. `insecure`: plain http away from
 * localhost. Both come with the link's host.
 */
export type PairingLinkProblem =
  | "not_link"
  | "incomplete"
  | "bad_key"
  | "other_origin"
  | "insecure";

export type ParsedPairingLink =
  | { ok: true; link: PairingLink }
  | { ok: false; problem: PairingLinkProblem; host?: string };

const ROUTE = "#/pair?";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https, or http on this machine. */
const isSecure = (url: URL) =>
  url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));

export function buildPairingLink({ origin, code, key, serverId }: PairingLink): string {
  const query = new URLSearchParams({ c: code, k: toBase64Url(key), s: serverId });
  return `${new URL(origin).origin}/${ROUTE}${query}`;
}

/**
 * Reads the pair route's query (`c`, `k`, `s`) for a link opened at `origin` (this app's).
 * Undefined when none of them is there (the route was opened without a link).
 */
export function readPairingParams(
  params: Partial<Record<"c" | "k" | "s", string | undefined>>,
  origin: string,
): ParsedPairingLink | undefined {
  const { c: code, k, s: serverId } = params;
  if (!code && !k && !serverId) return undefined;
  const url = new URL(origin);
  if (!isSecure(url)) return { ok: false, problem: "insecure", host: url.host };
  if (!code || !k || !serverId) return { ok: false, problem: "incomplete" };
  let key: Uint8Array;
  try {
    key = fromBase64Url(k);
  } catch {
    return { ok: false, problem: "bad_key" };
  }
  if (key.length !== 32) return { ok: false, problem: "bad_key" };
  return { ok: true, link: { origin: url.origin, code, key, serverId } };
}

/** Reads a pasted or scanned pairing link, for use by the app running at `appOrigin`. */
export function parsePairingLink(text: string, appOrigin: string): ParsedPairingLink {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, problem: "not_link" };
  }
  // javascript:, file:, data: and the like are never pairing links.
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, problem: "not_link" };
  if (!url.hash.startsWith(ROUTE)) return { ok: false, problem: "not_link" };
  if (url.origin !== new URL(appOrigin).origin) {
    return { ok: false, problem: "other_origin", host: url.host };
  }
  const query = new URLSearchParams(url.hash.slice(ROUTE.length));
  const params = {
    c: query.get("c") ?? undefined,
    k: query.get("k") ?? undefined,
    s: query.get("s") ?? undefined,
  };
  return readPairingParams(params, url.origin) ?? { ok: false, problem: "incomplete" };
}
