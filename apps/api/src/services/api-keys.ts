import { randomBytes, createHash, randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { apiKeys, type ApiKeyRow } from "../db/schema";
import type { Db } from "../db";
import type { ApiScope, CreateApiKeyInput } from "@tuezday/contracts";

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export async function createApiKey(db: Db, workspaceId: string, input: CreateApiKeyInput): Promise<{ rawKey: string, apiKey: ApiKeyRow }> {
  const rawKey = "tzk_" + randomBytes(32).toString("base64url");
  const keyHash = hashKey(rawKey);
  const now = Date.now();

  const apiKey = (await db
    .insert(apiKeys)
    .values({
      id: randomUUID(),
      workspaceId,
      name: input.name,
      keyHash,
      scopesJson: JSON.stringify(input.scopes),
      createdAt: now,
    })
    .returning())[0]!;

  return { rawKey, apiKey };
}

export async function verifyApiKey(db: Db, rawKey: string): Promise<{ workspaceId: string, scopes: ApiScope[] } | null> {
  const keyHash = hashKey(rawKey);
  const now = Date.now();

  const apiKey = (await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt))))[0];

  if (!apiKey) return null;

  await db.update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, apiKey.id));

  return {
    workspaceId: apiKey.workspaceId,
    scopes: JSON.parse(apiKey.scopesJson) as ApiScope[],
  };
}

export async function listApiKeys(db: Db, workspaceId: string) {
  return (await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      scopes: apiKeys.scopesJson,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt))))
    .map((k) => ({
      ...k,
      scopes: JSON.parse(k.scopes) as ApiScope[],
    }));
}

export async function revokeApiKey(db: Db, workspaceId: string, id: string): Promise<void> {
  await db.update(apiKeys)
    .set({ revokedAt: Date.now() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId)));
}
