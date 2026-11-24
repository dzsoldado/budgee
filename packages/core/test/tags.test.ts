import { describe, expect, test } from "bun:test";
import type { LiveTransaction, Tombstone, TransactionRow } from "../src/schema";
import {
  canonicalTag,
  deleteTag,
  InvalidTagError,
  listTags,
  mergeTags,
  normalizeTag,
  renameTag,
  sameTag,
  tagKey,
  uniqueTags,
  validateTag,
} from "../src/tags";

const HLC = "001763000000000:00000:dev-a";
let n = 0;
function tx(tags: string[], extra: Partial<LiveTransaction> = {}): LiveTransaction {
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
    tags,
    original_amount: null,
    original_currency: null,
    created_at: new Date(Date.UTC(2026, 10, 1, 10) + n * 1000).toISOString(),
    ...extra,
  };
}
const tombstone: Tombstone = {
  id: "00000000-0000-4000-8000-999999999999",
  hlc: HLC,
  deleted: true,
  device: "dev-a",
};

describe("normalizing and matching", () => {
  test("tags are trimmed", () => {
    expect(normalizeTag("  Istanbul 2026 \t")).toBe("Istanbul 2026");
    expect(normalizeTag("Wedding")).toBe("Wedding");
  });

  test("matching ignores case and surrounding spaces", () => {
    expect(sameTag("Istanbul 2026", " istanbul 2026 ")).toBe(true);
    expect(sameTag("WEDDING", "wedding")).toBe(true);
    expect(sameTag("Wedding", "Weddings")).toBe(false);
    expect(tagKey(" Istanbul 2026 ")).toBe(tagKey("ISTANBUL 2026"));
  });

  test("canonicalTag keeps the spelling already in use", () => {
    expect(canonicalTag(" istanbul 2026 ", ["Wedding", "Istanbul 2026"])).toBe("Istanbul 2026");
    expect(canonicalTag("  New trip ", ["Wedding"])).toBe("New trip");
  });

  test("uniqueTags trims, drops empties and keeps the first spelling", () => {
    expect(uniqueTags([" Trip ", "trip", "", "  ", "Work", "TRIP", "work "])).toEqual([
      "Trip",
      "Work",
    ]);
  });

  test("validateTag rejects ';' and empty tags, and returns the trimmed tag", () => {
    expect(validateTag("  Istanbul 2026 ")).toEqual({ ok: true, tag: "Istanbul 2026" });
    expect(validateTag("a;b")).toEqual({ ok: false, error: "semicolon" });
    expect(validateTag(";")).toEqual({ ok: false, error: "semicolon" });
    expect(validateTag("   ")).toEqual({ ok: false, error: "empty" });
    expect(validateTag("")).toEqual({ ok: false, error: "empty" });
  });
});

describe("listTags", () => {
  test("counts live transactions per tag, matching case-insensitively", () => {
    const rows: TransactionRow[] = [
      tx(["Istanbul 2026", "Wedding"]),
      tx(["istanbul 2026"]),
      tx(["ISTANBUL 2026 ", "istanbul 2026"]), // one transaction counts once
      tx([]),
      tx(["Wedding"]),
      tombstone,
    ];
    expect(listTags(rows)).toEqual([
      { tag: "Istanbul 2026", count: 3 },
      { tag: "Wedding", count: 2 },
    ]);
  });

  test("uses the spelling first used (earliest created_at), whatever the input order", () => {
    const later = tx(["wedding"], { created_at: "2026-11-05T09:00:00.000Z" });
    const first = tx(["Wedding"], { created_at: "2026-01-02T09:00:00.000Z" });
    expect(listTags([later, first])).toEqual([{ tag: "Wedding", count: 2 }]);
  });

  test("is sorted by name, ignoring case", () => {
    expect(listTags([tx(["b"]), tx(["C"]), tx(["a"])]).map((t) => t.tag)).toEqual(["a", "b", "C"]);
  });
});

describe("renameTag", () => {
  test("updates every matching transaction, in place in the tag list", () => {
    const a = tx(["Wedding", "Istanbul 2026"]);
    const b = tx(["istanbul 2026"]);
    const c = tx(["Work"]);
    const updated = renameTag([a, b, c, tombstone], "Istanbul 2026", "Istanbul trip");
    expect(updated.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(updated[0]?.tags).toEqual(["Wedding", "Istanbul trip"]);
    expect(updated[1]?.tags).toEqual(["Istanbul trip"]);
  });

  test("keeps every other field, including hlc (the caller assigns a new one)", () => {
    const a = tx(["Trip"], { note: "keep", detail: "ferry" });
    const [updated] = renameTag([a], "trip", "Journey");
    expect(updated).toEqual({ ...a, tags: ["Journey"] });
    expect(updated?.hlc).toBe(HLC);
  });

  test("does not mutate its input", () => {
    const a = tx(["Trip"]);
    const tags = a.tags;
    renameTag([a], "Trip", "Journey");
    expect(a.tags).toBe(tags);
    expect(a.tags).toEqual(["Trip"]);
  });

  test("renaming onto a tag the transaction already has leaves one copy", () => {
    const a = tx(["Trip", "Holiday", "journey"]);
    expect(renameTag([a], "Trip", "Journey")[0]?.tags).toEqual(["Journey", "Holiday"]);
  });

  test("changing only the case respells it everywhere", () => {
    const a = tx(["wedding"]);
    const b = tx(["Wedding"]);
    const updated = renameTag([a, b], "wedding", "Wedding");
    expect(updated.map((t) => t.id)).toEqual([a.id]);
    expect(updated[0]?.tags).toEqual(["Wedding"]);
  });

  test("trims the new name and rejects ';' or an empty name", () => {
    const a = tx(["Trip"]);
    expect(renameTag([a], "Trip", "  Journey  ")[0]?.tags).toEqual(["Journey"]);
    expect(() => renameTag([a], "Trip", "a;b")).toThrow(InvalidTagError);
    expect(() => renameTag([a], "Trip", "  ")).toThrow(InvalidTagError);
    try {
      renameTag([a], "Trip", "secret;tag");
    } catch (error) {
      expect((error as InvalidTagError).reason).toBe("semicolon");
      expect(String(error)).not.toContain("secret");
    }
  });

  test("returns nothing when no transaction carries the tag", () => {
    expect(renameTag([tx(["Work"])], "Trip", "Journey")).toEqual([]);
  });
});

describe("mergeTags", () => {
  test("replaces each source tag with the target on every matching transaction", () => {
    const a = tx(["Istanbul", "Food"]);
    const b = tx(["Food", "Istanbul trip", "Istanbul"]);
    // Also carried the target, spelled differently: one copy, in the target's spelling.
    const c = tx(["istanbul 2026", "Istanbul trip"]);
    const d = tx(["Work"]);
    // Carries only the target, so the merge has nothing to do there.
    const e = tx(["istanbul 2026"]);
    const updated = mergeTags([a, b, c, d, e], ["Istanbul", "Istanbul trip"], "Istanbul 2026");
    expect(updated.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(updated[0]?.tags).toEqual(["Istanbul 2026", "Food"]);
    expect(updated[1]?.tags).toEqual(["Food", "Istanbul 2026"]);
    expect(updated[2]?.tags).toEqual(["Istanbul 2026"]);
  });

  test("rejects an invalid target", () => {
    expect(() => mergeTags([tx(["a"])], ["a"], "x;y")).toThrow(InvalidTagError);
  });
});

describe("deleteTag", () => {
  test("removes the tag from every matching transaction", () => {
    const a = tx(["Wedding", "Gift"]);
    const b = tx(["wedding "]);
    const c = tx(["Gift"]);
    const updated = deleteTag([a, b, c, tombstone], "WEDDING");
    expect(updated.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(updated[0]?.tags).toEqual(["Gift"]);
    expect(updated[1]?.tags).toEqual([]);
    expect(updated[0]?.hlc).toBe(HLC);
  });
});
