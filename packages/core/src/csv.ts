// CSV export and import. Files are RFC 4180 (quoted fields, CRLF) in UTF-8 with a header row.
// Amounts are plain decimals with a dot and no grouping (`4500`, `12999.5`), read and written
// as text so hundredths stay exact. Tags are joined with `;`.
import * as v from "valibot";
import { isKnownCurrency } from "./currencies";
import { HLC_PATTERN } from "./hlc";
import { isValidDate, type TransactionFields, type TransactionRow, uuidSchema } from "./schema";
import { type Deleted, listTags, type Tagged, tagKey, uniqueTags } from "./tags";

export const SIMPLE_COLUMNS = [
  "date",
  "type",
  "amount",
  "category",
  "detail",
  "note",
  "tags",
  "original_amount",
  "original_currency",
] as const;
/** The simple columns plus `id` and `hlc`, for lossless backups and re-imports. */
export const FULL_COLUMNS = [...SIMPLE_COLUMNS, "id", "hlc"] as const;
export type CsvColumn = (typeof FULL_COLUMNS)[number];
export type CsvFlavour = "simple" | "full";

const TAG_SEPARATOR = ";";

// ─── RFC 4180 ───────────────────────────────────────────────────────────────

const NEEDS_QUOTES = /[",\r\n]/;

/** One line per record, CRLF after each; fields with `"`, `,` or a line break are quoted. */
export function writeCsv(records: readonly (readonly string[])[]): string {
  return records
    .map(
      (record) =>
        `${record
          .map((field) => (NEEDS_QUOTES.test(field) ? `"${field.replaceAll('"', '""')}"` : field))
          .join(",")}\r\n`,
    )
    .join("");
}

export type CsvParseErrorReason = "unterminated_quote" | "text_after_quote";

/** Malformed CSV. Names the line (1-based) where the record starts, never its contents. */
export class CsvParseError extends Error {
  override name = "CsvParseError";
  readonly line: number;
  readonly reason: CsvParseErrorReason;

  constructor(line: number, reason: CsvParseErrorReason) {
    const what =
      reason === "unterminated_quote" ? "unterminated quoted field" : "text after a closing quote";
    super(`CSV line ${line}: ${what}`);
    this.line = line;
    this.reason = reason;
  }
}

/**
 * Reads RFC 4180 text: quoted fields may hold commas, `""` and line breaks; lines may end in
 * CRLF, LF or CR; a leading BOM is dropped; blank lines are skipped. The first record is the
 * header. Rows keep the number of fields they had; `lines` holds the file line (1-based) each
 * row starts on, for messages. Throws CsvParseError.
 */
export function parseCsv(text: string): { headers: string[]; rows: string[][]; lines: number[] } {
  const records: string[][] = [];
  const starts: number[] = [];
  let record: string[] = [];
  let field = "";
  // A field that was quoted counts even when empty, so `""` is not a blank line.
  let quotedField = false;
  let line = 1;
  let recordLine = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endRecord = () => {
    if (record.length > 0 || field !== "" || quotedField) {
      record.push(field);
      records.push(record);
      starts.push(recordLine);
    }
    record = [];
    field = "";
    quotedField = false;
  };

  while (i < text.length) {
    const c = text[i];
    if (c === '"' && field === "" && !quotedField) {
      // Quoted field: read up to the closing quote.
      quotedField = true;
      i += 1;
      for (;;) {
        if (i >= text.length) throw new CsvParseError(recordLine, "unterminated_quote");
        const q = text[i];
        if (q === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (q === "\n" || (q === "\r" && text[i + 1] !== "\n")) line += 1;
        field += q;
        i += 1;
      }
      const next = text[i];
      if (next !== undefined && next !== "," && next !== "\r" && next !== "\n") {
        throw new CsvParseError(recordLine, "text_after_quote");
      }
    } else if (c === ",") {
      record.push(field);
      field = "";
      quotedField = false;
      i += 1;
    } else if (c === "\r" || c === "\n") {
      endRecord();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line += 1;
      recordLine = line;
    } else {
      field += c;
      i += 1;
    }
  }
  endRecord();
  return { headers: records[0] ?? [], rows: records.slice(1), lines: starts.slice(1) };
}

// ─── Amounts ────────────────────────────────────────────────────────────────

/** Hundredths as a plain decimal with a dot: 450000 → `4500`, 1299950 → `12999.5`. */
export function formatCsvAmount(hundredths: number): string {
  if (!Number.isSafeInteger(hundredths) || hundredths < 0) {
    throw new RangeError("A CSV amount must be a non-negative safe integer");
  }
  const cents = hundredths % 100;
  const units = String((hundredths - cents) / 100);
  if (cents === 0) return units;
  return `${units}.${String(cents).padStart(2, "0").replace(/0$/, "")}`;
}

/**
 * A plain decimal with a dot (`4500`, `12999.5`, `0.05`) to hundredths, or null. Digits past
 * the second decimal must be zeros. No sign, grouping or exponent.
 */
export function parseCsvAmount(text: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, units = "", fraction = ""] = match;
  if (/[^0]/.test(fraction.slice(2))) return null;
  const value = Number(units + fraction.slice(0, 2).padEnd(2, "0"));
  return Number.isSafeInteger(value) ? value : null;
}

// ─── Export ─────────────────────────────────────────────────────────────────

/** Live transactions as CSV, in the order given; deleted rows are left out. */
export function exportCsv(rows: readonly TransactionRow[], flavour: CsvFlavour): string {
  const columns = flavour === "full" ? FULL_COLUMNS : SIMPLE_COLUMNS;
  const records: string[][] = [[...columns]];
  for (const row of rows) {
    if (row.deleted) continue;
    const cells: Record<CsvColumn, string> = {
      date: row.date,
      type: row.type,
      amount: formatCsvAmount(row.amount),
      category: row.category,
      detail: row.detail,
      note: row.note,
      tags: row.tags.join(TAG_SEPARATOR),
      original_amount: row.original_amount === null ? "" : formatCsvAmount(row.original_amount),
      original_currency: row.original_currency ?? "",
      id: row.id,
      hlc: row.hlc,
    };
    records.push(columns.map((column) => cells[column]));
  }
  return writeCsv(records);
}

// ─── Import ─────────────────────────────────────────────────────────────────

/** Which column index each field reads from; unmapped fields read as empty. */
export type ColumnMapping = Partial<Record<CsvColumn, number>>;

const headerKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const HEADER_FIELDS = new Map<string, CsvColumn>([
  ...FULL_COLUMNS.map((column) => [headerKey(column), column] as const),
  ["tag", "tags"],
  ["notes", "note"],
  ["details", "detail"],
]);

/**
 * Matches headers to fields by name, ignoring case, spaces, `-` and `_`. First match wins. An
 * explicit original currency header always wins; failing that, a bare `currency` header counts
 * as the original currency only when an original amount column is mapped too: beside a plain
 * amount it names the amount's own currency.
 */
export function autoMapHeaders(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  headers.forEach((header, index) => {
    const field = HEADER_FIELDS.get(headerKey(header));
    if (field && mapping[field] === undefined) mapping[field] = index;
  });
  if (mapping.original_currency === undefined && mapping.original_amount !== undefined) {
    const bare = headers.findIndex((header) => headerKey(header) === "currency");
    if (bare >= 0) mapping.original_currency = bare;
  }
  return mapping;
}

/** Fields every row needs. */
const REQUIRED_COLUMNS = ["date", "type", "amount", "category"] as const;

export interface ImportContext {
  /** Categories that exist (archived ones too). */
  categories: readonly { type: "income" | "expense"; name: string }[];
  /** Stored transactions: for duplicate warnings and the tag spellings already in use. */
  transactions: readonly (ImportExisting | Deleted)[];
}

export interface ImportExisting extends Tagged {
  date: string;
  type: "income" | "expense";
  amount: number;
  category: string;
}

/**
 * `required`: empty; `invalid`: unreadable; `pair`: only one of `original_amount`/
 * `original_currency` or of `id`/`hlc`, reported on the empty one; `unknown_currency`: not an
 * ISO 4217 code; `income_category`/`expense_category`: names a category of the other type
 * (names are unique across types).
 */
export type ImportIssueCode =
  | "required"
  | "invalid"
  | "pair"
  | "unknown_currency"
  | "income_category"
  | "expense_category";

/** What is wrong and where, never the cell's contents. */
export interface ImportIssue {
  field: CsvColumn;
  code: ImportIssueCode;
}

/** A transaction read from CSV: everything but the sync columns and `created_at`. */
export type ImportedFields = Omit<TransactionFields, "created_at">;

export type ImportRow =
  | {
      /** Position in the rows given. */
      index: number;
      ok: true;
      fields: ImportedFields;
      /** Set when the row carries an id: it merges like a synced row (higher hlc wins). */
      merge: { id: string; hlc: string } | null;
      /** A row without id with the same date, amount, type and category as a stored entry or an earlier row. */
      duplicate: boolean;
    }
  | { index: number; ok: false; errors: ImportIssue[] };

export interface ImportValidation {
  /** One per row, in order; rows whose cells are all empty are skipped. */
  rows: ImportRow[];
  /** Required fields with no column mapped. */
  missingColumns: CsvColumn[];
  /** Names used by valid rows that do not exist yet, each once in its first spelling. */
  unknownCategories: { type: "income" | "expense"; name: string }[];
}

const nameKey = (name: string) => name.toLowerCase();
const duplicateKey = (t: { date: string; type: string; amount: number; category: string }) =>
  `${t.date}|${t.type}|${t.amount}|${nameKey(t.category)}`;

/**
 * Checks each row against `mapping` and turns valid ones into transaction fields. Known
 * categories and tags take the spelling already in use; unknown categories are listed for
 * creation. Structured cells are trimmed; `detail` and `note` are kept exactly.
 */
export function validateImportRows(
  rows: readonly (readonly string[])[],
  mapping: ColumnMapping,
  context: ImportContext,
): ImportValidation {
  // Lower-case key → the spelling in use: stored names first, then those first met in the file.
  const categories = new Map(
    context.categories.map((c) => [`${c.type}:${nameKey(c.name)}`, c.name]),
  );
  // Lower-case name → its type: a name belongs to one type only.
  const owners = new Map(context.categories.map((c) => [nameKey(c.name), c.type]));
  const tagSpellings = new Map(listTags(context.transactions).map(({ tag }) => [tagKey(tag), tag]));
  const duplicates = new Set<string>();
  for (const t of context.transactions) {
    if (!t.deleted) duplicates.add(duplicateKey(t as ImportExisting));
  }

  const result: ImportValidation = {
    rows: [],
    missingColumns: REQUIRED_COLUMNS.filter((column) => mapping[column] === undefined),
    unknownCategories: [],
  };

  rows.forEach((row, index) => {
    if (row.every((cell) => cell.trim() === "")) return;
    const raw = (column: CsvColumn) => {
      const at = mapping[column];
      return at === undefined ? "" : (row[at] ?? "");
    };
    const cell = (column: CsvColumn) => raw(column).trim();
    const errors: ImportIssue[] = [];
    const fail = (field: CsvColumn, code: ImportIssueCode) => {
      errors.push({ field, code });
    };

    const date = cell("date");
    if (date === "") fail("date", "required");
    else if (!isValidDate(date)) fail("date", "invalid");

    const typeText = cell("type").toLowerCase();
    const type = typeText === "income" || typeText === "expense" ? typeText : null;
    if (typeText === "") fail("type", "required");
    else if (!type) fail("type", "invalid");

    const amountText = cell("amount");
    const amount = parseCsvAmount(amountText);
    if (amountText === "") fail("amount", "required");
    else if (!amount) fail("amount", "invalid");

    const categoryText = cell("category");
    const categoryKey = `${type}:${nameKey(categoryText)}`;
    const owner = owners.get(nameKey(categoryText));
    if (categoryText === "") fail("category", "required");
    else if (type && owner && owner !== type && !categories.has(categoryKey))
      fail("category", owner === "income" ? "income_category" : "expense_category");

    const originalText = cell("original_amount");
    const currency = cell("original_currency").toUpperCase();
    if (originalText !== "" && currency === "") fail("original_currency", "pair");
    if (originalText === "" && currency !== "") fail("original_amount", "pair");
    const originalAmount = originalText === "" ? null : parseCsvAmount(originalText);
    if (originalText !== "" && !originalAmount) fail("original_amount", "invalid");
    if (currency !== "" && !isKnownCurrency(currency))
      fail("original_currency", "unknown_currency");

    const id = cell("id");
    const hlc = cell("hlc");
    if (id !== "" && hlc === "") fail("hlc", "pair");
    if (id === "" && hlc !== "") fail("id", "pair");
    if (id !== "" && !v.is(uuidSchema, id)) fail("id", "invalid");
    if (hlc !== "" && !HLC_PATTERN.test(hlc)) fail("hlc", "invalid");

    if (errors.length > 0 || !type || !amount) {
      result.rows.push({ index, ok: false, errors });
      return;
    }

    const category = categories.get(categoryKey) ?? categoryText;
    if (!categories.has(categoryKey)) {
      categories.set(categoryKey, categoryText);
      owners.set(nameKey(categoryText), type);
      result.unknownCategories.push({ type, name: categoryText });
    }

    const tags = uniqueTags(raw("tags").split(TAG_SEPARATOR)).map((tag) => {
      const key = tagKey(tag);
      if (!tagSpellings.has(key)) tagSpellings.set(key, tag);
      return tagSpellings.get(key) ?? tag;
    });

    const fields: ImportedFields = {
      date,
      type,
      amount,
      category,
      detail: raw("detail"),
      note: raw("note"),
      tags,
      original_amount: originalAmount,
      original_currency: currency === "" ? null : currency,
    };
    const merge = id === "" ? null : { id, hlc };
    const key = duplicateKey(fields);
    const duplicate = merge === null && duplicates.has(key);
    duplicates.add(key);
    result.rows.push({ index, ok: true, fields, merge, duplicate });
  });

  return result;
}
