import { describe, expect, test } from "bun:test";
import { resolveTheme } from "../src/theme";

describe("resolveTheme", () => {
  test("light and dark are fixed", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("system follows the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});
