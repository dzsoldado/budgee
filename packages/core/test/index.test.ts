import { expect, test } from "bun:test";
import { API_BASE } from "../src/index";

test("API_BASE is the versioned API prefix", () => {
  expect(API_BASE).toBe("/api/v1");
});
