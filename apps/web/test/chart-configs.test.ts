import { describe, expect, test } from "bun:test";
import { DEFAULT_CHART_CONFIGS, GALLERY_PRESETS, SEED_HLC } from "@budgee/core";
import {
  addChart,
  liveCharts,
  moveAnnouncement,
  moveChart,
  removeChart,
  SaveChartError,
  saveChart,
} from "../src/dashboard/charts";
import type { BudgeeDb } from "../src/db/db";
import { type LocalChange, openRepository, type Repository } from "../src/db/repository";
import { seedDefaults } from "../src/db/seed";
import { freshDb } from "./helpers";

async function setup(): Promise<{ db: BudgeeDb; repo: Repository; changes: LocalChange[][] }> {
  const db = freshDb();
  await seedDefaults(db);
  const repo = await openRepository(db);
  const changes: LocalChange[][] = [];
  repo.onLocalWrite((c) => changes.push([...c]));
  return { db, repo, changes };
}

const names = async (db: BudgeeDb) => (await liveCharts(db)).map((c) => c.name);
const ids = DEFAULT_CHART_CONFIGS.map((c) => c.id);
const pace = GALLERY_PRESETS.find((p) => p.key === "month_pace")?.config;
if (!pace) throw new Error("month_pace preset missing");

describe("save", () => {
  test("a new chart goes last: sort is the last one's plus one", async () => {
    const { db, repo, changes } = await setup();
    await repo.update("chart_configs", ids[3] ?? "", { sort: 7 });
    changes.length = 0;
    const row = await addChart(db, repo, { name: "Month pace", config: pace });
    expect(row.sort).toBe(8);
    expect(row.hlc).not.toBe(SEED_HLC);
    expect((await db.chart_configs.get(row.id))?.dirty).toBe(1);
    expect(await names(db)).toEqual([
      "Expenses, this year vs last year",
      "By category vs last year",
      "Kept of income",
      "Year by year",
      "Month pace",
    ]);
    expect(changes).toEqual([[{ table: "chart_configs", id: row.id }]]);
  });

  test("the first chart of an empty dashboard is sort 0", async () => {
    const { db, repo } = await setup();
    for (const id of ids) await repo.remove("chart_configs", id);
    const row = await addChart(db, repo, { name: "Only", config: pace });
    expect(row.sort).toBe(0);
  });

  test("editing a default chart gives it a real hlc and keeps its place", async () => {
    const { db, repo } = await setup();
    const id = ids[1] ?? "";
    const config = { ...(DEFAULT_CHART_CONFIGS[1]?.config ?? pace), limit: 5 };
    await saveChart(db, repo, id, { name: "Top five", config });
    const row = await db.chart_configs.get(id);
    expect(row).toMatchObject({ name: "Top five", sort: 1, deleted: false, dirty: 1 });
    expect(row?.hlc).not.toBe(SEED_HLC);
    if (row && !row.deleted) expect(row.config.limit).toBe(5);
    // So the seed no longer refreshes it.
    await seedDefaults(db);
    expect((await db.chart_configs.get(id))?.hlc).toBe(row?.hlc ?? "");
  });

  test("saving a chart deleted meanwhile refuses rather than bring it back", async () => {
    const { db, repo } = await setup();
    const id = ids[0] ?? "";
    await repo.remove("chart_configs", id);
    await expect(saveChart(db, repo, id, { name: "Back", config: pace })).rejects.toBeInstanceOf(
      SaveChartError,
    );
    expect((await db.chart_configs.get(id))?.deleted).toBe(true);
  });

  test("an invalid chart is refused by the core schema", async () => {
    const { db, repo } = await setup();
    await expect(addChart(db, repo, { name: "", config: pace })).rejects.toThrow();
    await expect(
      addChart(db, repo, { name: "Bad", config: { ...pace, limit: 0 } }),
    ).rejects.toThrow();
    expect(await names(db)).toHaveLength(4);
  });
});

describe("save after a rename elsewhere", () => {
  test("lists the editor didn't change keep what is stored now; changed ones win", async () => {
    const { db, repo } = await setup();
    const id = ids[1] ?? "";
    const loaded = DEFAULT_CHART_CONFIGS[1]?.config ?? pace;
    const base = {
      ...loaded,
      exclude: { categories: ["Gifts"], tags: ["Trip"] },
      onlyTags: ["Trip"],
    };
    await repo.update("chart_configs", id, { config: base });
    // Opened in the editor with `base`; meanwhile Settings renames Gifts and the tag.
    const renamed = {
      ...base,
      exclude: { categories: ["Presents"], tags: ["Journey"] },
      onlyTags: ["Journey"],
    };
    await repo.update("chart_configs", id, { config: renamed });
    // The editor changed the name and the limit only.
    await saveChart(db, repo, id, { name: "Edited", config: { ...base, limit: 5 } }, base);
    const row = await db.chart_configs.get(id);
    if (!row || row.deleted) throw new Error("chart missing");
    expect(row.name).toBe("Edited");
    expect(row.config.limit).toBe(5);
    expect(row.config.exclude).toEqual(renamed.exclude);
    expect(row.config.onlyTags).toEqual(["Journey"]);

    // An exclusion list the editor did change is saved as edited; the lists it left alone
    // keep the renames made meanwhile.
    const edited = { ...base, exclude: { ...base.exclude, tags: ["Wedding"] } };
    await saveChart(db, repo, id, { name: "Edited", config: edited }, base);
    const again = await db.chart_configs.get(id);
    if (!again || again.deleted) throw new Error("chart missing");
    expect(again.config.exclude).toEqual({
      categories: ["Presents"],
      tags: ["Wedding"],
    });
    expect(again.config.onlyTags).toEqual(["Journey"]);
  });
});

describe("remove", () => {
  test("leaves a tombstone", async () => {
    const { db, repo } = await setup();
    const id = ids[2] ?? "";
    await removeChart(repo, id);
    const row = await db.chart_configs.get(id);
    expect(row).toMatchObject({ id, deleted: true, dirty: 1 });
    expect(row?.hlc).not.toBe(SEED_HLC);
    expect(await names(db)).not.toContain("Kept of income");
  });
});

describe("reorder", () => {
  test("moving down swaps with the next chart and writes only those two rows, once", async () => {
    const { db, repo, changes } = await setup();
    await moveChart(db, repo, ids[1] ?? "", 1);
    expect(await names(db)).toEqual([
      "Expenses, this year vs last year",
      "Kept of income",
      "By category vs last year",
      "Year by year",
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.map((c) => c.id).sort()).toEqual([ids[1] ?? "", ids[2] ?? ""].sort());
    // Rows that kept their sort keep their seed hlc.
    expect((await db.chart_configs.get(ids[0] ?? ""))?.hlc).toBe(SEED_HLC);
  });

  test("moving up past the top, or down past the bottom, writes nothing", async () => {
    const { db, repo, changes } = await setup();
    expect(await moveChart(db, repo, ids[0] ?? "", -1)).toBe(false);
    expect(await moveChart(db, repo, ids[3] ?? "", 1)).toBe(false);
    expect(await moveChart(db, repo, "00000000-0000-4000-8000-00000000dead", 1)).toBe(false);
    expect(changes.flat()).toEqual([]);
    expect(await moveChart(db, repo, ids[3] ?? "", -1)).toBe(true);
  });

  test("the announcement gives the new place, worked out from the order before the move", () => {
    const order = ["a", "b", "c", "d"];
    expect(moveAnnouncement(order, "b", 1, "Bills")).toBe("Bills is now chart 3 of 4.");
    expect(moveAnnouncement(order, "b", -1, "Bills")).toBe("Bills is now chart 1 of 4.");
    expect(moveAnnouncement(order, "a", -1, "First")).toBeNull();
    expect(moveAnnouncement(order, "d", 1, "Last")).toBeNull();
    expect(moveAnnouncement(order, "x", 1, "Gone")).toBeNull();
  });

  test("gaps and ties left by deletes or other devices are closed by the same write", async () => {
    const { db, repo, changes } = await setup();
    // sorts 0, 1, 1, 9: two devices gave the same sort, and a gap.
    await repo.update("chart_configs", ids[2] ?? "", { sort: 1 });
    await repo.update("chart_configs", ids[3] ?? "", { sort: 9 });
    const before = (await liveCharts(db)).map((c) => c.id);
    changes.length = 0;
    await moveChart(db, repo, before[3] ?? "", -1);
    const after = await liveCharts(db);
    expect(after.map((c) => c.sort)).toEqual([0, 1, 2, 3]);
    expect(after.map((c) => c.id)).toEqual([0, 1, 3, 2].map((i) => before[i] ?? ""));
    expect(changes).toHaveLength(1);
    // The first row already had sort 0 and 1 kept its place: not written.
    expect(changes[0]?.map((c) => c.id)).not.toContain(before[0] ?? "");
  });
});
