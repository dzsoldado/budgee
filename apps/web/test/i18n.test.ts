import { describe, expect, test } from "bun:test";
import en from "../src/i18n/en.json";
import { formatPlainDate } from "../src/i18n/format";
import { createTranslator } from "../src/i18n/translator";

const dict = { "nav.list": "List", "greet.named": "Hello {name}, {count} new" };

describe("t", () => {
  test("returns the dictionary text", () => {
    expect(createTranslator(dict)("nav.list")).toBe("List");
  });

  test("interpolates {name} params, leaving unknown ones as written", () => {
    const t = createTranslator(dict);
    expect(t("greet.named", { name: "Ada", count: 3 })).toBe("Hello Ada, 3 new");
    expect(t("greet.named", { name: "Ada" })).toBe("Hello Ada, {count} new");
  });

  test("a missing key returns the key and warns once", () => {
    const warnings: string[] = [];
    const t = createTranslator<string>(dict, { warn: (m) => warnings.push(m) });
    expect(t("nope.missing")).toBe("nope.missing");
    expect(t("nope.missing")).toBe("nope.missing");
    expect(warnings).toEqual(['Missing translation: "nope.missing"']);
  });

  test("without a warn function, a missing key is silent", () => {
    expect(createTranslator<string>(dict)("x.y")).toBe("x.y");
  });
});

describe("en.json", () => {
  test("uses flat dotted keys with non-empty strings", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
      expect(typeof value).toBe("string");
      expect(value.trim()).not.toBe("");
    }
  });
});

describe("formatPlainDate", () => {
  test("formats a YYYY-MM-DD date as that calendar day, whatever the time zone", () => {
    expect(
      formatPlainDate("2026-11-17", "en", { weekday: "short", day: "numeric", month: "short" }),
    ).toBe("Tue, Nov 17");
    expect(formatPlainDate("2026-01-01", "en", { month: "long", year: "numeric" })).toBe(
      "January 2026",
    );
  });
});
