import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  campaigns,
  discoveredItemMatches,
  discoveredItems,
  discoverySources,
  personas,
  workspaces,
  type DiscoveredItemRow,
} from "../src/db/schema";
import { getDiscoveredItem } from "../src/services/discovery";
import {
  deleteDiscoverySourcePreservingDuplicates,
  repairDanglingDuplicateGroups,
} from "../src/services/discovery-dedupe";
import { createTestDb } from "./helpers";

async function fixture() {
  const db = await createTestDb();
  const workspaceId = "workspace-dedupe";
  await db.insert(workspaces)
    .values({
      id: workspaceId,
      name: "Dedupe",
      createdAt: 1,
      updatedAt: 1,
    });

  async function source(id: string) {
    await db.insert(discoverySources)
      .values({
        id,
        workspaceId,
        type: "rss",
        name: id,
        configJson: JSON.stringify({ feedUrl: `https://${id}.test/rss` }),
        enabled: true,
        status: "active",
        cursorJson: "{}",
        executionVersion: 1,
        createdAt: 1,
      });
  }

  async function item(
    id: string,
    sourceId: string,
    overrides: Partial<DiscoveredItemRow> = {},
  ) {
    await db.insert(discoveredItems)
      .values({
        id,
        workspaceId,
        sourceId,
        externalId: `${id}-provider`,
        title: `${id} title`,
        url: `https://example.test/${id}`,
        summary: `${id} summary`,
        publishedAt: null,
        score: null,
        suggestedPersonaId: null,
        suggestedCampaignId: null,
        scoreReason: null,
        status: "new",
        signalId: null,
        scoredAt: null,
        matchingState: "pending",
        matchingVersion: 0,
        matchingInputFingerprint: null,
        matchingLeaseOwner: null,
        matchingLeaseExpiresAt: null,
        matchingHeartbeatAt: null,
        matchingError: null,
        urlHash: `${id}-url-hash`,
        contentHash: `${id}-content-hash`,
        duplicateOfId: null,
        createdAt: 1,
        ...overrides,
      });
  }

  await source("source-a");
  await source("source-b");
  await source("source-c");
  return { db, workspaceId, source, item };
}

async function canonicalGroup() {
  const f = await fixture();
  const signalId = "signal-canonical";
  await f.item("canonical", "source-a", {
    externalId: "canonical-provider-id",
    title: "Canonical title",
    url: "https://canonical.test/story",
    summary: "Canonical summary",
    publishedAt: 99,
    score: 91,
    suggestedPersonaId: "persona-canonical",
    suggestedCampaignId: "campaign-canonical",
    scoreReason: "Canonical score reason",
    status: "accepted",
    signalId,
    scoredAt: 100,
    matchingState: "frozen",
    matchingVersion: 7,
    matchingInputFingerprint: "fingerprint-canonical",
    matchingLeaseOwner: "stale-worker",
    matchingLeaseExpiresAt: 999,
    matchingHeartbeatAt: 998,
    matchingError: "stale-error",
    createdAt: 10,
  });
  await f.item("survivor-oldest", "source-b", {
    externalId: "survivor-provider-id",
    duplicateOfId: "canonical",
    status: "duplicate",
    matchingState: "frozen",
    createdAt: 20,
  });
  await f.item("survivor-newer", "source-c", {
    duplicateOfId: "canonical",
    status: "duplicate",
    matchingState: "frozen",
    createdAt: 30,
  });
  await dbMatches(f, "match-a", "canonical", 80);
  await dbMatches(f, "match-b", "canonical", 70);
  await dbMatches(f, "stale-survivor-match", "survivor-oldest", 1);
  return { ...f, signalId };
}

async function dbMatches(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  itemId: string,
  score: number,
) {
  await f.db.insert(discoveredItemMatches)
    .values({
      id,
      workspaceId: f.workspaceId,
      itemId,
      personaId: null,
      campaignId: null,
      score,
      reason: id,
      createdAt: 1,
    });
}

describe("discovery dedupe source deletion", () => {
  it("promotes the oldest surviving occurrence without changing its identity", async () => {
    const f = await canonicalGroup();

    expect(
      await deleteDiscoverySourcePreservingDuplicates(
        f.db,
        f.workspaceId,
        "source-a",
      ),
    ).toBe(true);

    const promoted = ((await f.db
      .select()
      .from(discoveredItems)
      .where(eq(discoveredItems.id, "survivor-oldest")))[0])!;
    expect(promoted).toMatchObject({
      id: "survivor-oldest",
      workspaceId: f.workspaceId,
      sourceId: "source-b",
      externalId: "survivor-provider-id",
      urlHash: "survivor-oldest-url-hash",
      contentHash: "survivor-oldest-content-hash",
      createdAt: 20,
      title: "Canonical title",
      url: "https://canonical.test/story",
      summary: "Canonical summary",
      publishedAt: 99,
      score: 91,
      scoreReason: "Canonical score reason",
      status: "accepted",
      signalId: f.signalId,
      duplicateOfId: null,
      matchingState: "frozen",
      matchingVersion: 7,
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
    });
    expect(
      (await f.db
        .select()
        .from(discoveredItemMatches))
        .map((row) => row.itemId)
        .sort(),
    ).toEqual(["survivor-oldest", "survivor-oldest"]);
    expect(
      ((await f.db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, "survivor-newer")))[0])!.duplicateOfId,
    ).toBe("survivor-oldest");
  });

  // Sprint 53: the collapse no longer copies the legacy routing columns — it
  // moves the match rows, and routing is projected from those.
  it("carries routing across a collapse through the moved match rows", async () => {
    const f = await canonicalGroup();
    await f.db
      .insert(personas)
      .values({
        id: "persona-live",
        workspaceId: f.workspaceId,
        name: "Field CTO",
        createdAt: 1,
        updatedAt: 1,
      });
    await f.db
      .insert(campaigns)
      .values({
        id: "campaign-live",
        workspaceId: f.workspaceId,
        name: "Launch",
        createdAt: 1,
        updatedAt: 1,
      });
    await f.db
      .update(discoveredItemMatches)
      .set({ personaId: "persona-live", campaignId: "campaign-live" })
      .where(eq(discoveredItemMatches.id, "match-a"));
    // the legacy columns are already gone (as Task 7's migration will leave them)
    await f.db
      .update(discoveredItems)
      .set({ suggestedPersonaId: null, suggestedCampaignId: null })
      .where(eq(discoveredItems.id, "canonical"));

    expect(
      await deleteDiscoverySourcePreservingDuplicates(f.db, f.workspaceId, "source-a"),
    ).toBe(true);

    const promoted = (await getDiscoveredItem(f.db, f.workspaceId, "survivor-oldest"))!;
    expect(promoted.matches[0]).toMatchObject({
      personaId: "persona-live",
      campaignId: "campaign-live",
      score: 80,
    });
    expect(promoted.suggestedPersonaId).toBe("persona-live");
    expect(promoted.suggestedCampaignId).toBe("campaign-live");
    expect(
      ((await f.db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, "survivor-oldest")))[0])!.suggestedPersonaId,
    ).toBeNull();
  });

  it("rolls back promotion and repointing when source deletion faults", async () => {
    const f = await canonicalGroup();
    const before = {
      sources: await f.db.select().from(discoverySources),
      items: await f.db.select().from(discoveredItems),
      matches: await f.db.select().from(discoveredItemMatches),
    };

    expect(async () =>
      await deleteDiscoverySourcePreservingDuplicates(
        f.db,
        f.workspaceId,
        "source-a",
        {
          beforeSourceDelete() {
            throw new Error("delete fault");
          },
        },
      ),
    ).toThrow("delete fault");

    expect(await f.db.select().from(discoverySources)).toEqual(
      before.sources,
    );
    expect(await f.db.select().from(discoveredItems)).toEqual(before.items);
    expect(await f.db.select().from(discoveredItemMatches)).toEqual(
      before.matches,
    );
  });

  it("deleting a duplicate-only source leaves the canonical group intact", async () => {
    const f = await canonicalGroup();

    expect(
      await deleteDiscoverySourcePreservingDuplicates(
        f.db,
        f.workspaceId,
        "source-c",
      ),
    ).toBe(true);
    expect(
      (await f.db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, "canonical")))[0],
    ).toBeDefined();
    expect(
      ((await f.db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, "survivor-oldest")))[0])!.duplicateOfId,
    ).toBe("canonical");
  });

  it("normally removes a canonical that has no surviving occurrence", async () => {
    const f = await fixture();
    await f.item("only-item", "source-a");

    expect(
      await deleteDiscoverySourcePreservingDuplicates(
        f.db,
        f.workspaceId,
        "source-a",
      ),
    ).toBe(true);
    expect(
      (await f.db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, "only-item")))[0],
    ).toBeUndefined();
  });
});

describe("legacy dangling duplicate repair", () => {
  it("promotes deterministically, clears scoring state, and is idempotent", async () => {
    const f = await fixture();
    await f.item("dangling-oldest", "source-b", {
      duplicateOfId: "missing-canonical",
      status: "duplicate",
      score: 75,
      signalId: "stale-signal",
      matchingState: "leased",
      matchingVersion: 4,
      matchingInputFingerprint: "stale-fingerprint",
      matchingLeaseOwner: "worker",
      matchingLeaseExpiresAt: 999,
      matchingHeartbeatAt: 998,
      matchingError: "stale",
      createdAt: 20,
    });
    await f.item("dangling-newer", "source-c", {
      duplicateOfId: "missing-canonical",
      status: "duplicate",
      matchingState: "failed",
      matchingLeaseOwner: "worker",
      matchingLeaseExpiresAt: 999,
      matchingHeartbeatAt: 998,
      matchingError: "stale",
      createdAt: 30,
    });
    await dbMatches(f, "dangling-match", "dangling-newer", 50);

    expect(await repairDanglingDuplicateGroups(f.db)).toEqual({
      groups: 1,
      promoted: 1,
      repointed: 1,
    });
    expect(
      (await f.db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, "dangling-oldest")))[0],
    ).toMatchObject({
      status: "new",
      score: null,
      signalId: null,
      matchingState: "pending",
      matchingVersion: 5,
      matchingInputFingerprint: null,
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
      matchingError: null,
      duplicateOfId: null,
    });
    expect(
      (await f.db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, "dangling-newer")))[0],
    ).toMatchObject({
      status: "duplicate",
      matchingState: "frozen",
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
      matchingError: null,
      duplicateOfId: "dangling-oldest",
    });
    expect(await f.db.select().from(discoveredItemMatches)).toEqual([]);

    const stableRows = await f.db.select().from(discoveredItems);
    expect(await repairDanglingDuplicateGroups(f.db)).toEqual({
      groups: 0,
      promoted: 0,
      repointed: 0,
    });
    expect(await f.db.select().from(discoveredItems)).toEqual(stableRows);
  });
});
