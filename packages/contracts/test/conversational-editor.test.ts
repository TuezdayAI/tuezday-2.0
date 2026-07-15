import { describe, expect, it } from "vitest";
import {
  DRAFT_REVISION_INSTRUCTION_MAX_CHARS,
  DRAFT_REVISION_STATUSES,
  draftEditorContextSchema,
  draftRevisionTurnSchema,
  reviseDraftInputSchema,
} from "../src/index";

const workspaceId = "44444444-4444-4444-8444-444444444444";
const draftId = "55555555-5555-4555-8555-555555555555";

function completedTurn() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    requestId: "33333333-3333-4333-8333-333333333333",
    workspaceId,
    draftId,
    actorId: null,
    instruction: "Shorter.",
    sourceContent: "Long copy",
    resultContent: "Short copy",
    contextSections: [],
    status: "completed",
    error: null,
    model: "fake-model",
    provider: "fake",
    durationMs: 5,
    createdAt: 10,
    completedAt: 15,
  } as const;
}

function editorContextFixture() {
  return {
    draft: {
      id: draftId,
      workspaceId,
      sourceGenerationId: null,
      sourceSignalId: null,
      campaignId: null,
      leadId: null,
      mediaContactId: null,
      taskType: "linkedin_post",
      channel: "linkedin",
      personaId: null,
      originalContent: "Original copy",
      content: "Current copy",
      state: "pending_review",
      media: null,
      createdAt: 10,
      updatedAt: 20,
      review: null,
    },
    decisions: [],
    turns: [completedTurn()],
    contextSections: [
      {
        key: "voice",
        layer: "org",
        title: "Voice",
        content: "Direct",
        included: true,
        reason: "Constitutional",
        tokens: 1,
        evidence: null,
      },
      {
        key: "evidence",
        layer: "evidence",
        title: "Evidence",
        content: "",
        included: false,
        reason: "Excluded: no evidence retrieved.",
        tokens: 0,
        evidence: null,
      },
    ],
    evidenceCitations: [],
    campaign: null,
    persona: null,
    staleness: {
      stale: false,
      planActivatedAt: null,
      contextResolvedAt: 10,
      reason: "No active campaign plan applies.",
    },
    siblings: [],
    destination: null,
    publications: [],
    executions: [],
    actions: [],
  } as const;
}

describe("conversational editor contracts", () => {
  it("owns the revision vocabulary", () => {
    expect(DRAFT_REVISION_STATUSES).toEqual(["running", "completed", "failed"]);
  });

  it("validates idempotent revision input", () => {
    expect(
      reviseDraftInputSchema.parse({
        requestId: "11111111-1111-4111-8111-111111111111",
        instruction: "  Make the opening more direct.  ",
        expectedDraftUpdatedAt: 42,
      }).instruction,
    ).toBe("Make the opening more direct.");
    expect(
      reviseDraftInputSchema.safeParse({
        requestId: "11111111-1111-4111-8111-111111111111",
        instruction: "x".repeat(DRAFT_REVISION_INSTRUCTION_MAX_CHARS + 1),
        expectedDraftUpdatedAt: 42,
      }).success,
    ).toBe(false);
  });

  it("requires completed turns to carry result metadata", () => {
    expect(draftRevisionTurnSchema.safeParse(completedTurn()).success).toBe(true);
    expect(
      draftRevisionTurnSchema.safeParse({ ...completedTurn(), model: null }).success,
    ).toBe(false);
  });

  it("requires failed turns to carry an error", () => {
    expect(
      draftRevisionTurnSchema.safeParse({
        ...completedTurn(),
        status: "failed",
        resultContent: null,
        error: null,
        model: null,
        provider: null,
        durationMs: null,
        completedAt: 15,
      }).success,
    ).toBe(false);
  });

  it("accepts a complete editor projection", () => {
    const parsed = draftEditorContextSchema.parse(editorContextFixture());
    expect(parsed.draft.id).toBe(draftId);
    expect(parsed.contextSections[1]?.included).toBe(false);
    expect(parsed.turns[0]?.resultContent).toBe("Short copy");
    expect(parsed.actions).toEqual([]);
  });
});
