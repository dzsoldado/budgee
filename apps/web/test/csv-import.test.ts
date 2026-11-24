import { describe, expect, test } from "bun:test";
import {
  autoMapHeaders,
  exportCsv,
  FULL_COLUMNS,
  type LiveTransaction,
  validateImportRows,
} from "@budgee/core";
import {
  applyImport,
  CsvReadError,
  categoryKey,
  checkCsvSize,
  confirmSummary,
  loadImportContext,
  MAX_CSV_BYTES,
  missingColumns,
  newNames,
  PREVIEW_LIMIT,
  planImport,
  previewPage,
  previewSummary,
  readCsvText,
  upToDateIds,
} from "../src/csv/import";
import type { BudgeeDb } from "../src/db/db";
import { openRepository, type Repository } from "../src/db/repository";
import { seedDefaults } from "../src/db/seed";
import { expense, freshDb } from "./helpers";

const NOW = Date.UTC(2026, 10, 23, 12);
const ID_A = "0b7c1e2a-5d3f-4c8e-9a1b-00000000000a";
const ID_B = "0b7c1e2a-5d3f-4c8e-9a1b-00000000000b";
const hlc = (wall: number, device = "laptop") =>
  `${String(wall).padStart(15, "0")}:00000:${device}`;

async function setup(): Promise<{ db: BudgeeDb; repo: Repository }> {
  const db = freshDb();
  await seedDefaults(db);
  const repo = await openRepository(db, { now: () => NOW });
  return { db, repo };
}

async function check(db: BudgeeDb, text: string) {
  const file = readCsvText(text);
  return validateImportRows(file.rows, autoMapHeaders(file.headers), await loadImportContext(db));
}

const live = async (db: BudgeeDb) =>
  (await db.transactions.toArray()).filter((row) => !row.deleted) as LiveTransaction[];

describe("reading the file", () => {
  test("a BOM is dropped and rows keep their file line", () => {
    const file = readCsvText("\uFEFFdate,type\n\n2026-11-02,expense\n");
    expect(file.headers).toEqual(["date", "type"]);
    expect(file.lines).toEqual([3]);
  });

  test("malformed CSV names the line; empty files and header-only files are refused", () => {
    expect(() => readCsvText('date\n"2026')).toThrow(CsvReadError);
    try {
      readCsvText('date\n2026\n"x');
    } catch (error) {
      expect(error).toMatchObject({ reason: "unterminated_quote", line: 3 });
    }
    for (const text of ["", "\n\n", "date,type\n", "date,type\n,\n"]) {
      expect(() => readCsvText(text)).toThrow(expect.objectContaining({ reason: "empty" }));
    }
  });

  test("files over the limit are refused before reading", () => {
    expect(() => checkCsvSize(MAX_CSV_BYTES)).not.toThrow();
    expect(() => checkCsvSize(MAX_CSV_BYTES + 1)).toThrow(
      expect.objectContaining({ reason: "too_large" }),
    );
  });
});

describe("planImport and applyImport", () => {
  test("new categories are created after the last of their type; declined ones skip their rows", async () => {
    const { db, repo } = await setup();
    const validation = await check(
      db,
      [
        "date,type,amount,category",
        "2026-11-03,expense,10,Souvenirs",
        "2026-11-04,expense,20,souvenirs",
        "2026-11-05,income,30,Bonus",
        "2026-11-06,expense,40,Travel",
        "2026-11-07,expense,50,Groceries",
      ].join("\n"),
    );
    const plan = planImport(validation, new Set([categoryKey("expense", "souvenirs")]));
    expect(plan.categories).toEqual([
      { type: "income", name: "Bonus" },
      { type: "expense", name: "Travel" },
    ]);
    expect(plan.declinedRows).toBe(2);
    expect(plan.added.map((f) => f.amount)).toEqual([3000, 4000, 5000]);

    const result = await applyImport(db, repo, plan, NOW);
    expect(result).toEqual({ added: 3, merged: 0, categories: 2 });
    const categories = (await db.categories.toArray()).filter((c) => !c.deleted);
    const last = (type: string) =>
      Math.max(...categories.filter((c) => c.type === type).map((c) => c.sort));
    expect(categories.find((c) => c.name === "Travel")).toMatchObject({
      type: "expense",
      sort: last("expense"),
      dirty: 1,
    });
    expect(categories.find((c) => c.name === "Bonus")).toMatchObject({
      type: "income",
      sort: last("income"),
      dirty: 1,
    });
    expect(categories.some((c) => c.name === "Souvenirs")).toBe(false);
    const entries = (await live(db)).sort((a, b) => a.amount - b.amount);
    expect(entries.map((e) => [e.type, e.category])).toEqual([
      ["income", "Bonus"],
      ["expense", "Travel"],
      ["expense", "Groceries"],
    ]);
    // A millisecond apart in file order.
    expect(entries.map((e) => e.created_at)).toEqual(
      [0, 1, 2].map((i) => new Date(NOW + i).toISOString()),
    );
  });

  test("declining a category skips its rows and does not create it", async () => {
    const { db, repo } = await setup();
    const validation = await check(db, "date,type,amount,category\n2026-11-03,expense,10,Travel\n");
    const plan = planImport(validation, new Set([categoryKey("expense", "Travel")]));
    expect(plan).toMatchObject({ added: [], categories: [], declinedRows: 1 });
    expect(await applyImport(db, repo, plan, NOW)).toEqual({
      added: 0,
      merged: 0,
      categories: 0,
    });
  });

  test("a category of the other type is a row error, never offered for creation", async () => {
    const { db } = await setup();
    const validation = await check(db, "date,type,amount,category\n2026-11-03,income,10,gifts\n");
    expect(validation.rows[0]).toMatchObject({
      ok: false,
      errors: [{ field: "category", code: "expense_category" }],
    });
    expect(newNames(validation)).toEqual([]);
    expect(planImport(validation)).toMatchObject({ added: [], categories: [], errorRows: 1 });
  });

  test("a category created meanwhile (another device) in another case: rows take its spelling", async () => {
    const { db, repo } = await setup();
    const header = FULL_COLUMNS.join(",");
    const plan = planImport(
      await check(
        db,
        [
          header,
          "2026-11-03,expense,10,Souvenirs,,,,,,,",
          `2026-11-04,expense,11,souvenirs,,,,,,${ID_A},${hlc(NOW + 1000)}`,
        ].join("\n"),
      ),
    );
    expect(plan.categories).toEqual([{ type: "expense", name: "Souvenirs" }]);
    await repo.put("categories", { type: "expense", name: "SOUVENIRS", sort: 20, archived: false });
    const result = await applyImport(db, repo, plan, NOW);
    expect(result.categories).toBe(0);
    const names = (await db.categories.toArray()).flatMap((c) => (c.deleted ? [] : [c.name]));
    expect(names.filter((n) => n.toLowerCase() === "souvenirs")).toEqual(["SOUVENIRS"]);
    expect((await live(db)).map((e) => e.category)).toEqual(["SOUVENIRS", "SOUVENIRS"]);
  });

  test("rows with an id merge by hlc: newer ones replace, older ones change nothing", async () => {
    const { db, repo } = await setup();
    const mine = await repo.put("transactions", { ...expense, detail: "mine" });
    const older = { ...mine, detail: "older", hlc: hlc(1000) };
    const newer = { ...mine, id: ID_A, detail: "file", hlc: hlc(NOW + 5000) };
    const text = exportCsv([older, newer], "full");
    const validation = await check(db, text);
    const plan = planImport(validation);
    expect(plan.merges.map((m) => m.id)).toEqual([mine.id, ID_A]);
    expect(await upToDateIds(db, plan.merges)).toEqual(new Set([mine.id]));

    const result = await applyImport(db, repo, plan, NOW);
    expect(result).toEqual({ added: 0, merged: 1, categories: 0 });
    expect(await db.transactions.get(mine.id)).toMatchObject({ detail: "mine", hlc: mine.hlc });
    expect(await db.transactions.get(ID_A)).toMatchObject({
      detail: "file",
      hlc: hlc(NOW + 5000),
      device: "laptop",
      dirty: 1,
      created_at: new Date(NOW).toISOString(),
    });
    // Importing the same file again changes nothing.
    expect(await upToDateIds(db, plan.merges)).toEqual(new Set([mine.id, ID_A]));
    expect((await applyImport(db, repo, plan, NOW)).merged).toBe(0);
  });

  test("a merged row keeps the created_at of the entry here", async () => {
    const { db, repo } = await setup();
    const mine = await repo.put("transactions", expense);
    const text = exportCsv([{ ...mine, detail: "edited", hlc: hlc(NOW + 9000) }], "full");
    await applyImport(db, repo, planImport(await check(db, text)), NOW);
    expect(await db.transactions.get(mine.id)).toMatchObject({
      detail: "edited",
      created_at: expense.created_at,
    });
  });

  test("the same id twice in one file: the newest by hlc wins, whatever the order", async () => {
    const { db, repo } = await setup();
    const header = FULL_COLUMNS.join(",");
    const line = (detail: string, wall: number, id = ID_B) =>
      `2026-11-03,expense,10,Groceries,${detail},,,,,${id},${hlc(wall)}`;
    const text = [header, line("middle", 2000), line("newest", 3000), line("oldest", 1000)].join(
      "\n",
    );
    const plan = planImport(await check(db, text));
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0]?.fields.detail).toBe("newest");
    expect(plan.supersededRows).toBe(2);
    expect((await applyImport(db, repo, plan, NOW)).merged).toBe(1);
    expect(await db.transactions.get(ID_B)).toMatchObject({ detail: "newest", hlc: hlc(3000) });
  });

  test("likely duplicates are still imported", async () => {
    const { db, repo } = await setup();
    await repo.put("transactions", expense);
    const validation = await check(
      db,
      `date,type,amount,category\n${expense.date},expense,3240,Groceries\n`,
    );
    const [row] = validation.rows;
    expect(row?.ok && row.duplicate).toBe(true);
    expect((await applyImport(db, repo, planImport(validation), NOW)).added).toBe(1);
    expect(await live(db)).toHaveLength(2);
  });

  test("one write: the sync and the live file hear of it once", async () => {
    const { db, repo } = await setup();
    const heard: number[] = [];
    repo.onLocalWrite((changes) => heard.push(changes.length));
    const plan = planImport(
      await check(
        db,
        "date,type,amount,category\n2026-11-03,expense,10,Taxi\n2026-11-04,expense,11,Taxi\n",
      ),
    );
    await applyImport(db, repo, plan, NOW);
    expect(heard).toEqual([3]);
  });
});

describe("merging rows with an id against tombstones and each other", () => {
  const header = FULL_COLUMNS.join(",");
  const line = (detail: string, wall: number) =>
    `2026-11-03,expense,10,Groceries,${detail},,,,,${ID_A},${hlc(wall)}`;

  test("a local tombstone with a higher hlc rejects an older file row", async () => {
    const { db, repo } = await setup();
    await db.transactions.put({
      id: ID_A,
      hlc: hlc(NOW + 9000),
      device: "laptop",
      deleted: true,
      dirty: 0,
    });
    const plan = planImport(await check(db, [header, line("old", NOW + 1000)].join("\n")));
    expect(await upToDateIds(db, plan.merges)).toEqual(new Set([ID_A]));
    expect((await applyImport(db, repo, plan, NOW)).merged).toBe(0);
    expect(await db.transactions.get(ID_A)).toMatchObject({ deleted: true });
  });

  test("a tombstone with a lower hlc loses to the file row", async () => {
    const { db, repo } = await setup();
    await db.transactions.put({
      id: ID_A,
      hlc: hlc(1000),
      device: "laptop",
      deleted: true,
      dirty: 0,
    });
    const plan = planImport(await check(db, [header, line("back", NOW + 1000)].join("\n")));
    expect(await upToDateIds(db, plan.merges)).toEqual(new Set());
    expect((await applyImport(db, repo, plan, NOW)).merged).toBe(1);
    expect(await db.transactions.get(ID_A)).toMatchObject({
      deleted: false,
      detail: "back",
      created_at: new Date(NOW).toISOString(),
    });
  });

  test("equal hlcs within one file: the later row wins", () => {
    const validation = validateImportRows(
      readCsvText([header, line("first", 5000), line("second", 5000)].join("\n")).rows,
      autoMapHeaders(FULL_COLUMNS),
      CONTEXT_EMPTY,
    );
    const plan = planImport(validation);
    expect(plan.merges.map((m) => m.fields.detail)).toEqual(["second"]);
    expect(plan.supersededRows).toBe(1);
  });
});

const CONTEXT_EMPTY = { categories: [], transactions: [] };

describe("categories to create", () => {
  test("only categories a written row uses: not those of declined or replaced rows", async () => {
    const { db } = await setup();
    const header = FULL_COLUMNS.join(",");
    const validation = await check(
      db,
      [
        header,
        // Replaced by the newer row for the same id: its category Trips is never written.
        `2026-11-03,expense,10,Trips,,,,,,${ID_A},${hlc(1000)}`,
        `2026-11-03,expense,10,Taxi,,,,,,${ID_A},${hlc(2000)}`,
        "2026-11-04,expense,20,Gadgets,,,,,,,",
      ].join("\n"),
    );
    expect(validation.unknownCategories.map((c) => c.name)).toEqual(["Trips", "Taxi", "Gadgets"]);
    expect(newNames(validation).map((n) => n.name)).toEqual(["Taxi", "Gadgets"]);
    const plan = planImport(validation, new Set([categoryKey("expense", "Gadgets")]));
    expect(plan.categories).toEqual([{ type: "expense", name: "Taxi" }]);
  });

  test("each category says its type and how many rows use it", async () => {
    const { db } = await setup();
    const validation = await check(
      db,
      [
        "date,type,amount,category",
        "2026-11-03,expense,10,Souvenirs",
        "2026-11-04,expense,20,souvenirs",
        "2026-11-05,income,30,Bonus",
      ].join("\n"),
    );
    expect(newNames(validation)).toEqual([
      { type: "expense", name: "Souvenirs", key: categoryKey("expense", "Souvenirs"), rows: 2 },
      { type: "income", name: "Bonus", key: categoryKey("income", "Bonus"), rows: 1 },
    ]);
  });

  test("a declined category stays offered, with the rows ticking it again brings back", async () => {
    const { db } = await setup();
    const validation = await check(
      db,
      [
        "date,type,amount,category",
        "2026-11-03,expense,10,Souvenirs",
        "2026-11-04,expense,20,Souvenirs",
        "2026-11-05,expense,30,Ferries",
      ].join("\n"),
    );
    const declined = new Set([categoryKey("expense", "Souvenirs")]);
    expect(newNames(validation, declined).map((n) => [n.name, n.rows])).toEqual([
      ["Souvenirs", 2],
      ["Ferries", 1],
    ]);
    expect(planImport(validation, declined).categories).toEqual([
      { type: "expense", name: "Ferries" },
    ]);
  });
});

describe("summaries", () => {
  const text = [
    "date,type,amount,category,id,hlc",
    "2026-11-02,expense,10,Groceries,,", // ready
    "2026-11-02,expense,10,Groceries,,", // duplicate of the row above
    "bad,expense,10,Groceries,,", // error
    "2026-11-03,income,10,Salary,,", // ready
    `2026-11-04,expense,10,Taxi,${ID_A},${hlc(NOW + 10)}`, // with an id, new category
    `2026-11-04,expense,12,Taxi,${ID_A},${hlc(NOW + 20)}`, // replaces it
    `2026-11-05,expense,12,Bills,${ID_B},${hlc(1)}`, // with an id
  ].join("\n");

  test("previewSummary counts every row and lists the problems in file order", async () => {
    const { db } = await setup();
    const summary = previewSummary(await check(db, text));
    expect({ ...summary, problems: summary.problems.map((r) => r.index) }).toEqual({
      rows: 7,
      ready: 6,
      errors: 1,
      duplicates: 1,
      withId: 3,
      problems: [1, 2],
    });
  });

  test("confirmSummary adds up what is written and what is skipped", async () => {
    const { db, repo } = await setup();
    // ID_B is here already at a newer hlc.
    await repo.merge("transactions", {
      ...expense,
      detail: "",
      note: "",
      tags: [],
      original_amount: null,
      original_currency: null,
      id: ID_B,
      hlc: hlc(5),
      device: "laptop",
      deleted: false,
    });
    const validation = await check(db, text);
    const declined = new Set([categoryKey("expense", "Taxi")]);
    const plan = planImport(validation, declined);
    expect(confirmSummary(plan, await upToDateIds(db, plan.merges))).toEqual({
      toAdd: 3,
      toMerge: 0,
      upToDate: 1,
      skippedErrors: 1,
      skippedDeclined: 2,
      skippedRepeated: 0,
      skipped: 3,
      nothingToDo: false,
    });
    const all = planImport(validation);
    expect(confirmSummary(all, await upToDateIds(db, all.merges))).toMatchObject({
      toMerge: 1,
      upToDate: 1,
      skippedRepeated: 1,
      skipped: 2,
    });
    const onlyKnown = planImport(
      await check(
        db,
        text
          .split("\n")
          .slice(0, 1)
          .concat(`2026-11-05,expense,12,Bills,${ID_B},${hlc(1)}`)
          .join("\n"),
      ),
    );
    expect(confirmSummary(onlyKnown, new Set([ID_B])).nothingToDo).toBe(true);
  });

  test("missingColumns reads no row", () => {
    expect(missingColumns({ date: 0, amount: 1 })).toEqual(["type", "category"]);
    expect(missingColumns(autoMapHeaders(FULL_COLUMNS))).toEqual([]);
  });

  test("a bank file with amount and currency imports without pair errors", async () => {
    const { db } = await setup();
    const validation = await check(
      db,
      "Date,Type,Amount,Category,Currency\n2026-11-03,expense,9.99,Groceries,DZD\n",
    );
    expect(previewSummary(validation)).toMatchObject({ ready: 1, errors: 0 });
  });
});

describe("previewPage", () => {
  test("draws at most the limit and says when rows are left out", () => {
    const rows = Array.from({ length: 450 }, (_, i) => i);
    expect(previewPage(rows)).toEqual({
      shown: rows.slice(0, PREVIEW_LIMIT),
      total: 450,
      capped: true,
    });
    expect(previewPage(rows.slice(0, PREVIEW_LIMIT))).toMatchObject({
      total: PREVIEW_LIMIT,
      capped: false,
    });
    expect(previewPage([1, 2, 3], 2)).toEqual({ shown: [1, 2], total: 3, capped: true });
    expect(previewPage([])).toEqual({ shown: [], total: 0, capped: false });
  });
});
