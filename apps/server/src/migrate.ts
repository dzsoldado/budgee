import type { Db } from "./ports";

/** One numbered `.sql` file from `apps/server/migrations/`, e.g. `{ name: "001_init", sql }`. */
export interface Migration {
  name: string;
  sql: string;
}

/**
 * Splits a migration file into single statements: on `;` outside strings, quoted identifiers
 * and comments. Comments are dropped. Trigger bodies (`BEGIN … ; … END`) are not supported.
 */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const closers: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

  while (i < sql.length) {
    const ch = sql.charAt(i);
    const closer = closers[ch];
    if (closer) {
      // Quoted text; a doubled closing quote ('' or "") is an escaped quote and stays inside.
      let end = i + 1;
      for (;;) {
        end = sql.indexOf(closer, end);
        if (end === -1) end = sql.length;
        else if (closer !== "]" && sql.charAt(end + 1) === closer) {
          end += 2;
          continue;
        } else end += 1;
        break;
      }
      current += sql.slice(i, end);
      i = end;
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === ";") {
      statements.push(current);
      current = "";
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Applies, in name order, the migrations not yet recorded in `_migrations`. Each migration and
 * its record go into one batch, so a migration applies completely or not at all. Returns the
 * names applied by this call.
 */
export async function migrate(db: Db, migrations: readonly Migration[]): Promise<string[]> {
  await db.run(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const isApplied = async (name: string) =>
    (await db.query("SELECT 1 FROM _migrations WHERE name = ?", [name])).length > 0;

  const applied: string[] = [];
  const ordered = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const migration of ordered) {
    if (await isApplied(migration.name)) continue;
    try {
      await db.batch([
        ...splitSql(migration.sql).map((sql) => ({ sql })),
        { sql: "INSERT INTO _migrations (name) VALUES (?)", params: [migration.name] },
      ]);
    } catch (error) {
      // Another runner (a second server on the same file, say) applied it in the meantime.
      if (await isApplied(migration.name)) continue;
      throw new Error(`Migration ${migration.name} failed`, { cause: error });
    }
    applied.push(migration.name);
  }
  return applied;
}
