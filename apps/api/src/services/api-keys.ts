import { randomBytes, createHash, randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { apiKeys, type ApiKeyRow } from "../db/schema";
import type { Db } from "../db";
import type { ApiScope, CreateApiKeyInput } from "@tuezday/contracts";

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function createApiKey(db: Db, workspaceId: string, input: CreateApiKeyInput): { rawKey: string, apiKey: ApiKeyRow } {
  const rawKey = "tzk_" + randomBytes(32).toString("base64url");
  const keyHash = hashKey(rawKey);
  const now = Date.now();

  const apiKey = db
    .insert(apiKeys)
    .values({
      id: randomUUID(),
      workspaceId,
      name: input.name,
      keyHash,
      scopesJson: JSON.stringify(input.scopes),
      createdAt: now,
    })
    .returning()
    .get();

  return { rawKey, apiKey };
}

export function verifyApiKey(db: Db, rawKey: string): { workspaceId: string, scopes: ApiScope[] } | null {
  const keyHash = hashKey(rawKey);
  const now = Date.now();

  const apiKey = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .get();

  if (!apiKey) return null;

  db.update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, apiKey.id))
    .run();

  return {
    workspaceId: apiKey.workspaceId,
    scopes: JSON.parse(apiKey.scopesJson) as ApiScope[],
  };
}

export function listApiKeys(db: Db, workspaceId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      scopes: apiKeys.scopesJson,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
    .all()
    .map((k) => ({
      ...k,
      scopes: JSON.parse(k.scopes) as ApiScope[],
    }));
}

export function revokeApiKey(db: Db, workspaceId: string, id: string): void {
  db.update(apiKeys)
    .set({ revokedAt: Date.now() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId)))
    .run();
}
