// CSV export (spec "Export"): simple or full CSV of every entry or of what the List shows,
// saved through a download, or through the share sheet on Android where it takes files.
import { type CsvFlavour, exportCsv, type LiveTransaction } from "@budgee/core";
import type { BudgeeDb } from "../db/db";
import { filterEntries, type ListFilter } from "../list/filter";
import { loadMonthEntries } from "../list/month";
import type { OutgoingFile, Platform } from "../platform/types";

/** Lets Excel read the file as UTF-8; the import drops it. */
const BOM = "\uFEFF";
export const CSV_TYPE = "text/csv";

/** Oldest first, entries of one day in the order they were made: how a spreadsheet reads. */
const chronological = (a: LiveTransaction, b: LiveTransaction) =>
  a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at);

/** The CSV text written to a file: a BOM, then the rows oldest first. */
export function csvText(rows: readonly LiveTransaction[], flavour: CsvFlavour): string {
  return BOM + exportCsv([...rows].sort(chronological), flavour);
}

/** Every live entry. */
export async function loadAllEntries(db: BudgeeDb): Promise<LiveTransaction[]> {
  const rows = await db.transactions.toArray();
  return rows.filter((row): row is typeof row & LiveTransaction => !row.deleted);
}

/** What the List shows: the month's entries that pass its filter. */
export async function loadListEntries(
  db: BudgeeDb,
  month: string,
  filter: ListFilter,
): Promise<LiveTransaction[]> {
  return filterEntries(await loadMonthEntries(db, month), filter);
}

export type ExportScope = { kind: "all"; today: string } | { kind: "list"; month: string };

/** `budgee-2026-11-23.csv`, `budgee-2026-11.csv` for a List month; `-full` before the date. */
export function exportFileName(scope: ExportScope, flavour: CsvFlavour): string {
  const flavourPart = flavour === "full" ? "-full" : "";
  const when = scope.kind === "all" ? scope.today : scope.month;
  return `budgee${flavourPart}-${when}.csv`;
}

export function csvFile(
  rows: readonly LiveTransaction[],
  flavour: CsvFlavour,
  scope: ExportScope,
): OutgoingFile {
  return { name: exportFileName(scope, flavour), type: CSV_TYPE, data: csvText(rows, flavour) };
}

/** Android browsers: files go to the share sheet there, where it takes them. */
export function isAndroid(userAgent: string): boolean {
  return /\bAndroid\b/i.test(userAgent);
}

/**
 * Hands the file to the share sheet on Android when it takes files, else downloads it. A share
 * the browser refuses falls back to the download. `cancelled`: the user closed the share sheet.
 */
export async function deliverFile(
  platform: Pick<Platform, "fileExport" | "share">,
  file: OutgoingFile,
  android: boolean,
): Promise<"shared" | "saved" | "cancelled"> {
  if (android && platform.share.canShareFiles()) {
    try {
      return (await platform.share.shareFile(file)) ? "shared" : "cancelled";
    } catch (error) {
      console.warn("Sharing the file failed; downloading it instead", error);
    }
  }
  await platform.fileExport.save(file);
  return "saved";
}
