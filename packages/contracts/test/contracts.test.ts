import { describe, expect, it } from "vitest";
import {
  AD_CREATIVE_FORMATS,
  AD_CREATIVE_TASK_TYPES,
  adAccountSchema,
  formatAdCreative,
  generateAdCreativesInputSchema,
  isAdCreativeTaskType,
  parseAdCreative,
  validateAdCreative,
  adCampaignSchema,
  adDailyMetricSchema,
  adsCsvImportInputSchema,
  adsSyncInputSchema,
  APPROVAL_ACTIONS,
  APPROVAL_STATES,
  BRAIN_DOC_MAX_CHARS,
  canTransition,
  editDraftInputSchema,
  importAdAccountsInputSchema,
  linkAdCampaignInputSchema,
  transitionTo,
  BRAIN_DOC_TYPES,
  CHANNELS,
  CHANNEL_GUIDANCE_DEFAULTS,
  CHANNEL_LABELS,
  GUIDANCE_SOURCES,
  channelGuidanceSchema,
  updateGuidanceInputSchema,
  CONNECTOR_AUTH_MODES,
  CONNECTOR_CATEGORIES,
  CONNECTOR_PROVIDERS,
  connectInputSchema,
  createWebhookInputSchema,
  crmContactSchema,
  crmSyncFilterInputSchema,
  crmSyncFilterSchema,
  crmSyncInputSchema,
  crmViewSchema,
  EVENT_TYPES,
  logDraftInputSchema,
  pushLeadInputSchema,
  OUTPUT_RATINGS,
  PERSONA_OVERLAY_MAX_CHARS,
  PUBLICATION_STATUSES,
  publicationSchema,
  publishDraftInputSchema,
  SOCIAL_POST_CONSTRAINTS,
  validateSocialPost,
  TASK_TYPES,
  brainDocumentSchema,
  createDiscoverySourceInputSchema,
  createLeadInputSchema,
  createMediaContactInputSchema,
  createMetricInputSchema,
  importMediaContactsInputSchema,
  MEDIA_CONTACT_TYPES,
  mediaContactSchema,
  PR_PITCH_TYPES,
  pressKitRequestSchema,
  prPitchRequestSchema,
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
      "meta_ad_creative",
      "google_rsa",
      "pr_pitch",
      "press_boilerplate",
    ]);
  });

  it("covers the planned channels", () => {
    expect(CHANNELS).toEqual(["linkedin", "x", "email", "ads", "web", "pr"]);
  });
});

describe("channel guidance (Sprint 21)", () => {
  it("provides a built-in default and a label for every channel", () => {
    for (const channel of CHANNELS) {
      expect(CHANNEL_GUIDANCE_DEFAULTS[channel].length).toBeGreaterThan(0);
      expect(CHANNEL_LABELS[channel].length).toBeGreaterThan(0);
    }
  });

  it("defines the guidance source vocabulary", () => {
    expect(GUIDANCE_SOURCES).toEqual(["default", "workspace"]);
  });

  it("validates a resolved guidance row, including a null updatedAt for defaults", () => {
    expect(
      channelGuidanceSchema.safeParse({
        channel: "linkedin",
        content: CHANNEL_GUIDANCE_DEFAULTS.linkedin,
        source: "default",
        updatedAt: null,
      }).success,
    ).toBe(true);
    expect(
      channelGuidanceSchema.safeParse({
        channel: "linkedin",
        content: "Override.",
        source: "workspace",
        updatedAt: 1765400000000,
      }).success,
    ).toBe(true);
    expect(
      channelGuidanceSchema.safeParse({
        channel: "tiktok",
        content: "x",
        source: "workspace",
        updatedAt: 1,
      }).success,
    ).toBe(false);
  });

  it("requires non-empty guidance content within the length cap", () => {
    expect(updateGuidanceInputSchema.safeParse({ content: "Open with a contrarian line." }).success).toBe(
      true,
    );
    expect(updateGuidanceInputSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(updateGuidanceInputSchema.safeParse({ content: "x".repeat(4001) }).success).toBe(false);
  });

  it("trims guidance content", () => {
    expect(updateGuidanceInputSchema.parse({ content: "  hello  " }).content).toBe("hello");
  });
});

describe("PR & media outreach (Sprint 16)", () => {
  const contactId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const signalId = "9b2e8f00-1111-4222-8333-444455556666";

  it("defines the media contact types", () => {
    expect(MEDIA_CONTACT_TYPES).toEqual(["journalist", "publication", "podcast"]);
  });

  it("defines the pitch types", () => {
    expect(PR_PITCH_TYPES).toEqual(["announcement", "thought_leadership", "reactive"]);
  });

  it("accepts a media contact and applies defaults", () => {
    const parsed = createMediaContactInputSchema.parse({
      name: "Riya Sen",
      email: "RIYA@techcrunch.com ",
    });
    expect(parsed).toEqual({
      name: "Riya Sen",
      email: "RIYA@techcrunch.com",
      type: "journalist",
      outlet: "",
      beat: "",
      coverageNotes: "",
    });
  });

  it("rejects a media contact with a bad email or unknown type", () => {
    expect(createMediaContactInputSchema.safeParse({ name: "X", email: "nope" }).success).toBe(false);
    expect(
      createMediaContactInputSchema.safeParse({ name: "X", email: "x@y.io", type: "influencer" })
        .success,
    ).toBe(false);
  });

  it("rejects an over-long beat", () => {
    expect(
      createMediaContactInputSchema.safeParse({
        name: "X",
        email: "x@y.io",
        beat: "b".repeat(201),
      }).success,
    ).toBe(false);
  });

  it("validates the full media contact schema", () => {
    expect(
      mediaContactSchema.safeParse({
        id: contactId,
        workspaceId: signalId,
        name: "Riya Sen",
        email: "riya@techcrunch.com",
        type: "podcast",
        outlet: "TechCrunch",
        beat: "AI startups",
        coverageNotes: "",
        createdAt: 1,
      }).success,
    ).toBe(true);
  });

  it("requires CSV content for import", () => {
    expect(importMediaContactsInputSchema.safeParse({ csv: "" }).success).toBe(false);
    expect(importMediaContactsInputSchema.safeParse({ csv: "name,email" }).success).toBe(true);
  });

  it("requires a signal for a reactive pitch", () => {
    expect(
      prPitchRequestSchema.safeParse({ contactIds: [contactId], pitchType: "reactive" }).success,
    ).toBe(false);
    expect(
      prPitchRequestSchema.safeParse({
        contactIds: [contactId],
        pitchType: "reactive",
        signalId,
      }).success,
    ).toBe(true);
  });

  it("rejects a signal on non-reactive pitches", () => {
    for (const pitchType of ["announcement", "thought_leadership"] as const) {
      expect(
        prPitchRequestSchema.safeParse({ contactIds: [contactId], pitchType }).success,
      ).toBe(true);
      expect(
        prPitchRequestSchema.safeParse({ contactIds: [contactId], pitchType, signalId }).success,
      ).toBe(false);
    }
  });

  it("bounds the contact batch at 1-25", () => {
    expect(
      prPitchRequestSchema.safeParse({ contactIds: [], pitchType: "announcement" }).success,
    ).toBe(false);
    expect(
      prPitchRequestSchema.safeParse({
        contactIds: Array.from({ length: 26 }, () => contactId),
        pitchType: "announcement",
      }).success,
    ).toBe(false);
  });

  it("accepts an empty press kit request", () => {
    expect(pressKitRequestSchema.safeParse({}).success).toBe(true);
    expect(pressKitRequestSchema.safeParse({ tokenBudget: 100 }).success).toBe(false);
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

describe("crm contracts", () => {
  it("registers freshsales as an api_key CRM provider needing a base url", () => {
    const freshsales = CONNECTOR_PROVIDERS.find((p) => p.key === "freshsales");
    expect(freshsales?.authMode).toBe("api_key");
    expect(freshsales?.nangoProvider).toBe("freshsales");
    expect(freshsales?.categories).toContain("crm");
    expect(freshsales?.requiresBaseUrl).toBe(true);
  });

  it("marks the oauth CRMs with the crm category for later", () => {
    const byKey = Object.fromEntries(CONNECTOR_PROVIDERS.map((p) => [p.key, p]));
    expect(byKey.pipedrive?.categories).toContain("crm");
    expect(byKey.hubspot?.categories).toContain("crm");
    expect(byKey.smartlead?.categories).not.toContain("crm");
  });

  it("includes the CRM write events in the event vocabulary", () => {
    expect(EVENT_TYPES).toContain("crm.contact.created");
    expect(EVENT_TYPES).toContain("crm.note.logged");
  });

  it("accepts a mirror contact with empty email and no lead link", () => {
    const result = crmContactSchema.safeParse({
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      workspaceId: "9b2c8a44-1d2e-4f5a-8b6c-7d8e9f0a1b2c",
      connectionId: "1c2d3e44-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
      externalId: "42",
      name: "No Email",
      email: "",
      company: "",
      role: "",
      leadId: null,
      discardedAt: null,
      lastSyncedAt: 1765400000000,
      createdAt: 1765400000000,
    });
    expect(result.success).toBe(true);
  });

  it("validates the CRM action inputs", () => {
    const uuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    expect(crmSyncInputSchema.safeParse({ connectionId: uuid }).success).toBe(true);
    expect(crmSyncInputSchema.safeParse({}).success).toBe(false);
    expect(pushLeadInputSchema.safeParse({ leadId: uuid, connectionId: uuid }).success).toBe(true);
    expect(pushLeadInputSchema.safeParse({ leadId: uuid }).success).toBe(false);
    expect(logDraftInputSchema.safeParse({ draftId: uuid }).success).toBe(true);
    expect(logDraftInputSchema.safeParse({ draftId: "nope" }).success).toBe(false);
  });

  it("validates the sync filter, its input wrapper, and views (Sprint 23)", () => {
    const uuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    // Empty filter is valid (no scoping); populated filter is valid.
    expect(crmSyncFilterSchema.safeParse({}).success).toBe(true);
    expect(
      crmSyncFilterSchema.safeParse({ viewId: "9", viewName: "Hot leads", updatedSince: 1765400000000 })
        .success,
    ).toBe(true);
    expect(crmSyncFilterSchema.safeParse({ updatedSince: "yesterday" }).success).toBe(false);
    expect(
      crmSyncFilterInputSchema.safeParse({ connectionId: uuid, filter: { viewId: "9" } }).success,
    ).toBe(true);
    expect(crmSyncFilterInputSchema.safeParse({ filter: {} }).success).toBe(false);
    expect(crmViewSchema.safeParse({ id: "9", name: "Hot leads" }).success).toBe(true);
    expect(crmViewSchema.safeParse({ id: 9, name: "Hot leads" }).success).toBe(false);
  });
});

describe("ads contracts", () => {
  const uuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  it("registers meta_ads as an access_token ads provider over the facebook template", () => {
    const metaAds = CONNECTOR_PROVIDERS.find((p) => p.key === "meta_ads");
    expect(metaAds?.authMode).toBe("access_token");
    expect(metaAds?.nangoProvider).toBe("facebook");
    expect(metaAds?.categories).toContain("ads");
    expect(metaAds?.baseUrl).toBe("https://graph.facebook.com");
    expect(metaAds?.testPath?.startsWith("/")).toBe(true);
  });

  it("extends the auth-mode and category vocabularies", () => {
    expect(CONNECTOR_AUTH_MODES).toContain("access_token");
    expect(CONNECTOR_CATEGORIES).toContain("ads");
  });

  it("includes ads.synced in the event vocabulary", () => {
    expect(EVENT_TYPES).toContain("ads.synced");
  });

  it("accepts an access token in the connect input", () => {
    expect(connectInputSchema.safeParse({ accessToken: "EAAB..." }).success).toBe(true);
    expect(connectInputSchema.safeParse({ accessToken: "  " }).success).toBe(false);
  });

  it("accepts a synced ad account and a CSV-only account (null connection)", () => {
    const base = {
      id: uuid,
      workspaceId: uuid,
      externalId: "act_123",
      name: "Tuezday Main",
      currency: "USD",
      lastSyncedAt: 1765400000000,
      lastError: null,
      createdAt: 1765400000000,
    };
    expect(adAccountSchema.safeParse({ ...base, connectionId: uuid }).success).toBe(true);
    expect(
      adAccountSchema.safeParse({ ...base, connectionId: null, lastSyncedAt: null }).success,
    ).toBe(true);
  });

  it("accepts an ad campaign with and without a Tuezday campaign link", () => {
    const base = {
      id: uuid,
      workspaceId: uuid,
      adAccountId: uuid,
      externalId: "238412",
      name: "Lead gen June",
      lastSyncedAt: 1765400000000,
      createdAt: 1765400000000,
    };
    expect(adCampaignSchema.safeParse({ ...base, campaignId: uuid }).success).toBe(true);
    expect(adCampaignSchema.safeParse({ ...base, campaignId: null }).success).toBe(true);
  });

  it("validates daily metric rows: date format, integer cents, source vocabulary", () => {
    const row = {
      id: uuid,
      adCampaignId: uuid,
      date: "2026-06-10",
      spendCents: 1234,
      impressions: 4000,
      clicks: 85,
      conversions: 6,
      source: "sync",
    };
    expect(adDailyMetricSchema.safeParse(row).success).toBe(true);
    expect(adDailyMetricSchema.safeParse({ ...row, source: "csv" }).success).toBe(true);
    expect(adDailyMetricSchema.safeParse({ ...row, date: "10/06/2026" }).success).toBe(false);
    expect(adDailyMetricSchema.safeParse({ ...row, spendCents: 12.34 }).success).toBe(false);
    expect(adDailyMetricSchema.safeParse({ ...row, clicks: -1 }).success).toBe(false);
    expect(adDailyMetricSchema.safeParse({ ...row, source: "manual" }).success).toBe(false);
  });

  it("validates the ads action inputs", () => {
    expect(importAdAccountsInputSchema.safeParse({ connectionId: uuid }).success).toBe(true);
    expect(importAdAccountsInputSchema.safeParse({}).success).toBe(false);
    expect(adsSyncInputSchema.safeParse({}).success).toBe(true);
    expect(
      adsSyncInputSchema.safeParse({ since: "2026-05-01", until: "2026-05-28" }).success,
    ).toBe(true);
    expect(adsSyncInputSchema.safeParse({ since: "May 1" }).success).toBe(false);
    expect(linkAdCampaignInputSchema.safeParse({ campaignId: uuid }).success).toBe(true);
    expect(linkAdCampaignInputSchema.safeParse({ campaignId: null }).success).toBe(true);
    expect(linkAdCampaignInputSchema.safeParse({}).success).toBe(false);
  });

  it("validates CSV import rows: spend in currency units, caps the batch", () => {
    const row = {
      date: "2026-06-01",
      campaignName: "Launch",
      spend: 12.34,
      impressions: 100,
      clicks: 5,
      conversions: 1,
    };
    expect(adsCsvImportInputSchema.safeParse({ rows: [row] }).success).toBe(true);
    const parsed = adsCsvImportInputSchema.parse({ rows: [row] });
    expect(parsed.currency).toBe("USD");
    expect(adsCsvImportInputSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(
      adsCsvImportInputSchema.safeParse({ rows: [{ ...row, spend: -1 }] }).success,
    ).toBe(false);
    expect(
      adsCsvImportInputSchema.safeParse({ rows: [{ ...row, campaignName: " " }] }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: 5001 }, () => row);
    expect(adsCsvImportInputSchema.safeParse({ rows: tooMany }).success).toBe(false);
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
      mediaContactId: null,
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

describe("ad creative formats (Sprint 15)", () => {
  it("registers both platforms with the planned hard limits", () => {
    expect(AD_CREATIVE_TASK_TYPES).toEqual(["meta_ad_creative", "google_rsa"]);
    const meta = AD_CREATIVE_FORMATS.meta_ad_creative;
    expect(meta.fields).toEqual([
      { key: "primary_text", label: "Primary text", maxChars: 125, minCount: 1, maxCount: 1 },
      { key: "headline", label: "Headline", maxChars: 40, minCount: 1, maxCount: 1 },
      { key: "description", label: "Description", maxChars: 30, minCount: 1, maxCount: 1 },
    ]);
    expect(meta.variantCount).toEqual({ min: 1, max: 10, default: 3 });

    const rsa = AD_CREATIVE_FORMATS.google_rsa;
    expect(rsa.fields).toEqual([
      { key: "headline", label: "Headline", maxChars: 30, minCount: 3, maxCount: 15 },
      { key: "description", label: "Description", maxChars: 90, minCount: 2, maxCount: 4 },
    ]);
    expect(rsa.variantCount).toBeNull();
  });

  it("identifies ad creative task types", () => {
    expect(isAdCreativeTaskType("meta_ad_creative")).toBe(true);
    expect(isAdCreativeTaskType("google_rsa")).toBe(true);
    expect(isAdCreativeTaskType("linkedin_post")).toBe(false);
    expect(isAdCreativeTaskType("ad_copy_variant")).toBe(false);
  });
});

describe("parseAdCreative", () => {
  it("parses a Meta variant", () => {
    const parsed = parseAdCreative(
      "meta_ad_creative",
      "Primary text: Ship GTM faster.\nHeadline: Your brain, on every channel\nDescription: Try Tuezday free",
    );
    expect(parsed).toEqual({
      fields: [
        { key: "primary_text", index: 1, value: "Ship GTM faster." },
        { key: "headline", index: 1, value: "Your brain, on every channel" },
        { key: "description", index: 1, value: "Try Tuezday free" },
      ],
    });
  });

  it("keeps multi-line primary text in one field and is case-insensitive", () => {
    const parsed = parseAdCreative(
      "meta_ad_creative",
      "primary TEXT: Line one.\nLine two.\nHEADLINE: Hi\nDescription: There",
    );
    expect(parsed!.fields[0]).toEqual({ key: "primary_text", index: 1, value: "Line one.\nLine two." });
    expect(parsed!.fields).toHaveLength(3);
  });

  it("parses numbered Google RSA labels and auto-numbers unnumbered repeats", () => {
    const numbered = parseAdCreative(
      "google_rsa",
      "Headline 1: A\nHeadline 2: B\nHeadline 3: C\nDescription 1: D\nDescription 2: E",
    );
    expect(numbered!.fields.map((f) => [f.key, f.index])).toEqual([
      ["headline", 1],
      ["headline", 2],
      ["headline", 3],
      ["description", 1],
      ["description", 2],
    ]);

    const unnumbered = parseAdCreative(
      "google_rsa",
      "Headline: A\nHeadline: B\nHeadline: C\nDescription: D\nDescription: E",
    );
    expect(unnumbered!.fields.map((f) => [f.key, f.index])).toEqual([
      ["headline", 1],
      ["headline", 2],
      ["headline", 3],
      ["description", 1],
      ["description", 2],
    ]);
  });

  it("returns null for content that is not the canonical format", () => {
    expect(parseAdCreative("meta_ad_creative", "Just a paragraph of prose.")).toBeNull();
    expect(parseAdCreative("meta_ad_creative", "")).toBeNull();
    expect(
      parseAdCreative("meta_ad_creative", "Preamble first\nHeadline: too late"),
    ).toBeNull();
  });

  it("round-trips through formatAdCreative", () => {
    const content = "Primary text: One.\nTwo.\nHeadline: Hi\nDescription: There";
    const parsed = parseAdCreative("meta_ad_creative", content)!;
    expect(formatAdCreative("meta_ad_creative", parsed.fields)).toBe(content);

    const rsa = "Headline 1: A\nHeadline 2: B\nHeadline 3: C\nDescription 1: D\nDescription 2: E";
    expect(formatAdCreative("google_rsa", parseAdCreative("google_rsa", rsa)!.fields)).toBe(rsa);
  });
});

describe("validateAdCreative", () => {
  it("accepts a valid Meta variant", () => {
    const result = validateAdCreative(
      "meta_ad_creative",
      "Primary text: Ship GTM faster.\nHeadline: Hi\nDescription: There",
    );
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it("flags over-limit fields with the exact counts", () => {
    const result = validateAdCreative(
      "meta_ad_creative",
      `Primary text: Fine.\nHeadline: ${"x".repeat(41)}\nDescription: ok`,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { field: "Headline", message: "Headline is 41 characters (max 40)." },
    ]);
  });

  it("flags missing and empty fields", () => {
    const missing = validateAdCreative("meta_ad_creative", "Headline: Hi\nDescription: There");
    expect(missing.ok).toBe(false);
    expect(missing.violations.some((v) => v.field === "Primary text")).toBe(true);

    const empty = validateAdCreative(
      "meta_ad_creative",
      "Primary text: Fine.\nHeadline:\nDescription: There",
    );
    expect(empty.violations).toEqual([{ field: "Headline", message: "Headline is empty." }]);
  });

  it("enforces Google RSA counts and numbering", () => {
    const tooFew = validateAdCreative("google_rsa", "Headline 1: A\nHeadline 2: B\nDescription 1: D");
    expect(tooFew.ok).toBe(false);
    expect(tooFew.violations.map((v) => v.field)).toEqual(["Headline", "Description"]);

    const dupe = validateAdCreative(
      "google_rsa",
      "Headline 1: A\nHeadline 1: B\nHeadline 3: C\nDescription 1: D\nDescription 2: E",
    );
    expect(dupe.ok).toBe(false);
    expect(dupe.violations).toEqual([
      { field: "Headline 1", message: "Headline 1 appears more than once." },
    ]);

    const tooMany = validateAdCreative(
      "google_rsa",
      `${Array.from({ length: 16 }, (_, i) => `Headline ${i + 1}: H${i + 1}`).join("\n")}\nDescription 1: D\nDescription 2: E`,
    );
    expect(tooMany.ok).toBe(false);
    expect(tooMany.violations.map((v) => v.field)).toContain("Headline");
    expect(tooMany.violations.map((v) => v.field)).toContain("Headline 16");

    const overChars = validateAdCreative(
      "google_rsa",
      `Headline 1: ${"x".repeat(31)}\nHeadline 2: B\nHeadline 3: C\nDescription 1: D\nDescription 2: E`,
    );
    expect(overChars.violations).toEqual([
      { field: "Headline 1", message: "Headline 1 is 31 characters (max 30)." },
    ]);
  });

  it("reports unparseable content as a content violation", () => {
    const result = validateAdCreative("google_rsa", "not ad creative at all");
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.field).toBe("content");
  });
});

describe("generateAdCreativesInputSchema", () => {
  const campaignId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  it("accepts a minimal Meta request", () => {
    const parsed = generateAdCreativesInputSchema.safeParse({
      taskType: "meta_ad_creative",
      campaignId,
    });
    expect(parsed.success).toBe(true);
  });

  it("requires a campaign", () => {
    expect(
      generateAdCreativesInputSchema.safeParse({ taskType: "meta_ad_creative" }).success,
    ).toBe(false);
  });

  it("bounds variantCount and rejects it for google_rsa", () => {
    expect(
      generateAdCreativesInputSchema.safeParse({
        taskType: "meta_ad_creative",
        campaignId,
        variantCount: 5,
      }).success,
    ).toBe(true);
    expect(
      generateAdCreativesInputSchema.safeParse({
        taskType: "meta_ad_creative",
        campaignId,
        variantCount: 11,
      }).success,
    ).toBe(false);
    expect(
      generateAdCreativesInputSchema.safeParse({
        taskType: "google_rsa",
        campaignId,
        variantCount: 3,
      }).success,
    ).toBe(false);
    expect(
      generateAdCreativesInputSchema.safeParse({ taskType: "google_rsa", campaignId }).success,
    ).toBe(true);
  });

  it("rejects non-ad-creative task types", () => {
    expect(
      generateAdCreativesInputSchema.safeParse({ taskType: "linkedin_post", campaignId }).success,
    ).toBe(false);
  });
});

describe("social publishing contracts (Sprint 17)", () => {
  const uuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  it("registers reddit as an oauth social provider", () => {
    const reddit = CONNECTOR_PROVIDERS.find((p) => p.key === "reddit");
    expect(reddit?.authMode).toBe("oauth");
    expect(reddit?.nangoProvider).toBe("reddit");
    expect(reddit?.categories).toEqual(["social"]);
    expect(reddit?.baseUrl).toBe("https://oauth.reddit.com");
    expect(reddit?.testPath?.startsWith("/")).toBe(true);
    expect(reddit?.oauthScopes).toBe("identity,submit");
  });

  it("extends the category vocabulary with social", () => {
    expect(CONNECTOR_CATEGORIES).toContain("social");
  });

  it("includes post.published in the event vocabulary", () => {
    expect(EVENT_TYPES).toContain("post.published");
  });

  it("defines reddit post constraints", () => {
    expect(SOCIAL_POST_CONSTRAINTS.reddit).toMatchObject({
      titleMaxChars: 300,
      bodyMaxChars: 40000,
    });
    expect(PUBLICATION_STATUSES).toEqual(["scheduled", "published", "failed"]);
  });

  it("validates posts against the platform constraints", () => {
    expect(validateSocialPost("reddit", { target: "test", title: "Hi", body: "x" }).ok).toBe(true);
    const over = validateSocialPost("reddit", {
      target: "",
      title: "t".repeat(301),
      body: "b".repeat(40_001),
    });
    expect(over.ok).toBe(false);
    expect(over.violations.map((v) => v.field).sort()).toEqual(["body", "target", "title"]);
    expect(validateSocialPost("not_a_platform", { target: "t", title: "t", body: "b" }).ok).toBe(false);
  });

  it("accepts a publish request, with an optional schedule", () => {
    expect(
      publishDraftInputSchema.safeParse({ connectionId: uuid, target: "test", title: "Hello" })
        .success,
    ).toBe(true);
    expect(
      publishDraftInputSchema.safeParse({
        connectionId: uuid,
        target: "test",
        title: "Hello",
        scheduledFor: 1765500000000,
      }).success,
    ).toBe(true);
    expect(
      publishDraftInputSchema.safeParse({ connectionId: uuid, target: " ", title: "Hello" }).success,
    ).toBe(false);
    expect(
      publishDraftInputSchema.safeParse({ connectionId: uuid, target: "test", title: "" }).success,
    ).toBe(false);
  });

  it("validates the publication shape", () => {
    const publication = {
      id: uuid,
      workspaceId: uuid,
      draftId: uuid,
      connectionId: uuid,
      providerKey: "reddit",
      target: "test",
      title: "Hello",
      status: "published",
      scheduledFor: 1765500000000,
      publishedAt: 1765500001000,
      externalId: "t3_abc",
      externalUrl: "https://www.reddit.com/r/test/comments/abc/x/",
      lastError: null,
      createdAt: 1765500000000,
      updatedAt: 1765500001000,
    };
    expect(publicationSchema.safeParse(publication).success).toBe(true);
    expect(publicationSchema.safeParse({ ...publication, status: "queued" }).success).toBe(false);
    expect(
      publicationSchema.safeParse({
        ...publication,
        status: "scheduled",
        publishedAt: null,
        externalId: null,
        externalUrl: null,
      }).success,
    ).toBe(true);
  });
});
