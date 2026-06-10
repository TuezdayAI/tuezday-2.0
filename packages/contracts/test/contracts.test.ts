import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATES,
  BRAIN_DOC_MAX_CHARS,
  BRAIN_DOC_TYPES,
  CHANNELS,
  OUTPUT_RATINGS,
  PERSONA_OVERLAY_MAX_CHARS,
  TASK_TYPES,
  brainDocumentSchema,
  createWorkspaceInputSchema,
  generationSchema,
  rateGenerationInputSchema,
  resolveRequestSchema,
  updateBrainDocInputSchema,
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
  it("matches the planned sandbox task types", () => {
    expect(TASK_TYPES).toEqual([
      "linkedin_post",
      "cold_email_opener",
      "ad_copy_variant",
      "landing_page_hero",
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
