import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type {
  CampaignStatus,
  UpsertCampaignInput,
  UpsertPersonaInput,
} from "@tuezday/contracts";
import type { Db } from "../src/db";
import {
  campaigns,
  discoveredItemMatches,
  discoveredItems,
  discoverySources,
  personas,
  workspaces,
} from "../src/db/schema";
import * as campaignServices from "../src/services/campaigns";
import {
  createCampaign,
  setCampaignAutomation,
  updateCampaign,
} from "../src/services/campaigns";
import {
  claimMatchingBatch,
} from "../src/services/discovery-matching";
import {
  createPersona,
  deletePersona,
  updatePersona,
} from "../src/services/personas";
import { createTestDb } from "./helpers";

const personaInput = (
  name: string,
  overrides: Partial<UpsertPersonaInput> = {},
): UpsertPersonaInput => ({
  name,
  description: "",
  overlay: "",
  topics: [],
  tone: "",
  styleRules: "",
  avoid: "",
  ...overrides,
});

const campaignInput = (
  name: string,
  personaIds: string[],
  status: CampaignStatus = "active",
  overrides: Partial<UpsertCampaignInput> = {},
): UpsertCampaignInput => ({
  name,
  purpose: "initiative",
  objective: "",
  kpi: "",
  timeframe: "",
  audience: "",
  pillars: [],
  channels: [],
  personaIds,
  overlay: "",
  status,
  automationMode: "manual",
  autoDailyCap: null,
  ...overrides,
});

interface MatchingFixture {
  db: Db;
  workspaceId: string;
  persona: {
    edited: string;
    next: string;
    unrelated: string;
  };
  campaign: {
    edited: string;
    unrelated: string;
  };
  item: {
    persona: string;
    nextPersona: string;
    campaign: string;
    unrelated: string;
    zeroMatch: string;
    terminal: string;
    duplicate: string;
  };
}

async function seedFixture(
  input: { campaignStatus?: CampaignStatus } = {},
): Promise<MatchingFixture> {
  const db = await createTestDb();
  const workspaceId = randomUUID();
  const sourceId = randomUUID();
  await db.insert(workspaces)
    .values({
      id: workspaceId,
      name: "Targeted matching",
      createdAt: 1,
      updatedAt: 1,
    });
  await db.insert(discoverySources)
    .values({
      id: sourceId,
      workspaceId,
      type: "rss",
      name: "Fixture source",
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
    });

  const editedPersona = await createPersona(
    db,
    workspaceId,
    personaInput("Edited persona", {
      description: "Original semantic description",
      topics: ["original"],
    }),
  );
  const nextPersona = await createPersona(
    db,
    workspaceId,
    personaInput("Next persona"),
  );
  const unrelatedPersona = await createPersona(
    db,
    workspaceId,
    personaInput("Unrelated persona"),
  );
  const editedCampaign = await createCampaign(
    db,
    workspaceId,
    campaignInput(
      "Edited campaign",
      [editedPersona.id],
      input.campaignStatus ?? "active",
      { objective: "Original objective" },
    ),
  );
  const unrelatedCampaign = await createCampaign(
    db,
    workspaceId,
    campaignInput("Unrelated campaign", [unrelatedPersona.id]),
  );

  const insertItem = async (
    label: string,
    options: {
      status?: "new" | "accepted" | "duplicate";
      matchingState?: "ready" | "frozen";
      duplicateOfId?: string | null;
    } = {},
  ) => {
    const id = randomUUID();
    await db.insert(discoveredItems)
      .values({
        id,
        workspaceId,
        sourceId,
        externalId: id,
        title: label,
        url: `https://example.com/${id}`,
        summary: `${label} summary`,
        publishedAt: 1,
        score: 80,
        suggestedPersonaId: null,
        suggestedCampaignId: null,
        scoreReason: "Existing judgment",
        status: options.status ?? "new",
        signalId: null,
        scoredAt: 10,
        matchingState: options.matchingState ?? "ready",
        matchingVersion: 4,
        matchingInputFingerprint: "old-fingerprint",
        matchingLeaseOwner: null,
        matchingLeaseExpiresAt: null,
        matchingHeartbeatAt: null,
        matchingError: "old-error",
        urlHash: null,
        contentHash: `content-${id}`,
        duplicateOfId: options.duplicateOfId ?? null,
        createdAt: 1,
      });
    return id;
  };

  const personaItem = await insertItem("Edited persona match");
  const nextPersonaItem = await insertItem("Next persona match");
  const campaignItem = await insertItem("Edited campaign match");
  const unrelatedItem = await insertItem("Unrelated match");
  const zeroMatchItem = await insertItem("Zero match");
  const terminalItem = await insertItem("Accepted match", {
    status: "accepted",
    matchingState: "frozen",
  });
  const duplicateItem = await insertItem("Duplicate match", {
    status: "duplicate",
    matchingState: "frozen",
    duplicateOfId: zeroMatchItem,
  });

  const insertMatch = async (
    itemId: string,
    personaId: string | null,
    campaignId: string | null,
  ) => {
    await db.insert(discoveredItemMatches)
      .values({
        id: randomUUID(),
        workspaceId,
        itemId,
        personaId,
        campaignId,
        score: 80,
        reason: "Existing match",
        createdAt: 1,
      });
  };

  await insertMatch(personaItem, editedPersona.id, null);
  await insertMatch(nextPersonaItem, nextPersona.id, null);
  await insertMatch(campaignItem, null, editedCampaign.id);
  await insertMatch(
    unrelatedItem,
    unrelatedPersona.id,
    unrelatedCampaign.id,
  );
  await insertMatch(terminalItem, editedPersona.id, null);
  await insertMatch(duplicateItem, editedPersona.id, null);

  return {
    db,
    workspaceId,
    persona: {
      edited: editedPersona.id,
      next: nextPersona.id,
      unrelated: unrelatedPersona.id,
    },
    campaign: {
      edited: editedCampaign.id,
      unrelated: unrelatedCampaign.id,
    },
    item: {
      persona: personaItem,
      nextPersona: nextPersonaItem,
      campaign: campaignItem,
      unrelated: unrelatedItem,
      zeroMatch: zeroMatchItem,
      terminal: terminalItem,
      duplicate: duplicateItem,
    },
  };
}

async function itemState(db: Db, itemId: string) {
  return ((await db
    .select()
    .from(discoveredItems)
    .where(eq(discoveredItems.id, itemId)))[0])!;
}

async function expectPending(db: Db, itemId: string): Promise<void> {
  expect(await itemState(db, itemId)).toMatchObject({
    matchingState: "pending",
    matchingVersion: 5,
    matchingInputFingerprint: null,
    matchingLeaseOwner: null,
    matchingLeaseExpiresAt: null,
    matchingHeartbeatAt: null,
    matchingError: null,
  });
}

async function expectReady(db: Db, itemId: string): Promise<void> {
  expect(await itemState(db, itemId)).toMatchObject({
    matchingState: "ready",
    matchingVersion: 4,
  });
}

async function claimedIds(fixture: MatchingFixture): Promise<Set<string>> {
  return new Set(
    (await claimMatchingBatch(fixture.db, {
      workspaceId: fixture.workspaceId,
      owner: "matching-worker",
      limit: 20,
      leaseMs: 60_000,
    })).map((claim) => claim.itemId),
  );
}

describe("incremental matching invalidation", () => {
  it("invalidates only an edited persona's matches and ready zero-match items", async () => {
    const fixture = await seedFixture();

    await updatePersona(
      fixture.db,
      fixture.workspaceId,
      fixture.persona.edited,
      personaInput("Edited persona", {
        description: "Changed semantic description",
        topics: ["changed"],
      }),
    );

    await expectPending(fixture.db, fixture.item.persona);
    await expectPending(fixture.db, fixture.item.zeroMatch);
    await expectReady(fixture.db, fixture.item.campaign);
    await expectReady(fixture.db, fixture.item.nextPersona);
    await expectReady(fixture.db, fixture.item.unrelated);
    expect((await itemState(fixture.db, fixture.item.terminal)).matchingState).toBe(
      "frozen",
    );
    expect((await itemState(fixture.db, fixture.item.duplicate)).matchingState).toBe(
      "frozen",
    );
    expect(
      await fixture.db
        .select()
        .from(discoveredItemMatches)
        .where(eq(discoveredItemMatches.itemId, fixture.item.persona)),
    ).toHaveLength(1);
    expect(await claimedIds(fixture)).toEqual(
      new Set([fixture.item.persona, fixture.item.zeroMatch]),
    );
  });

  it("does not invalidate matching for persona drafting-only edits", async () => {
    const fixture = await seedFixture();

    await updatePersona(
      fixture.db,
      fixture.workspaceId,
      fixture.persona.edited,
      personaInput("Edited persona", {
        description: "Original semantic description",
        topics: ["original"],
        overlay: "A new drafting overlay",
        tone: "Direct",
        styleRules: "Use short sentences.",
        avoid: "Jargon",
      }),
    );

    await expectReady(fixture.db, fixture.item.persona);
    await expectReady(fixture.db, fixture.item.zeroMatch);
    expect(await claimedIds(fixture)).toEqual(new Set());
  });

  it("captures persona matches before delete cascades and invalidates no others", async () => {
    const fixture = await seedFixture();

    expect(
      await deletePersona(
        fixture.db,
        fixture.workspaceId,
        fixture.persona.edited,
      ),
    ).toBe(true);

    await expectPending(fixture.db, fixture.item.persona);
    await expectReady(fixture.db, fixture.item.zeroMatch);
    await expectReady(fixture.db, fixture.item.unrelated);
    expect((await itemState(fixture.db, fixture.item.terminal)).matchingState).toBe(
      "frozen",
    );
    expect(
      await fixture.db
        .select()
        .from(discoveredItemMatches)
        .where(eq(discoveredItemMatches.personaId, fixture.persona.edited)),
    ).toEqual([]);
    expect(await claimedIds(fixture)).toEqual(new Set([fixture.item.persona]));
  });

  it("invalidates campaign, previous/current persona, and zero-match blast radius on active edits", async () => {
    const fixture = await seedFixture();

    await updateCampaign(
      fixture.db,
      fixture.workspaceId,
      fixture.campaign.edited,
      campaignInput("Edited campaign", [fixture.persona.next], "active", {
        objective: "Changed objective",
      }),
    );

    await expectPending(fixture.db, fixture.item.campaign);
    await expectPending(fixture.db, fixture.item.persona);
    await expectPending(fixture.db, fixture.item.nextPersona);
    await expectPending(fixture.db, fixture.item.zeroMatch);
    await expectReady(fixture.db, fixture.item.unrelated);
    expect(await claimedIds(fixture)).toEqual(
      new Set([
        fixture.item.campaign,
        fixture.item.persona,
        fixture.item.nextPersona,
        fixture.item.zeroMatch,
      ]),
    );
  });

  it("invalidates only direct blast radius when an active campaign becomes inactive", async () => {
    const fixture = await seedFixture();

    await updateCampaign(
      fixture.db,
      fixture.workspaceId,
      fixture.campaign.edited,
      campaignInput(
        "Edited campaign",
        [fixture.persona.edited],
        "paused",
        { objective: "Original objective" },
      ),
    );

    await expectPending(fixture.db, fixture.item.campaign);
    await expectPending(fixture.db, fixture.item.persona);
    await expectReady(fixture.db, fixture.item.zeroMatch);
    await expectReady(fixture.db, fixture.item.nextPersona);
    await expectReady(fixture.db, fixture.item.unrelated);
    expect(await claimedIds(fixture)).toEqual(
      new Set([fixture.item.campaign, fixture.item.persona]),
    );
  });

  it("invalidates direct plus zero-match blast radius when an inactive campaign activates", async () => {
    const fixture = await seedFixture({ campaignStatus: "paused" });

    await updateCampaign(
      fixture.db,
      fixture.workspaceId,
      fixture.campaign.edited,
      campaignInput(
        "Edited campaign",
        [fixture.persona.edited],
        "active",
        { objective: "Original objective" },
      ),
    );

    await expectPending(fixture.db, fixture.item.campaign);
    await expectPending(fixture.db, fixture.item.persona);
    await expectPending(fixture.db, fixture.item.zeroMatch);
    await expectReady(fixture.db, fixture.item.unrelated);
  });

  it("ignores inactive-only semantic edits and automation-only edits", async () => {
    const inactive = await seedFixture({ campaignStatus: "paused" });
    await updateCampaign(
      inactive.db,
      inactive.workspaceId,
      inactive.campaign.edited,
      campaignInput(
        "Renamed while inactive",
        [inactive.persona.next],
        "paused",
        { objective: "Changed while inactive" },
      ),
    );
    await expectReady(inactive.db, inactive.item.campaign);
    await expectReady(inactive.db, inactive.item.persona);
    await expectReady(inactive.db, inactive.item.nextPersona);
    await expectReady(inactive.db, inactive.item.zeroMatch);
    expect(await claimedIds(inactive)).toEqual(new Set());

    const automation = await seedFixture();
    await setCampaignAutomation(
      automation.db,
      automation.workspaceId,
      automation.campaign.edited,
      { automationMode: "scheduled_auto", autoDailyCap: 3 },
    );
    await expectReady(automation.db, automation.item.campaign);
    await expectReady(automation.db, automation.item.persona);
    await expectReady(automation.db, automation.item.zeroMatch);
    expect(await claimedIds(automation)).toEqual(new Set());
  });

  it("invalidates ready zero-match items for new personas and active campaigns only", async () => {
    const personaFixture = await seedFixture();
    await createPersona(
      personaFixture.db,
      personaFixture.workspaceId,
      personaInput("New persona"),
    );
    await expectPending(personaFixture.db, personaFixture.item.zeroMatch);
    await expectReady(personaFixture.db, personaFixture.item.unrelated);

    const activeFixture = await seedFixture();
    await createCampaign(
      activeFixture.db,
      activeFixture.workspaceId,
      campaignInput("New active campaign", [], "active"),
    );
    await expectPending(activeFixture.db, activeFixture.item.zeroMatch);
    await expectReady(activeFixture.db, activeFixture.item.unrelated);

    const inactiveFixture = await seedFixture();
    await createCampaign(
      inactiveFixture.db,
      inactiveFixture.workspaceId,
      campaignInput("New draft campaign", [], "draft"),
    );
    await expectReady(inactiveFixture.db, inactiveFixture.item.zeroMatch);
    expect(await claimedIds(inactiveFixture)).toEqual(new Set());
  });

  it("captures campaign matches before delete cascades and invalidates only direct blast radius", async () => {
    const fixture = await seedFixture();
    const deleteCampaign = Reflect.get(
      campaignServices,
      "deleteCampaign",
    ) as
      | ((
          db: Db,
          workspaceId: string,
          campaignId: string,
        ) => Promise<boolean>)
      | undefined;

    expect(deleteCampaign).toBeTypeOf("function");
    expect(
      await deleteCampaign!(
        fixture.db,
        fixture.workspaceId,
        fixture.campaign.edited,
      ),
    ).toBe(true);

    await expectPending(fixture.db, fixture.item.campaign);
    await expectPending(fixture.db, fixture.item.persona);
    await expectReady(fixture.db, fixture.item.zeroMatch);
    expect(
      await fixture.db
        .select()
        .from(discoveredItemMatches)
        .where(eq(discoveredItemMatches.campaignId, fixture.campaign.edited)),
    ).toEqual([]);
    expect(
      (await fixture.db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, fixture.campaign.edited)))[0],
    ).toBeUndefined();
  });

  it("rolls back a persona semantic write when its invalidation fails", async () => {
    const fixture = await seedFixture();
    await fixture.db.execute(sql.raw(`
      CREATE FUNCTION reject_matching_invalidation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'reject_matching_invalidation'; END
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_matching_invalidation
      BEFORE UPDATE OF matching_state ON discovered_items
      FOR EACH ROW
      WHEN (OLD.matching_state = 'ready' AND NEW.matching_state = 'pending')
      EXECUTE FUNCTION reject_matching_invalidation();
    `));

    expect(async () =>
      await updatePersona(
        fixture.db,
        fixture.workspaceId,
        fixture.persona.edited,
        personaInput("Should roll back", {
          description: "Changed semantic description",
          topics: ["changed"],
        }),
      ),
    ).toThrow("reject_matching_invalidation");

    expect(
      (await fixture.db
        .select()
        .from(personas)
        .where(eq(personas.id, fixture.persona.edited)))[0],
    ).toMatchObject({
      name: "Edited persona",
      description: "Original semantic description",
      topicsJson: "[\"original\"]",
    });
    await expectReady(fixture.db, fixture.item.persona);
    await expectReady(fixture.db, fixture.item.zeroMatch);
  });

  it("rolls back a campaign semantic write when its invalidation fails", async () => {
    const fixture = await seedFixture();
    await fixture.db.execute(sql.raw(`
      CREATE FUNCTION reject_campaign_invalidation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'reject_campaign_invalidation'; END
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_campaign_invalidation
      BEFORE UPDATE OF matching_state ON discovered_items
      FOR EACH ROW
      WHEN (OLD.matching_state = 'ready' AND NEW.matching_state = 'pending')
      EXECUTE FUNCTION reject_campaign_invalidation();
    `));

    expect(async () =>
      await updateCampaign(
        fixture.db,
        fixture.workspaceId,
        fixture.campaign.edited,
        campaignInput(
          "Should roll back",
          [fixture.persona.next],
          "active",
          { objective: "Changed objective" },
        ),
      ),
    ).toThrow("reject_campaign_invalidation");

    expect(
      (await fixture.db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, fixture.campaign.edited)))[0],
    ).toMatchObject({
      name: "Edited campaign",
      objective: "Original objective",
      personaIdsJson: JSON.stringify([fixture.persona.edited]),
    });
    await expectReady(fixture.db, fixture.item.campaign);
    await expectReady(fixture.db, fixture.item.zeroMatch);
  });
});
