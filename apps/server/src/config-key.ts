// CONFIG_KEY: the server's own secret, 32 random bytes in base64. Two keys are derived from it
// with HKDF, so neither use can stand in for the other: AES-256-GCM seals secrets kept in the
// `config` table (the Google refresh token), and HMAC-SHA256 signs the OAuth `state`.
import { fromBase64, fromBase64Url, toBase64, toBase64Url } from "@budgee/core";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface ConfigKeys {
  /** AES-256-GCM, for sealSecret / openSecret. */
  seal: CryptoKey;
  /** HMAC-SHA256, for signText / verifyText. */
  sign: CryptoKey;
}

/** A sealed secret that does not open: wrong CONFIG_KEY or purpose, modified, or malformed. */
export class SecretError extends Error {
  override name = "SecretError";
}

/** The key bytes from CONFIG_KEY's base64 text; null unless it is exactly 32 bytes. */
export function parseConfigKey(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bytes = fromBase64(text.trim());
    return bytes.length === KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

export async function deriveConfigKeys(raw: Uint8Array): Promise<ConfigKeys> {
  const base = await crypto.subtle.importKey("raw", new Uint8Array(raw), "HKDF", false, [
    "deriveKey",
  ]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(),
    info: new TextEncoder().encode(info),
  });
  const [seal, sign] = await Promise.all([
    crypto.subtle.deriveKey(
      hkdf("budgee config seal v1"),
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.deriveKey(
      hkdf("budgee oauth state v1"),
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    ),
  ]);
  return { seal: seal as CryptoKey, sign: sign as CryptoKey };
}

/**
 * `plaintext` encrypted with a fresh 96-bit IV, as base64(IV + ciphertext + tag). `purpose` is
 * the associated data: the result opens only for the same purpose.
 */
export async function sealSecret(
  key: CryptoKey,
  purpose: string,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
    key,
    new TextEncoder().encode(plaintext),
  );
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return toBase64(out);
}

/** The text sealSecret sealed for `purpose`. Throws SecretError. */
export async function openSecret(key: CryptoKey, purpose: string, sealed: string): Promise<string> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(sealed);
  } catch {
    throw new SecretError("Sealed secret is not base64");
  }
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new SecretError("Sealed secret is too short");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, IV_BYTES),
        additionalData: new TextEncoder().encode(purpose),
      },
      key,
      bytes.subarray(IV_BYTES),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new SecretError("Sealed secret does not open with this CONFIG_KEY");
  }
}

/** HMAC-SHA256 of `text`, base64url without padding. */
export async function signText(key: CryptoKey, text: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return toBase64Url(new Uint8Array(mac));
}

/** Whether `signature` is signText's for `text` (compared in constant time by Web Crypto). */
export async function verifyText(
  key: CryptoKey,
  text: string,
  signature: string,
): Promise<boolean> {
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromBase64Url(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(text));
}
