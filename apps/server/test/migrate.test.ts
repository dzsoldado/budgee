import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrations } from "../migrations";
import { splitSql } from "../src/migrate";

describe("splitSql", () => {
  test("splits on semicolons and drops empty statements", () => {
    expect(splitSql("CREATE TABLE a (x);\n\nINSERT INTO a VALUES (1) ;;\n  ")).toEqual([
      "CREATE TABLE a (x)",
      "INSERT INTO a VALUES (1)",
    ]);
  });

  test("keeps a last statement without a semicolon", () => {
    expect(splitSql("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("ignores semicolons inside strings and quoted identifiers", () => {
    expect(
      splitSql(`INSERT INTO "a;b" VALUES ('x;y', 'it''s; fine');\nSELECT \`c;d\`, [e;f] FROM t;`),
    ).toEqual([`INSERT INTO "a;b" VALUES ('x;y', 'it''s; fine')`, "SELECT `c;d`, [e;f] FROM t"]);
  });

  test("strips comments, including semicolons inside them", () => {
    expect(
      splitSql(
        "-- header; not a statement\nCREATE TABLE a (\n  x INTEGER -- note; here\n); /* a; b */ SELECT 1;\n-- trailing",
      ),
    ).toEqual(["CREATE TABLE a (\n  x INTEGER \n)", "SELECT 1"]);
  });

  test("keeps comment markers inside strings", () => {
    expect(splitSql("SELECT '--not a comment', '/* nor this */';")).toEqual([
      "SELECT '--not a comment', '/* nor this */'",
    ]);
  });

  test("a file of only comments has no statements", () => {
    expect(splitSql("-- nothing\n/* here */\n")).toEqual([]);
  });
});

describe("bundled migrations", () => {
  test("migrations/index.ts matches the .sql files (run `bun run gen:migrations` after editing one)", () => {
    const dir = join(import.meta.dir, "..", "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    expect(files.length).toBeGreaterThan(0);
    expect(migrations).toEqual(
      files.map((f) => ({
        name: f.replace(/\.sql$/, ""),
        sql: readFileSync(join(dir, f), "utf8"),
      })),
    );
  });

  test("names are numbered and unique", () => {
    const names = migrations.map((m) => m.name);
    for (const name of names) expect(name).toMatch(/^\d{3}_[a-z0-9_]+$/);
    expect(new Set(names).size).toBe(names.length);
  });
});
