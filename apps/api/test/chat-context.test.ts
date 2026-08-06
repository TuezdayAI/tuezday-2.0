import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertCampaignInputSchema, upsertPersonaInputSchema } from "@tuezday/contracts";
import type { Db } from "../src/db";
import { workspaces } from "../src/db/schema";
import type { AddDocumentInput, EvidenceStore, StoreSearchResult } from "../src/evidence/store";
import { updateBrainDoc } from "../src/services/brain";
import { createCampaign } from "../src/services/campaigns";
import { citationsForToolCall, dedupeCitations } from "../src/services/chat-citations";
import { buildChatContext, chatRetrievalQuery, DEFAULT_CHAT_CHANNEL } from "../src/services/chat-context";
import { createSession } from "../src/services/chat";
import { createPersona } from "../src/services/personas";
import { createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// A thread's system prefix and its citations.
//
// The claim under test in the first block is the one that separates this from
// "a chatbot pointed at an export": the prefix is a bundle from the SAME
// Context Resolver generation uses, selected by the thread's own scope.
// ---------------------------------------------------------------------------

class NoEvidence implements EvidenceStore {
  async health() {
    return { healthy: false, detail: "not configured" };
  }
  async createCollection(n: string) {
    return n;
  }
  async addDocument(_i: AddDocumentInput) {
    return "d";
  }
  async attachDocument() {}
  async deleteDocument() {}
  async search(): Promise<StoreSearchResult[]> {
    return [];
  }
}

let db: Db;
let workspaceId: string;
const evidence = new NoEvidence();

beforeEach(() => {
  db = createTestDb();
  workspaceId = randomUUID();
  db.insert(workspaces).values({ id: workspaceId, name: "Acme", createdAt: 1, updatedAt: 1 }).run();
  updateBrainDoc(db, workspaceId, "soul", "## Why\n\nWe make GTM legible.\n");
  updateBrainDoc(db, workspaceId, "icp", "## Buyer\n\nSeed-stage founders selling to RevOps.\n");
  updateBrainDoc(db, workspaceId, "history", "## Launches\n\nShipped the analytics beta in March.\n");
});

describe("the thread's context bundle", () => {
  it("is the resolver's bundle, carrying brain content and the conversation directive", async () => {
    const session = createSession(db, workspaceId, null, {});
    const { resolved, system } = await buildChatContext(db, evidence, session, "How do we launch?");

    expect(system).toContain("We make GTM legible.");
    expect(resolved.sections.some((s) => s.key === "task")).toBe(true);
    // The directive lives in packages/brain as this task type's instruction,
    // so it travels in the bundle and shows up in /resolver.
    expect(system).toContain("Elicit before you assume");
    expect(system).toContain("Name what you need FROM THEM");
  });

  it("takes ICP and history in full — the gtm_conversation matrix row", async () => {
    const session = createSession(db, workspaceId, null, {});
    const { system } = await buildChatContext(db, evidence, session, "Who do we sell to?");

    expect(system).toContain("Seed-stage founders selling to RevOps.");
    expect(system).toContain("Shipped the analytics beta in March.");
  });

  it("resolves against `web` when the thread binds no channel", async () => {
    const session = createSession(db, workspaceId, null, {});
    const { channel } = await buildChatContext(db, evidence, session, "Anything");
    expect(channel).toBe(DEFAULT_CHAT_CHANNEL);
  });

  it("uses the thread's channel when one is bound", async () => {
    const session = createSession(db, workspaceId, null, { channel: "linkedin" });
    const { channel } = await buildChatContext(db, evidence, session, "Anything");
    expect(channel).toBe("linkedin");
  });

  it("pulls the campaign and its persona into the bundle when the thread is scoped", async () => {
    const campaign = createCampaign(
      db,
      workspaceId,
      upsertCampaignInputSchema.parse({
        name: "Spring Launch",
        objective: "Land 50 RevOps demos",
      }),
    );
    const persona = createPersona(
      db,
      workspaceId,
      upsertPersonaInputSchema.parse({ name: "Head of RevOps", tone: "pragmatic" }),
    );
    const session = createSession(db, workspaceId, null, {
      campaignId: campaign.id,
      personaId: persona.id,
    });

    const { system } = await buildChatContext(db, evidence, session, "How is it going?");

    expect(system).toContain("Land 50 RevOps demos");
    expect(system).toContain("Head of RevOps");
  });

  it("puts the goal ahead of the bundle, and omits the line when there is none", async () => {
    const withGoal = createSession(db, workspaceId, null, { goal: "Launch across LinkedIn" });
    const a = await buildChatContext(db, evidence, withGoal, "Hello");
    expect(a.system.startsWith("THREAD GOAL: Launch across LinkedIn")).toBe(true);

    const withoutGoal = createSession(db, workspaceId, null, {});
    const b = await buildChatContext(db, evidence, withoutGoal, "Hello");
    expect(b.system).not.toContain("THREAD GOAL:");
  });

  it("ignores a scope pointing at another workspace's campaign rather than resolving it", async () => {
    // The FK on chat_sessions.campaign_id is global, not workspace-scoped, so a
    // foreign id is storable. The lookup is what must be scoped — and it is:
    // getCampaign misses, and the thread degrades to unscoped rather than
    // pulling a rival workspace's objective into the prefix.
    const rival = randomUUID();
    db.insert(workspaces).values({ id: rival, name: "Rival", createdAt: 1, updatedAt: 1 }).run();
    const theirCampaign = createCampaign(
      db,
      rival,
      upsertCampaignInputSchema.parse({ name: "Their launch", objective: "SECRETOBJECTIVE" }),
    );

    const session = createSession(db, workspaceId, null, { campaignId: theirCampaign.id });
    const { system } = await buildChatContext(db, evidence, session, "What is our objective?");

    expect(system).not.toContain("SECRETOBJECTIVE");
    expect(system).not.toContain("Their launch");
  });

  it("composes the retrieval query from the goal and the latest message", () => {
    const session = createSession(db, workspaceId, null, { goal: "Launch the analytics beta" });
    const query = chatRetrievalQuery(session, "Which channels performed best?");
    expect(query).toContain("Launch the analytics beta");
    expect(query).toContain("Which channels performed best?");
  });
});

describe("citations", () => {
  it("maps a campaign list to per-campaign links", () => {
    const citations = citationsForToolCall(
      "list_campaigns",
      {},
      { campaigns: [{ id: "c1", name: "Launch", status: "active" }] },
    );
    expect(citations).toEqual([
      { kind: "data", ref: "campaign:c1", label: "Launch", detail: "active" },
    ]);
  });

  it("maps evidence results to their document ids with a relevance detail", () => {
    const citations = citationsForToolCall(
      "search_evidence",
      { query: "pricing" },
      { results: [{ documentId: "doc-9", title: "Pricing research", score: 0.912 }] },
    );
    expect(citations).toEqual([
      { kind: "evidence", ref: "doc-9", label: "Pricing research", detail: "relevance 0.91" },
    ]);
  });

  it("handles both shapes of get_brain_section", () => {
    const single = citationsForToolCall(
      "get_brain_section",
      { docType: "voice", sectionId: "tone" },
      { docType: "voice", sectionId: "tone", heading: "Tone", content: "..." },
    );
    expect(single).toEqual([
      { kind: "brain", ref: "voice#tone", label: "Tone", detail: "voice" },
    ]);

    const queried = citationsForToolCall(
      "get_brain_section",
      { query: "tone" },
      { sections: [{ docType: "voice", sectionId: "tone", heading: "Tone", text: "..." }] },
    );
    expect(queried).toEqual(single);
  });

  it("takes the sequence id from the request, since the funnel returns only counts", () => {
    const citations = citationsForToolCall("get_sequence_funnel", { sequenceId: "seq-1" }, { sent: 10 });
    expect(citations[0]!).toMatchObject({ ref: "outreach_sequence:seq-1", detail: "funnel" });
  });

  it("marks a fetched page as the one source the workspace does not control", () => {
    const citations = citationsForToolCall(
      "safe_fetch_url",
      { url: "https://example.com/a" },
      { finalUrl: "https://example.com/a", status: 200, text: "..." },
    );
    expect(citations[0]!.detail).toBe("fetched web page");
  });

  it("produces nothing for a failed or not-found result", () => {
    expect(
      citationsForToolCall("get_campaign_insights", { campaignId: "x" }, { error: "not_found" }),
    ).toEqual([]);
    expect(
      citationsForToolCall("safe_fetch_url", { url: "https://x.test" }, { error: "blocked" }),
    ).toEqual([]);
    expect(citationsForToolCall("list_campaigns", {}, { campaigns: [], note: "none" })).toEqual([]);
  });

  it("produces nothing for the two tools whose output carries no record id", () => {
    // Deliberate (see chat-citations.ts): a chip that cannot be opened is worse
    // than no chip, and these are style anchors rather than factual sources.
    expect(
      citationsForToolCall(
        "find_similar_approved_drafts",
        { query: "pricing" },
        { drafts: [{ taskType: "linkedin_post", content: "..." }] },
      ),
    ).toEqual([]);
    expect(
      citationsForToolCall(
        "find_instructive_rejections",
        {},
        { rejections: [{ taskType: "linkedin_post", content: "..." }] },
      ),
    ).toEqual([]);
  });

  it("survives a tool whose shape drifted", () => {
    expect(citationsForToolCall("list_campaigns", {}, null)).toEqual([]);
    expect(citationsForToolCall("list_campaigns", {}, { campaigns: "not an array" })).toEqual([]);
    expect(citationsForToolCall("list_campaigns", {}, { campaigns: [{ name: "no id" }] })).toEqual([]);
    expect(citationsForToolCall("a_tool_that_does_not_exist", {}, { anything: true })).toEqual([]);
  });

  it("dedupes on kind and ref, first occurrence winning", () => {
    const deduped = dedupeCitations([
      { kind: "data", ref: "campaign:c1", label: "Launch" },
      { kind: "data", ref: "campaign:c1", label: "Launch (again)" },
      { kind: "brain", ref: "campaign:c1", label: "Different kind" },
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]!.label).toBe("Launch");
  });
});
