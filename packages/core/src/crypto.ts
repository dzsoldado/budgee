// Row encryption with the vault key (AES-256-GCM via Web Crypto), the recovery key text form,
// and base64 helpers. Blob = base64(IV + ciphertext + GCM tag); the associated data binds
// `table`, `id` and `hlc`, so a blob decrypts only for the row and edit it was made for.
import type { TableName } from "./schema";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// ─── errors ─────────────────────────────────────────────────────────────────

/**
 * A blob that cannot be decrypted. `failed`: authentication failed, which is all GCM can tell
 * about a wrong vault key, a blob moved to another row or a modified blob. `malformed`: not
 * base64, too short to hold an IV and tag, or plaintext that is not JSON.
 */
export class DecryptError extends Error {
  override name = "DecryptError";
  readonly reason: "failed" | "malformed";

  constructor(reason: "failed" | "malformed", message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

// ─── vault key ──────────────────────────────────────────────────────────────

/** A random 256-bit AES-GCM key, extractable so it can be shown and paired. */
export function generateVaultKey(): Promise<CryptoKey> {
  // Casts: Bun's Web Crypto typings return unions where the DOM ones narrow by algorithm.
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]) as Promise<CryptoKey>;
}

/** The key's 32 raw bytes. */
export async function exportKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

export function importKey(bytes: Uint8Array): Promise<CryptoKey> {
  if (bytes.length !== KEY_BYTES) {
    return Promise.reject(new RangeError(`A vault key is ${KEY_BYTES} bytes, got ${bytes.length}`));
  }
  return crypto.subtle.importKey("raw", new Uint8Array(bytes), "AES-GCM", true, [
    "encrypt",
    "decrypt",
  ]);
}

// ─── rows ───────────────────────────────────────────────────────────────────

/** Associated data: JSON of `[table, id, hlc]`, which cannot be ambiguous. */
const associatedData = (table: TableName, id: string, hlc: string) =>
  new TextEncoder().encode(JSON.stringify([table, id, hlc]));

/** Encrypts a row's user fields (as JSON) with a fresh 96-bit IV. */
export async function encryptRow(
  key: CryptoKey,
  table: TableName,
  id: string,
  hlc: string,
  fields: Record<string, unknown>,
): Promise<string> {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new TypeError("Row fields must be a plain object");
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(fields));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(table, id, hlc) },
    key,
    plaintext,
  );
  const blob = new Uint8Array(IV_BYTES + sealed.byteLength);
  blob.set(iv);
  blob.set(new Uint8Array(sealed), IV_BYTES);
  return toBase64(blob);
}

export interface SealedRow {
  table: TableName;
  id: string;
  hlc: string;
  blob: string;
}

/** Decrypts a live envelope's blob to its fields (unvalidated JSON). Throws DecryptError. */
export async function decryptRow(
  key: CryptoKey,
  { table, id, hlc, blob }: SealedRow,
): Promise<unknown> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(blob);
  } catch (cause) {
    throw new DecryptError("malformed", "Blob is not valid base64", { cause });
  }
  if (bytes.length < IV_BYTES + TAG_BYTES) {
    throw new DecryptError(
      "malformed",
      `Blob is ${bytes.length} bytes, shorter than IV (${IV_BYTES}) + GCM tag (${TAG_BYTES})`,
    );
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, IV_BYTES),
        additionalData: associatedData(table, id, hlc),
      },
      key,
      bytes.subarray(IV_BYTES),
    );
  } catch (cause) {
    throw new DecryptError(
      "failed",
      `Blob for ${table}/${id} failed to decrypt: wrong vault key, moved from another row, or modified`,
      { cause },
    );
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext),
    );
  } catch {
    // No cause: a JSON.parse error message quotes the plaintext.
    throw new DecryptError("malformed", "Decrypted blob is not JSON");
  }
}

// ─── base64 ─────────────────────────────────────────────────────────────────

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Strict standard base64 with padding; throws SyntaxError otherwise. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  if (!BASE64.test(text)) throw new SyntaxError("Invalid base64");
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** URL-safe base64 without padding, for the vault key in the pairing link. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict URL-safe base64 without padding; throws SyntaxError otherwise. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new SyntaxError("Invalid base64url");
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
}

// ─── recovery key ───────────────────────────────────────────────────────────

// Crockford base32: no I, L, O or U. Decoding reads I and L as 1 and O as 0.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_SYMBOLS = Math.ceil((KEY_BYTES * 8) / 5); // 52
const CHECK_SYMBOLS = 4;

/**
 * `-` and what documents and password managers substitute for it: the dashes U+2010–U+2015,
 * the minus sign U+2212, the small em dash U+FE58, the small and fullwidth hyphen-minus U+FE63
 * and U+FF0D, and the (invisible) soft hyphen U+00AD.
 */
const DASHES = String.fromCodePoint(
  0x2d,
  0x2010,
  0x2011,
  0x2012,
  0x2013,
  0x2014,
  0x2015,
  0x2212,
  0xfe58,
  0xfe63,
  0xff0d,
  0xad,
);

const isSeparator = (char: string) => /\s/.test(char) || DASHES.includes(char);

export type RecoveryKeyProblem = "length" | "character" | "checksum";

export class RecoveryKeyError extends Error {
  override name = "RecoveryKeyError";
  readonly reason: RecoveryKeyProblem;

  constructor(reason: RecoveryKeyProblem, message: string) {
    super(message);
    this.reason = reason;
  }
}

function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + CROCKFORD[(value << (5 - bits)) & 31] : out;
}

/** Decodes symbols already known to be in the alphabet; trailing padding bits are dropped. */
function decodeBase32(symbols: string, byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  let value = 0;
  let bits = 0;
  let at = 0;
  for (const symbol of symbols) {
    value = (value << 5) | CROCKFORD.indexOf(symbol);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (at < byteLength) bytes[at++] = (value >>> bits) & 0xff;
    }
    value &= (1 << bits) - 1;
  }
  return bytes;
}

/** The first 20 bits of SHA-256 of the key, as 4 symbols. */
async function checksum(key: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", key));
  return encodeBase32(digest.subarray(0, 3)).slice(0, CHECK_SYMBOLS);
}

/**
 * The vault key as text: 52 Crockford base32 symbols plus a 4-symbol checksum, in groups of 4
 * separated by `-` (14 groups).
 */
export async function toRecoveryKey(bytes: Uint8Array): Promise<string> {
  if (bytes.length !== KEY_BYTES) {
    throw new RangeError(`A vault key is ${KEY_BYTES} bytes, got ${bytes.length}`);
  }
  const symbols = encodeBase32(bytes) + (await checksum(new Uint8Array(bytes)));
  return symbols.match(/.{4}/g)?.join("-") ?? "";
}

/**
 * Reads a recovery key back to the vault key bytes. Case, whitespace and dashes don't matter
 * (including the Unicode dashes and minus sign a password manager or document may substitute);
 * I and L read as 1, O as 0. Throws RecoveryKeyError.
 */
export async function fromRecoveryKey(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const symbols = Array.from(text.toUpperCase())
    .filter((char) => !isSeparator(char))
    .join("")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (!/^[0-9A-HJKMNP-TV-Z]*$/.test(symbols)) {
    throw new RecoveryKeyError("character", "Recovery key has a character that is not allowed");
  }
  if (symbols.length !== KEY_SYMBOLS + CHECK_SYMBOLS) {
    throw new RecoveryKeyError(
      "length",
      `Recovery key has ${symbols.length} characters, expected ${KEY_SYMBOLS + CHECK_SYMBOLS}`,
    );
  }
  const bytes = decodeBase32(symbols.slice(0, KEY_SYMBOLS), KEY_BYTES);
  if ((await checksum(bytes)) !== symbols.slice(KEY_SYMBOLS)) {
    throw new RecoveryKeyError("checksum", "Recovery key checksum does not match (typo?)");
  }
  return bytes;
}
