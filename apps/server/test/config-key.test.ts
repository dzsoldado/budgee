import { describe, expect, test } from "bun:test";
import { toBase64 } from "@budgee/core";
import {
  deriveConfigKeys,
  openSecret,
  parseConfigKey,
  SecretError,
  sealSecret,
  signText,
  verifyText,
} from "../src/config-key";

const raw = (fill: number) => new Uint8Array(32).fill(fill);
const keysOf = (fill: number) => deriveConfigKeys(raw(fill));

describe("CONFIG_KEY", () => {
  test("is 32 bytes of base64; anything else is refused", () => {
    expect(parseConfigKey(toBase64(raw(7)))).toEqual(raw(7));
    expect(parseConfigKey(` ${toBase64(raw(7))}\n`)).toEqual(raw(7));
    expect(parseConfigKey(toBase64(new Uint8Array(16)))).toBeNull();
    expect(parseConfigKey(toBase64(new Uint8Array(33)))).toBeNull();
    expect(parseConfigKey("not base64 at all!")).toBeNull();
    expect(parseConfigKey("")).toBeNull();
  });

  test("sealing round-trips, with a fresh IV each time", async () => {
    const { seal } = await keysOf(1);
    const a = await sealSecret(seal, "drive", "1//refresh-token");
    const b = await sealSecret(seal, "drive", "1//refresh-token");
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh-token");
    expect(await openSecret(seal, "drive", a)).toBe("1//refresh-token");
    expect(await openSecret(seal, "drive", b)).toBe("1//refresh-token");
  });

  test("a sealed secret opens only with the same key and purpose, unmodified", async () => {
    const { seal } = await keysOf(1);
    const sealed = await sealSecret(seal, "drive", "secret");
    const other = (await keysOf(2)).seal;
    const bytes = Uint8Array.from(atob(sealed), (ch) => ch.charCodeAt(0));
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;

    for (const attempt of [
      () => openSecret(other, "drive", sealed),
      () => openSecret(seal, "other-purpose", sealed),
      () => openSecret(seal, "drive", toBase64(bytes)),
      () => openSecret(seal, "drive", "AAAA"),
      () => openSecret(seal, "drive", "not base64!"),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(SecretError);
    }
  });

  test("signatures verify only for the same text and key", async () => {
    const { sign } = await keysOf(1);
    const signature = await signText(sign, "payload");
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyText(sign, "payload", signature)).toBe(true);
    expect(await verifyText(sign, "payload2", signature)).toBe(false);
    expect(await verifyText((await keysOf(2)).sign, "payload", signature)).toBe(false);
    expect(await verifyText(sign, "payload", "")).toBe(false);
    expect(await verifyText(sign, "payload", "!!")).toBe(false);
  });

  test("the sealing and signing keys are distinct derivations", async () => {
    const keys = await keysOf(1);
    // An HMAC key cannot be used for AES-GCM and the other way round.
    await expect(sealSecret(keys.sign, "drive", "x")).rejects.toThrow();
    await expect(signText(keys.seal, "x")).rejects.toThrow();
  });
});
