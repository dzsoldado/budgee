import { describe, expect, test } from "bun:test";
import { renameCategory } from "../src/categories";
import type { LiveTransaction, Tombstone } from "../src/schema";

const HLC = "001763000000000:00000:dev-a";
let n = 0;
function tx(extra: Partial<LiveTransaction>): LiveTransaction {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    hlc: HLC,
    deleted: false,
    device: "dev-a",
    type: "expense",
    amount: 1000,
    date: "2026-11-01",
    category: "Transport",
    detail: "",
    note: "",
    tags: [],
    original_amount: null,
    original_currency: null,
    created_at: "2026-11-01T10:00:00.000Z",
    ...extra,
  };
}
const tombstone: Tombstone = {
  id: "00000000-0000-4000-8000-999999999999",
  hlc: HLC,
  deleted: true,
  device: "dev-a",
};

describe("renameCategory", () => {
  test("bulk-updates every transaction of that type in that category and returns only those", () => {
    const a = tx({ category: "Gifts" });
    const b = tx({ category: "Medical" });
    const c = tx({ category: "Gifts", note: "keep" });
    const income = tx({ type: "income", category: "Gifts" });
    const updated = renameCategory([a, b, c, income, tombstone], "expense", "Gifts", "Presents");
    expect(updated).toEqual([
      { ...a, category: "Presents" },
      { ...c, category: "Presents" },
    ]);
    expect(a.category).toBe("Gifts"); // input untouched
    expect(updated[0]?.hlc).toBe(HLC); // the caller assigns the new hlc
    expect(renameCategory([a, income], "income", "Gifts", "Gifts received")).toEqual([
      { ...income, category: "Gifts received" },
    ]);
  });

  test("matches the exact managed name", () => {
    expect(renameCategory([tx({ category: "gifts" })], "expense", "Gifts", "Presents")).toEqual([]);
    // Renaming to the same name changes nothing, so nothing needs a new hlc.
    expect(renameCategory([tx({ category: "Gifts" })], "expense", "Gifts", "Gifts")).toEqual([]);
  });
});
