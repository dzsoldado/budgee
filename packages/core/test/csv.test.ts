import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  autoMapHeaders,
  type ColumnMapping,
  CsvParseError,
  exportCsv,
  FULL_COLUMNS,
  formatCsvAmount,
  type ImportContext,
  type ImportRow,
  parseCsv,
  parseCsvAmount,
  SIMPLE_COLUMNS,
  validateImportRows,
  writeCsv,
} from "../src/csv";
import { DEFAULT_CATEGORIES } from "../src/defaults";
import { type LiveTransaction, type Tombstone, transactionFieldsSchema } from "../src/schema";

// Verbatim from the spec's "CSV format" section.
const SPEC_SAMPLE = `date,type,amount,category,detail,note,tags,original_amount,original_currency
2026-11-02,expense,4500,Medical,dentist,,,,
2026-11-03,expense,12999.5,Clothing,AliExpress,winter coat,,95,USD
2026-08-12,expense,2808,Transport,ferry,,Istanbul 2026,720,TRY
2026-11-01,income,85000,Salary,,,,,
`;

const CONTEXT: ImportContext = {
  categories: DEFAULT_CATEGORIES,
  transactions: [],
};

const okRows = (rows: readonly ImportRow[]) =>
  rows.map((row) => {
    if (!row.ok) throw new Error(`row ${row.index} failed: ${JSON.stringify(row.errors)}`);
    return row;
  });

const issues = (row: ImportRow | undefined) => (row && !row.ok ? row.errors : []);

function importText(text: string, context: ImportContext = CONTEXT) {
  const { headers, rows } = parseCsv(text);
  return validateImportRows(rows, autoMapHeaders(headers), context);
}

let n = 0;
function tx(extra: Partial<LiveTransaction> = {}): LiveTransaction {
  n += 1;
  return {
    id: `0b7c1e2a-5d3f-4c8e-9a1b-${String(n).padStart(12, "0")}`,
    hlc: `001763000000${String(n).padStart(3, "0")}:00002:dev-${n}`,
    deleted: false,
    device: `dev-${n}`,
    type: "expense",
    amount: 450000,
    date: "2026-11-02",
    category: "Medical",
    detail: "",
    note: "",
    tags: [],
    original_amount: null,
    original_currency: null,
    created_at: "2026-11-02T08:00:00.000Z",
    ...extra,
  };
}

describe("RFC 4180 writer and reader", () => {
  test("quotes commas, quotes and newlines, and uses CRLF line endings", () => {
    const text = writeCsv([
      ["a", "b,c", 'say "hi"', "line1\nline2", "cr\r\nlf", ""],
      ["plain", "", "", "", "", "x"],
    ]);
    expect(text).toBe('a,"b,c","say ""hi""","line1\nline2","cr\r\nlf",\r\nplain,,,,,x\r\n');
  });

  test("reads back exactly what it wrote, including UTF-8 text", () => {
    const records = [
      ["date", "detail", "note"],
      ["2026-11-02", "Café, Alger", 'Il a dit "ça va"\nsecond line'],
      ["2026-11-03", "مطعم", "Ünïcödé 🎉, ok"],
      ["", "", ""],
    ];
    const { headers, rows } = parseCsv(writeCsv(records));
    expect(headers).toEqual(records[0] as string[]);
    expect(rows).toEqual(records.slice(1));
  });

  test("accepts LF, CRLF and CR line endings, a BOM, and no final newline", () => {
    for (const text of ["\uFEFFa,b\n1,2\n3,4", "a,b\r\n1,2\r\n3,4\r\n", "a,b\r1,2\r3,4\r"]) {
      expect(parseCsv(text)).toEqual({
        headers: ["a", "b"],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
        lines: [2, 3],
      });
    }
  });

  test("skips blank lines but keeps a quoted empty field", () => {
    expect(parseCsv('a\n\n1\n\n""\n').rows).toEqual([["1"], [""]]);
  });

  test("keeps empty trailing fields and short rows as read", () => {
    expect(parseCsv("a,b,c\n1,,\n2\n").rows).toEqual([["1", "", ""], ["2"]]);
  });

  test("an empty file has no header and no rows", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [], lines: [] });
  });

  test("gives the file line each row starts on, past blank lines and quoted line breaks", () => {
    const text = 'a,b\n\n1,"two\nlines"\r\n2,x\r\n\r\n"3\r\nmore\rstill",y\n4,z';
    const { rows, lines } = parseCsv(text);
    expect(rows.map((r) => r[0])).toEqual(["1", "2", "3\r\nmore\rstill", "4"]);
    expect(lines).toEqual([3, 5, 7, 10]);
    // After a BOM and a header that is not on line 1.
    expect(parseCsv("\uFEFF\n\na\n1\n").lines).toEqual([4]);
  });

  test("rejects an unterminated quote or text after a closing quote, naming only the line", () => {
    try {
      parseCsv('a,b\n1,"secret\n2,3');
      throw new Error("expected a CsvParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(CsvParseError);
      expect((error as CsvParseError).line).toBe(2);
      expect((error as CsvParseError).reason).toBe("unterminated_quote");
      expect(String(error)).not.toContain("secret");
    }
    try {
      parseCsv('a,b\n1,2\n"secret"x,3');
      throw new Error("expected a CsvParseError");
    } catch (error) {
      expect((error as CsvParseError).line).toBe(3);
      expect((error as CsvParseError).reason).toBe("text_after_quote");
      expect(String(error)).not.toContain("secret");
    }
  });

  test("a quote inside an unquoted field is kept as text", () => {
    expect(parseCsv('a\n5" screen\n').rows).toEqual([['5" screen']]);
  });
});

describe("CSV amounts", () => {
  test("format as plain decimals with a dot, no grouping, no trailing zeros", () => {
    expect(formatCsvAmount(450000)).toBe("4500");
    expect(formatCsvAmount(1299950)).toBe("12999.5");
    expect(formatCsvAmount(9500)).toBe("95");
    expect(formatCsvAmount(12345)).toBe("123.45");
    expect(formatCsvAmount(5)).toBe("0.05");
    expect(formatCsvAmount(50)).toBe("0.5");
    expect(formatCsvAmount(0)).toBe("0");
    expect(formatCsvAmount(900719925474099)).toBe("9007199254740.99");
  });

  test("parse back exactly to hundredths", () => {
    expect(parseCsvAmount("4500")).toBe(450000);
    expect(parseCsvAmount("12999.5")).toBe(1299950);
    expect(parseCsvAmount("12999.50")).toBe(1299950);
    expect(parseCsvAmount(" 0.05 ")).toBe(5);
    expect(parseCsvAmount("0.1")).toBe(10);
    expect(parseCsvAmount("95.000")).toBe(9500);
    expect(parseCsvAmount("9007199254740.99")).toBe(900719925474099);
    // 0.1 + 0.2-style float traps cannot happen: every digit is read as text.
    expect(parseCsvAmount("1.15")).toBe(115);
    expect(parseCsvAmount("4.35")).toBe(435);
  });

  test("round-trip every hundredth over a range without drift", () => {
    for (let h = 0; h < 20000; h += 1) expect(parseCsvAmount(formatCsvAmount(h))).toBe(h);
  });

  test("reject grouping, commas, signs, exponents and sub-hundredths", () => {
    for (const bad of [
      "",
      "1,500",
      "1 500",
      "12,5",
      "-5",
      "+5",
      "1e3",
      ".5",
      "5.",
      "1.005",
      "abc",
      "9007199254740.992",
      "99999999999999999",
    ]) {
      expect(parseCsvAmount(bad)).toBeNull();
    }
  });
});

describe("exportCsv", () => {
  test("simple export has the spec's columns in order", () => {
    expect(exportCsv([], "simple")).toBe(`${SIMPLE_COLUMNS.join(",")}\r\n`);
    expect(SIMPLE_COLUMNS.join(",")).toBe(
      "date,type,amount,category,detail,note,tags,original_amount,original_currency",
    );
  });

  test("full export adds id and hlc", () => {
    expect(FULL_COLUMNS.join(",")).toBe(
      "date,type,amount,category,detail,note,tags,original_amount,original_currency,id,hlc",
    );
    const row = tx({
      tags: ["Istanbul 2026", "Ferry"],
      original_amount: 72000,
      original_currency: "TRY",
    });
    const [header, line] = exportCsv([row], "full").split("\r\n");
    expect(header).toBe(FULL_COLUMNS.join(","));
    expect(line).toBe(
      `2026-11-02,expense,4500,Medical,,,Istanbul 2026;Ferry,720,TRY,${row.id},${row.hlc}`,
    );
  });

  test("leaves out deleted rows", () => {
    const tombstone: Tombstone = { id: tx().id, hlc: tx().hlc, deleted: true, device: "dev-1" };
    expect(exportCsv([tombstone, tx()], "simple").split("\r\n")).toHaveLength(3);
  });

  test("reproduces the spec sample from its own import", () => {
    const result = importText(SPEC_SAMPLE);
    const rows = okRows(result.rows).map((row, i) => ({
      ...tx(),
      ...row.fields,
      created_at: `2026-11-0${i + 1}T00:00:00.000Z`,
    }));
    expect(exportCsv(rows, "simple")).toBe(SPEC_SAMPLE.replaceAll("\n", "\r\n"));
  });
});

describe("autoMapHeaders", () => {
  test("maps the export's own headers", () => {
    const mapping = autoMapHeaders([...FULL_COLUMNS]);
    FULL_COLUMNS.forEach((column, i) => {
      expect(mapping[column]).toBe(i);
    });
  });

  test("ignores case, spaces, dashes and underscores, and knows a few common names", () => {
    expect(
      autoMapHeaders([
        " Date ",
        "TYPE",
        "Amount",
        "Category",
        "Original Amount",
        "original currency",
        "Notes",
        "Tag",
        "Bank reference",
        "Details",
      ]),
    ).toEqual({
      date: 0,
      type: 1,
      amount: 2,
      category: 3,
      original_amount: 4,
      original_currency: 5,
      note: 6,
      tags: 7,
      detail: 9,
    });
  });

  test("a bare currency header is the original currency only beside an original amount", () => {
    // A bank file: the amount's own currency, not a foreign one; mapping it would make every
    // row an original-pair error.
    expect(autoMapHeaders(["Date", "Amount", "Currency"])).toEqual({ date: 0, amount: 1 });
    expect(autoMapHeaders(["Date", "Amount", "Original amount", "Currency"])).toEqual({
      date: 0,
      amount: 1,
      original_amount: 2,
      original_currency: 3,
    });
    // An explicit original currency header is always mapped.
    expect(autoMapHeaders(["Amount", "Original currency"])).toEqual({
      amount: 0,
      original_currency: 1,
    });
  });

  test("an explicit original currency header wins over a bare currency one, wherever it is", () => {
    expect(autoMapHeaders(["Currency", "Amount", "Original currency"])).toEqual({
      amount: 1,
      original_currency: 2,
    });
    expect(autoMapHeaders(["Currency", "Amount", "Original amount", "Original currency"])).toEqual({
      amount: 1,
      original_amount: 2,
      original_currency: 3,
    });
  });

  test("maps a field to the first matching column only", () => {
    expect(autoMapHeaders(["note", "Note", "amount"])).toEqual({ note: 0, amount: 2 });
  });
});

describe("validateImportRows: the spec sample", () => {
  test("every row parses to exact transaction fields", () => {
    const result = importText(SPEC_SAMPLE);
    expect(result.missingColumns).toEqual([]);
    expect(result.unknownCategories).toEqual([]);
    expect(okRows(result.rows).map((r) => r.fields)).toEqual([
      {
        date: "2026-11-02",
        type: "expense",
        amount: 450000,
        category: "Medical",
        detail: "dentist",
        note: "",
        tags: [],
        original_amount: null,
        original_currency: null,
      },
      {
        date: "2026-11-03",
        type: "expense",
        amount: 1299950,
        category: "Clothing",
        detail: "AliExpress",
        note: "winter coat",
        tags: [],
        original_amount: 9500,
        original_currency: "USD",
      },
      {
        date: "2026-08-12",
        type: "expense",
        amount: 280800,
        category: "Transport",
        detail: "ferry",
        note: "",
        tags: ["Istanbul 2026"],
        original_amount: 72000,
        original_currency: "TRY",
      },
      {
        date: "2026-11-01",
        type: "income",
        amount: 8500000,
        category: "Salary",
        detail: "",
        note: "",
        tags: [],
        original_amount: null,
        original_currency: null,
      },
    ]);
    for (const row of okRows(result.rows)) {
      expect(row.merge).toBeNull();
      expect(row.duplicate).toBe(false);
      // What import produces is a valid transaction once the caller stamps created_at.
      expect(
        v.is(transactionFieldsSchema, { ...row.fields, created_at: "2026-11-17T10:00:00.000Z" }),
      ).toBe(true);
    }
  });
});

describe("export then import round-trips exactly", () => {
  const rows = [
    tx({
      tags: ["Istanbul 2026", "Ferry"],
      original_amount: 72000,
      original_currency: "TRY",
      amount: 280800,
      date: "2026-08-12",
      category: "Transport",
      detail: "ferry, Kadıköy",
    }),
    tx({
      category: "Clothing",
      amount: 1299950,
      detail: 'AliExpress "Pro"',
      note: "winter coat\nsize L, black\r\nsecond line",
      original_amount: 9500,
      original_currency: "USD",
    }),
    tx({
      type: "income",
      category: "Salary",
      amount: 8500000,
      date: "2026-11-01",
    }),
    tx({ amount: 1, note: "  padded note  ", detail: " ", tags: ["Wedding"] }),
    tx({ original_amount: 1, original_currency: "HRK", date: "2022-07-01" }),
  ];
  const fieldsOf = ({ id, hlc, deleted, device, created_at, ...fields }: LiveTransaction) => fields;

  test("full: fields, tags, original pair, id and hlc", () => {
    const result = importText(exportCsv(rows, "full"));
    const imported = okRows(result.rows);
    expect(imported.map((r) => r.fields)).toEqual(rows.map(fieldsOf));
    expect(imported.map((r) => r.merge)).toEqual(rows.map(({ id, hlc }) => ({ id, hlc })));
    expect(result.unknownCategories).toEqual([]);
  });

  test("simple: fields, tags and original pair; rows get new ids", () => {
    const imported = okRows(importText(exportCsv(rows, "simple")).rows);
    expect(imported.map((r) => r.fields)).toEqual(rows.map(fieldsOf));
    expect(imported.every((r) => r.merge === null)).toBe(true);
  });

  test("a second export of the import is byte-identical", () => {
    const first = exportCsv(rows, "full");
    const again = okRows(importText(first).rows).map((r, i) => ({
      ...(rows[i] as LiveTransaction),
      ...r.fields,
      ...(r.merge ?? {}),
    }));
    expect(exportCsv(again, "full")).toBe(first);
  });
});

describe("validateImportRows: errors", () => {
  const header = "date,type,amount,category,original_amount,original_currency";

  test("only one of original_amount and original_currency is an error", () => {
    const result = importText(
      `${header}\n2026-11-03,expense,10,Clothing,95,\n2026-11-03,expense,10,Clothing,,USD\n`,
    );
    expect(issues(result.rows[0])).toEqual([{ field: "original_currency", code: "pair" }]);
    expect(issues(result.rows[1])).toEqual([{ field: "original_amount", code: "pair" }]);
  });

  test("an unknown currency code is an error; known codes are read in any case", () => {
    const result = importText(
      `${header}\n2026-11-03,expense,10,Clothing,95,ABC\n2026-11-03,expense,10,Clothing,95,XXX\n2026-11-03,expense,10,Clothing,95, eur \n2026-11-03,expense,10,Clothing,95,EURO\n`,
    );
    expect(issues(result.rows[0])).toEqual([
      { field: "original_currency", code: "unknown_currency" },
    ]);
    expect(issues(result.rows[1])).toEqual([
      { field: "original_currency", code: "unknown_currency" },
    ]);
    const eur = result.rows[2];
    expect(eur?.ok && eur.fields.original_currency).toBe("EUR");
    expect(issues(result.rows[3])).toEqual([
      { field: "original_currency", code: "unknown_currency" },
    ]);
  });

  test("bad dates, amounts and types are errors", () => {
    const result = importText(
      [
        header,
        "2026-02-30,expense,10,Clothing,,",
        "03/11/2026,expense,10,Clothing,,",
        "2026-11-03,expense,1 500,Clothing,,",
        "2026-11-03,expense,0,Clothing,,",
        "2026-11-03,expense,-10,Clothing,,",
        "2026-11-03,expense,10,Clothing,0,USD",
        "2026-11-03,refund,10,Clothing,,",
        ",,,,,,",
        ",Expense,,,,,",
      ].join("\n"),
    );
    expect(result.rows.map((r) => (r.ok ? "ok" : r.errors))).toEqual([
      [{ field: "date", code: "invalid" }],
      [{ field: "date", code: "invalid" }],
      [{ field: "amount", code: "invalid" }],
      [{ field: "amount", code: "invalid" }],
      [{ field: "amount", code: "invalid" }],
      [{ field: "original_amount", code: "invalid" }],
      [{ field: "type", code: "invalid" }],
      // The all-empty row is skipped; "Expense" is read in any case.
      [
        { field: "date", code: "required" },
        { field: "amount", code: "required" },
        { field: "category", code: "required" },
      ],
    ]);
    expect(result.rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 8]);
  });

  test("every row needs a category, income and expenses alike", () => {
    const result = importText(
      `${header}\n2026-11-03,expense,10,,,\n2026-11-03,income,10, ,,\n2026-11-04,income,10,Salary,,\n`,
    );
    expect(issues(result.rows[0])).toEqual([{ field: "category", code: "required" }]);
    expect(issues(result.rows[1])).toEqual([{ field: "category", code: "required" }]);
    expect(result.rows[2]?.ok && result.rows[2].fields.category).toBe("Salary");
  });

  test("id and hlc come together and must be well formed", () => {
    const full = FULL_COLUMNS.join(",");
    const id = "0b7c1e2a-5d3f-4c8e-9a1b-000000000001";
    const hlc = "001763000000000:00000:dev-a";
    const result = importText(
      [
        full,
        `2026-11-03,expense,10,Clothing,,,,,,${id},`,
        `2026-11-03,expense,10,Clothing,,,,,,,${hlc}`,
        `2026-11-03,expense,10,Clothing,,,,,,not-a-uuid,${hlc}`,
        `2026-11-03,expense,10,Clothing,,,,,,${id},12:3:x`,
      ].join("\n"),
    );
    expect(result.rows.map(issues)).toEqual([
      [{ field: "hlc", code: "pair" }],
      [{ field: "id", code: "pair" }],
      [{ field: "id", code: "invalid" }],
      [{ field: "hlc", code: "invalid" }],
    ]);
  });

  test("unmapped required columns are reported once, and rows fail on them", () => {
    const result = importText("when,amount,category\n2026-11-03,10,Salary\n");
    expect(result.missingColumns).toEqual(["date", "type"]);
    expect(issues(result.rows[0])).toEqual([
      { field: "date", code: "required" },
      { field: "type", code: "required" },
    ]);
  });

  test("row issues never carry the cell contents", () => {
    const result = importText(`${header}\nSECRET,SECRET,SECRET,Clothing,SECRET,SECRET\n`);
    expect(JSON.stringify(result.rows)).not.toContain("SECRET");
  });

  test("a custom mapping reads the columns it names", () => {
    const mapping: ColumnMapping = { date: 2, type: 0, amount: 1, category: 3 };
    const result = validateImportRows(
      [["income", "12.5", "2026-11-01", "Freelance"]],
      mapping,
      CONTEXT,
    );
    const row = okRows(result.rows)[0];
    expect(row?.fields).toMatchObject({ type: "income", amount: 1250, date: "2026-11-01" });
  });
});

describe("validateImportRows: names, tags, merge and duplicates", () => {
  const header = "date,type,amount,category,tags";

  test("unknown categories are collected for creation with their type, once each", () => {
    const result = importText(
      [
        header,
        "2026-11-03,expense,10,Souvenirs,",
        "2026-11-04,expense,10,souvenirs,",
        "2026-11-05,income,10,Bonus,",
        "2026-11-07,expense,10,transport,",
        "2026-11-08,income,10,salary,",
        "2026-11-08,refund,10,Trips,", // invalid row: not collected
      ].join("\n"),
    );
    expect(result.unknownCategories).toEqual([
      { type: "expense", name: "Souvenirs" },
      { type: "income", name: "Bonus" },
    ]);
    const fields = result.rows.flatMap((r) => (r.ok ? [r.fields] : []));
    // Names already known (or met earlier in the file) keep their first spelling.
    expect(fields.map((f) => f.category)).toEqual([
      "Souvenirs",
      "Souvenirs",
      "Bonus",
      "Transport",
      "Salary",
    ]);
  });

  test("a category of the other type is an error, stored or met earlier in the file", () => {
    const result = importText(
      [
        header,
        "2026-11-03,income,10,groceries,", // an expense category
        "2026-11-04,expense,10,Salary,", // an income category
        "2026-11-05,income,10,Bonus,",
        "2026-11-06,expense,10,bonus,", // income since the row above
      ].join("\n"),
    );
    expect(result.rows.map(issues)).toEqual([
      [{ field: "category", code: "expense_category" }],
      [{ field: "category", code: "income_category" }],
      [],
      [{ field: "category", code: "income_category" }],
    ]);
    expect(result.unknownCategories).toEqual([{ type: "income", name: "Bonus" }]);
  });

  test("tags are split on ';', trimmed, de-duplicated and spelled as already in use", () => {
    const context: ImportContext = {
      ...CONTEXT,
      transactions: [tx({ tags: ["Istanbul 2026"] })],
    };
    const result = importText(
      `${header}\n2026-11-03,expense,10,Transport, istanbul 2026 ; Ferry;;ferry ;\n2026-11-04,expense,20,Transport,FERRY\n`,
      context,
    );
    expect(okRows(result.rows).map((r) => r.fields.tags)).toEqual([
      ["Istanbul 2026", "Ferry"],
      ["Ferry"],
    ]);
  });

  test("rows with an id are flagged for merge and skip the duplicate warning", () => {
    const existing = tx();
    const result = importText(exportCsv([existing], "full"), {
      ...CONTEXT,
      transactions: [existing],
    });
    const [row] = okRows(result.rows);
    expect(row?.merge).toEqual({ id: existing.id, hlc: existing.hlc });
    expect(row?.duplicate).toBe(false);
  });

  test("likely duplicates: same date, amount, type and category as a stored entry", () => {
    const existing = tx({
      date: "2026-11-02",
      amount: 450000,
      category: "Medical",
      detail: "dentist",
    });
    const deleted = tx({ date: "2026-11-05", amount: 1000, category: "Bills" });
    const context: ImportContext = {
      ...CONTEXT,
      transactions: [existing, { ...deleted, deleted: true }],
    };
    const result = importText(
      [
        "date,type,amount,category,detail",
        "2026-11-02,expense,4500,medical,other detail", // duplicate (detail ignored)
        "2026-11-02,expense,4500.01,Medical,", // different amount
        "2026-11-03,expense,4500,Medical,", // different date
        "2026-11-02,income,4500,Salary,", // different type and category
        "2026-11-02,expense,4500,Groceries,", // different category
        "2026-11-05,expense,10,Bills,", // matches only a deleted entry
      ].join("\n"),
      context,
    );
    expect(okRows(result.rows).map((r) => r.duplicate)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test("a row repeated within the file is a likely duplicate of the earlier one", () => {
    const line = "2026-11-03,expense,12,Transport,";
    const result = importText(`${header}\n${line}\n${line}\n${line}\n`);
    expect(okRows(result.rows).map((r) => r.duplicate)).toEqual([false, true, true]);
  });
});
