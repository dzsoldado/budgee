import { Database } from "bun:sqlite";
import { bunSqliteDb } from "../adapters/db/bun-sqlite";
import { runDbContract } from "./db-contract";

runDbContract("bun:sqlite", async () => {
  const database = new Database(":memory:");
  return { db: bunSqliteDb(database), dispose: () => database.close() };
});
