import { describe, expect, it } from "vitest";
import {
  APPROVAL_ACTIONS,
  APPROVAL_STATES,
  BRAIN_DOC_MAX_CHARS,
  canTransition,
  editDraftInputSchema,
  transitionTo,
  BRAIN_DOC_TYPES,
  CHANNELS,
  CONNECTOR_PROVIDERS,
  connectInputSchema,
  createWebhookInputSchema,
  OUTPUT_RATINGS,
  PERSONA_OVERLAY_MAX_CHARS,
  TASK_TYPES,
  brainDocumentSchema,
  createDiscoverySourceInputSchema,
  createLeadInputSchema,
  createMetricInputSchema,
  outboundDraftRequestSchema,
  createSignalInputSchema,
  DISCOVERY_SOURCE_TYPES,
  createWorkspaceInputSchema,
  generationSchema,
  rateGenerationInputSchema,
  resolveRequestSchema,
  updateBrainDocInputSchema,
  upsertCampaignInputSchema,
  upsertPersonaInputSchema,
  workspaceSchema,
} from "../src/index";

describe("brain doc types", () => {
  it("contains exactly the five planned docs in order", () => {
    expect(BRAIN_DOC_TYPES).toEqual(["soul", "icp", "voice", "history", "now"]);
  });
});

describe("approval states", () => {
  it("matches the planned state machine vocabulary", () => {
    expect(APPROVAL_STATES).toEqual([
      "draft",
      "pending_review",
      "approved",
      "rejected",
      "edited",
    ]);
  });
});

describe("output ratings", () => {
  it("matches the planned training signal vocabulary", () => {
    expect(OUTPUT_RATINGS).toEqual(["accepted", "needs_edit", "rejected"]);
  });
});

describe("createWorkspaceInputSchema", () => {
  it("accepts a valid name and trims whitespace", () => {
    const parsed = createWorkspaceInputSchema.parse({ name: "  Hexalog  " });
    expect(parsed.name).toBe("Hexalog");
  });

  it("rejects an empty name", () => {
    expect(createWorkspaceInputSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    expect(createWorkspaceInputSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects a name longer than 100 characters", () => {
    const name = "x".repeat(101);
    expect(createWorkspaceInputSchema.safeParse({ name }).success).toBe(false);
  });

  it("rejects a missing name", () => {
    expect(createWorkspaceInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("task types and channels", () => {
  it("matches the planned task types", () => {
    expect(TASK_TYPES).toEqual([
      "linkedin_post",
      "cold_email_opener",
      "ad_copy_variant",
      "landing_page_hero",
      "signal_response",
      "outbound_email",
    ]);
  });

  it("covers the planned channels", () => {
    expect(CHANNELS).toEqual(["linkedin", "x", "email", "ads", "web"]);
  });
});

describe("upsertPersonaInputSchema", () => {
  it("accepts a persona and applies defaults", () => {
    const parsed = upsertPersonaInputSchema.parse({ name: "CEO" });
    expect(parsed).toEqual({ name: "CEO", description: "", overlay: "" });
  });

  it("trims name and description", () => {
    const parsed = upsertPersonaInputSchema.parse({
      name: "  CEO  ",
      description: "  Founder voice  ",
    });
    expect(parsed.name).toBe("CEO");
    expect(parsed.description).toBe("Founder voice");
  });

  it("rejects an empty name", () => {
    expect(upsertPersonaInputSchema.safeParse({ name: " " }).success).toBe(false);
  });

  it("rejects an oversized overlay", () => {
    const overlay = "x".repeat(PERSONA_OVERLAY_MAX_CHARS + 1);
    expect(upsertPersonaInputSchema.safeParse({ name: "CEO", overlay }).success).toBe(false);
  });
});

describe("resolveRequestSchema", () => {
  it("accepts a minimal request", () => {
    const result = resolveRequestSchema.safeParse({ taskType: "linkedin_post", channel: "linkedin" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown task type", () => {
    const result = resolveRequestSchema.safeParse({ taskType: "tiktok_dance", channel: "linkedin" });
    expect(result.success).toBe(false);
  });

  it("rejects a token budget below the floor", () => {
    const result = resolveRequestSchema.safeParse({
      taskType: "linkedin_post",
      channel: "linkedin",
      tokenBudget: 100,
    });
    expect(result.success).toBe(false);
  });
});

describe("updateBrainDocInputSchema", () => {
  it("accepts normal markdown content", () => {
    const result = updateBrainDocInputSchema.safeParse({ content: "# Soul\n\nWe exist to..." });
    expect(result.success).toBe(true);
  });

  it("accepts empty content (clearing a doc is allowed)", () => {
    expect(updateBrainDocInputSchema.safeParse({ content: "" }).success).toBe(true);
  });

  it("rejects content over the max length", () => {
    const content = "x".repeat(BRAIN_DOC_MAX_CHARS + 1);
    expect(updateBrainDocInputSchema.safeParse({ content }).success).toBe(false);
  });

  it("rejects a missing content field", () => {
    expect(updateBrainDocInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("brainDocumentSchema", () => {
  it("accepts a valid brain document", () => {
    const result = brainDocumentSchema.safeParse({
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      workspaceId: "9b2c8a44-1d2e-4f5a-8b6c-7d8e9f0a1b2c",
      docType: "soul",
      content: "",
      createdAt: 1765400000000,
      updatedAt: 1765400000000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown doc type", () => {
    const result = brainDocumentSchema.safeParse({
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      workspaceId: "9b2c8a44-1d2e-4f5a-8b6c-7d8e9f0a1b2c",
      docType: "strategy",
      content: "",
      createdAt: 1765400000000,
      updatedAt: 1765400000000,
    });
    expect(result.success).toBe(false);
  });
});

describe("connector contracts", () => {
  it("registers smartlead and instantly as api_key providers", () => {
    const byKey = Object.fromEntries(CONNECTOR_PROVIDERS.map((p) => [p.key, p]));
    expect(byKey.smartlead?.authMode).toBe("api_key");
    expect(byKey.instantly?.authMode).toBe("api_key");
    expect(byKey.hubspot?.authMode).toBe("oauth");
    expect(byKey.custom).toBeDefined();
  });

  it("connect input accepts api key, basic, or no credentials (enforced per provider)", () => {
    expect(connectInputSchema.safeParse({}).success).toBe(true);
    expect(connectInputSchema.safeParse({ apiKey: "sk-123" }).success).toBe(true);
    expect(connectInputSchema.safeParse({ username: "u", password: "p" }).success).toBe(true);
    expect(connectInputSchema.safeParse({ baseUrl: "not-a-url" }).success).toBe(false);
  });

  it("custom provider is credential-less", () => {
    const custom = CONNECTOR_PROVIDERS.find((p) => p.key === "custom");
    expect(custom?.authMode).toBe("none");
  });

  it("webhook input validates url and event types", () => {
    expect(
      createWebhookInputSchema.safeParse({ url: "https://hooks.example.com/x", eventTypes: ["draft.approved"] })
        .success,
    ).toBe(true);
    expect(createWebhookInputSchema.safeParse({ url: "nope", eventTypes: ["draft.approved"] }).success).toBe(false);
    expect(
      createWebhookInputSchema.safeParse({ url: "https://x.io", eventTypes: [] }).success,
    ).toBe(false);
    expect(
      createWebhookInputSchema.safeParse({ url: "https://x.io", eventTypes: ["bogus.event"] }).success,
    ).toBe(false);
  });
});

describe("lead schemas", () => {
  it("accepts a lead with defaults", () => {
    const parsed = createLeadInputSchema.parse({ name: "Asha", email: "asha@acme.io" });
    expect(parsed.company).toBe("");
    expect(parsed.notes).toBe("");
  });

  it("rejects an invalid email", () => {
    expect(createLeadInputSchema.safeParse({ name: "X", email: "not-an-email" }).success).toBe(
      false,
    );
  });

  it("bounds outbound batches to 25 leads", () => {
    const leadIds = Array.from({ length: 26 }, () => "7c9e6679-7425-40de-944b-e07fc1f90ae7");
    expect(outboundDraftRequestSchema.safeParse({ leadIds }).success).toBe(false);
    expect(outboundDraftRequestSchema.safeParse({ leadIds: [] }).success).toBe(false);
    expect(
      outboundDraftRequestSchema.safeParse({ leadIds: leadIds.slice(0, 3) }).success,
    ).toBe(true);
  });
});

describe("createMetricInputSchema", () => {
  it("accepts a minimal metric", () => {
    const parsed = createMetricInputSchema.parse({ channel: "linkedin" });
    expect(parsed.description).toBe("");
    expect(parsed.notes).toBe("");
  });

  it("accepts full metrics", () => {
    const result = createMetricInputSchema.safeParse({
      channel: "linkedin",
      description: "June launch post",
      impressions: 12000,
      engagements: 340,
      clicks: 85,
      notes: "Best performer this month",
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative numbers", () => {
    expect(
      createMetricInputSchema.safeParse({ channel: "linkedin", impressions: -1 }).success,
    ).toBe(false);
  });

  it("rejects an unknown channel", () => {
    expect(createMetricInputSchema.safeParse({ channel: "tiktok" }).success).toBe(false);
  });
});

describe("upsertCampaignInputSchema", () => {
  it("accepts a name-only campaign with defaults", () => {
    const parsed = upsertCampaignInputSchema.parse({ name: "Rebuild launch" });
    expect(parsed.status).toBe("active");
    expect(parsed.pillars).toEqual([]);
    expect(parsed.channels).toEqual([]);
    expect(parsed.overlay).toBe("");
  });

  it("accepts a full campaign", () => {
    const result = upsertCampaignInputSchema.safeParse({
      name: "Q3 GTM memory push",
      objective: "Position Tuezday as the GTM memory layer",
      kpi: "20 demo calls",
      timeframe: "Jul-Sep 2026",
      audience: "Founder-led SaaS, 5-50 employees",
      pillars: ["GTM that remembers", "Brain before pipeline"],
      channels: ["linkedin", "email"],
      personaIds: [],
      overlay: "This quarter we lead with the memory problem.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(upsertCampaignInputSchema.safeParse({ name: " " }).success).toBe(false);
  });

  it("rejects more than 10 pillars", () => {
    const pillars = Array.from({ length: 11 }, (_, i) => `pillar ${i}`);
    expect(upsertCampaignInputSchema.safeParse({ name: "X", pillars }).success).toBe(false);
  });

  it("rejects an unknown channel", () => {
    expect(
      upsertCampaignInputSchema.safeParse({ name: "X", channels: ["tiktok"] }).success,
    ).toBe(false);
  });
});

describe("createSignalInputSchema", () => {
  it("accepts a pasted signal with source and url", () => {
    const result = createSignalInputSchema.safeParse({
      content: "Saw this thread complaining about AI content all sounding the same.",
      source: "reddit",
      sourceUrl: "https://reddit.com/r/marketing/comments/abc123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a signal without a url", () => {
    const result = createSignalInputSchema.safeParse({ content: "Customer quote.", source: "other" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty signal", () => {
    expect(createSignalInputSchema.safeParse({ content: "  ", source: "x" }).success).toBe(false);
  });

  it("rejects an unknown source", () => {
    expect(
      createSignalInputSchema.safeParse({ content: "hi", source: "tiktok" }).success,
    ).toBe(false);
  });

  it("rejects an invalid url", () => {
    expect(
      createSignalInputSchema.safeParse({ content: "hi", source: "x", sourceUrl: "not-a-url" })
        .success,
    ).toBe(false);
  });
});

describe("createDiscoverySourceInputSchema", () => {
  it("accepts an rss source with a feed url", () => {
    const result = createDiscoverySourceInputSchema.safeParse({
      type: "rss",
      config: { feedUrl: "https://example.com/feed.xml" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an rss source without a feed url", () => {
    expect(createDiscoverySourceInputSchema.safeParse({ type: "rss", config: {} }).success).toBe(
      false,
    );
  });

  it("accepts a google_news source with a query", () => {
    const result = createDiscoverySourceInputSchema.safeParse({
      type: "google_news",
      config: { query: "GTM orchestration" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a reddit source with only a subreddit", () => {
    const result = createDiscoverySourceInputSchema.safeParse({
      type: "reddit",
      config: { subreddit: "SaaS" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a reddit source with neither query nor subreddit", () => {
    expect(
      createDiscoverySourceInputSchema.safeParse({ type: "reddit", config: {} }).success,
    ).toBe(false);
  });

  it("accepts an x source with a query (infra registered before keys exist)", () => {
    const result = createDiscoverySourceInputSchema.safeParse({
      type: "x",
      config: { query: "GTM memory" },
    });
    expect(result.success).toBe(true);
  });

  it("covers the planned source types", () => {
    expect(DISCOVERY_SOURCE_TYPES).toEqual(["rss", "google_news", "reddit", "x", "linkedin"]);
  });
});

describe("approval state machine", () => {
  it("allows the full happy path: submit -> edit -> resubmit -> approve", () => {
    expect(transitionTo("draft", "submit")).toBe("pending_review");
    expect(transitionTo("pending_review", "edit")).toBe("edited");
    expect(transitionTo("edited", "resubmit")).toBe("pending_review");
    expect(transitionTo("pending_review", "approve")).toBe("approved");
  });

  it("allows edit-before-approve in one step from edited", () => {
    expect(transitionTo("edited", "approve")).toBe("approved");
    expect(transitionTo("edited", "reject")).toBe("rejected");
  });

  it("allows re-editing an edited draft", () => {
    expect(transitionTo("edited", "edit")).toBe("edited");
  });

  it("allows rejection from pending_review", () => {
    expect(transitionTo("pending_review", "reject")).toBe("rejected");
  });

  it("treats approved and rejected as terminal", () => {
    for (const state of ["approved", "rejected"] as const) {
      for (const action of APPROVAL_ACTIONS) {
        expect(canTransition(state, action)).toBe(false);
      }
    }
  });

  it("refuses approving or editing an unsubmitted draft", () => {
    expect(canTransition("draft", "approve")).toBe(false);
    expect(canTransition("draft", "edit")).toBe(false);
    expect(canTransition("draft", "reject")).toBe(false);
  });

  it("refuses resubmitting anything that is not edited", () => {
    expect(canTransition("draft", "resubmit")).toBe(false);
    expect(canTransition("pending_review", "resubmit")).toBe(false);
  });

  it("refuses double submission", () => {
    expect(canTransition("pending_review", "submit")).toBe(false);
  });
});

describe("editDraftInputSchema", () => {
  it("accepts normal content", () => {
    expect(editDraftInputSchema.safeParse({ content: "Edited post." }).success).toBe(true);
  });

  it("rejects empty content", () => {
    expect(editDraftInputSchema.safeParse({ content: "" }).success).toBe(false);
  });
});

describe("rateGenerationInputSchema", () => {
  it("accepts each valid rating", () => {
    for (const rating of OUTPUT_RATINGS) {
      expect(rateGenerationInputSchema.safeParse({ rating }).success).toBe(true);
    }
  });

  it("rejects an unknown rating", () => {
    expect(rateGenerationInputSchema.safeParse({ rating: "meh" }).success).toBe(false);
  });
});

describe("generationSchema", () => {
  it("accepts a stored generation with nullable rating fields", () => {
    const result = generationSchema.safeParse({
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      workspaceId: "9b2c8a44-1d2e-4f5a-8b6c-7d8e9f0a1b2c",
      taskType: "linkedin_post",
      channel: "linkedin",
      personaId: null,
      campaignId: null,
      leadId: null,
      prompt: "## Soul\n\n...",
      output: "Here is a post.",
      model: "gemini-2.5-flash",
      provider: "gemini",
      durationMs: 1200,
      rating: null,
      ratedAt: null,
      createdAt: 1765400000000,
    });
    expect(result.success).toBe(true);
  });
});

describe("workspaceSchema", () => {
  it("accepts a full workspace record", () => {
    const result = workspaceSchema.safeParse({
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      name: "Tuezday",
      createdAt: 1765400000000,
      updatedAt: 1765400000000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid id", () => {
    const result = workspaceSchema.safeParse({
      id: "not-a-uuid",
      name: "Tuezday",
      createdAt: 1765400000000,
      updatedAt: 1765400000000,
    });
    expect(result.success).toBe(false);
  });
});
