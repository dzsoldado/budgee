import { describe, expect, test } from "bun:test";
import { DEFAULT_CATEGORIES, type LiveTransaction, SETTING_IDS } from "@budgee/core";
import type { BudgeeDb } from "../src/db/db";
import { type LocalChange, openRepository, type Repository } from "../src/db/repository";
import { seedDefaults } from "../src/db/seed";
import {
  addItem,
  categoriesOfType,
  chartsFilteringOn,
  checkName,
  deleteItem,
  type EntryType,
  ListError,
  mergeItem,
  mergeTagInto,
  moveItem,
  removeTag,
  renameItem,
  renameTagEverywhere,
  setArchived,
  tagCollision,
  usage,
} from "../src/settings/lists";
import { expense, freshDb } from "./helpers";

/** A default category's id, by name. */
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)?.id ?? "";

async function setup(): Promise<{ db: BudgeeDb; repo: Repository; changes: LocalChange[][] }> {
  const db = freshDb();
  await seedDefaults(db);
  const repo = await openRepository(db);
  const changes: LocalChange[][] = [];
  repo.onLocalWrite((c) => changes.push([...c]));
  return { db, repo, changes };
}

async function live(db: BudgeeDb): Promise<LiveTransaction[]> {
  const rows = await db.transactions.toArray();
  return rows.filter((r): r is typeof r & LiveTransaction => !r.deleted);
}

const income = { ...expense, type: "income", category: "Gifts received" } as const;

async function names(db: BudgeeDb, type: EntryType): Promise<string[]> {
  return categoriesOfType(await db.categories.toArray(), type).map((r) => r.name);
}

describe("checkName", () => {
  const rows = [
    { id: "g", name: "Groceries" },
    { id: "t", name: "Transport" },
  ];
  test("trims, and rejects empty names and case-insensitive duplicates", () => {
    expect(checkName("  Travel ", rows)).toEqual({ ok: true, name: "Travel" });
    expect(checkName("   ", rows)).toEqual({ ok: false, error: "empty" });
    expect(checkName("transport", rows)).toEqual({ ok: false, error: "taken" });
    expect(checkName(" TRANSPORT ", rows)).toEqual({ ok: false, error: "taken" });
  });
  test("a row may keep its own name in another case", () => {
    expect(checkName("transport", rows, "t")).toEqual({ ok: true, name: "transport" });
    expect(checkName("groceries", rows, "t")).toEqual({ ok: false, error: "taken" });
  });
});

describe("usage", () => {
  test("counts live entries of the type filed under the name", () => {
    const rows = [
      { ...expense, deleted: false, category: "Gifts" },
      { ...expense, deleted: false, category: "Gifts" },
      { ...expense, deleted: false, category: "Medical" },
      { ...income, deleted: false, category: "Gifts" },
      { deleted: true },
    ] as const;
    expect(usage(rows, "expense", "Gifts")).toBe(2);
    expect(usage(rows, "income", "Gifts")).toBe(1);
    expect(usage(rows, "expense", "Travel")).toBe(0);
  });
});

describe("addItem", () => {
  test("adds at the end of its type's list", async () => {
    const { db, repo } = await setup();
    const travel = await addItem(db, repo, "expense", " Travel ");
    await addItem(db, repo, "income", "Refunds");
    expect(travel).toMatchObject({ type: "expense", name: "Travel", archived: false });
    expect((await names(db, "expense")).slice(-2)).toEqual(["Misc", "Travel"]);
    expect(await names(db, "income")).toEqual(["Salary", "Freelance", "Gifts received", "Refunds"]);
  });

  test("rejects a taken name (any case), in either type", async () => {
    const { db, repo } = await setup();
    await expect(addItem(db, repo, "expense", "groceries")).rejects.toThrow(ListError);
    await expect(addItem(db, repo, "expense", " ")).rejects.toMatchObject({ reason: "empty" });
    // Names are unique across types, archived ones included.
    await expect(addItem(db, repo, "income", " gifts ")).rejects.toMatchObject({
      reason: "takenByExpense",
    });
    await setArchived(db, repo, "income", id("Freelance"), true);
    await expect(addItem(db, repo, "expense", "FREELANCE")).rejects.toMatchObject({
      reason: "takenByIncome",
    });
    expect(await names(db, "income")).toEqual(["Salary", "Freelance", "Gifts received"]);
  });
});

describe("renameItem", () => {
  test("renames the category and its entries in one write", async () => {
    const { db, repo, changes } = await setup();
    const a = await repo.put("transactions", { ...expense, category: "Medical" });
    const b = await repo.put("transactions", expense);
    changes.length = 0;
    expect(await renameItem(db, repo, "expense", id("Medical"), " Doctor ")).toBe(1);
    expect(await names(db, "expense")).toContain("Doctor");
    expect(await names(db, "expense")).not.toContain("Medical");
    const after = await live(db);
    expect(after.find((t) => t.id === a.id)?.category).toBe("Doctor");
    expect(after.find((t) => t.id === b.id)?.category).toBe("Groceries");
    expect(changes).toEqual([
      [
        { table: "transactions", id: a.id },
        { table: "categories", id: id("Medical") },
      ],
    ]);
    const renamed = await db.transactions.get(a.id);
    expect(renamed?.dirty).toBe(1);
    expect(renamed?.hlc).not.toBe(a.hlc);
  });

  test("rejects a name the other type has, touching no entry", async () => {
    const { db, repo } = await setup();
    const a = await repo.put("transactions", { ...expense, category: "Medical" });
    await expect(renameItem(db, repo, "expense", id("Medical"), "salary")).rejects.toMatchObject({
      reason: "takenByIncome",
    });
    await expect(
      renameItem(db, repo, "income", id("Freelance"), "Groceries"),
    ).rejects.toMatchObject({ reason: "takenByExpense" });
    expect((await db.transactions.get(a.id))?.hlc).toBe(a.hlc);
    expect(await names(db, "expense")).toContain("Medical");
  });

  test("may change case; rejects a name another category of the type has", async () => {
    const { db, repo } = await setup();
    await renameItem(db, repo, "expense", id("Medical"), "MEDICAL");
    expect(await names(db, "expense")).toContain("MEDICAL");
    await expect(renameItem(db, repo, "expense", id("Medical"), "groceries")).rejects.toMatchObject(
      { reason: "taken" },
    );
  });

  test("refuses a category deleted elsewhere, touching no entry", async () => {
    const { db, repo } = await setup();
    const a = await repo.put("transactions", { ...expense, category: "Medical" });
    await repo.remove("categories", id("Medical"));
    await expect(renameItem(db, repo, "expense", id("Medical"), "Doctor")).rejects.toMatchObject({
      reason: "missing",
    });
    expect((await db.transactions.get(a.id))?.hlc).toBe(a.hlc);
  });

  test("rolls back the saved entries when a later write in the same change fails", async () => {
    const { db, repo, changes } = await setup();
    const a = await repo.put("transactions", { ...expense, category: "Medical" });
    changes.length = 0;
    // The entries are saved first, then the category update throws.
    const failing: Repository = {
      ...repo,
      write: (fn) =>
        repo.write((w) =>
          fn({
            ...w,
            update: async () => {
              throw new Error("disk full");
            },
          }),
        ),
    };
    await expect(renameItem(db, failing, "expense", id("Medical"), "Doctor")).rejects.toThrow(
      "disk full",
    );
    expect(await db.transactions.get(a.id)).toEqual({ ...a, dirty: 1 });
    expect(await names(db, "expense")).toContain("Medical");
    expect(changes).toEqual([]);
  });

  test("an archived category still holds its name", async () => {
    const { db, repo } = await setup();
    await setArchived(db, repo, "expense", id("Medical"), true);
    await expect(addItem(db, repo, "expense", "medical")).rejects.toMatchObject({
      reason: "taken",
    });
    await expect(renameItem(db, repo, "expense", id("Groceries"), "MEDICAL")).rejects.toMatchObject(
      { reason: "taken" },
    );
  });
});

describe("mergeItem", () => {
  test("moves the entries to the target, then deletes the source, in one write", async () => {
    const { db, repo, changes } = await setup();
    const travel = await addItem(db, repo, "expense", "Travel");
    const a = await repo.put("transactions", { ...expense, category: "Travel" });
    const b = await repo.put("transactions", { ...expense, category: "Travel" });
    await repo.remove("transactions", b.id);
    changes.length = 0;
    expect(await mergeItem(db, repo, "expense", travel.id, id("Transport"))).toBe(1);
    expect(await names(db, "expense")).not.toContain("Travel");
    expect((await db.categories.get(travel.id))?.deleted).toBe(true);
    expect((await live(db)).find((t) => t.id === a.id)?.category).toBe("Transport");
    expect(changes).toHaveLength(1);
  });

  test("rejects merging a category into itself or into one of the other type", async () => {
    const { db, repo } = await setup();
    await expect(
      mergeItem(db, repo, "expense", id("Medical"), id("Medical")),
    ).rejects.toMatchObject({ reason: "missing" });
    await expect(mergeItem(db, repo, "expense", id("Gifts"), id("Salary"))).rejects.toMatchObject({
      reason: "missing",
    });
  });

  test("refuses to merge away the type's only active category", async () => {
    const { db, repo } = await setup();
    await setArchived(db, repo, "income", id("Freelance"), true);
    await setArchived(db, repo, "income", id("Gifts received"), true);
    await expect(
      mergeItem(db, repo, "income", id("Salary"), id("Freelance")),
    ).rejects.toMatchObject({ reason: "last" });
    expect(await names(db, "income")).toEqual(["Salary", "Freelance", "Gifts received"]);
  });
});

describe("deleteItem", () => {
  test("deletes an unused category", async () => {
    const { db, repo } = await setup();
    await deleteItem(db, repo, "expense", id("Medical"));
    expect((await db.categories.get(id("Medical")))?.deleted).toBe(true);
  });

  test("refuses while a live entry uses it", async () => {
    const { db, repo } = await setup();
    const a = await repo.put("transactions", { ...expense, category: "Medical" });
    await expect(deleteItem(db, repo, "expense", id("Medical"))).rejects.toMatchObject({
      reason: "inUse",
    });
    await repo.remove("transactions", a.id);
    await deleteItem(db, repo, "expense", id("Medical"));
    expect(await names(db, "expense")).not.toContain("Medical");
  });

  test("keeps at least one active category of the type", async () => {
    const { db, repo } = await setup();
    await deleteItem(db, repo, "income", id("Freelance"));
    await deleteItem(db, repo, "income", id("Gifts received"));
    await expect(deleteItem(db, repo, "income", id("Salary"))).rejects.toMatchObject({
      reason: "last",
    });
    await expect(setArchived(db, repo, "income", id("Salary"), true)).rejects.toMatchObject({
      reason: "last",
    });
  });
});

describe("setArchived", () => {
  test("archives and restores, keeping the entries", async () => {
    const { db, repo } = await setup();
    const a = await repo.put("transactions", { ...expense, category: "Medical" });
    await setArchived(db, repo, "expense", id("Medical"), true);
    expect((await db.categories.get(id("Medical"))) as { archived?: boolean }).toMatchObject({
      archived: true,
    });
    expect((await db.transactions.get(a.id))?.hlc).toBe(a.hlc);
    await setArchived(db, repo, "expense", id("Medical"), false);
    expect((await db.categories.get(id("Medical"))) as { archived?: boolean }).toMatchObject({
      archived: false,
    });
  });
});

describe("moveItem", () => {
  test("swaps with the neighbour and renumbers the type's list", async () => {
    const { db, repo } = await setup();
    await moveItem(db, repo, "expense", id("Transport"), -1);
    expect((await names(db, "expense")).slice(0, 3)).toEqual(["Transport", "Groceries", "Bills"]);
    await moveItem(db, repo, "expense", id("Misc"), 1); // already last: no change
    expect((await names(db, "expense")).at(-1)).toBe("Misc");
    expect(await names(db, "income")).toEqual(["Salary", "Freelance", "Gifts received"]);
  });

  test("writes only the rows whose sort changes, in one write", async () => {
    const { db, repo, changes } = await setup();
    await moveItem(db, repo, "income", id("Freelance"), -1);
    expect(await names(db, "income")).toEqual(["Freelance", "Salary", "Gifts received"]);
    expect(changes).toEqual([
      [
        { table: "categories", id: id("Freelance") },
        { table: "categories", id: id("Salary") },
      ],
    ]);
  });

  test("tied and gapped sorts (e.g. from two devices) move by the shown order", async () => {
    const { db, repo } = await setup();
    const refunds = await addItem(db, repo, "income", "Refunds");
    await repo.update("categories", id("Salary"), { sort: 5 });
    await repo.update("categories", id("Freelance"), { sort: 5 });
    await repo.update("categories", id("Gifts received"), { sort: 7 });
    await repo.update("categories", refunds.id, { sort: 40 });
    // Ties sort by name: Freelance before Salary.
    expect(await names(db, "income")).toEqual(["Freelance", "Salary", "Gifts received", "Refunds"]);
    await moveItem(db, repo, "income", refunds.id, -1);
    expect(await names(db, "income")).toEqual(["Freelance", "Salary", "Refunds", "Gifts received"]);
    const sorts = (await db.categories.toArray())
      .filter((c) => !c.deleted && c.type === "income")
      .map((c) => [c.id, (c as { sort: number }).sort]);
    expect(Object.fromEntries(sorts)).toEqual({
      [id("Freelance")]: 0,
      [id("Salary")]: 1,
      [refunds.id]: 2,
      [id("Gifts received")]: 3,
    });
  });
});

describe("dashboard and chart references follow the names", () => {
  const exclude = (categories: string[], tags: string[]) => ({ categories, tags });

  async function withReferences(
    repo: Repository,
    names: { categories?: string[]; tags?: string[] },
    onlyTags: string[] = [],
  ) {
    const lists = exclude(names.categories ?? [], names.tags ?? []);
    await repo.setSetting("dashboard", {
      period: "month",
      compare: "same_period_last_year",
      exclude: lists,
    });
    const chart = await repo.put("chart_configs", {
      name: "Trip",
      sort: 9,
      config: {
        kind: "bar",
        metric: "expenses",
        groupBy: "day",
        period: "all_time",
        exclude: lists,
        onlyTags,
      },
    });
    const untouched = await repo.put("chart_configs", {
      name: "Plain",
      sort: 10,
      config: { kind: "bar", metric: "expenses", groupBy: "day", period: "all_time" },
    });
    return { chart, untouched };
  }

  async function dashboardExclude(db: BudgeeDb) {
    const row = await db.settings.get(SETTING_IDS.dashboard);
    return (row as { value: { exclude: unknown } }).value.exclude;
  }
  async function chartOf(db: BudgeeDb, id: string) {
    const row = await db.chart_configs.get(id);
    return (row as { config: { exclude: unknown; onlyTags: string[] } }).config;
  }

  test("a category rename maps the name everywhere, in the same write", async () => {
    const { db, repo, changes } = await setup();
    const { chart, untouched } = await withReferences(repo, {
      categories: ["Medical", "Groceries"],
    });
    changes.length = 0;
    await renameItem(db, repo, "expense", id("Medical"), "Doctor");
    expect(await dashboardExclude(db)).toEqual(exclude(["Doctor", "Groceries"], []));
    expect((await chartOf(db, chart.id)).exclude).toEqual(exclude(["Doctor", "Groceries"], []));
    expect((await db.chart_configs.get(untouched.id))?.hlc).toBe(untouched.hlc);
    expect(changes).toEqual([
      [
        { table: "categories", id: id("Medical") },
        { table: "settings", id: SETTING_IDS.dashboard },
        { table: "chart_configs", id: chart.id },
      ],
    ]);
  });

  test("a category merge maps onto the target once; a delete drops the name", async () => {
    const { db, repo } = await setup();
    const travel = await addItem(db, repo, "expense", "Travel");
    const trip = await addItem(db, repo, "expense", "Trip");
    const { chart } = await withReferences(repo, {
      categories: ["Travel", "Transport", "Trip"],
    });
    await mergeItem(db, repo, "expense", travel.id, id("Transport"));
    expect(await dashboardExclude(db)).toEqual(exclude(["Transport", "Trip"], []));
    await deleteItem(db, repo, "expense", trip.id);
    expect(await dashboardExclude(db)).toEqual(exclude(["Transport"], []));
    expect((await chartOf(db, chart.id)).exclude).toEqual(exclude(["Transport"], []));
  });

  test("income categories map the same way", async () => {
    const { db, repo } = await setup();
    const { chart } = await withReferences(repo, {
      categories: ["Salary", "Freelance", "Groceries"],
    });
    await renameItem(db, repo, "income", id("Salary"), "Wages");
    await mergeItem(db, repo, "income", id("Freelance"), id("Gifts received"));
    const expected = exclude(["Wages", "Gifts received", "Groceries"], []);
    expect(await dashboardExclude(db)).toEqual(expected);
    expect((await chartOf(db, chart.id)).exclude).toEqual(expected);
  });

  test("tags: rename, merge and delete patch exclusions and onlyTags, ignoring case", async () => {
    const { db, repo } = await setup();
    await repo.put("transactions", { ...expense, tags: ["Trip", "Wedding", "Home office"] });
    const { chart } = await withReferences(repo, { tags: ["trip", "Wedding"] }, [
      "TRIP",
      "Home office",
    ]);
    await renameTagEverywhere(db, repo, "Trip", "Istanbul 2026");
    expect(await dashboardExclude(db)).toEqual(exclude([], ["Istanbul 2026", "Wedding"]));
    expect((await chartOf(db, chart.id)).onlyTags).toEqual(["Istanbul 2026", "Home office"]);

    await mergeTagInto(db, repo, "Home office", "Istanbul 2026");
    expect((await chartOf(db, chart.id)).onlyTags).toEqual(["Istanbul 2026"]);

    await removeTag(db, repo, "wedding");
    expect(await dashboardExclude(db)).toEqual(exclude([], ["Istanbul 2026"]));
    expect((await chartOf(db, chart.id)).exclude).toEqual(exclude([], ["Istanbul 2026"]));
  });

  test("a deleted tag leaves exclusions but stays in onlyTags, so the chart shows nothing", async () => {
    const { db, repo } = await setup();
    await repo.put("transactions", { ...expense, tags: ["Trip"] });
    const { chart } = await withReferences(repo, { tags: ["Trip"] }, ["trip"]);
    await removeTag(db, repo, "Trip");
    expect(await dashboardExclude(db)).toEqual(exclude([], []));
    expect(await chartOf(db, chart.id)).toMatchObject({
      exclude: exclude([], []),
      onlyTags: ["trip"],
    });
  });

  test("chartsFilteringOn counts live charts limited to the tag, ignoring case", async () => {
    const { db, repo } = await setup();
    const config = { kind: "bar", metric: "expenses", groupBy: "day", period: "all_time" } as const;
    await repo.put("chart_configs", {
      name: "A",
      sort: 1,
      config: { ...config, onlyTags: ["Trip"] },
    });
    await repo.put("chart_configs", {
      name: "B",
      sort: 2,
      config: { ...config, onlyTags: ["Wedding", "TRIP"] },
    });
    const gone = await repo.put("chart_configs", {
      name: "C",
      sort: 3,
      config: { ...config, onlyTags: ["trip"] },
    });
    await repo.put("chart_configs", {
      name: "D",
      sort: 4,
      config: { ...config, exclude: exclude([], ["Trip"]) },
    });
    await repo.remove("chart_configs", gone.id);
    const charts = await db.chart_configs.toArray();
    expect(chartsFilteringOn(charts, "trip")).toBe(2);
    expect(chartsFilteringOn(charts, "Wedding")).toBe(1);
    expect(chartsFilteringOn(charts, "Holiday")).toBe(0);
  });

  test("no references, no extra writes", async () => {
    const { db, repo, changes } = await setup();
    const a = await repo.put("transactions", { ...expense, tags: ["Trip"] });
    changes.length = 0;
    await renameTagEverywhere(db, repo, "Trip", "Holiday");
    expect(changes).toEqual([[{ table: "transactions", id: a.id }]]);
  });
});

describe("tags", () => {
  test("rename updates every entry carrying the tag, in one write", async () => {
    const { db, repo, changes } = await setup();
    const a = await repo.put("transactions", { ...expense, tags: ["istanbul 2026", "Trip"] });
    const b = await repo.put("transactions", { ...expense, tags: ["Wedding"] });
    changes.length = 0;
    expect(await renameTagEverywhere(db, repo, "Istanbul 2026", "Istanbul trip")).toBe(1);
    const after = await live(db);
    expect(after.find((t) => t.id === a.id)?.tags).toEqual(["Istanbul trip", "Trip"]);
    expect(after.find((t) => t.id === b.id)?.tags).toEqual(["Wedding"]);
    expect(changes).toEqual([[{ table: "transactions", id: a.id }]]);
  });

  test("rename rejects ';' and empty names", async () => {
    const { db, repo } = await setup();
    await repo.put("transactions", { ...expense, tags: ["Trip"] });
    await expect(renameTagEverywhere(db, repo, "Trip", "a;b")).rejects.toMatchObject({
      reason: "semicolon",
    });
    await expect(renameTagEverywhere(db, repo, "Trip", "  ")).rejects.toMatchObject({
      reason: "empty",
    });
  });

  test("merge keeps the target's spelling once per entry", async () => {
    const { db, repo } = await setup();
    const a = await repo.put("transactions", { ...expense, tags: ["Trip", "Istanbul 2026"] });
    const b = await repo.put("transactions", { ...expense, tags: ["trip"] });
    expect(await mergeTagInto(db, repo, "Trip", "Istanbul 2026")).toBe(2);
    const after = await live(db);
    expect(after.find((t) => t.id === a.id)?.tags).toEqual(["Istanbul 2026"]);
    expect(after.find((t) => t.id === b.id)?.tags).toEqual(["Istanbul 2026"]);
  });

  test("delete removes the tag and keeps the entries", async () => {
    const { db, repo } = await setup();
    const a = await repo.put("transactions", { ...expense, tags: ["Trip", "Wedding"] });
    expect(await removeTag(db, repo, "trip")).toBe(1);
    expect((await live(db)).find((t) => t.id === a.id)?.tags).toEqual(["Wedding"]);
  });

  test("tagCollision names another tag with the same key", () => {
    const tags = ["Istanbul 2026", "Trip", "Wedding"];
    expect(tagCollision(tags, "Trip", "wedding")).toBe("Wedding");
    expect(tagCollision(tags, "Trip", "TRIP")).toBeUndefined();
    expect(tagCollision(tags, "Trip", "Holiday")).toBeUndefined();
  });
});
