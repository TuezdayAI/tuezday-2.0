import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATES,
  BRAIN_DOC_MAX_CHARS,
  BRAIN_DOC_TYPES,
  OUTPUT_RATINGS,
  brainDocumentSchema,
  createWorkspaceInputSchema,
  updateBrainDocInputSchema,
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
