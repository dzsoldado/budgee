import { describe, expect, test } from "bun:test";
import { type LiveTransaction, parseCsv } from "@budgee/core";
import {
  CSV_TYPE,
  csvFile,
  csvText,
  deliverFile,
  exportFileName,
  isAndroid,
  loadAllEntries,
  loadListEntries,
} from "../src/csv/export";
import { readCsvText } from "../src/csv/import";
import { openRepository } from "../src/db/repository";
import { EMPTY_FILTER } from "../src/list/filter";
import type { OutgoingFile } from "../src/platform/types";
import { expense, freshDb } from "./helpers";

const row = (extra: Partial<LiveTransaction>): LiveTransaction => ({
  ...expense,
  detail: expense.detail,
  note: "",
  tags: [],
  original_amount: null,
  original_currency: null,
  id: crypto.randomUUID(),
  hlc: "001763370000000:00000:laptop",
  device: "laptop",
  deleted: false,
  ...extra,
});

describe("CSV text", () => {
  test("starts with a BOM for Excel, which the import reads past", () => {
    const text = csvText([row({})], "simple");
    expect(text.startsWith("\uFEFFdate,type,amount,")).toBe(true);
    expect(readCsvText(text).headers[0]).toBe("date");
  });

  test("lists entries oldest first, same-day entries in the order they were made", () => {
    const rows = [
      row({ date: "2026-11-17", created_at: "2026-11-17T10:00:00.000Z", detail: "c" }),
      row({ date: "2026-11-02", created_at: "2026-11-20T00:00:00.000Z", detail: "a" }),
      row({ date: "2026-11-17", created_at: "2026-11-17T09:00:00.000Z", detail: "b" }),
    ];
    const { rows: read } = parseCsv(csvText(rows, "simple"));
    expect(read.map((r) => r[4])).toEqual(["a", "b", "c"]);
  });

  test("full adds id and hlc", () => {
    const entry = row({});
    const { headers, rows } = parseCsv(csvText([entry], "full"));
    expect(headers.slice(-2)).toEqual(["id", "hlc"]);
    expect(rows[0]?.slice(-2)).toEqual([entry.id, entry.hlc]);
  });
});

describe("file names", () => {
  test("say what was exported", () => {
    expect(exportFileName({ kind: "all", today: "2026-11-23" }, "simple")).toBe(
      "budgee-2026-11-23.csv",
    );
    expect(exportFileName({ kind: "all", today: "2026-11-23" }, "full")).toBe(
      "budgee-full-2026-11-23.csv",
    );
    expect(exportFileName({ kind: "list", month: "2026-11" }, "simple")).toBe("budgee-2026-11.csv");
    const file = csvFile([row({})], "simple", { kind: "list", month: "2026-11" });
    expect(file.type).toBe(CSV_TYPE);
  });
});

describe("what is exported", () => {
  test("everything, or the List's month through its filter; never deleted rows", async () => {
    const db = freshDb();
    const repo = await openRepository(db);
    await repo.put("transactions", expense);
    await repo.put("transactions", { ...expense, detail: "Taxi", category: "Transport" });
    await repo.put("transactions", { ...expense, date: "2026-10-30" });
    const gone = await repo.put("transactions", expense);
    await repo.remove("transactions", gone.id);
    expect(await loadAllEntries(db)).toHaveLength(3);
    expect(await loadListEntries(db, "2026-11", EMPTY_FILTER)).toHaveLength(2);
    const taxi = await loadListEntries(db, "2026-11", { ...EMPTY_FILTER, search: "taxi" });
    expect(taxi.map((e) => e.detail)).toEqual(["Taxi"]);
  });
});

describe("deliverFile", () => {
  const file: OutgoingFile = { name: "budgee.csv", type: CSV_TYPE, data: "x" };
  function fakePlatform(opts: { canShare: boolean; share?: () => Promise<boolean> }) {
    const calls: string[] = [];
    return {
      calls,
      platform: {
        fileExport: {
          save: async () => {
            calls.push("save");
          },
        },
        share: {
          canShareFiles: () => opts.canShare,
          shareFile: async () => {
            calls.push("share");
            return (opts.share ?? (async () => true))();
          },
        },
      },
    };
  }

  test("Android with file sharing: the share sheet", async () => {
    const { platform, calls } = fakePlatform({ canShare: true });
    expect(await deliverFile(platform, file, true)).toBe("shared");
    expect(calls).toEqual(["share"]);
  });

  test("closing the share sheet saves nothing", async () => {
    const { platform, calls } = fakePlatform({ canShare: true, share: async () => false });
    expect(await deliverFile(platform, file, true)).toBe("cancelled");
    expect(calls).toEqual(["share"]);
  });

  test("a refused share falls back to the download", async () => {
    const { platform, calls } = fakePlatform({
      canShare: true,
      share: () => Promise.reject(new DOMException("no", "NotAllowedError")),
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await deliverFile(platform, file, true)).toBe("saved");
    } finally {
      console.warn = warn;
    }
    expect(calls).toEqual(["share", "save"]);
  });

  test("desktop, or Android without file sharing: a download", async () => {
    for (const [canShare, android] of [
      [true, false],
      [false, true],
    ] as const) {
      const { platform, calls } = fakePlatform({ canShare });
      expect(await deliverFile(platform, file, android)).toBe("saved");
      expect(calls).toEqual(["save"]);
    }
  });

  test("Android is told from the user agent", () => {
    expect(
      isAndroid("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile"),
    ).toBe(true);
    expect(isAndroid("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131")).toBe(false);
  });
});
