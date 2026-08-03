import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import {
  campaigns,
  discoveredItemMatches,
  discoveredItems,
  discoverySources,
  personas,
  workspaces,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  claimMatchingBatch,
  runMatchingBatch,
} from "../src/services/discovery-matching";
import { getDiscoveredItem } from "../src/services/discovery";
import { createTestDb } from "./helpers";

const srcDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Sprint 53 (D3b): `suggestedPersonaId` / `suggestedCampaignId` are derived in
 * memory from the top-scoring match (`projectSuggestedRouting`). These two files
 * are the only places a non-null value may legitimately appear against those
 * names: the column declaration, and the projection helper itself.
 */
const NON_NULL_ALLOWED = new Set([
  path.join("db", "schema.ts"),
  path.join("services", "matching.ts"),
]);

describe("the legacy suggested_* columns have no writers (Sprint 53)", () => {
  it("never assigns a non-null value to suggestedPersonaId / suggestedCampaignId", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const relative = path.relative(srcDir, file);
      if (NON_NULL_ALLOWED.has(relative)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const match = /\bsuggested(?:Persona|Campaign)Id\s*:\s*(.+)$/.exec(
            line,
          );
          if (!match) return;
          if (match[1]!.trim() === "null,") return;
          offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("mentions the raw column names nowhere but the schema", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const relative = path.relative(srcDir, file);
      if (relative === path.join("db", "schema.ts")) continue;
      if (/suggested_(?:persona|campaign)_id/.test(readFileSync(file, "utf8"))) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const PERSONA_ID = "44444444-4444-4444-8444-444444444444";
const CAMPAIGN_ID = "55555555-5555-4555-8555-555555555555";

function seedScorableItem(db: Db): void {
  db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Matching", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(personas)
    .values({
      id: PERSONA_ID,
      workspaceId: WORKSPACE_ID,
      name: "Field CTO",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(campaigns)
    .values({
      id: CAMPAIGN_ID,
      workspaceId: WORKSPACE_ID,
      name: "Product Launch",
      personaIdsJson: JSON.stringify([PERSONA_ID]),
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(discoverySources)
    .values({
      id: SOURCE_ID,
      workspaceId: WORKSPACE_ID,
      type: "rss",
      name: "Source",
      configJson: "{}",
      enabled: true,
      status: "active",
      lastError: null,
      lastFetchedAt: null,
      connectionId: null,
      cursorJson: "{}",
      backoffUntil: null,
      lastAttemptedAt: null,
      executionVersion: 1,
      createdAt: 1,
    })
    .run();
  db.insert(discoveredItems)
    .values({
      id: ITEM_ID,
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID,
      externalId: ITEM_ID,
      title: "A relevant item",
      url: "https://example.com/item",
      summary: "Summary",
      publishedAt: 1,
      score: null,
      suggestedPersonaId: null,
      suggestedCampaignId: null,
      scoreReason: null,
      status: "new",
      signalId: null,
      scoredAt: null,
      urlHash: null,
      contentHash: "content",
      duplicateOfId: null,
      matchingState: "pending",
      matchingVersion: 0,
      matchingInputFingerprint: null,
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
      matchingError: null,
      createdAt: 1,
    })
    .run();
}

describe("scoring an item (Sprint 53)", () => {
  it("writes the match rows and the score reason, but leaves the legacy columns null", async () => {
    const db = createTestDb();
    seedScorableItem(db);
    const llm: LlmGateway = {
      async generate() {
        return {
          text: JSON.stringify([
            {
              index: 0,
              score: 88,
              matches: [
                {
                  personaId: PERSONA_ID,
                  campaignId: CAMPAIGN_ID,
                  score: 90,
                  reason: "Fits the launch.",
                },
              ],
            },
          ]),
          model: "fake",
          provider: "fake",
          durationMs: 1,
        };
      },
    };
    const claims = claimMatchingBatch(db, {
      workspaceId: WORKSPACE_ID,
      owner: "owner-a",
      limit: 5,
      leaseMs: 60_000,
    });
    expect(claims).toHaveLength(1);

    const result = await runMatchingBatch(
      { db, llm, leaseMs: 60_000, heartbeatMs: 30_000 },
      claims,
      new AbortController().signal,
    );
    expect(result.ready).toBe(1);

    // The stored row keeps the real scoring output …
    const row = db
      .select()
      .from(discoveredItems)
      .where(eq(discoveredItems.id, ITEM_ID))
      .get()!;
    expect(row.score).toBe(88);
    expect(row.scoreReason).toBe("Fits the launch.");
    expect(row.matchingState).toBe("ready");
    // … and nothing in the legacy mapping.
    expect(row.suggestedPersonaId).toBeNull();
    expect(row.suggestedCampaignId).toBeNull();

    // The match row is where routing actually lives now.
    expect(
      db
        .select()
        .from(discoveredItemMatches)
        .where(eq(discoveredItemMatches.itemId, ITEM_ID))
        .all(),
    ).toHaveLength(1);

    // And the read path still projects it for the UI.
    const item = getDiscoveredItem(db, WORKSPACE_ID, ITEM_ID)!;
    expect(item.suggestedPersonaId).toBe(PERSONA_ID);
    expect(item.suggestedCampaignId).toBe(CAMPAIGN_ID);
  });
});
