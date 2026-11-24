// CSV import (spec "Import"): read the file, check its rows against the column mapping (core
// validateImportRows), then write the chosen ones in one repository write. Rows with an id merge
// like synced rows (the higher hlc wins); rows without one become new entries. Unknown
// categories are created unless the user declined them, in which case the rows that use them are
// left out.
import {
  type ColumnMapping,
  type CsvColumn,
  CsvParseError,
  type CsvParseErrorReason,
  type ImportContext,
  type ImportedFields,
  type ImportRow,
  type ImportValidation,
  type LiveTransaction,
  parseCsv,
  parseHlc,
  validateImportRows,
} from "@budgee/core";
import type { BudgeeDb } from "../db/db";
import type { FieldsInputOf, Repository } from "../db/repository";

/**
 * The largest CSV read. The file is parsed and checked on the main thread, so this keeps the
 * work to well under a second: 10 MB is about 100,000 rows, decades of personal entries.
 */
export const MAX_CSV_BYTES = 10 * 1024 * 1024;

export type CsvReadProblem = "too_large" | "empty" | CsvParseErrorReason;

export class CsvReadError extends Error {
  override name = "CsvReadError";
  readonly reason: CsvReadProblem;
  /** The file line, for a malformed record. */
  readonly line: number | undefined;

  constructor(reason: CsvReadProblem, line?: number) {
    super(line === undefined ? reason : `${reason} (line ${line})`);
    this.reason = reason;
    this.line = line;
  }
}

export interface CsvFile {
  headers: string[];
  rows: string[][];
  /** The file line each row starts on. */
  lines: number[];
}

/** Throws CsvReadError("too_large") for a file over `max` bytes; cheap, before reading. */
export function checkCsvSize(size: number, max = MAX_CSV_BYTES): void {
  if (size > max) throw new CsvReadError("too_large");
}

/** Parses the file's text. Throws CsvReadError when it is malformed or has no rows. */
export function readCsvText(text: string): CsvFile {
  let parsed: CsvFile;
  try {
    parsed = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvParseError) throw new CsvReadError(error.reason, error.line);
    throw error;
  }
  const filled = parsed.rows.some((row) => row.some((cell) => cell.trim() !== ""));
  if (parsed.headers.length === 0 || !filled) throw new CsvReadError("empty");
  return parsed;
}

/** What validation compares rows with: live categories and entries. */
export async function loadImportContext(db: BudgeeDb): Promise<ImportContext> {
  const [categories, transactions] = await Promise.all([
    db.categories.toArray(),
    db.transactions.toArray(),
  ]);
  return { categories: categories.filter((row) => !row.deleted), transactions };
}

export type OkRow = Extract<ImportRow, { ok: true }>;
type EntryType = "income" | "expense";

/** One key per category of a type, ignoring case. */
export const categoryKey = (type: string, name: string) => `${type}:${name.toLowerCase()}`;

const NO_CONTEXT: ImportContext = { categories: [], transactions: [] };

/** Required fields with no column in `mapping`: cheap, reads no row. */
export function missingColumns(mapping: ColumnMapping): CsvColumn[] {
  return validateImportRows([], mapping, NO_CONTEXT).missingColumns;
}

/** How many preview rows are drawn at most; the counts still cover every row. */
export const PREVIEW_LIMIT = 200;

export interface PreviewSummary {
  /** Rows read (all-empty rows are skipped). */
  rows: number;
  ready: number;
  errors: number;
  duplicates: number;
  withId: number;
  /** Rows with an error or a duplicate warning, in file order. */
  problems: ImportRow[];
}

/** The preview's counts and its Problems list. */
export function previewSummary(validation: ImportValidation): PreviewSummary {
  const summary: PreviewSummary = {
    rows: validation.rows.length,
    ready: 0,
    errors: 0,
    duplicates: 0,
    withId: 0,
    problems: [],
  };
  for (const row of validation.rows) {
    if (!row.ok) {
      summary.errors++;
      summary.problems.push(row);
      continue;
    }
    summary.ready++;
    if (row.merge) summary.withId++;
    if (row.duplicate) {
      summary.duplicates++;
      summary.problems.push(row);
    }
  }
  return summary;
}

export interface ImportPlan {
  /** Rows without an id: each becomes a new entry. */
  added: ImportedFields[];
  /** Rows with an id, one per id: the newest by hlc when the file has an id twice. */
  merges: { id: string; hlc: string; fields: ImportedFields }[];
  /** Categories to create: unknown ones some kept row uses, in the order the file first used them. */
  categories: { type: EntryType; name: string }[];
  /** Rows with errors, skipped. */
  errorRows: number;
  /** Valid rows left out because they use a name the user chose not to create. */
  declinedRows: number;
  /** Rows with an id that a newer row in the file for the same id replaces. */
  supersededRows: number;
}

const usesKey = (fields: ImportedFields) => categoryKey(fields.type, fields.category);

/**
 * Turns checked rows into what to write. `declined` holds the keys (categoryKey) of unknown
 * categories not to create: the rows that use them are left out. Only categories that a kept
 * row still uses are created, so a declined or replaced row leaves nothing behind.
 */
export function planImport(
  validation: ImportValidation,
  declined: ReadonlySet<string> = new Set(),
): ImportPlan {
  const plan: ImportPlan = {
    added: [],
    merges: [],
    categories: [],
    errorRows: 0,
    declinedRows: 0,
    supersededRows: 0,
  };
  const merges = new Map<string, ImportPlan["merges"][number]>();
  for (const row of validation.rows) {
    if (!row.ok) {
      plan.errorRows++;
      continue;
    }
    const { fields } = row;
    if (declined.has(usesKey(fields))) {
      plan.declinedRows++;
      continue;
    }
    if (!row.merge) {
      plan.added.push(fields);
      continue;
    }
    const seen = merges.get(row.merge.id);
    if (seen) plan.supersededRows++;
    // On equal hlcs the later row wins, like a later line overwriting an earlier one.
    if (!seen || row.merge.hlc >= seen.hlc) merges.set(row.merge.id, { ...row.merge, fields });
  }
  plan.merges = [...merges.values()];
  const used = new Set(keptFields(plan).map(usesKey));
  plan.categories = validation.unknownCategories.filter((c) =>
    used.has(categoryKey(c.type, c.name)),
  );
  return plan;
}

/** The fields of every row the plan writes. */
const keptFields = (plan: ImportPlan) => [...plan.added, ...plan.merges.map((m) => m.fields)];

export interface NewName {
  type: EntryType;
  name: string;
  key: string;
  /** Rows that use it, among those the import would write. */
  rows: number;
}

/**
 * The unknown categories offered for creation: those some written row uses, given `declined`,
 * plus the declined ones (to tick again), each with the rows that use it.
 */
export function newNames(
  validation: ImportValidation,
  declined: ReadonlySet<string> = new Set(),
): NewName[] {
  // Rows that would be written with these declines; a declined category counts the rows that
  // ticking it again brings back.
  const uses = (plan: ImportPlan) => {
    const rows = new Map<string, number>();
    for (const f of keptFields(plan)) rows.set(usesKey(f), (rows.get(usesKey(f)) ?? 0) + 1);
    return rows;
  };
  const kept = uses(planImport(validation, declined));
  const all = declined.size > 0 ? uses(planImport(validation)) : kept;
  return validation.unknownCategories
    .map(({ type, name }) => {
      const key = categoryKey(type, name);
      return { type, name, key, rows: (declined.has(key) ? all : kept).get(key) ?? 0 };
    })
    .filter((name) => name.rows > 0);
}

export interface PreviewPage<T> {
  /** The rows drawn: at most `limit`. */
  shown: T[];
  total: number;
  /** Some rows are not drawn: say "Showing the first N of M". */
  capped: boolean;
}

/** The part of a preview list that is drawn, so a large file never builds thousands of rows. */
export function previewPage<T>(rows: readonly T[], limit = PREVIEW_LIMIT): PreviewPage<T> {
  return { shown: rows.slice(0, limit), total: rows.length, capped: rows.length > limit };
}

export interface ConfirmSummary {
  toAdd: number;
  /** Rows with an id that would update or add an entry here. */
  toMerge: number;
  /** Rows with an id this device already has at that hlc or newer. */
  upToDate: number;
  skippedErrors: number;
  skippedDeclined: number;
  skippedRepeated: number;
  /** Every skipped row. */
  skipped: number;
  /** Nothing would change: the Import button is off. */
  nothingToDo: boolean;
}

/** The confirm step's counts, from the plan and the ids already up to date here. */
export function confirmSummary(plan: ImportPlan, upToDate: ReadonlySet<string>): ConfirmSummary {
  const toMerge = plan.merges.filter((m) => !upToDate.has(m.id)).length;
  return {
    toAdd: plan.added.length,
    toMerge,
    upToDate: plan.merges.length - toMerge,
    skippedErrors: plan.errorRows,
    skippedDeclined: plan.declinedRows,
    skippedRepeated: plan.supersededRows,
    skipped: plan.errorRows + plan.declinedRows + plan.supersededRows,
    nothingToDo: plan.added.length + toMerge === 0,
  };
}

/** The ids among `merges` this device already has at that hlc or newer: merging changes nothing. */
export async function upToDateIds(
  db: BudgeeDb,
  merges: readonly { id: string; hlc: string }[],
): Promise<Set<string>> {
  const local = await db.transactions.bulkGet(merges.map((m) => m.id));
  return new Set(
    merges
      .filter((m, i) => {
        const row = local[i];
        return row !== undefined && row.hlc >= m.hlc;
      })
      .map((m) => m.id),
  );
}

export interface ImportResult {
  added: number;
  /** Rows with an id that were written (newer than this device's copy, or new here). */
  merged: number;
  categories: number;
}

/**
 * Writes the plan in one repository write: new categories first (after the last of their type),
 * then the entries. New entries get `created_at` from `now`, a millisecond apart in file order, so
 * entries of one day keep the file's order. A merged row keeps the `created_at` of the entry
 * here, if any. A category that appeared meanwhile (another device), in any case, is not created
 * twice: the rows take its spelling.
 */
export function applyImport(
  db: BudgeeDb,
  repo: Repository,
  plan: ImportPlan,
  now = Date.now(),
): Promise<ImportResult> {
  return repo.write(async (w) => {
    const result: ImportResult = { added: 0, merged: 0, categories: 0 };
    const live = (await db.categories.toArray()).filter((row) => !row.deleted);
    const nextSort = (type: EntryType) =>
      Math.max(-1, ...live.filter((row) => row.type === type).map((row) => row.sort)) + 1;

    // Key → the spelling stored: what exists now, then what this import creates.
    const categoryNames = new Map(live.map((row) => [categoryKey(row.type, row.name), row.name]));
    const sort = { income: nextSort("income"), expense: nextSort("expense") };
    for (const { type, name } of plan.categories) {
      const key = categoryKey(type, name);
      if (categoryNames.has(key)) continue;
      categoryNames.set(key, name);
      await w.put("categories", { type, name, sort: sort[type]++, archived: false });
      result.categories++;
    }
    const spelled = (fields: ImportedFields): ImportedFields => ({
      ...fields,
      category: categoryNames.get(usesKey(fields)) ?? fields.category,
    });

    for (const [i, fields] of plan.added.entries()) {
      const created_at = new Date(now + i).toISOString();
      await w.put("transactions", {
        ...spelled(fields),
        created_at,
      } as FieldsInputOf<"transactions">);
      result.added++;
    }
    for (const { id, hlc, fields } of plan.merges) {
      const local = await db.transactions.get(id);
      const created_at = local && !local.deleted ? local.created_at : new Date(now).toISOString();
      const row: LiveTransaction = {
        ...spelled(fields),
        created_at,
        id,
        hlc,
        device: parseHlc(hlc).device,
        deleted: false,
      };
      if (await w.merge("transactions", row)) result.merged++;
    }
    return result;
  });
}
