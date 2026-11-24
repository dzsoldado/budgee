import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { bunSqliteDb } from "../adapters/db/bun-sqlite";
import { migrations } from "../migrations";
import { initDatabase } from "../src/init";
import {
  newPairingCode,
  normalizePairingCode,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from "../src/tokens";

describe("initDatabase", () => {
  test("migrates, then creates the serverId once and keeps it", async () => {
    const database = new Database(":memory:");
    const db = bunSqliteDb(database);

    const first = await initDatabase(db, migrations);
    expect(first.serverId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db.query("SELECT name FROM _migrations")).toEqual(
      migrations.map(({ name }) => ({ name })),
    );
    expect(await initDatabase(db, migrations)).toEqual(first);
    expect(await db.query("SELECT key, value FROM config")).toEqual([
      { key: "serverId", value: first.serverId },
    ]);
    database.close();
  });

  test("two databases get different serverIds", async () => {
    const ids = await Promise.all(
      [1, 2].map(
        async () =>
          (await initDatabase(bunSqliteDb(new Database(":memory:")), migrations)).serverId,
      ),
    );
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("tokens", () => {
  test("randomToken is 32 random bytes as base64url", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  test("sha256Hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("timingSafeEqual compares any two strings", async () => {
    expect(await timingSafeEqual("secret", "secret")).toBe(true);
    expect(await timingSafeEqual("secret", "secreT")).toBe(false);
    expect(await timingSafeEqual("secret", "secret!")).toBe(false);
    expect(await timingSafeEqual("", "")).toBe(true);
  });

  test("pairing codes are 8 Crockford base32 symbols", () => {
    const codes = new Set(Array.from({ length: 200 }, newPairingCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  test("normalizePairingCode reads typed codes; null when it cannot be a code", () => {
    expect(normalizePairingCode("ab12-cd34")).toBe("AB12CD34");
    expect(normalizePairingCode(" il0o ab cd ")).toBe("1100ABCD");
    expect(normalizePairingCode("AB12CD3")).toBeNull();
    expect(normalizePairingCode("AB12CD345")).toBeNull();
    expect(normalizePairingCode("AB12CD3U")).toBeNull();
  });
});
