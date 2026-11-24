import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BudgeeDb } from "../src/db/db";

/** A database on its own in-memory IndexedDB, so tests never share state. */
export function freshDb(): BudgeeDb {
  return new BudgeeDb("budgee-test", { indexedDB: new IDBFactory(), IDBKeyRange });
}

/** A controllable wall clock. */
export function fakeNow(start: number) {
  let t = start;
  return {
    now: () => t,
    set: (ms: number) => {
      t = ms;
    },
  };
}

export const expense = {
  type: "expense",
  amount: 324000,
  date: "2026-11-17",
  category: "Groceries",
  detail: "Carrefour",
  created_at: "2026-11-17T09:00:00.000Z",
} as const;
