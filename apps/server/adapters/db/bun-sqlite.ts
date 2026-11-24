import type { Database } from "bun:sqlite";
import type { Db, SqlValue, Statement } from "../../src/ports";

/** The `Db` port over a `bun:sqlite` database (self-hosting, local development, tests). */
export function bunSqliteDb(database: Database): Db {
  const runOne = (sql: string, params: readonly SqlValue[] = []) => ({
    changes: database.query(sql).run(...params).changes,
  });
  // bun:sqlite runs the callback inside BEGIN … COMMIT and rolls back if it throws.
  const runAll = database.transaction((statements: readonly Statement[]) =>
    statements.map((s) => runOne(s.sql, s.params)),
  );

  return {
    async query<T>(sql: string, params: readonly SqlValue[] = []) {
      return database.query(sql).all(...params) as T[];
    },
    async run(sql, params) {
      return runOne(sql, params);
    },
    async batch(statements) {
      return statements.length === 0 ? [] : runAll(statements);
    },
  };
}
