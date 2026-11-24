import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  BLOB_MAX_LENGTH,
  categoryRowSchema,
  chartConfigRowSchema,
  chartConfigSchema,
  currencySchema,
  deviceListResponseSchema,
  deviceSchema,
  envelopeSchema,
  errorResponseSchema,
  fieldSchemas,
  healthResponseSchema,
  inviteResponseSchema,
  isoDateSchema,
  isValidDate,
  PULL_LIMIT,
  PUSH_MAX,
  PUSH_MAX_BYTES,
  pairRequestSchema,
  pairResponseSchema,
  pullQuerySchema,
  pullResponseSchema,
  pushRequestSchema,
  pushResponseSchema,
  renameDeviceRequestSchema,
  revokeDeviceRequestSchema,
  rowSchemas,
  SETTING_IDS,
  SYNCED_TABLES,
  settingFieldsSchema,
  settingRowSchema,
  setupRequestSchema,
  setupResponseSchema,
  tagSchema,
  transactionFieldsSchema,
  transactionRowSchema,
} from "../src/schema";

const ok = (schema: v.GenericSchema, input: unknown) => v.safeParse(schema, input).success;

const ID = "6f1c2c1e-6b8a-4f57-9d0c-3f7f2a1d9e01";
const HLC = "001762250000000:00003:a1b2c3";
const sync = { id: ID, hlc: HLC, deleted: false, device: "a1b2c3" } as const;

const expense = {
  type: "expense",
  amount: 450000,
  date: "2026-11-02",
  category: "Medical",
  detail: "dentist",
  note: "",
  tags: [],
  original_amount: null,
  original_currency: null,
  created_at: "2026-11-02T09:15:00.000Z",
} as const;

const income = {
  ...expense,
  type: "income",
  amount: 8500000,
  category: "Salary",
  detail: "",
} as const;

describe("dates", () => {
  test("accepts real calendar dates", () => {
    for (const d of ["2026-11-17", "2024-02-29", "2000-02-29", "1999-12-31", "2026-01-01"]) {
      expect(isValidDate(d)).toBe(true);
      expect(ok(isoDateSchema, d)).toBe(true);
    }
  });

  test("rejects impossible dates and other formats", () => {
    for (const d of [
      "2026-02-29", // not a leap year
      "1900-02-29", // century, not a leap year
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-11-00",
      "2026-11-1",
      "26-11-01",
      "2026/11/01",
      "2026-11-01T00:00:00Z",
      " 2026-11-01",
    ]) {
      expect(isValidDate(d)).toBe(false);
      expect(ok(isoDateSchema, d)).toBe(false);
    }
  });
});

describe("currency", () => {
  test("accepts 3-letter uppercase ISO 4217 style codes", () => {
    for (const c of ["DZD", "EUR", "USD", "TRY"]) expect(ok(currencySchema, c)).toBe(true);
  });

  test("rejects lowercase, wrong length and non-letters", () => {
    for (const c of ["eur", "Eur", "EU", "EURO", "E1R", "", " EUR"]) {
      expect(ok(currencySchema, c)).toBe(false);
    }
  });
});

describe("tags", () => {
  test("accept free-form labels", () => {
    for (const t of ["Istanbul 2026", "Wedding", "home-office"])
      expect(ok(tagSchema, t)).toBe(true);
  });

  test("reject ';', empty and untrimmed values", () => {
    for (const t of ["a;b", ";", "", " ", " Wedding", "Wedding "]) {
      expect(ok(tagSchema, t)).toBe(false);
    }
  });
});

describe("transactions", () => {
  test("valid expense and income fields parse", () => {
    expect(ok(transactionFieldsSchema, expense)).toBe(true);
    expect(ok(transactionFieldsSchema, income)).toBe(true);
  });

  test("optional fields default to empty values", () => {
    const parsed = v.parse(transactionFieldsSchema, {
      type: "expense",
      amount: 100,
      date: "2026-11-02",
      category: "Transport",
      created_at: "2026-11-02T09:15:00.000Z",
    });
    expect(parsed).toEqual({
      type: "expense",
      amount: 100,
      date: "2026-11-02",
      category: "Transport",
      detail: "",
      note: "",
      tags: [],
      original_amount: null,
      original_currency: null,
      created_at: "2026-11-02T09:15:00.000Z",
    });
  });

  test("amount must be a positive integer (hundredths)", () => {
    for (const amount of [0, -100, 12.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "100"]) {
      expect(ok(transactionFieldsSchema, { ...expense, amount })).toBe(false);
    }
    expect(ok(transactionFieldsSchema, { ...expense, amount: 1 })).toBe(true);
  });

  test("original amount and currency are both set or both empty", () => {
    expect(
      ok(transactionFieldsSchema, { ...expense, original_amount: 12000, original_currency: "EUR" }),
    ).toBe(true);
    expect(ok(transactionFieldsSchema, { ...expense, original_amount: 12000 })).toBe(false);
    expect(ok(transactionFieldsSchema, { ...expense, original_currency: "EUR" })).toBe(false);
    expect(
      ok(transactionFieldsSchema, { ...expense, original_amount: 0, original_currency: "EUR" }),
    ).toBe(false);
    expect(
      ok(transactionFieldsSchema, { ...expense, original_amount: 12000, original_currency: "eur" }),
    ).toBe(false);
  });

  test("the one-sided original pair is reported on the missing field", () => {
    const result = v.safeParse(transactionFieldsSchema, { ...expense, original_amount: 12000 });
    expect(result.success).toBe(false);
    expect(result.issues?.map((i) => v.getDotPath(i))).toContain("original_currency");
  });

  test("category is required for expenses and income", () => {
    expect(ok(transactionFieldsSchema, { ...expense, category: "" })).toBe(false);
    const result = v.safeParse(transactionFieldsSchema, { ...income, category: "" });
    expect(result.issues?.map((i) => v.getDotPath(i))).toContain("category");
    const { category: _, ...noCategory } = income;
    expect(ok(transactionFieldsSchema, noCategory)).toBe(false);
  });

  test("date must be a valid calendar date", () => {
    expect(ok(transactionFieldsSchema, { ...expense, date: "2026-02-30" })).toBe(false);
  });

  test("tags contain no ';'", () => {
    expect(ok(transactionFieldsSchema, { ...expense, tags: ["Istanbul 2026", "Wedding"] })).toBe(
      true,
    );
    expect(ok(transactionFieldsSchema, { ...expense, tags: ["Istanbul;2026"] })).toBe(false);
  });

  test("created_at must be an ISO timestamp", () => {
    expect(ok(transactionFieldsSchema, { ...expense, created_at: "2026-11-02" })).toBe(false);
    expect(ok(transactionFieldsSchema, { ...expense, created_at: "yesterday" })).toBe(false);
  });

  test("unknown fields are rejected", () => {
    expect(ok(transactionFieldsSchema, { ...expense, rate: 1.2 })).toBe(false);
  });

  test("rows carry the sync columns", () => {
    expect(ok(transactionRowSchema, { ...sync, ...expense })).toBe(true);
    expect(ok(transactionRowSchema, expense)).toBe(false);
    expect(ok(transactionRowSchema, { ...sync, id: "not-a-uuid", ...expense })).toBe(false);
    expect(ok(transactionRowSchema, { ...sync, hlc: "1762250000000:3:a", ...expense })).toBe(false);
    expect(ok(transactionRowSchema, { ...sync, device: "", ...expense })).toBe(false);
  });

  test("row invariants apply to live rows too", () => {
    expect(ok(transactionRowSchema, { ...sync, ...expense, original_amount: 12000 })).toBe(false);
  });

  test("a tombstone row is the sync columns alone", () => {
    expect(ok(transactionRowSchema, { ...sync, deleted: true })).toBe(true);
    expect(ok(transactionRowSchema, { ...sync, deleted: false })).toBe(false);
    expect(ok(transactionRowSchema, { ...sync, deleted: true, ...expense })).toBe(false);
  });
});

describe("categories", () => {
  test("category rows: type, name, sort, archived", () => {
    const row = { ...sync, type: "income", name: "Salary", sort: 0, archived: false };
    expect(ok(categoryRowSchema, row)).toBe(true);
    expect(ok(categoryRowSchema, { ...row, type: "transfer" })).toBe(false);
    expect(ok(categoryRowSchema, { ...row, name: "" })).toBe(false);
    expect(ok(categoryRowSchema, { ...row, sort: 1.5 })).toBe(false);
    const { type: _, ...untyped } = row;
    expect(ok(categoryRowSchema, untyped)).toBe(false);
    expect(ok(categoryRowSchema, { ...sync, deleted: true })).toBe(true);
  });
});

describe("settings", () => {
  const dashboard = {
    period: "month",
    compare: "same_period_last_year",
    exclude: { categories: ["Medical"], tags: ["Istanbul 2026"] },
  };

  test("one row per key, each value checked against its key", () => {
    const cases: [string, unknown, boolean][] = [
      ["currency", "DZD", true],
      ["currency", "dzd", false],
      ["decimals", 0, true],
      ["decimals", 2, true],
      ["decimals", 3, false],
      ["locale", "en", true],
      ["locale", "pt-BR", true],
      ["locale", "", false],
      ["theme", "system", true],
      ["theme", "dark", true],
      ["theme", "sepia", false],
      ["dashboard", dashboard, true],
      ["dashboard", { ...dashboard, period: "week" }, false],
      ["dashboard", { ...dashboard, compare: "yesterday" }, false],
      ["dashboard", { ...dashboard, extra: 1 }, false],
      ["unknown", "x", false],
    ];
    for (const [key, value, valid] of cases) {
      expect([key, value, ok(settingFieldsSchema, { key, value })]).toEqual([key, value, valid]);
    }
  });

  test("dashboard exclusions default to empty lists", () => {
    const parsed = v.parse(settingFieldsSchema, {
      key: "dashboard",
      value: { period: "year", compare: "none" },
    });
    expect(parsed.value).toEqual({
      period: "year",
      compare: "none",
      exclude: { categories: [], tags: [] },
    });
  });

  test("a setting row's id is the fixed id of its key", () => {
    const row = { ...sync, id: SETTING_IDS.currency, key: "currency", value: "EUR" };
    expect(ok(settingRowSchema, row)).toBe(true);
    expect(ok(settingRowSchema, { ...row, id: SETTING_IDS.theme })).toBe(false);
    expect(ok(settingRowSchema, { ...row, id: ID })).toBe(false);
    expect(ok(settingRowSchema, { ...sync, id: SETTING_IDS.theme, deleted: true })).toBe(true);
  });

  test("setting ids are distinct UUIDs", () => {
    const ids = Object.values(SETTING_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(ok(v.pipe(v.string(), v.uuid()), id)).toBe(true);
  });
});

describe("chart configs", () => {
  const minimal = { kind: "bar", metric: "expenses", groupBy: "category", period: "dashboard" };

  test("fills the documented defaults", () => {
    expect(v.parse(chartConfigSchema, minimal)).toEqual({
      ...minimal,
      compare: "none",
      cumulative: false,
      onlyTags: [],
      exclude: { categories: [], tags: [] },
      useDashboardExclusions: true,
    } as never);
  });

  test("default objects are fresh on every parse", () => {
    const a = v.parse(chartConfigSchema, minimal);
    const b = v.parse(chartConfigSchema, minimal);
    expect(a.exclude).not.toBe(b.exclude);
    expect(a.onlyTags).not.toBe(b.onlyTags);
  });

  test("accepts every documented enum value", () => {
    const values = {
      kind: ["bar", "line", "doughnut", "table"],
      metric: ["expenses", "income", "difference", "kept_ratio", "count"],
      groupBy: ["day", "month", "year", "weekday", "category", "detail", "tag"],
      period: ["dashboard", "last_12_months", "this_year", "all_time"],
      compare: ["none", "previous_period", "same_period_last_year", "avg_12_months"],
    };
    for (const [field, options] of Object.entries(values)) {
      for (const option of options) {
        expect([field, option, ok(chartConfigSchema, { ...minimal, [field]: option })]).toEqual([
          field,
          option,
          true,
        ]);
      }
      expect(ok(chartConfigSchema, { ...minimal, [field]: "nope" })).toBe(false);
    }
  });

  test("required fields, limit, tags and unknown fields", () => {
    const { kind: _kind, ...withoutKind } = minimal;
    expect(ok(chartConfigSchema, withoutKind)).toBe(false);
    expect(ok(chartConfigSchema, { ...minimal, limit: 5 })).toBe(true);
    expect(ok(chartConfigSchema, { ...minimal, limit: 0 })).toBe(false);
    expect(ok(chartConfigSchema, { ...minimal, limit: 2.5 })).toBe(false);
    expect(ok(chartConfigSchema, { ...minimal, onlyTags: ["Istanbul 2026"] })).toBe(true);
    expect(ok(chartConfigSchema, { ...minimal, onlyTags: ["a;b"] })).toBe(false);
    expect(ok(chartConfigSchema, { ...minimal, exclude: { tags: ["x;y"] } })).toBe(false);
    expect(
      ok(chartConfigSchema, { ...minimal, exclude: { categories: ["Medical"], other: [] } }),
    ).toBe(false);
    expect(ok(chartConfigSchema, { ...minimal, stacked: true })).toBe(false);
  });

  test("chart_configs rows hold name, sort and config", () => {
    const row = { ...sync, name: "Trip", sort: 0, config: minimal };
    expect(ok(chartConfigRowSchema, row)).toBe(true);
    expect(ok(chartConfigRowSchema, { ...row, config: { ...minimal, kind: "pie" } })).toBe(false);
    expect(ok(chartConfigRowSchema, { ...row, name: "" })).toBe(false);
  });
});

describe("envelopes", () => {
  const blob = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  const live = { table: "transactions", id: ID, hlc: HLC, deleted: false, device: "a1b2c3", blob };
  const dead = { table: "transactions", id: ID, hlc: HLC, deleted: true, device: "a1b2c3" };

  test("a live envelope carries a base64 blob; seq is optional", () => {
    expect(ok(envelopeSchema, live)).toBe(true);
    expect(ok(envelopeSchema, { ...live, seq: 42 })).toBe(true);
    expect(ok(envelopeSchema, { ...live, blob: undefined })).toBe(false);
    const { blob: _blob, ...noBlob } = live;
    expect(ok(envelopeSchema, noBlob)).toBe(false);
    expect(ok(envelopeSchema, { ...live, blob: "not base64!" })).toBe(false);
    expect(ok(envelopeSchema, { ...live, blob: "" })).toBe(false);
  });

  test("a blob is at most BLOB_MAX_LENGTH characters", () => {
    expect(BLOB_MAX_LENGTH).toBe(65_536);
    expect(ok(envelopeSchema, { ...live, blob: "A".repeat(BLOB_MAX_LENGTH) })).toBe(true);
    expect(ok(envelopeSchema, { ...live, blob: "A".repeat(BLOB_MAX_LENGTH + 4) })).toBe(false);
  });

  test("a tombstone carries no blob", () => {
    expect(ok(envelopeSchema, dead)).toBe(true);
    expect(ok(envelopeSchema, { ...dead, blob })).toBe(false);
  });

  test("table, id, hlc, device and seq are checked; unknown fields rejected", () => {
    expect(ok(envelopeSchema, { ...live, table: "devices" })).toBe(false);
    expect(ok(envelopeSchema, { ...live, id: "x" })).toBe(false);
    expect(ok(envelopeSchema, { ...live, hlc: "today" })).toBe(false);
    expect(ok(envelopeSchema, { ...live, device: "a:b" })).toBe(false);
    expect(ok(envelopeSchema, { ...live, seq: -1 })).toBe(false);
    expect(ok(envelopeSchema, { ...live, seq: 1.5 })).toBe(false);
    expect(ok(envelopeSchema, { ...live, amount: 100 })).toBe(false);
  });

  test("every synced table is a valid envelope table", () => {
    for (const table of SYNCED_TABLES) expect(ok(envelopeSchema, { ...live, table })).toBe(true);
  });
});

describe("API payloads", () => {
  const live = {
    table: "categories",
    id: ID,
    hlc: HLC,
    deleted: false,
    device: "a1b2c3",
    blob: "AAEC",
  };

  test("GET /health response", () => {
    expect(ok(healthResponseSchema, { serverId: "s1", version: "0.1.0", serverTime: 1 })).toBe(
      true,
    );
    expect(ok(healthResponseSchema, { serverId: "s1", version: "0.1.0" })).toBe(false);
  });

  test("POST /setup", () => {
    expect(ok(setupRequestSchema, { secret: "s3cret", deviceName: "Pixel" })).toBe(true);
    expect(ok(setupRequestSchema, { secret: "", deviceName: "Pixel" })).toBe(false);
    expect(ok(setupRequestSchema, { secret: "s3cret", deviceName: "" })).toBe(false);
    expect(ok(setupRequestSchema, { secret: "s", deviceName: "P", admin: true })).toBe(false);
    expect(ok(setupResponseSchema, { token: "t0k", serverId: "s1" })).toBe(true);
    expect(ok(setupResponseSchema, { token: "t0k" })).toBe(false);
  });

  test("POST /devices/invite and /devices/pair", () => {
    expect(ok(inviteResponseSchema, { code: "abc", expiresAt: 1762250600000 })).toBe(true);
    expect(ok(inviteResponseSchema, { code: "", expiresAt: 1 })).toBe(false);
    expect(ok(pairRequestSchema, { code: "abc", deviceName: "Laptop" })).toBe(true);
    expect(ok(pairRequestSchema, { code: "abc" })).toBe(false);
    expect(ok(pairResponseSchema, { token: "t0k", serverId: "s1" })).toBe(true);
  });

  test("POST /sync/push takes at most 500 envelopes", () => {
    expect(PUSH_MAX).toBe(500);
    expect(ok(pushRequestSchema, { envelopes: [] })).toBe(true);
    expect(ok(pushRequestSchema, { envelopes: Array(500).fill(live) })).toBe(true);
    expect(ok(pushRequestSchema, { envelopes: Array(501).fill(live) })).toBe(false);
    expect(ok(pushRequestSchema, { envelopes: [{ ...live, blob: undefined }] })).toBe(false);
    expect(ok(pushRequestSchema, { envelopes: [], force: true })).toBe(false);
    expect(ok(pushResponseSchema, { accepted: 3, ignored: 1 })).toBe(true);
    expect(ok(pushResponseSchema, { accepted: -1, ignored: 1 })).toBe(false);
  });

  test("GET /sync/pull query parses strings, limit defaults to 500", () => {
    expect(PULL_LIMIT).toBe(500);
    expect(v.parse(pullQuerySchema, { since: "0" })).toEqual({ since: 0, limit: 500 });
    expect(v.parse(pullQuerySchema, { since: "1234", limit: "50" })).toEqual({
      since: 1234,
      limit: 50,
    });
    for (const query of [
      {},
      { since: "-1" },
      { since: "1.5" },
      { since: "abc" },
      { since: "" },
      { since: "0", limit: "0" },
      { since: "0", limit: "501" },
      { since: "0", cursor: "x" },
    ]) {
      expect([query, ok(pullQuerySchema, query)]).toEqual([query, false]);
    }
  });

  test("GET /sync/pull response", () => {
    const page = {
      envelopes: [{ ...live, seq: 7 }],
      nextSeq: 7,
      hasMore: false,
      resetRequired: false,
    };
    expect(ok(pullResponseSchema, page)).toBe(true);
    expect(ok(pullResponseSchema, { ...page, hasMore: undefined })).toBe(false);
    expect(ok(pullResponseSchema, { ...page, nextSeq: -1 })).toBe(false);
  });

  test("push bodies are capped at PUSH_MAX_BYTES", () => {
    expect(PUSH_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  test("GET /devices lists devices with the caller marked current", () => {
    const device = {
      id: ID,
      name: "Pixel",
      createdAt: 1,
      lastSeen: null,
      revoked: false,
      current: true,
    };
    expect(ok(deviceListResponseSchema, { devices: [device] })).toBe(true);
    expect(ok(deviceListResponseSchema, { devices: [{ ...device, lastSeen: 5 }] })).toBe(true);
    expect(ok(deviceListResponseSchema, { devices: [{ ...device, current: undefined }] })).toBe(
      false,
    );
    expect(ok(deviceSchema, { ...device, tokenHash: "ab" })).toBe(false);
  });

  test("PATCH /devices/:id and POST /devices/:id/revoke", () => {
    expect(ok(renameDeviceRequestSchema, { name: "Laptop" })).toBe(true);
    expect(ok(renameDeviceRequestSchema, { name: "" })).toBe(false);
    expect(ok(renameDeviceRequestSchema, { name: "x".repeat(101) })).toBe(false);
    expect(ok(renameDeviceRequestSchema, { name: "L", revoked: true })).toBe(false);
    expect(ok(revokeDeviceRequestSchema, {})).toBe(true);
    expect(ok(revokeDeviceRequestSchema, { confirmSelf: true })).toBe(true);
    expect(ok(revokeDeviceRequestSchema, { confirmSelf: false })).toBe(false);
  });

  test("error responses", () => {
    expect(ok(errorResponseSchema, { error: { code: "not_found", message: "Not found" } })).toBe(
      true,
    );
    expect(ok(errorResponseSchema, { error: { code: "x" } })).toBe(false);
  });
});

describe("table registries", () => {
  test("every synced table has a fields schema and a row schema", () => {
    expect([...SYNCED_TABLES]).toEqual(["transactions", "categories", "settings", "chart_configs"]);
    for (const table of SYNCED_TABLES) {
      expect(fieldSchemas[table]).toBeDefined();
      expect(rowSchemas[table]).toBeDefined();
      expect(ok(rowSchemas[table], { ...sync, deleted: true })).toBe(true);
    }
  });
});
