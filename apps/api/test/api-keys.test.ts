import { test, expect, beforeAll } from "vitest";
import { createTestDb } from "./helpers";
import type { Db } from "../src/db";
import { workspaces } from "../src/db/schema";
import { createApiKey, verifyApiKey, listApiKeys, revokeApiKey } from "../src/services/api-keys";

let db: Db;
let WS = "test-ws-api-keys";

beforeAll(() => {
  db = createTestDb();
  db.insert(workspaces).values({
    id: WS,
    name: "API Keys Workspace",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).run();
});

test("api keys lifecycle", () => {
  // 1. Create a key
  const { rawKey, apiKey } = createApiKey(db, WS, {
    name: "My First Key",
    scopes: ["ideas:write", "drafts:read"],
  });

  expect(rawKey.startsWith("tzk_")).toBe(true);
  expect(apiKey.workspaceId).toBe(WS);
  expect(apiKey.name).toBe("My First Key");

  // 2. Verify it
  const verified = verifyApiKey(db, rawKey);
  expect(verified).not.toBeNull();
  expect(verified!.workspaceId).toBe(WS);
  expect(verified!.scopes).toEqual(["ideas:write", "drafts:read"]);

  // Verify invalid key
  const invalid = verifyApiKey(db, "tzk_invalidkey123");
  expect(invalid).toBeNull();

  // 3. List keys
  const list = listApiKeys(db, WS);
  expect(list.length).toBe(1);
  expect(list[0]!.id).toBe(apiKey.id);
  expect(list[0]!.name).toBe("My First Key");
  expect(list[0]!.scopes).toEqual(["ideas:write", "drafts:read"]);
  expect(list[0]!.lastUsedAt).toBeGreaterThan(0);

  // 4. Revoke key
  revokeApiKey(db, WS, apiKey.id);

  // 5. Verify revoked key fails
  const verifiedAfterRevoke = verifyApiKey(db, rawKey);
  expect(verifiedAfterRevoke).toBeNull();

  // 6. List shouldn't include revoked
  const listAfterRevoke = listApiKeys(db, WS);
  expect(listAfterRevoke.length).toBe(0);
});
