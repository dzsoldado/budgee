import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  DecryptError,
  decryptRow,
  encryptRow,
  exportKey,
  fromBase64,
  fromBase64Url,
  fromRecoveryKey,
  generateVaultKey,
  importKey,
  RecoveryKeyError,
  toBase64,
  toBase64Url,
  toRecoveryKey,
} from "../src/crypto";

const ID = "6f1c2c1e-6b8a-4f57-9d0c-3f7f2a1d9e01";
const OTHER_ID = "6f1c2c1e-6b8a-4f57-9d0c-3f7f2a1d9e02";
const HLC = "001762250000000:00003:a1b2c3";
const fields = { type: "expense", name: "Transport", sort: 2, archived: false };

async function sealed() {
  const key = await generateVaultKey();
  const blob = await encryptRow(key, "categories", ID, HLC, fields);
  return { key, blob, envelope: { table: "categories" as const, id: ID, hlc: HLC, blob } };
}

/** Flip one bit of the decoded blob at `index` (negative counts from the end). */
function tamper(blob: string, index: number): string {
  const bytes = fromBase64(blob);
  const at = index < 0 ? bytes.length + index : index;
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  return toBase64(bytes);
}

async function decryptError(promise: Promise<unknown>): Promise<DecryptError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DecryptError);
    return error as DecryptError;
  }
  throw new Error("expected a DecryptError");
}

afterEach(() => {
  // Restore any spies.
  (crypto.subtle.decrypt as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("vault key", () => {
  test("a 256-bit AES-GCM key that exports to 32 raw bytes and imports back", async () => {
    const key = await generateVaultKey();
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    const raw = await exportKey(key);
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(raw.length).toBe(32);
    const again = await importKey(raw);
    expect(await exportKey(again)).toEqual(raw);
    // An imported key decrypts what the original encrypted.
    const blob = await encryptRow(key, "categories", ID, HLC, fields);
    expect(await decryptRow(again, { table: "categories", id: ID, hlc: HLC, blob })).toEqual(
      fields,
    );
  });

  test("two generated keys differ", async () => {
    const a = await exportKey(await generateVaultKey());
    const b = await exportKey(await generateVaultKey());
    expect(a).not.toEqual(b);
  });

  test("importKey refuses anything but 32 bytes", async () => {
    await expect(importKey(new Uint8Array(16))).rejects.toThrow(RangeError);
    await expect(importKey(new Uint8Array(33))).rejects.toThrow(RangeError);
  });
});

describe("row encryption", () => {
  test("encrypt then decrypt round-trips", async () => {
    const { key, envelope } = await sealed();
    expect(await decryptRow(key, envelope)).toEqual(fields);
  });

  test("blob is base64 of a fresh 12-byte IV + ciphertext + 16-byte tag", async () => {
    const key = await generateVaultKey();
    const a = await encryptRow(key, "categories", ID, HLC, fields);
    const b = await encryptRow(key, "categories", ID, HLC, fields);
    expect(a).not.toBe(b);
    expect(fromBase64(a).slice(0, 12)).not.toEqual(fromBase64(b).slice(0, 12));
    const plaintext = new TextEncoder().encode(JSON.stringify(fields));
    expect(fromBase64(a).length).toBe(12 + plaintext.length + 16);
    expect(a).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test("a wrong key fails", async () => {
    const { envelope } = await sealed();
    const error = await decryptError(decryptRow(await generateVaultKey(), envelope));
    expect(error.reason).toBe("failed");
  });

  test("a blob moved to another row id fails (associated data)", async () => {
    const { key, envelope } = await sealed();
    const error = await decryptError(decryptRow(key, { ...envelope, id: OTHER_ID }));
    expect(error.reason).toBe("failed");
  });

  test("a blob moved to another table or hlc fails (associated data)", async () => {
    const { key, envelope } = await sealed();
    await decryptError(decryptRow(key, { ...envelope, table: "transactions" }));
    await decryptError(decryptRow(key, { ...envelope, hlc: "001762250000000:00004:a1b2c3" }));
  });

  test("a modified blob fails: IV, ciphertext or tag", async () => {
    const { key, blob, envelope } = await sealed();
    for (const index of [0, 11, 12, 20, -1, -16]) {
      const error = await decryptError(decryptRow(key, { ...envelope, blob: tamper(blob, index) }));
      expect(error.reason).toBe("failed");
    }
  });

  test("a blob shorter than IV + tag is rejected before Web Crypto runs", async () => {
    const { key, envelope } = await sealed();
    const decrypt = spyOn(crypto.subtle, "decrypt");
    for (const length of [0, 1, 12, 27]) {
      const blob = toBase64(new Uint8Array(length));
      const error = await decryptError(decryptRow(key, { ...envelope, blob }));
      expect(error.reason).toBe("malformed");
      expect(error.message).toContain(`${length} bytes`);
      expect(error.message).toContain("IV (12)");
      expect(error.message).toContain("tag (16)");
    }
    expect(decrypt).not.toHaveBeenCalled();
  });

  test("a truncated blob fails", async () => {
    const { key, blob, envelope } = await sealed();
    const bytes = fromBase64(blob);
    await decryptError(decryptRow(key, { ...envelope, blob: toBase64(bytes.slice(0, -1)) }));
    await decryptError(decryptRow(key, { ...envelope, blob: toBase64(bytes.slice(0, 28)) }));
  });

  test("a blob that is not base64 is malformed", async () => {
    const { key, envelope } = await sealed();
    for (const blob of ["not base64!", "abc", "YWJj\nZGVm", ""]) {
      const error = await decryptError(decryptRow(key, { ...envelope, blob }));
      expect(error.reason).toBe("malformed");
    }
  });

  test("encryptRow only takes plain objects", async () => {
    const key = await generateVaultKey();
    await expect(encryptRow(key, "categories", ID, HLC, null as never)).rejects.toThrow(TypeError);
    await expect(encryptRow(key, "categories", ID, HLC, [1] as never)).rejects.toThrow(TypeError);
  });
});

describe("base64 helpers", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

  test("base64 round-trips and is strict", () => {
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
    expect(() => fromBase64("+/8")).toThrow(SyntaxError);
    expect(() => fromBase64("-_8=")).toThrow(SyntaxError);
  });

  test("base64url round-trips without padding and is URL-safe", async () => {
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    const key = await exportKey(await generateVaultKey());
    const text = toBase64Url(key);
    expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromBase64Url(text)).toEqual(key);
    expect(() => fromBase64Url("+/8")).toThrow(SyntaxError);
    expect(() => fromBase64Url("-_8=")).toThrow(SyntaxError);
    expect(() => fromBase64Url("a")).toThrow(SyntaxError);
  });
});

describe("recovery key", () => {
  const FORMAT = /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/;

  async function reason(text: string): Promise<string> {
    try {
      await fromRecoveryKey(text);
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryKeyError);
      return (error as RecoveryKeyError).reason;
    }
    throw new Error("expected a RecoveryKeyError");
  }

  test("Crockford base32 in groups of 4 plus a checksum group, round-trips", async () => {
    for (let i = 0; i < 20; i++) {
      const raw = await exportKey(await generateVaultKey());
      const text = await toRecoveryKey(raw);
      expect(text).toMatch(FORMAT);
      expect(await fromRecoveryKey(text)).toEqual(raw);
    }
  });

  test("known vectors: all zero bytes and all 0xff bytes", async () => {
    const zeros = await toRecoveryKey(new Uint8Array(32));
    expect(zeros.startsWith("0000-".repeat(13))).toBe(true);
    const ones = await toRecoveryKey(new Uint8Array(32).fill(0xff));
    // 256 one-bits: 51 full Z symbols, then 1 bit + 4 zero padding bits = 0b10000 = G.
    expect(ones.replaceAll("-", "").slice(0, 52)).toBe(`${"Z".repeat(51)}G`);
  });

  test("decoding is forgiving: case, I/L for 1, O for 0, spaces and missing dashes", async () => {
    const raw = await exportKey(await generateVaultKey());
    const text = await toRecoveryKey(raw);
    const loose = text.toLowerCase().replaceAll("1", "l").replaceAll("0", "O").replaceAll("-", " ");
    expect(await fromRecoveryKey(loose)).toEqual(raw);
    expect(await fromRecoveryKey(text.replaceAll("-", ""))).toEqual(raw);
    expect(await fromRecoveryKey(`  ${text.replaceAll("1", "I")}\n`)).toEqual(raw);
  });

  test("dashes a password manager or document substitutes, and any whitespace, are ignored", async () => {
    const raw = await exportKey(await generateVaultKey());
    const text = await toRecoveryKey(raw);
    // U+2010–U+2015 (hyphen to horizontal bar) and U+2212 (minus sign).
    // Also the fullwidth and small hyphen-minus (U+FF0D, U+FE63), small em dash (U+FE58), soft hyphen.
    for (const code of [
      0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xff0d, 0xfe58, 0xfe63, 0xad,
    ]) {
      const dash = String.fromCodePoint(code);
      expect(await fromRecoveryKey(text.replaceAll("-", dash))).toEqual(raw);
    }
    // No-break space between groups, em space and tab before, CRLF and ideographic space after.
    const [nbsp, emSpace, ideographic] = [0xa0, 0x2003, 0x3000].map((c) => String.fromCodePoint(c));
    const spaced = `${emSpace}\t${text.replaceAll("-", nbsp ?? "")}\r\n${ideographic}`;
    expect(await fromRecoveryKey(spaced)).toEqual(raw);
  });

  test("a single changed character fails the checksum", async () => {
    const raw = await exportKey(await generateVaultKey());
    const text = await toRecoveryKey(raw);
    // Change each of the first 51 data symbols in turn (the 52nd also carries padding bits).
    const symbols = text.replaceAll("-", "");
    for (let i = 0; i < 51; i++) {
      const swapped = symbols[i] === "A" ? "B" : "A";
      const changed = symbols.slice(0, i) + swapped + symbols.slice(i + 1);
      expect([i, await reason(changed)]).toEqual([i, "checksum"]);
    }
  });

  test("swapped adjacent groups and a changed checksum group fail", async () => {
    const text = await toRecoveryKey(await exportKey(await generateVaultKey()));
    const groups = text.split("-");
    const swapped = [groups[1], groups[0], ...groups.slice(2)].join("-");
    if (groups[0] !== groups[1]) expect(await reason(swapped)).toBe("checksum");
    const lastGroup = groups[13] ?? "";
    const changed = [...groups.slice(0, 13), lastGroup === "AAAA" ? "BBBB" : "AAAA"].join("-");
    expect(await reason(changed)).toBe("checksum");
  });

  test("wrong length and invalid characters", async () => {
    const text = await toRecoveryKey(await exportKey(await generateVaultKey()));
    expect(await reason(text.slice(0, -1))).toBe("length");
    expect(await reason(`${text}0`)).toBe("length");
    expect(await reason("")).toBe("length");
    expect(await reason(`U${text.slice(1)}`)).toBe("character");
    expect(await reason(`*${text.slice(1)}`)).toBe("character");
  });

  test("toRecoveryKey refuses anything but 32 bytes", async () => {
    await expect(toRecoveryKey(new Uint8Array(31))).rejects.toThrow(RangeError);
  });
});

describe("decrypt errors never carry plaintext", () => {
  test("plaintext that is not JSON stays out of the error and its cause", async () => {
    const key = await generateVaultKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealedBytes = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(JSON.stringify(["categories", ID, HLC])),
      },
      key,
      new TextEncoder().encode("SECRET-7f3a not json"),
    );
    const blob = toBase64(new Uint8Array([...iv, ...new Uint8Array(sealedBytes)]));
    const error = await decryptError(
      decryptRow(key, { table: "categories", id: ID, hlc: HLC, blob }),
    );
    expect(error.reason).toBe("malformed");
    const exposed = [
      String(error),
      error.stack,
      Bun.inspect(error),
      Bun.inspect(error.cause),
    ].join();
    expect(exposed).not.toContain("SECRET");
  });
});
