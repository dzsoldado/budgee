import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DecryptError, encryptRow, generateVaultKey } from "../src/crypto";
import { fromEnvelope, InvalidRowError, type RowOf, toEnvelope } from "../src/envelope";
import { envelopeSchema, type LiveTransaction, SETTING_IDS, type TableName } from "../src/schema";

const ID = "6f1c2c1e-6b8a-4f57-9d0c-3f7f2a1d9e01";
const OTHER_ID = "6f1c2c1e-6b8a-4f57-9d0c-3f7f2a1d9e02";
const HLC = "001762250000000:00003:a1b2c3";
const sync = { id: ID, hlc: HLC, deleted: false, device: "a1b2c3" } as const;

const transaction: LiveTransaction = {
  ...sync,
  type: "expense",
  amount: 1850000,
  date: "2026-11-14",
  category: "Home",
  detail: "IKEA · desk chair",
  note: "",
  tags: ["Office"],
  original_amount: 12000,
  original_currency: "EUR",
  created_at: "2026-11-14T10:00:00.000Z",
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("toEnvelope / fromEnvelope", () => {
  test("a live row round-trips through a valid envelope with only sync columns in the clear", async () => {
    const key = await generateVaultKey();
    const envelope = await toEnvelope(key, "transactions", transaction);
    expect(v.safeParse(envelopeSchema, envelope).success).toBe(true);
    expect(Object.keys(envelope).sort()).toEqual([
      "blob",
      "deleted",
      "device",
      "hlc",
      "id",
      "table",
    ]);
    expect(envelope).toMatchObject({
      table: "transactions",
      id: ID,
      hlc: HLC,
      deleted: false,
      device: "a1b2c3",
    });
    expect(JSON.stringify(envelope)).not.toContain("IKEA");
    expect(await fromEnvelope(key, envelope)).toEqual(transaction);
  });

  test("schema defaults are filled before encrypting", async () => {
    const key = await generateVaultKey();
    const { detail, note, tags, original_amount, original_currency, ...minimal } = transaction;
    const row = await fromEnvelope(key, await toEnvelope(key, "transactions", minimal));
    expect(row).toEqual({
      ...minimal,
      detail: "",
      note: "",
      tags: [],
      original_amount: null,
      original_currency: null,
    });
  });

  test("every table round-trips", async () => {
    const key = await generateVaultKey();
    const rows: { [T in Exclude<TableName, "transactions">]: RowOf<T> } = {
      categories: { ...sync, type: "income", name: "Salary", sort: 0, archived: false },
      settings: { ...sync, id: SETTING_IDS.currency, key: "currency", value: "DZD" },
      chart_configs: {
        ...sync,
        name: "Trip total",
        sort: 4,
        config: {
          kind: "doughnut",
          metric: "expenses",
          groupBy: "category",
          period: "all_time",
          compare: "none",
          cumulative: false,
          onlyTags: ["Istanbul 2026"],
          exclude: { categories: [], tags: [] },
          useDashboardExclusions: false,
        },
      },
    };
    for (const [table, row] of Object.entries(rows)) {
      const envelope = await toEnvelope(key, table as keyof typeof rows, row);
      expect(await fromEnvelope(key, envelope)).toEqual(row);
    }
  });

  test("tombstones carry no blob, in both directions, and need no decryption", async () => {
    const key = await generateVaultKey();
    const tombstone = { id: ID, hlc: HLC, deleted: true, device: "a1b2c3" } as const;
    const envelope = await toEnvelope(key, "transactions", tombstone);
    expect(envelope).toEqual({ table: "transactions", ...tombstone });
    expect("blob" in envelope).toBe(false);
    expect(await fromEnvelope(await generateVaultKey(), { ...envelope, seq: 7 })).toEqual(
      tombstone,
    );
  });

  test("fromEnvelope drops the server seq", async () => {
    const key = await generateVaultKey();
    const envelope = await toEnvelope(key, "transactions", transaction);
    expect(await fromEnvelope(key, { ...envelope, seq: 42 })).toEqual(transaction);
  });

  test("toEnvelope rejects an invalid row with InvalidRowError", async () => {
    const key = await generateVaultKey();
    const error = await rejection(
      toEnvelope(key, "transactions", { ...transaction, original_currency: null } as never),
    );
    expect(error).toBeInstanceOf(InvalidRowError);
    expect((error as InvalidRowError).table).toBe("transactions");
    expect((error as InvalidRowError).issues.length).toBeGreaterThan(0);
  });

  test("decrypt failures surface as DecryptError: wrong key, moved blob, other table", async () => {
    const key = await generateVaultKey();
    const envelope = await toEnvelope(key, "transactions", transaction);
    expect(await rejection(fromEnvelope(await generateVaultKey(), envelope))).toBeInstanceOf(
      DecryptError,
    );
    expect(await rejection(fromEnvelope(key, { ...envelope, id: OTHER_ID }))).toBeInstanceOf(
      DecryptError,
    );
    expect(await rejection(fromEnvelope(key, { ...envelope, table: "categories" }))).toBeInstanceOf(
      DecryptError,
    );
  });

  test("decrypted fields are validated against the table's field schema", async () => {
    const key = await generateVaultKey();
    const blob = await encryptRow(key, "categories", ID, HLC, {
      type: "expense",
      name: "",
      sort: 1,
      archived: false,
    });
    const envelope = {
      table: "categories",
      id: ID,
      hlc: HLC,
      deleted: false,
      device: "a1b2c3",
      blob,
    } as const;
    const error = await rejection(fromEnvelope(key, envelope));
    expect(error).toBeInstanceOf(InvalidRowError);
    expect(error).not.toBeInstanceOf(DecryptError);
  });

  test("decrypted fields may not smuggle sync columns or unknown fields", async () => {
    const key = await generateVaultKey();
    for (const extra of [{ deleted: true }, { id: OTHER_ID }, { color: "red" }]) {
      const blob = await encryptRow(key, "categories", ID, HLC, {
        type: "expense",
        name: "Transport",
        sort: 1,
        archived: false,
        ...extra,
      });
      const envelope = {
        table: "categories",
        id: ID,
        hlc: HLC,
        deleted: false,
        device: "a1b2c3",
        blob,
      } as const;
      expect(await rejection(fromEnvelope(key, envelope))).toBeInstanceOf(InvalidRowError);
    }
  });

  test("a settings row whose id does not match its key is rejected", async () => {
    const key = await generateVaultKey();
    const blob = await encryptRow(key, "settings", SETTING_IDS.theme, HLC, {
      key: "currency",
      value: "DZD",
    });
    const envelope = {
      table: "settings",
      id: SETTING_IDS.theme,
      hlc: HLC,
      deleted: false,
      device: "a1b2c3",
      blob,
    } as const;
    expect(await rejection(fromEnvelope(key, envelope))).toBeInstanceOf(InvalidRowError);
  });
});

describe("errors never carry row contents", () => {
  const SECRET = "SECRET-7f3a";

  /** Every way a caller might log or report the error. */
  function exposed(error: unknown): string {
    const own = Object.fromEntries(
      Object.getOwnPropertyNames(error).map((name) => [
        name,
        (error as Record<string, unknown>)[name],
      ]),
    );
    return [
      String(error),
      (error as Error).message,
      (error as Error).stack ?? "",
      JSON.stringify(error),
      JSON.stringify(own),
      Bun.inspect(error),
      Bun.inspect((error as Error).cause),
    ].join("\n");
  }

  async function invalidRow(table: TableName, fields: Record<string, unknown>) {
    const key = await generateVaultKey();
    const blob = await encryptRow(key, table, ID, HLC, fields);
    const envelope = { table, id: ID, hlc: HLC, deleted: false, device: "a1b2c3", blob } as const;
    const error = await rejection(fromEnvelope(key, envelope as never));
    expect(error).toBeInstanceOf(InvalidRowError);
    return error as InvalidRowError;
  }

  test("a decrypted bad field's value stays out of the error", async () => {
    const error = await invalidRow("categories", {
      type: "expense",
      name: "Transport",
      sort: SECRET,
      archived: false,
    });
    expect(exposed(error)).not.toContain(SECRET);
    expect(error.message).toBe("Invalid categories row: sort: invalid_type (expected number)");
    expect(error.issues).toEqual([
      { path: "sort", kind: "schema", type: "number", expected: "number" },
    ]);
  });

  test("a cross-field check, whose issue input is the whole row, stays out of the error", async () => {
    const { id, hlc, deleted, device, ...fields } = transaction;
    const error = await invalidRow("transactions", {
      ...fields,
      detail: SECRET,
      note: SECRET,
      original_currency: null,
    });
    expect(exposed(error)).not.toContain(SECRET);
    expect(exposed(error)).not.toContain("1850000");
    expect(error.message).toContain("original_currency: check");
  });

  test("an unknown field's name and value stay out of the error", async () => {
    const error = await invalidRow("categories", {
      type: "expense",
      name: "Transport",
      sort: 1,
      archived: false,
      [SECRET]: SECRET,
    });
    expect(exposed(error)).not.toContain(SECRET);
    expect(error.message).toBe("Invalid categories row: ?: invalid_type (expected never)");
  });

  test("toEnvelope errors don't carry row contents either", async () => {
    const key = await generateVaultKey();
    const error = await rejection(
      toEnvelope(key, "transactions", { ...transaction, note: SECRET, amount: -5 }),
    );
    expect(error).toBeInstanceOf(InvalidRowError);
    expect(exposed(error)).not.toContain(SECRET);
  });
});
