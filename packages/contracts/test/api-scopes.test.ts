import { expect, test } from "vitest";
import { API_SCOPES, createApiKeyInputSchema } from "../src/index";

test("API_SCOPES includes required scopes", () => {
  expect(API_SCOPES).toContain("ideas:write");
  expect(API_SCOPES).toContain("drafts:write");
});

test("createApiKeyInputSchema requires at least one scope", () => {
  expect(
    createApiKeyInputSchema.safeParse({ name: "Test Key", scopes: [] }).success,
  ).toBe(false);

  expect(
    createApiKeyInputSchema.safeParse({ name: "Test Key", scopes: ["ideas:write"] }).success,
  ).toBe(true);
});
