import { describe, expect, it } from "vitest";
import type { DraftEditorContext, DraftRevisionTurn, ExecutionResult, Publication } from "@tuezday/contracts";
import {
  automationExplanation,
  editorRecoveryHref,
  editorVersionContent,
  editorVersionOptions,
  groupEditorSections,
  initialPublishFields,
  publishActionPayload,
  publishEligibility,
  stalenessExplanation,
} from "./conversational-editor";

const TURN_ID = "22222222-2222-4222-8222-222222222222";

function context(): DraftEditorContext {
  const turn = {
    id: TURN_ID,
    requestId: "33333333-3333-4333-8333-333333333333",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    draftId: "44444444-4444-4444-8444-444444444444",
    actorId: null,
    instruction: "Make it sharper",
    sourceContent: "Current copy",
    resultContent: "Revised copy",
    contextSections: [],
    status: "completed",
    error: null,
    model: "model",
    provider: "provider",
    durationMs: 12,
    createdAt: 2,
    completedAt: 3,
  } satisfies DraftRevisionTurn;
  return {
    draft: {
      id: turn.draftId,
      workspaceId: turn.workspaceId,
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
      state: "edited",
      media: null,
      review: null,
      createdAt: 1,
      updatedAt: 3,
    },
    decisions: [],
    turns: [turn],
    contextSections: [
      {
        key: "voice",
        layer: "brain",
        title: "Voice",
        content: "Direct",
        included: true,
        reason: "Always included",
        tokens: 1,
        evidence: null,
      },
      {
        key: "evidence",
        layer: "evidence",
        title: "Evidence",
        content: "",
        included: false,
        reason: "Excluded: no evidence documents uploaded yet.",
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
      contextResolvedAt: 3,
      reason: "No active campaign plan applies.",
    },
    siblings: [],
    destination: null,
    publications: [],
    executions: [],
  };
}

describe("conversational editor view model", () => {
  it("builds original, current, and completed revision versions", () => {
    const value = context();
    expect(editorVersionOptions(value).map((item) => item.label)).toEqual([
      "Original",
      "Current",
      "Revision 1",
    ]);
    expect(editorVersionContent(value, `revision:${TURN_ID}`)).toBe("Revised copy");
    expect(editorVersionContent(value, "original")).toBe("Original copy");
  });

  it("groups included and excluded context without losing resolver order or reasons", () => {
    const grouped = groupEditorSections(context().contextSections);
    expect(grouped.included.map((section) => section.key)).toEqual(["voice"]);
    expect(grouped.excluded[0]!.reason).toContain("Excluded");
    expect(grouped.byLayer.brain![0]!.title).toBe("Voice");
  });

  it("explains automation modes and staleness in user language", () => {
    expect(automationExplanation("scheduled_auto")).toContain("may approve and post");
    expect(automationExplanation("human_in_the_loop")).toContain("your approval");
    expect(automationExplanation("manual")).toContain("you stay in control");
    expect(stalenessExplanation({ ...context().staleness, stale: true })).toContain("changed");
  });

  it("gates publication proposal on approved content and a connected destination", () => {
    const value = context();
    expect(publishEligibility(value).eligible).toBe(false);
    expect(publishEligibility(value).reason).toContain("Approve");

    const approved = { ...value, draft: { ...value.draft, state: "approved" as const } };
    expect(publishEligibility(approved).eligible).toBe(false);
    expect(publishEligibility(approved).reason).toContain("Connect");

    const destination = {
      providerKey: "linkedin",
      label: "Acme LinkedIn",
      status: "connected" as const,
      error: null,
    };
    expect(
      publishEligibility({
        ...approved,
        destination: { ...destination, status: "error" as const, error: "expired" },
      }).eligible,
    ).toBe(false);
    expect(publishEligibility({ ...approved, destination }).eligible).toBe(true);
    expect(publishEligibility({ ...approved, destination }).reason).toBeNull();
  });

  it("prefills the publication target and title from the draft", () => {
    const value = context();
    const fields = initialPublishFields({
      ...value,
      draft: { ...value.draft, content: "# Launch note\nBody copy" },
    });
    expect(fields.title).toBe("Launch note");
    expect(fields.target).toBe("feed");
  });

  it("builds immediate and future publish payloads with a retained request key", () => {
    const immediate = publishActionPayload({
      connectionId: "66666666-6666-4666-8666-666666666666",
      target: "r/startups",
      title: " Launch note ",
      scheduledForLocal: "",
      idempotencyKey: "key-1",
    });
    expect(immediate.target).toBe("startups");
    expect(immediate.title).toBe("Launch note");
    expect(immediate.scheduledFor).toBeUndefined();
    expect(immediate.idempotencyKey).toBe("key-1");

    const future = publishActionPayload({
      connectionId: "66666666-6666-4666-8666-666666666666",
      target: "feed",
      title: "Launch note",
      scheduledForLocal: "2099-01-02T09:30",
      idempotencyKey: "key-1",
    });
    expect(future.scheduledFor).toBe(new Date("2099-01-02T09:30").getTime());
  });

  it("routes execution recovery to its owning surface", () => {
    const execution = {
      kind: "launch",
      id: "55555555-5555-4555-8555-555555555555",
    } as ExecutionResult;
    expect(editorRecoveryHref("ws1", execution)).toBe(
      "/workspaces/ws1/launches?launch=55555555-5555-4555-8555-555555555555",
    );
    expect(editorRecoveryHref("ws1", { status: "scheduled" } as Publication)).toBe(
      "/workspaces/ws1/calendar",
    );
    expect(editorRecoveryHref("ws1", { status: "failed" } as Publication)).toBe(
      "/workspaces/ws1/content",
    );
  });
});
