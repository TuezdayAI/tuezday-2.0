import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { upsertCampaignInputSchema, upsertPersonaInputSchema } from "@tuezday/contracts";
import { findInstructiveRejectionsTool } from "../src/agents/tools/find-instructive-rejections";
import { findSimilarApprovedDraftsTool } from "../src/agents/tools/find-similar-approved-drafts";
import { getBrainSectionTool } from "../src/agents/tools/get-brain-section";
import { getCampaignPlanTool } from "../src/agents/tools/get-campaign-plan";
import { getPersonaTool } from "../src/agents/tools/get-persona";
import { getPriorPostsTool } from "../src/agents/tools/get-prior-posts";
import { listChannelGuardrailsTool } from "../src/agents/tools/list-channel-guardrails";
import { listRecentPublicationsTool } from "../src/agents/tools/list-recent-publications";
import { searchDiscoveryItemsTool } from "../src/agents/tools/search-discovery-items";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../src/agents/registry";
import type { Db } from "../src/db";
import {
  campaignLaneRevisions,
  campaignLanes,
  campaignPlanRevisions,
  campaigns,
  connections,
  discoveredItems,
  discoverySources,
  draftRevisionTurns,
  drafts,
  publicationMetrics,
  publications,
  workspaces,
} from "../src/db/schema";
import { updateBrainDoc } from "../src/services/brain";
import { createCampaign } from "../src/services/campaigns";
import { setChannelGuidance } from "../src/services/guidance";
import { createPersona } from "../src/services/personas";
import { createTestDb } from "./helpers";

// search_evidence is exercised end to end in agent-runner.test.ts (it is the
// Sprint 56 proof tool, now registry-shaped); this file covers the other
// batch-1 read tools directly at the Tool.run level.

// A real uuid — plan/lane contract schemas validate id formats.
const WORKSPACE_ID = randomUUID();

let db: Db;
let ctx: ToolContext;

beforeEach(async () => {
  db = createTestDb();
  await db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Read tools", createdAt: 1, updatedAt: 1 })
    .run();
  ctx = {
    db,
    evidence: null as unknown as ToolContext["evidence"],
    safeFetch: null as unknown as ToolContext["safeFetch"],
    workspaceId: WORKSPACE_ID,
    actor: { userId: "founder", label: "Founder" },
    budget: DEFAULT_TOOL_BUDGET,
  };
});

const VOICE_DOC = `## Tone of voice

Direct, concrete, no hype. Every claim earns its place.

## Words we avoid

Never say "synergy", "leverage" (as a verb), or "game-changing".
`;

describe("get_brain_section", () => {
  it("returns one exact section by docType + sectionId", async () => {
    await updateBrainDoc(db, WORKSPACE_ID, "voice", VOICE_DOC);
    const result = (await getBrainSectionTool.run(ctx, {
      docType: "voice",
      sectionId: "words-we-avoid",
    })) as { heading: string; content: string };
    expect(result.heading).toBe("Words we avoid");
    expect(result.content).toContain("synergy");
  });

  it("lists available section ids when the section is unknown", async () => {
    await updateBrainDoc(db, WORKSPACE_ID, "voice", VOICE_DOC);
    const result = (await getBrainSectionTool.run(ctx, {
      docType: "voice",
      sectionId: "nope",
    })) as { error: string; availableSectionIds: string[] };
    expect(result.error).toBe("not_found");
    expect(result.availableSectionIds).toContain("tone-of-voice");
  });

  it("ranks sections by query, filtered by docType when given", async () => {
    await updateBrainDoc(db, WORKSPACE_ID, "voice", VOICE_DOC);
    await updateBrainDoc(db, WORKSPACE_ID, "now", "## Current focus\n\nShip the agent inspector.\n");
    const result = (await getBrainSectionTool.run(ctx, { query: "words avoid hype" })) as {
      sections: Array<{ docType: string; sectionId: string }>;
    };
    expect(result.sections[0]!.sectionId).toBe("words-we-avoid");

    const filtered = (await getBrainSectionTool.run(ctx, {
      query: "inspector",
      docType: "voice",
    })) as { sections: Array<{ docType: string }>; note?: string };
    // "inspector" only matches the now doc — the docType filter excludes it,
    // so the fallback path returns voice sections with a note.
    expect(filtered.sections.every((s) => s.docType === "voice")).toBe(true);
    expect(filtered.note).toBeDefined();
  });

  it("requires sectionId+docType or a query, as instructive error data", async () => {
    const bare = (await getBrainSectionTool.run(ctx, {})) as { error: string };
    expect(bare.error).toBe("invalid_arguments");
    const noDoc = (await getBrainSectionTool.run(ctx, { sectionId: "x" })) as { error: string };
    expect(noDoc.error).toBe("invalid_arguments");
  });
});

describe("get_persona", () => {
  it("returns the resolver-facing persona shape", async () => {
    const persona = await createPersona(
      db,
      WORKSPACE_ID,
      upsertPersonaInputSchema.parse({
        name: "Field CTO",
        description: "Technical founder voice",
        tone: "direct",
        topics: ["infrastructure", "pricing"],
        styleRules: "Short sentences.",
        avoid: "Buzzwords",
      }),
    );
    const result = (await getPersonaTool.run(ctx, { personaId: persona.id })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      id: persona.id,
      name: "Field CTO",
      topics: ["infrastructure", "pricing"],
      avoid: "Buzzwords",
    });
  });

  it("lists available personas on unknown id", async () => {
    await createPersona(db, WORKSPACE_ID, upsertPersonaInputSchema.parse({ name: "Field CTO" }));
    const result = (await getPersonaTool.run(ctx, { personaId: "missing" })) as {
      error: string;
      availablePersonas: Array<{ name: string }>;
    };
    expect(result.error).toBe("not_found");
    expect(result.availablePersonas.map((p) => p.name)).toContain("Field CTO");
  });
});

describe("get_campaign_plan", () => {
  it("returns the campaign with a note when no plan revision is active", async () => {
    const campaign = await createCampaign(
      db,
      WORKSPACE_ID,
      upsertCampaignInputSchema.parse({ name: "Launch", objective: "Ship it" }),
    );
    const result = (await getCampaignPlanTool.run(ctx, { campaignId: campaign.id })) as {
      campaign: { name: string };
      plan: null;
      note: string;
    };
    expect(result.campaign.name).toBe("Launch");
    expect(result.plan).toBeNull();
    expect(result.note).toContain("no activated plan");
  });

  it("returns the current plan revision with its lanes", async () => {
    const campaign = await createCampaign(
      db,
      WORKSPACE_ID,
      upsertCampaignInputSchema.parse({ name: "Launch" }),
    );
    const persona = await createPersona(
      db,
      WORKSPACE_ID,
      upsertPersonaInputSchema.parse({ name: "Field CTO" }),
    );
    const planId = randomUUID();
    await db.insert(campaignPlanRevisions)
      .values({
        id: planId,
        workspaceId: WORKSPACE_ID,
        campaignId: campaign.id,
        revision: 1,
        status: "active",
        objective: "Win the launch week",
        pillarsJson: JSON.stringify(["proof over promises"]),
        guidance: "Be concrete.",
        createdAt: 1,
        activatedAt: 2,
      })
      .run();
    await db.update(campaigns)
      .set({ currentPlanRevisionId: planId })
      .where(eq(campaigns.id, campaign.id))
      .run();
    const laneId = randomUUID();
    await db.insert(campaignLanes)
      .values({
        id: laneId,
        workspaceId: WORKSPACE_ID,
        campaignId: campaign.id,
        key: "li-founder",
        name: "LinkedIn founder",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await db.insert(campaignLaneRevisions)
      .values({
        id: randomUUID(),
        workspaceId: WORKSPACE_ID,
        laneId,
        planRevisionId: planId,
        key: "li-founder",
        name: "LinkedIn founder",
        personaId: persona.id,
        channel: "linkedin",
        format: "post",
        deliveryMode: "reactive",
        reactivePeriod: "week",
        reactiveCap: 3,
        createdAt: 1,
      })
      .run();

    const result = (await getCampaignPlanTool.run(ctx, { campaignId: campaign.id })) as {
      plan: { objective: string; pillars: string[] };
      lanes: Array<{ key: string; channel: string; reactiveCap: number }>;
    };
    expect(result.plan.objective).toBe("Win the launch week");
    expect(result.plan.pillars).toEqual(["proof over promises"]);
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]).toMatchObject({
      key: "li-founder",
      channel: "linkedin",
      reactiveCap: 3,
    });
  });

  it("lists available campaigns on unknown id", async () => {
    await createCampaign(db, WORKSPACE_ID, upsertCampaignInputSchema.parse({ name: "Launch" }));
    const result = (await getCampaignPlanTool.run(ctx, { campaignId: "missing" })) as {
      error: string;
      availableCampaigns: Array<{ name: string }>;
    };
    expect(result.error).toBe("not_found");
    expect(result.availableCampaigns.map((c) => c.name)).toContain("Launch");
  });
});

describe("list_channel_guardrails", () => {
  it("returns defaults for every channel plus automation limits", async () => {
    const result = (await listChannelGuardrailsTool.run(ctx, {})) as {
      guidance: Array<{ channel: string; source: string }>;
      limits: {
        killSwitch: boolean;
        perConnectionDailyCap: number;
        perConnectionReplyDailyCap: number;
      };
    };
    expect(result.guidance.length).toBeGreaterThanOrEqual(7);
    expect(result.guidance.every((g) => g.source === "default")).toBe(true);
    expect(result.limits.killSwitch).toBe(false);
    expect(result.limits.perConnectionDailyCap).toBeGreaterThan(0);
    expect(result.limits.perConnectionReplyDailyCap).toBeGreaterThan(0);
  });

  it("surfaces workspace overrides and scoped rows, filtered by channel", async () => {
    const persona = await createPersona(
      db,
      WORKSPACE_ID,
      upsertPersonaInputSchema.parse({ name: "Field CTO" }),
    );
    await setChannelGuidance(db, WORKSPACE_ID, "linkedin", "No emojis. Ever.");
    await setChannelGuidance(db, WORKSPACE_ID, "linkedin", "Field CTO may use one emoji.", {
      personaId: persona.id,
    });

    const result = (await listChannelGuardrailsTool.run(ctx, { channel: "linkedin" })) as {
      guidance: Array<{ channel: string; source: string; content: string }>;
      scopedOverrides: Array<{ personaName: string | null; content: string }>;
    };
    expect(result.guidance).toHaveLength(1);
    expect(result.guidance[0]).toMatchObject({ channel: "linkedin", source: "workspace" });
    expect(result.guidance[0]!.content).toContain("No emojis");
    expect(result.scopedOverrides).toHaveLength(1);
    expect(result.scopedOverrides[0]!.personaName).toBe("Field CTO");
  });
});

// ---------------------------------------------------------------------------
// Batch 2 — publications, prior posts, similar drafts, rejections, discovery
// ---------------------------------------------------------------------------

async function seedDraft(opts: {
  state: string;
  content: string;
  original?: string;
  taskType?: string;
  channel?: string;
  campaignId?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(drafts)
    .values({
      id,
      workspaceId: WORKSPACE_ID,
      taskType: opts.taskType ?? "linkedin_post",
      channel: opts.channel ?? "linkedin",
      campaignId: opts.campaignId ?? null,
      originalContent: opts.original ?? opts.content,
      content: opts.content,
      state: opts.state,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  return id;
}

async function seedConnection(): Promise<string> {
  const id = randomUUID();
  await db.insert(connections)
    .values({
      id,
      workspaceId: WORKSPACE_ID,
      providerKey: "reddit",
      nangoConnectionId: `nango-${id}`,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  return id;
}

async function seedPublication(
  connectionId: string,
  draftId: string,
  opts: { title: string; status?: string; publishedAt?: number },
): Promise<string> {
  const id = randomUUID();
  await db.insert(publications)
    .values({
      id,
      workspaceId: WORKSPACE_ID,
      draftId,
      connectionId,
      providerKey: "reddit",
      target: "r/startups",
      title: opts.title,
      status: opts.status ?? "published",
      scheduledFor: 1,
      publishedAt: opts.publishedAt ?? 100,
      externalUrl: `https://example.com/${id}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  return id;
}

describe("list_recent_publications_with_metrics", () => {
  it("returns only published posts, with their metric snapshots", async () => {
    const connectionId = await seedConnection();
    const liveDraft = await seedDraft({ state: "approved", content: "Usage-based pricing post." });
    const liveId = await seedPublication(connectionId, liveDraft, { title: "Pricing post" });
    const queuedDraft = await seedDraft({ state: "approved", content: "Not out yet." });
    await seedPublication(connectionId, queuedDraft, { title: "Queued", status: "scheduled" });
    await db.insert(publicationMetrics)
      .values({
        id: randomUUID(),
        workspaceId: WORKSPACE_ID,
        publicationId: liveId,
        window: "24h",
        likes: 12,
        impressions: 900,
        capturedAt: 1,
        createdAt: 1,
      })
      .run();

    const result = (await listRecentPublicationsTool.run(ctx, {})) as {
      publications: Array<{ title: string; metrics: Array<{ window: string; likes: number }> }>;
    };
    expect(result.publications).toHaveLength(1);
    expect(result.publications[0]!.title).toBe("Pricing post");
    expect(result.publications[0]!.metrics[0]).toMatchObject({ window: "24h", likes: 12 });
  });

  it("filters by campaign through the draft join", async () => {
    const connectionId = await seedConnection();
    const campaign = await createCampaign(
      db,
      WORKSPACE_ID,
      upsertCampaignInputSchema.parse({ name: "Launch" }),
    );
    const inCampaign = await seedDraft({
      state: "approved",
      content: "Campaign post.",
      campaignId: campaign.id,
    });
    await seedPublication(connectionId, inCampaign, { title: "In campaign" });
    const outside = await seedDraft({ state: "approved", content: "Other post." });
    await seedPublication(connectionId, outside, { title: "Outside" });

    const result = (await listRecentPublicationsTool.run(ctx, { campaignId: campaign.id })) as {
      publications: Array<{ title: string }>;
    };
    expect(result.publications.map((p) => p.title)).toEqual(["In campaign"]);
  });
});

describe("get_prior_posts_on_topic", () => {
  it("ranks published posts by topic match", async () => {
    const connectionId = await seedConnection();
    const pricing = await seedDraft({
      state: "approved",
      content: "We tested usage-based pricing and churn dropped.",
    });
    await seedPublication(connectionId, pricing, { title: "Pricing lessons" });
    const onboarding = await seedDraft({ state: "approved", content: "Onboarding flows that work." });
    await seedPublication(connectionId, onboarding, { title: "Onboarding" });

    const result = (await getPriorPostsTool.run(ctx, { topic: "pricing churn" })) as {
      posts: Array<{ title: string }>;
    };
    expect(result.posts[0]!.title).toBe("Pricing lessons");
    expect(result.posts.some((p) => p.title === "Onboarding")).toBe(false);
  });

  it("says so when nothing matches the topic", async () => {
    const connectionId = await seedConnection();
    const d = await seedDraft({ state: "approved", content: "Onboarding flows." });
    await seedPublication(connectionId, d, { title: "Onboarding" });
    const result = (await getPriorPostsTool.run(ctx, { topic: "quantum blockchain" })) as {
      posts: unknown[];
      note: string;
    };
    expect(result.posts).toEqual([]);
    expect(result.note).toContain("matched");
  });
});

describe("find_similar_approved_drafts", () => {
  it("returns approved drafts ranked by the query, excluding rejections", async () => {
    await seedDraft({ state: "approved", content: "Approved take on usage-based pricing." });
    await seedDraft({ state: "rejected", content: "Rejected pricing rant." });
    await seedDraft({ state: "approved", content: "Approved onboarding story.", channel: "x" });

    const result = (await findSimilarApprovedDraftsTool.run(ctx, { query: "pricing" })) as {
      drafts: Array<{ content: string; approvedVia: string }>;
    };
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.content).toContain("usage-based pricing");
    expect(result.drafts[0]!.approvedVia).toBe("approval");
  });

  it("falls back to recent approvals with a note when the query matches nothing", async () => {
    await seedDraft({ state: "approved", content: "Approved onboarding story." });
    const result = (await findSimilarApprovedDraftsTool.run(ctx, { query: "zeppelin" })) as {
      drafts: unknown[];
      note?: string;
    };
    expect(result.drafts).toHaveLength(1);
    expect(result.note).toContain("most recent approvals");
  });
});

describe("find_instructive_rejections", () => {
  it("surfaces rejections, edit deltas, and human revision instructions", async () => {
    const rejectedId = await seedDraft({ state: "rejected", content: "Too salesy pricing pitch." });
    await db.insert(draftRevisionTurns)
      .values({
        id: randomUUID(),
        requestId: randomUUID(),
        workspaceId: WORKSPACE_ID,
        draftId: rejectedId,
        instruction: "Cut the hype, lead with the number.",
        sourceContent: "Too salesy pricing pitch.",
        status: "done",
        createdAt: 1,
      })
      .run();
    await seedDraft({
      state: "approved",
      content: "Tight, edited post.",
      original: "Rambling first version.",
    });
    await seedDraft({ state: "approved", content: "Untouched approved post." });

    const result = (await findInstructiveRejectionsTool.run(ctx, {})) as {
      rejections: Array<{
        outcome: string;
        wasEdited: boolean;
        originalContent?: string;
        humanInstructions: string[];
      }>;
    };
    expect(result.rejections).toHaveLength(2);
    const rejected = result.rejections.find((r) => r.outcome === "rejected")!;
    expect(rejected.humanInstructions).toEqual(["Cut the hype, lead with the number."]);
    const edited = result.rejections.find((r) => r.outcome === "approved")!;
    expect(edited.wasEdited).toBe(true);
    expect(edited.originalContent).toContain("Rambling");
  });
});

describe("search_discovery_items", () => {
  async function seedDiscovery(): Promise<void> {
    const sourceId = randomUUID();
    await db.insert(discoverySources)
      .values({
        id: sourceId,
        workspaceId: WORKSPACE_ID,
        type: "rss",
        name: "HN",
        configJson: "{}",
        status: "ok",
        createdAt: 1,
      })
      .run();
    const base = {
      workspaceId: WORKSPACE_ID,
      sourceId,
      summary: "",
      createdAt: 1,
    };
    await db.insert(discoveredItems)
      .values([
        {
          ...base,
          id: randomUUID(),
          externalId: "a",
          title: "SaaS pricing shakeup",
          url: "https://example.com/pricing",
          summary: "Usage-based pricing is eating seats.",
          score: 40,
        },
        {
          ...base,
          id: randomUUID(),
          externalId: "b",
          title: "New JS framework",
          url: "https://example.com/js",
          summary: "Another one.",
          score: 90,
        },
      ])
      .run();
  }

  it("orders by score without a query and by BM25 with one", async () => {
    await seedDiscovery();
    const byScore = (await searchDiscoveryItemsTool.run(ctx, {})) as {
      items: Array<{ title: string }>;
    };
    expect(byScore.items[0]!.title).toBe("New JS framework");

    const byQuery = (await searchDiscoveryItemsTool.run(ctx, { query: "usage based pricing" })) as {
      items: Array<{ title: string }>;
    };
    expect(byQuery.items[0]!.title).toBe("SaaS pricing shakeup");
    expect(byQuery.items.some((i) => i.title === "New JS framework")).toBe(false);
  });

  it("reports empty results with a note", async () => {
    const result = (await searchDiscoveryItemsTool.run(ctx, { status: "accepted" })) as {
      items: unknown[];
      note: string;
    };
    expect(result.items).toEqual([]);
  });
});
