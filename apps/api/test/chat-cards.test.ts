import { describe, expect, it } from "vitest";
import { CHAT_CARDS_PER_TURN, TOOL_CARD_KINDS } from "@tuezday/contracts";
import { cardKindForTool, cardsForToolCall, dedupeCards } from "../src/services/chat-cards";

// ---------------------------------------------------------------------------
// Tool result → typed cards (Sprint 77).
//
// The claim being tested is narrow and load-bearing: a card is the record, it
// routes by the same `<kind>:<id>` anchor a citation uses, and it offers a
// button ONLY where the platform can actually honour it.
// ---------------------------------------------------------------------------

describe("campaign cards", () => {
  it("renders one per campaign, keyed on the campaign ref", () => {
    const cards = cardsForToolCall(
      "list_campaigns",
      {},
      {
        campaigns: [
          {
            id: "c-1",
            name: "Spring Launch",
            status: "active",
            objective: "Land 50 RevOps demos",
            kpi: "demos",
            timeframe: "Q2",
            channels: ["linkedin", "email"],
          },
        ],
      },
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "campaign",
      ref: "campaign:c-1",
      title: "Spring Launch",
      subtitle: "active",
    });
    expect(cards[0]!.fields).toContainEqual({ label: "Objective", value: "Land 50 RevOps demos" });
    expect(cards[0]!.fields).toContainEqual({ label: "Channels", value: "linkedin, email" });
    // A campaign card is navigational, never actionable from chat.
    expect(cards[0]!.actions).toEqual(["open"]);
  });

  it("reads the nested campaign a plan or insights call returns", () => {
    const cards = cardsForToolCall(
      "get_campaign_insights",
      { campaignId: "c-1" },
      { campaign: { id: "c-1", name: "Spring Launch", status: "active" }, metrics: { impressions: 90 } },
    );
    expect(cards[0]!.ref).toBe("campaign:c-1");
    expect(cards[0]!.subtitle).toBe("performance");
    expect(cards[0]!.fields).toContainEqual({ label: "impressions", value: "90" });
  });
});

describe("draft cards", () => {
  it("offers approve, reject and edit ONLY on a draft that is pending review", () => {
    const [pending] = cardsForToolCall(
      "list_drafts",
      { state: "pending_review" },
      {
        drafts: [
          {
            id: "d-1",
            state: "pending_review",
            channel: "linkedin",
            taskType: "linkedin_post",
            content: "We raised a seed round.",
          },
        ],
      },
    );
    expect(pending!.actions).toEqual(["open", "approve", "reject", "edit"]);
    expect(pending!.body).toBe("We raised a seed round.");

    const [approved] = cardsForToolCall(
      "list_drafts",
      {},
      { drafts: [{ id: "d-2", state: "approved", channel: "linkedin", content: "Shipped." }] },
    );
    // A button that would 409 is worse than no button: it teaches the founder
    // the cards are decorative.
    expect(approved!.actions).toEqual(["open"]);
  });

  it("renders a training example as a read-only draft card", () => {
    const [card] = cardsForToolCall(
      "find_similar_approved_drafts",
      { query: "pricing" },
      { drafts: [{ draftId: "d-3", channel: "linkedin", content: "Our pricing post", wasEdited: true }] },
    );
    expect(card).toMatchObject({ kind: "draft", ref: "draft:d-3", subtitle: "approved after edits" });
    expect(card!.actions).toEqual(["open"]);
  });

  it("skips an example with no draft behind it", () => {
    expect(
      cardsForToolCall("find_similar_approved_drafts", {}, { drafts: [{ draftId: null, content: "x" }] }),
    ).toEqual([]);
  });
});

describe("the other kinds", () => {
  it("maps evidence, signals, personas, publications, metrics and brain sections", () => {
    expect(
      cardsForToolCall("search_evidence", {}, { results: [{ documentId: "doc-9", title: "Pricing research", score: 0.912 }] })[0],
    ).toMatchObject({ kind: "evidence", ref: "evidence:doc-9", subtitle: "relevance 0.91" });

    expect(
      cardsForToolCall("search_discovery_items", {}, { items: [{ id: "i-1", title: "Rival raised", status: "new" }] })[0],
    ).toMatchObject({ kind: "signal", ref: "discovery_item:i-1" });

    expect(cardsForToolCall("list_personas", {}, { personas: [{ id: "p-1", name: "Head of RevOps" }] })[0]).toMatchObject({
      kind: "persona",
      ref: "persona:p-1",
    });

    expect(
      cardsForToolCall("list_recent_publications_with_metrics", {}, { publications: [{ id: "pub-1", title: "Launch post", channel: "linkedin" }] })[0],
    ).toMatchObject({ kind: "publication", ref: "publication:pub-1" });

    expect(
      cardsForToolCall("get_metric_summary", { subjectType: "campaign" }, { subjectType: "campaign", subjectId: "c-1", window: "7d", metrics: { clicks: 12 } })[0],
    ).toMatchObject({ kind: "metric", ref: "campaign:c-1" });

    expect(
      cardsForToolCall("get_brain_section", {}, { docType: "voice", sectionId: "tone", heading: "Tone", content: "Plain." })[0],
    ).toMatchObject({ kind: "brain", ref: "brain:voice#tone" });
  });

  it("takes the sequence id from the request, since the funnel returns counts", () => {
    const [card] = cardsForToolCall("get_sequence_funnel", { sequenceId: "seq-1" }, { sent: 10, replied: 2 });
    expect(card).toMatchObject({ kind: "metric", ref: "outreach_sequence:seq-1" });
    expect(card!.fields).toContainEqual({ label: "Sent", value: "10" });
  });
});

describe("robustness", () => {
  it("produces nothing for a failed result", () => {
    expect(cardsForToolCall("list_campaigns", {}, { error: "not_found" })).toEqual([]);
    expect(cardsForToolCall("search_evidence", {}, { error: "unavailable", results: [] })).toEqual([]);
  });

  it("survives a tool whose shape drifted, rather than throwing the turn", () => {
    expect(cardsForToolCall("list_campaigns", {}, null)).toEqual([]);
    expect(cardsForToolCall("list_campaigns", {}, { campaigns: "not an array" })).toEqual([]);
    expect(cardsForToolCall("list_campaigns", {}, { campaigns: [{ name: "no id" }] })).toEqual([]);
    expect(cardsForToolCall("a_tool_that_does_not_exist", {}, { anything: true })).toEqual([]);
  });

  it("renders no cards for the untrusted fetch or a propose call", () => {
    // A fetched page is a citation, deliberately. A propose call's result is a
    // confirmation card, which is a different thing entirely.
    expect(cardsForToolCall("safe_fetch_url", { url: "https://x.test" }, { finalUrl: "https://x.test", text: "hi" })).toEqual([]);
    expect(cardsForToolCall("propose_draft", {}, { ok: true, id: "d-1" })).toEqual([]);
  });

  it("dedupes on kind and ref and caps the turn", () => {
    const many = Array.from({ length: CHAT_CARDS_PER_TURN + 5 }, (_, i) => ({
      id: `c-${i}`,
      name: `Campaign ${i}`,
      status: "active",
    }));
    const cards = dedupeCards(cardsForToolCall("list_campaigns", {}, { campaigns: many }));
    expect(cards).toHaveLength(CHAT_CARDS_PER_TURN);

    const duplicated = dedupeCards([
      ...cardsForToolCall("list_campaigns", {}, { campaigns: [{ id: "c-1", name: "A" }] }),
      ...cardsForToolCall("list_campaigns", {}, { campaigns: [{ id: "c-1", name: "A again" }] }),
    ]);
    expect(duplicated).toHaveLength(1);
    expect(duplicated[0]!.title).toBe("A");
  });
});

describe("the render hints and this mapper stay in lockstep", () => {
  it("every hinted tool produces a card of the kind it declared", () => {
    // The map is the contract; this asserts the implementation honours it, so a
    // hint added without a case here fails loudly rather than silently.
    const samples: Record<string, { args: unknown; result: unknown }> = {
      list_campaigns: { args: {}, result: { campaigns: [{ id: "c", name: "n" }] } },
      get_campaign_plan: { args: {}, result: { campaign: { id: "c", name: "n" } } },
      get_campaign_insights: { args: {}, result: { campaign: { id: "c", name: "n" } } },
      list_drafts: { args: {}, result: { drafts: [{ id: "d", state: "approved", content: "x" }] } },
      find_similar_approved_drafts: { args: {}, result: { drafts: [{ draftId: "d", content: "x" }] } },
      find_instructive_rejections: { args: {}, result: { rejections: [{ draftId: "d", content: "x" }] } },
      list_recent_publications_with_metrics: { args: {}, result: { publications: [{ id: "p", title: "t" }] } },
      get_prior_posts_on_topic: { args: {}, result: { posts: [{ id: "p", title: "t" }] } },
      list_personas: { args: {}, result: { personas: [{ id: "p", name: "n" }] } },
      get_persona: { args: {}, result: { id: "p", name: "n" } },
      get_metric_summary: { args: {}, result: { subjectType: "campaign", window: "7d" } },
      get_workspace_insights: { args: {}, result: { metrics: { clicks: 1 } } },
      get_sequence_funnel: { args: { sequenceId: "s" }, result: { sent: 1 } },
      search_evidence: { args: {}, result: { results: [{ documentId: "d", title: "t" }] } },
      search_discovery_items: { args: {}, result: { items: [{ id: "i", title: "t" }] } },
      get_brain_section: { args: {}, result: { docType: "voice", sectionId: "s", heading: "h" } },
    };

    for (const [tool, kind] of Object.entries(TOOL_CARD_KINDS)) {
      const sample = samples[tool];
      expect(sample, `no sample for ${tool}`).toBeDefined();
      const cards = cardsForToolCall(tool, sample!.args, sample!.result);
      expect(cards.length, tool).toBeGreaterThan(0);
      expect(cards[0]!.kind, tool).toBe(kind);
      expect(cardKindForTool(tool), tool).toBe(kind);
    }
  });

  it("reports no kind for an unhinted tool", () => {
    expect(cardKindForTool("safe_fetch_url")).toBeNull();
    expect(cardKindForTool("propose_campaign")).toBeNull();
  });
});
