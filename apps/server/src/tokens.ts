// Device tokens, pairing codes and secret comparison. Only hashes of tokens and codes are stored.
import { toBase64Url } from "@budgee/core";

/** 32 random bytes as base64url (43 characters): a device token, handed out once. */
export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Lowercase hex SHA-256 of the UTF-8 text: how tokens and pairing codes are stored. */
export async function sha256Hex(text: string): Promise<string> {
  return Array.from(await sha256(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two secrets in time that depends on neither. Hashing first gives both sides the same
 * length, so not even the length of the expected secret leaks.
 */
export async function timingSafeEqual(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// Crockford base32: no I, L, O or U, so a code reads back unambiguously.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

/** A one-time pairing code: 8 Crockford base32 symbols (40 random bits). */
export function newPairingCode(): string {
  // 256 is a multiple of 32, so the low 5 bits of a random byte are uniform.
  return Array.from(
    crypto.getRandomValues(new Uint8Array(CODE_LENGTH)),
    (b) => CROCKFORD[b & 31],
  ).join("");
}

/**
 * Reads a typed pairing code: case, spaces and dashes don't matter, I and L read as 1, O as 0.
 * Null when the text cannot be a code.
 */
export function normalizePairingCode(text: string): string | null {
  const code = text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return code.length === CODE_LENGTH && /^[0-9A-HJKMNP-TV-Z]+$/.test(code) ? code : null;
}
