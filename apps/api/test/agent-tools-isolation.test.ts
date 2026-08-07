import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertCampaignInputSchema, upsertPersonaInputSchema } from "@tuezday/contracts";
import { READ_TOOLS } from "../src/agents/tools/index";
import { getPersonaTool } from "../src/agents/tools/get-persona";
import { getCampaignPlanTool } from "../src/agents/tools/get-campaign-plan";
import { getMetricSummaryTool } from "../src/agents/tools/get-metric-summary";
import { getSequenceFunnelTool } from "../src/agents/tools/get-sequence-funnel";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../src/agents/registry";
import type { Db } from "../src/db";
import type { AddDocumentInput, EvidenceStore, StoreSearchResult } from "../src/evidence/store";
import {
  connections,
  discoveredItems,
  discoverySources,
  drafts,
  evidenceDocuments,
  publications,
  workspaces,
} from "../src/db/schema";
import { updateBrainDoc } from "../src/services/brain";
import { createCampaign } from "../src/services/campaigns";
import { setChannelGuidance } from "../src/services/guidance";
import { recordMetric } from "../src/services/metrics";
import { createPersona } from "../src/services/personas";
import { createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// The tenant-isolation sweep (Sprint 57 spec §4 step 8): seed the SAME kinds
// of data in two workspaces, run every read tool with workspace A's context,
// and assert nothing of workspace B leaks into any result. Every seeded text
// carries the workspace's marker so leakage is detectable in the serialized
// output of any tool, regardless of its result shape.
// ---------------------------------------------------------------------------

const MARKER = { a: "ALPHAWORD", b: "BRAVOWORD" } as const;

class FakeEvidenceStore implements EvidenceStore {
  private docs = new Map<string, AddDocumentInput>();
  private nextId = 1;

  async health() {
    return { healthy: true };
  }
  async createCollection(name: string) {
    return `collection-${name}`;
  }
  async addDocument(input: AddDocumentInput) {
    const id = `store-doc-${this.nextId++}`;
    this.docs.set(id, input);
    return id;
  }
  async attachDocument() {}
  async deleteDocument(documentId: string) {
    this.docs.delete(documentId);
  }
  async search(query: string, collectionId: string, limit: number): Promise<StoreSearchResult[]> {
    const terms = query.toLowerCase().split(/\s+/);
    return [...this.docs.entries()]
      .filter(([, doc]) => doc.collectionId === collectionId)
      .filter(([, doc]) => terms.some((t) => doc.content.toLowerCase().includes(t)))
      .slice(0, limit)
      .map(([documentId, doc]) => ({ documentId, text: doc.content, score: 0.9 }));
  }
}

let db: Db;
let store: FakeEvidenceStore;

interface Seeded {
  workspaceId: string;
  personaId: string;
  campaignId: string;
}

async function seedWorkspace(marker: string): Promise<Seeded> {
  const workspaceId = randomUUID();
  await db.insert(workspaces)
    .values({ id: workspaceId, name: `WS ${marker}`, createdAt: 1, updatedAt: 1 })
    .run();

  await updateBrainDoc(db, workspaceId, "voice", `## Tone\n\nOur tone is ${marker} direct.\n`);
  const persona = await createPersona(
    db,
    workspaceId,
    upsertPersonaInputSchema.parse({ name: `Persona ${marker}`, tone: marker }),
  );
  const campaign = await createCampaign(
    db,
    workspaceId,
    upsertCampaignInputSchema.parse({ name: `Campaign ${marker}`, objective: `${marker} wins` }),
  );
  await setChannelGuidance(db, workspaceId, "linkedin", `Guidance ${marker}: stay ${marker}.`);

  const draftId = randomUUID();
  await db.insert(drafts)
    .values({
      id: draftId,
      workspaceId,
      taskType: "linkedin_post",
      channel: "linkedin",
      originalContent: `${marker} original take.`,
      content: `${marker} approved pricing take.`,
      state: "approved",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await db.insert(drafts)
    .values({
      id: randomUUID(),
      workspaceId,
      taskType: "linkedin_post",
      channel: "linkedin",
      originalContent: `${marker} rejected rant.`,
      content: `${marker} rejected rant.`,
      state: "rejected",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();

  const connectionId = randomUUID();
  await db.insert(connections)
    .values({
      id: connectionId,
      workspaceId,
      providerKey: "reddit",
      nangoConnectionId: `nango-${connectionId}`,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await db.insert(publications)
    .values({
      id: randomUUID(),
      workspaceId,
      draftId,
      connectionId,
      providerKey: "reddit",
      target: "r/startups",
      title: `${marker} pricing post`,
      status: "published",
      scheduledFor: 1,
      publishedAt: 2,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();

  const sourceId = randomUUID();
  await db.insert(discoverySources)
    .values({
      id: sourceId,
      workspaceId,
      type: "rss",
      name: `Source ${marker}`,
      configJson: "{}",
      status: "ok",
      createdAt: 1,
    })
    .run();
  await db.insert(discoveredItems)
    .values({
      id: randomUUID(),
      workspaceId,
      sourceId,
      externalId: "x",
      title: `${marker} pricing story`,
      url: `https://example.com/${marker}`,
      summary: `${marker} summary about pricing.`,
      score: 50,
      createdAt: 1,
    })
    .run();

  // Evidence: one ready document per workspace, in that workspace's collection.
  const collectionId = await store.createCollection(workspaceId);
  const storeDocId = await store.addDocument({
    title: `${marker} research`,
    content: `${marker} buyers expect usage-based pricing.`,
    collectionId,
    metadata: {},
  });
  await db.insert(evidenceDocuments)
    .values({
      id: randomUUID(),
      workspaceId,
      r2rDocumentId: storeDocId,
      title: `${marker} research`,
      chars: 50,
      status: "ready",
      kind: "manual",
      createdAt: 1,
    })
    .run();

  return { workspaceId, personaId: persona.id, campaignId: campaign.id };
}

function ctxFor(workspaceId: string): ToolContext {
  return {
    db,
    evidence: store,
    safeFetch: null as unknown as ToolContext["safeFetch"],
    workspaceId,
    actor: { userId: "founder-a", label: "Founder A" },
    budget: DEFAULT_TOOL_BUDGET,
  };
}

describe("tenant isolation across every read tool", () => {
  let a: Seeded;
  let b: Seeded;

  beforeEach(async () => {
    db = createTestDb();
    store = new FakeEvidenceStore();
    a = await seedWorkspace(MARKER.a);
    b = await seedWorkspace(MARKER.b);
  });

  it("no tool run in workspace A ever returns workspace B data", async () => {
    const ctx = ctxFor(a.workspaceId);
    // Inputs chosen so every tool actually returns data for A (queries hit
    // the seeded texts). safe_fetch_url has no tenant data and no fetcher
    // here — its isolation property is the SSRF policy, tested elsewhere.
    const inputsByTool: Record<string, Record<string, unknown> | null> = {
      search_evidence: { query: "pricing" },
      get_brain_section: { query: "tone direct" },
      get_campaign_plan: { campaignId: a.campaignId },
      list_recent_publications_with_metrics: {},
      find_similar_approved_drafts: { query: "pricing" },
      find_instructive_rejections: {},
      get_persona: { personaId: a.personaId },
      list_channel_guardrails: {},
      search_discovery_items: { query: "pricing" },
      get_prior_posts_on_topic: { topic: "pricing" },
      safe_fetch_url: null,
      // Sprint 76 analytics + inventory reads.
      list_campaigns: {},
      list_personas: {},
      get_campaign_insights: { campaignId: a.campaignId },
      get_workspace_insights: {},
      // These two return numbers, not names — there is no marker to find in a
      // sum. Isolation is asserted directly in the next test instead, which is
      // the stronger check for an aggregate: not "did it avoid B's words" but
      // "did B's rows move the number at all".
      get_metric_summary: null,
      // Needs a sequence id, and the fixture seeds no outreach sequence.
      get_sequence_funnel: null,
      // Sprint 77 — the approval queue as data.
      list_drafts: {},
    };

    for (const tool of READ_TOOLS) {
      const input = inputsByTool[tool.name];
      if (input === null) continue;
      expect(input, `missing isolation input for ${tool.name}`).toBeDefined();
      const result = await tool.run(ctx, tool.input.parse(input));
      const serialized = JSON.stringify(result);
      expect(serialized, tool.name).toContain(MARKER.a);
      expect(serialized, tool.name).not.toContain(MARKER.b);
    }
  });

  it("ids from workspace B resolve to not_found in workspace A, without leaking B's inventory", async () => {
    const ctx = ctxFor(a.workspaceId);
    const persona = (await getPersonaTool.run(ctx, { personaId: b.personaId })) as {
      error: string;
      availablePersonas: Array<{ name: string }>;
    };
    expect(persona.error).toBe("not_found");
    expect(JSON.stringify(persona.availablePersonas)).not.toContain(MARKER.b);

    const campaign = (await getCampaignPlanTool.run(ctx, { campaignId: b.campaignId })) as {
      error: string;
      availableCampaigns: Array<{ name: string }>;
    };
    expect(campaign.error).toBe("not_found");
    expect(JSON.stringify(campaign.availableCampaigns)).not.toContain(MARKER.b);
  });

  it("a metric rollup counts only its own workspace's rows, and a foreign id rolls up to nothing", async () => {
    // The aggregate leak the marker sweep cannot catch: no name crosses the
    // boundary, just a number that is silently too big.
    const record = async (workspaceId: string, subjectId: string, value: number) =>
      await recordMetric(db, workspaceId, {
        subjectType: "campaign",
        subjectId,
        metricKey: "impressions",
        value,
        window: "1d",
        periodStart: 1,
        source: "manual",
        capturedAt: 1,
      });
    await record(a.workspaceId, a.campaignId, 100);
    await record(b.workspaceId, b.campaignId, 900);

    const own = (await getMetricSummaryTool.run(ctxFor(a.workspaceId), {
      subjectType: "campaign",
      window: "1d",
    })) as { entries: Array<{ metricKey: string; total: number }> };
    expect(own.entries.find((e) => e.metricKey === "impressions")?.total).toBe(100);

    // B's own campaign id, asked for from inside A.
    const foreign = (await getMetricSummaryTool.run(ctxFor(a.workspaceId), {
      subjectType: "campaign",
      subjectId: b.campaignId,
      window: "1d",
    })) as { entries: unknown[]; note?: string };
    expect(foreign.entries).toEqual([]);
    expect(foreign.note).toBeDefined();
  });

  it("an outreach funnel for a foreign sequence is not_found and lists only this workspace's sequences", async () => {
    const result = (await getSequenceFunnelTool.run(ctxFor(a.workspaceId), {
      sequenceId: randomUUID(),
    })) as { error: string; availableSequences: unknown[] };
    expect(result.error).toBe("not_found");
    expect(JSON.stringify(result.availableSequences)).not.toContain(MARKER.b);
  });
});
