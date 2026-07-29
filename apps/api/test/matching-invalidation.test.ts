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

function seedFixture(
  input: { campaignStatus?: CampaignStatus } = {},
): MatchingFixture {
  const db = createTestDb();
  const workspaceId = randomUUID();
  const sourceId = randomUUID();
  db.insert(workspaces)
    .values({
      id: workspaceId,
      name: "Targeted matching",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(discoverySources)
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
    })
    .run();

  const editedPersona = createPersona(
    db,
    workspaceId,
    personaInput("Edited persona", {
      description: "Original semantic description",
      topics: ["original"],
    }),
  );
  const nextPersona = createPersona(
    db,
    workspaceId,
    personaInput("Next persona"),
  );
  const unrelatedPersona = createPersona(
    db,
    workspaceId,
    personaInput("Unrelated persona"),
  );
  const editedCampaign = createCampaign(
    db,
    workspaceId,
    campaignInput(
      "Edited campaign",
      [editedPersona.id],
      input.campaignStatus ?? "active",
      { objective: "Original objective" },
    ),
  );
  const unrelatedCampaign = createCampaign(
    db,
    workspaceId,
    campaignInput("Unrelated campaign", [unrelatedPersona.id]),
  );

  const insertItem = (
    label: string,
    options: {
      status?: "new" | "accepted" | "duplicate";
      matchingState?: "ready" | "frozen";
      duplicateOfId?: string | null;
    } = {},
  ) => {
    const id = randomUUID();
    db.insert(discoveredItems)
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
      })
      .run();
    return id;
  };

  const personaItem = insertItem("Edited persona match");
  const nextPersonaItem = insertItem("Next persona match");
  const campaignItem = insertItem("Edited campaign match");
  const unrelatedItem = insertItem("Unrelated match");
  const zeroMatchItem = insertItem("Zero match");
  const terminalItem = insertItem("Accepted match", {
    status: "accepted",
    matchingState: "frozen",
  });
  const duplicateItem = insertItem("Duplicate match", {
    status: "duplicate",
    matchingState: "frozen",
    duplicateOfId: zeroMatchItem,
  });

  const insertMatch = (
    itemId: string,
    personaId: string | null,
    campaignId: string | null,
  ) => {
    db.insert(discoveredItemMatches)
      .values({
        id: randomUUID(),
        workspaceId,
        itemId,
        personaId,
        campaignId,
        score: 80,
        reason: "Existing match",
        createdAt: 1,
      })
      .run();
  };

  insertMatch(personaItem, editedPersona.id, null);
  insertMatch(nextPersonaItem, nextPersona.id, null);
  insertMatch(campaignItem, null, editedCampaign.id);
  insertMatch(
    unrelatedItem,
    unrelatedPersona.id,
    unrelatedCampaign.id,
  );
  insertMatch(terminalItem, editedPersona.id, null);
  insertMatch(duplicateItem, editedPersona.id, null);

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

function itemState(db: Db, itemId: string) {
  return db
    .select()
    .from(discoveredItems)
    .where(eq(discoveredItems.id, itemId))
    .get()!;
}

function expectPending(db: Db, itemId: string): void {
  expect(itemState(db, itemId)).toMatchObject({
    matchingState: "pending",
    matchingVersion: 5,
    matchingInputFingerprint: null,
    matchingLeaseOwner: null,
    matchingLeaseExpiresAt: null,
    matchingHeartbeatAt: null,
    matchingError: null,
  });
}

function expectReady(db: Db, itemId: string): void {
  expect(itemState(db, itemId)).toMatchObject({
    matchingState: "ready",
    matchingVersion: 4,
  });
}

function claimedIds(fixture: MatchingFixture): Set<string> {
  return new Set(
    claimMatchingBatch(fixture.db, {
      workspaceId: fixture.workspaceId,
      owner: "matching-worker",
      limit: 20,
      leaseMs: 60_000,
    }).map((claim) => claim.itemId),
  );
}

describe("incremental matching invalidation", () => {
  it("invalidates only an edited persona's matches and ready zero-match items", () => {
    const fixture = seedFixture();

    updatePersona(
      fixture.db,
      fixture.workspaceId,
      fixture.persona.edited,
      personaInput("Edited persona", {
        description: "Changed semantic description",
        topics: ["changed"],
      }),
    );

    expectPending(fixture.db, fixture.item.persona);
    expectPending(fixture.db, fixture.item.zeroMatch);
    expectReady(fixture.db, fixture.item.campaign);
    expectReady(fixture.db, fixture.item.nextPersona);
    expectReady(fixture.db, fixture.item.unrelated);
    expect(itemState(fixture.db, fixture.item.terminal).matchingState).toBe(
      "frozen",
    );
    expect(itemState(fixture.db, fixture.item.duplicate).matchingState).toBe(
      "frozen",
    );
    expect(
      fixture.db
        .select()
        .from(discoveredItemMatches)
        .where(eq(discoveredItemMatches.itemId, fixture.item.persona))
        .all(),
    ).toHaveLength(1);
    expect(claimedIds(fixture)).toEqual(
      new Set([fixture.item.persona, fixture.item.zeroMatch]),
    );
  });

  it("does not invalidate matching for persona drafting-only edits", () => {
    const fixture = seedFixture();

    updatePersona(
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

    expectReady(fixture.db, fixture.item.persona);
    expectReady(fixture.db, fixture.item.zeroMatch);
    expect(claimedIds(fixture)).toEqual(new Set());
  });

  it("captures persona matches before delete cascades and invalidates no others", () => {
    const fixture = seedFixture();

    expect(
      deletePersona(
        fixture.db,
        fixture.workspaceId,
        fixture.persona.edited,
      ),
    ).toBe(true);

    expectPending(fixture.db, fixture.item.persona);
    expectReady(fixture.db, fixture.item.zeroMatch);
    expectReady(fixture.db, fixture.item.unrelated);
    expect(itemState(fixture.db, fixture.item.terminal).matchingState).toBe(
      "frozen",
    );
    expect(
      fixture.db
        .select()
        .from(discoveredItemMatches)
        .where(eq(discoveredItemMatches.personaId, fixture.persona.edited))
        .all(),
    ).toEqual([]);
    expect(claimedIds(fixture)).toEqual(new Set([fixture.item.persona]));
  });

  it("invalidates campaign, previous/current persona, and zero-match blast radius on active edits", () => {
    const fixture = seedFixture();

    updateCampaign(
      fixture.db,
      fixture.workspaceId,
      fixture.campaign.edited,
      campaignInput("Edited campaign", [fixture.persona.next], "active", {
        objective: "Changed objective",
      }),
    );

    expectPending(fixture.db, fixture.item.campaign);
    expectPending(fixture.db, fixture.item.persona);
    expectPending(fixture.db, fixture.item.nextPersona);
    expectPending(fixture.db, fixture.item.zeroMatch);
    expectReady(fixture.db, fixture.item.unrelated);
    expect(claimedIds(fixture)).toEqual(
      new Set([
        fixture.item.campaign,
        fixture.item.persona,
        fixture.item.nextPersona,
        fixture.item.zeroMatch,
      ]),
    );
  });

  it("invalidates only direct blast radius when an active campaign becomes inactive", () => {
    const fixture = seedFixture();

    updateCampaign(
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

    expectPending(fixture.db, fixture.item.campaign);
    expectPending(fixture.db, fixture.item.persona);
    expectReady(fixture.db, fixture.item.zeroMatch);
    expectReady(fixture.db, fixture.item.nextPersona);
    expectReady(fixture.db, fixture.item.unrelated);
    expect(claimedIds(fixture)).toEqual(
      new Set([fixture.item.campaign, fixture.item.persona]),
    );
  });

  it("invalidates direct plus zero-match blast radius when an inactive campaign activates", () => {
    const fixture = seedFixture({ campaignStatus: "paused" });

    updateCampaign(
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

    expectPending(fixture.db, fixture.item.campaign);
    expectPending(fixture.db, fixture.item.persona);
    expectPending(fixture.db, fixture.item.zeroMatch);
    expectReady(fixture.db, fixture.item.unrelated);
  });

  it("ignores inactive-only semantic edits and automation-only edits", () => {
    const inactive = seedFixture({ campaignStatus: "paused" });
    updateCampaign(
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
    expectReady(inactive.db, inactive.item.campaign);
    expectReady(inactive.db, inactive.item.persona);
    expectReady(inactive.db, inactive.item.nextPersona);
    expectReady(inactive.db, inactive.item.zeroMatch);
    expect(claimedIds(inactive)).toEqual(new Set());

    const automation = seedFixture();
    setCampaignAutomation(
      automation.db,
      automation.workspaceId,
      automation.campaign.edited,
      { automationMode: "scheduled_auto", autoDailyCap: 3 },
    );
    expectReady(automation.db, automation.item.campaign);
    expectReady(automation.db, automation.item.persona);
    expectReady(automation.db, automation.item.zeroMatch);
    expect(claimedIds(automation)).toEqual(new Set());
  });

  it("invalidates ready zero-match items for new personas and active campaigns only", () => {
    const personaFixture = seedFixture();
    createPersona(
      personaFixture.db,
      personaFixture.workspaceId,
      personaInput("New persona"),
    );
    expectPending(personaFixture.db, personaFixture.item.zeroMatch);
    expectReady(personaFixture.db, personaFixture.item.unrelated);

    const activeFixture = seedFixture();
    createCampaign(
      activeFixture.db,
      activeFixture.workspaceId,
      campaignInput("New active campaign", [], "active"),
    );
    expectPending(activeFixture.db, activeFixture.item.zeroMatch);
    expectReady(activeFixture.db, activeFixture.item.unrelated);

    const inactiveFixture = seedFixture();
    createCampaign(
      inactiveFixture.db,
      inactiveFixture.workspaceId,
      campaignInput("New draft campaign", [], "draft"),
    );
    expectReady(inactiveFixture.db, inactiveFixture.item.zeroMatch);
    expect(claimedIds(inactiveFixture)).toEqual(new Set());
  });

  it("captures campaign matches before delete cascades and invalidates only direct blast radius", () => {
    const fixture = seedFixture();
    const deleteCampaign = Reflect.get(
      campaignServices,
      "deleteCampaign",
    ) as
      | ((
          db: Db,
          workspaceId: string,
          campaignId: string,
        ) => boolean)
      | undefined;

    expect(deleteCampaign).toBeTypeOf("function");
    expect(
      deleteCampaign!(
        fixture.db,
        fixture.workspaceId,
        fixture.campaign.edited,
      ),
    ).toBe(true);

    expectPending(fixture.db, fixture.item.campaign);
    expectPending(fixture.db, fixture.item.persona);
    expectReady(fixture.db, fixture.item.zeroMatch);
    expect(
      fixture.db
        .select()
        .from(discoveredItemMatches)
        .where(eq(discoveredItemMatches.campaignId, fixture.campaign.edited))
        .all(),
    ).toEqual([]);
    expect(
      fixture.db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, fixture.campaign.edited))
        .get(),
    ).toBeUndefined();
  });

  it("rolls back a persona semantic write when its invalidation fails", () => {
    const fixture = seedFixture();
    fixture.db.run(sql.raw(`
      CREATE TRIGGER reject_matching_invalidation
      BEFORE UPDATE OF matching_state ON discovered_items
      WHEN OLD.matching_state = 'ready' AND NEW.matching_state = 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'reject_matching_invalidation');
      END
    `));

    expect(() =>
      updatePersona(
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
      fixture.db
        .select()
        .from(personas)
        .where(eq(personas.id, fixture.persona.edited))
        .get(),
    ).toMatchObject({
      name: "Edited persona",
      description: "Original semantic description",
      topicsJson: "[\"original\"]",
    });
    expectReady(fixture.db, fixture.item.persona);
    expectReady(fixture.db, fixture.item.zeroMatch);
  });

  it("rolls back a campaign semantic write when its invalidation fails", () => {
    const fixture = seedFixture();
    fixture.db.run(sql.raw(`
      CREATE TRIGGER reject_campaign_invalidation
      BEFORE UPDATE OF matching_state ON discovered_items
      WHEN OLD.matching_state = 'ready' AND NEW.matching_state = 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'reject_campaign_invalidation');
      END
    `));

    expect(() =>
      updateCampaign(
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
      fixture.db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, fixture.campaign.edited))
        .get(),
    ).toMatchObject({
      name: "Edited campaign",
      objective: "Original objective",
      personaIdsJson: JSON.stringify([fixture.persona.edited]),
    });
    expectReady(fixture.db, fixture.item.campaign);
    expectReady(fixture.db, fixture.item.zeroMatch);
  });
});
