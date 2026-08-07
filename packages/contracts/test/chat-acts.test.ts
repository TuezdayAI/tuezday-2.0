import { describe, expect, it } from "vitest";
import {
  CHAT_PROPOSALS_PER_DAY,
  CHAT_PROPOSALS_PER_THREAD,
  CHAT_PROPOSAL_STATUSES,
  CHAT_STREAM_EVENTS,
  EXTERNAL_ACTION_ORIGIN_SURFACES,
  PROPOSE_TOOL_NAMES,
  chatProposalIntentSchema,
  chatProposalSchema,
  chatSessionDetailSchema,
  chatStreamEventSchema,
  chatTurnResultSchema,
} from "../src/index";

// ---------------------------------------------------------------------------
// Sprint 78 vocabulary. The claim under test throughout: a chat proposal is a
// PAUSE, not an action — so the shape has to carry an unresolved state, a
// statement of intent legible enough to confirm, and a place to record what a
// governed refusal said.
// ---------------------------------------------------------------------------

const INTENT = {
  title: "Submit a linkedin draft for review",
  detail: [{ label: "Channel", value: "linkedin" }],
  effect: "It goes into your approval queue as a draft. Nothing is published.",
  rationale: "You asked for a funding post.",
};

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    messageId: "44444444-4444-4444-8444-444444444444",
    agentRunId: "55555555-5555-4555-8555-555555555555",
    tool: "propose_draft",
    intent: INTENT,
    status: "pending",
    quarantined: false,
    quarantineReason: null,
    producedRef: null,
    producedStatus: null,
    error: null,
    errorMessage: null,
    confirmedByUserId: null,
    resolvedAt: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("chat proposal vocabulary", () => {
  it("has one unresolved state and three terminal ones", () => {
    expect(CHAT_PROPOSAL_STATUSES).toEqual(["pending", "confirmed", "declined", "failed"]);
  });

  it("accepts only the five Sprint 69 propose tools — chat adds no capability", () => {
    expect(chatProposalSchema.safeParse(proposal()).success).toBe(true);
    expect(chatProposalSchema.safeParse(proposal({ tool: "search_evidence" })).success).toBe(false);
    for (const tool of PROPOSE_TOOL_NAMES) {
      expect(chatProposalSchema.safeParse(proposal({ tool })).success, tool).toBe(true);
    }
  });

  it("records what a governed refusal said, rather than dropping the proposal", () => {
    const failed = chatProposalSchema.parse(
      proposal({
        status: "failed",
        error: "reply_not_approved",
        errorMessage: "The reply draft has not cleared the approval queue.",
        resolvedAt: 2,
      }),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("reply_not_approved");
  });

  it("carries the quarantine flag and its reason together", () => {
    const flagged = chatProposalSchema.parse(
      proposal({ quarantined: true, quarantineReason: "Repeats wording from an outside page." }),
    );
    expect(flagged.quarantined).toBe(true);
    expect(flagged.quarantineReason).toContain("outside page");
  });

  it("is recordable before its message exists — the row precedes the answer", () => {
    expect(chatProposalSchema.safeParse(proposal({ messageId: null })).success).toBe(true);
  });
});

describe("the statement of intent", () => {
  it("needs a title and an effect — a card without either is unconfirmable", () => {
    expect(chatProposalIntentSchema.safeParse(INTENT).success).toBe(true);
    expect(chatProposalIntentSchema.safeParse({ ...INTENT, title: "" }).success).toBe(false);
    expect(chatProposalIntentSchema.safeParse({ ...INTENT, effect: "  " }).success).toBe(false);
  });

  it("allows an empty detail list but never an absent one", () => {
    expect(chatProposalIntentSchema.safeParse({ ...INTENT, detail: [] }).success).toBe(true);
    const { detail: _drop, ...withoutDetail } = INTENT;
    expect(chatProposalIntentSchema.safeParse(withoutDetail).success).toBe(false);
  });
});

describe("caps", () => {
  it("bounds asking per thread and per day, without touching what gets minted", () => {
    expect(CHAT_PROPOSALS_PER_THREAD).toBe(10);
    expect(CHAT_PROPOSALS_PER_DAY).toBe(20);
    // The Sprint 69 per-day mint cap is unchanged by this sprint; these are
    // additional bounds on asking, not a replacement for it.
    expect(CHAT_PROPOSALS_PER_THREAD).toBeLessThan(CHAT_PROPOSALS_PER_DAY);
  });
});

describe("the stream", () => {
  it("emits proposals before the message they belong to", () => {
    expect(CHAT_STREAM_EVENTS.indexOf("proposal")).toBeLessThan(
      CHAT_STREAM_EVENTS.indexOf("message"),
    );
  });

  it("parses a proposal frame", () => {
    const frame = chatStreamEventSchema.safeParse({
      type: "proposal",
      proposal: proposal({ messageId: null }),
    });
    expect(frame.success).toBe(true);
  });
});

describe("turn and thread payloads", () => {
  it("carry proposals beside the transcript, not inside it", () => {
    // A proposal's status changes after its message is written; putting it on
    // the message would mean rewriting a transcript row on a button click.
    const shape = chatTurnResultSchema.shape;
    expect(shape.proposals).toBeDefined();
    expect(Object.keys(chatSessionDetailSchema.shape)).toContain("proposals");
    expect(Object.keys(shape.message.shape)).not.toContain("proposals");
  });
});

describe("origin surface", () => {
  it("tells a chat-proposed action from a pipeline-proposed one", () => {
    expect(EXTERNAL_ACTION_ORIGIN_SURFACES).toEqual(["chat", "pipeline"]);
  });
});
