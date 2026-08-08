import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_NAMES,
  CHAT_COMPACTION_KEEP_RECENT,
  CHAT_COMPACTION_THRESHOLD,
  CHAT_MESSAGE_ROLES,
  CHAT_THREAD_TOKEN_CAP,
  CHAT_TURN_BOUNDS,
  DEFAULT_TASK_DOC_MATRIX,
  GENERATION_TASK_TYPES,
  READ_TOOL_NAMES,
  TASK_TYPES,
  chatMessageSchema,
  chatSessionSchema,
  chatStreamEventSchema,
  toolInputSchemas,
  updateChatSessionInputSchema,
} from "../src/index";

describe("gtm_conversation task type (Sprint 76)", () => {
  it("is a task type with its own matrix row", () => {
    expect(TASK_TYPES).toContain("gtm_conversation");
    expect(DEFAULT_TASK_DOC_MATRIX.gtm_conversation).toBeDefined();
  });

  it("takes ICP and history in full — a strategy conversation is about both", () => {
    const row = DEFAULT_TASK_DOC_MATRIX.gtm_conversation;
    expect(row.icp.mode).toBe("full");
    expect(row.history.mode).toBe("full");
    expect(row.icp.reason.length).toBeGreaterThan(0);
    expect(row.history.reason.length).toBeGreaterThan(0);
  });

  it("every task type still has a matrix row", () => {
    for (const taskType of TASK_TYPES) {
      expect(DEFAULT_TASK_DOC_MATRIX[taskType], taskType).toBeDefined();
    }
  });

  it("GENERATION_TASK_TYPES excludes exactly the conversational one", () => {
    expect(GENERATION_TASK_TYPES).not.toContain("gtm_conversation");
    expect(GENERATION_TASK_TYPES).toHaveLength(TASK_TYPES.length - 1);
    // Order is preserved so pickers keep their existing sequence.
    expect(GENERATION_TASK_TYPES).toEqual(TASK_TYPES.filter((t) => t !== "gtm_conversation"));
  });
});

describe("chat vocabulary", () => {
  it("adds the compaction role without disturbing the existing three", () => {
    expect(CHAT_MESSAGE_ROLES).toEqual(["user", "assistant", "tool", "compaction"]);
  });

  it("bounds a thread rather than trusting the workspace budget alone", () => {
    expect(CHAT_THREAD_TOKEN_CAP).toBe(250_000);
    // Compaction has to fire well before a single turn's bound, or the
    // transcript is already unsendable by the time it triggers.
    expect(CHAT_COMPACTION_THRESHOLD).toBeGreaterThan(0);
    expect(CHAT_COMPACTION_THRESHOLD).toBeLessThan(1);
    expect(CHAT_TURN_BOUNDS.maxTokens).toBeLessThan(CHAT_THREAD_TOKEN_CAP);
    expect(CHAT_COMPACTION_KEEP_RECENT).toBeGreaterThan(0);
  });
});

describe("Sprint 76 read tools", () => {
  const NEW_TOOLS = [
    "list_campaigns",
    "list_personas",
    "get_campaign_insights",
    "get_workspace_insights",
    "get_metric_summary",
    "get_sequence_funnel",
  ] as const;

  it("are registered as read tools", () => {
    for (const name of NEW_TOOLS) {
      expect(READ_TOOL_NAMES, name).toContain(name);
      expect(AGENT_TOOL_NAMES, name).toContain(name);
    }
  });

  it("every tool name has an input schema", () => {
    for (const name of AGENT_TOOL_NAMES) {
      expect(toolInputSchemas[name], name).toBeDefined();
    }
  });

  it("get_metric_summary requires a window — the time semantics are never guessed", () => {
    // Sprint 55's rule: cumulative and periodic values must not be summed
    // together, so the caller has to say which question it is asking.
    expect(toolInputSchemas.get_metric_summary.safeParse({ subjectType: "campaign" }).success).toBe(
      false,
    );
    expect(
      toolInputSchemas.get_metric_summary.safeParse({ subjectType: "campaign", window: "1d" })
        .success,
    ).toBe(true);
  });
});

describe("chat schemas", () => {
  const session = {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    userId: null,
    title: "Launch planning",
    goal: "Launch the new product across LinkedIn and email",
    campaignId: null,
    personaId: null,
    channel: "linkedin" as const,
    totalInputTokens: 10,
    totalOutputTokens: 5,
    totalCostCents: 0.4,
    createdAt: 1,
    updatedAt: 2,
  };

  it("round-trips a thread with scope and lifetime totals", () => {
    expect(chatSessionSchema.parse(session)).toEqual(session);
  });

  it("round-trips a message carrying its run, cost and stop reason", () => {
    const message = {
      id: "33333333-3333-4333-8333-333333333333",
      sessionId: session.id,
      workspaceId: session.workspaceId,
      role: "assistant" as const,
      content: "Engagement fell 22% week over week.",
      toolName: null,
      citations: [{ kind: "data" as const, ref: "publication:abc", label: "Launch post" }],
      cards: [],
      agentRunId: "44444444-4444-4444-8444-444444444444",
      agentTaskId: null,
      costCents: 0.2,
      inputTokens: 900,
      outputTokens: 120,
      stopReason: "complete" as const,
      producedRef: null,
      createdAt: 3,
    };
    expect(chatMessageSchema.parse(message)).toEqual(message);
  });

  it("treats scope as tri-state on patch: absent leaves, null unbinds", () => {
    expect(updateChatSessionInputSchema.parse({}).campaignId).toBeUndefined();
    expect(updateChatSessionInputSchema.parse({ campaignId: null }).campaignId).toBeNull();
  });

  it("discriminates every stream frame kind", () => {
    const frames = [
      { type: "session", sessionId: "s", userMessageId: "m" },
      { type: "step_start", stepIndex: 0 },
      { type: "text_delta", stepIndex: 0, text: "hi" },
      { type: "tool_call_start", stepIndex: 0, callId: "c", name: "list_campaigns" },
      { type: "tool_call_end", stepIndex: 0, callId: "c", ok: true },
      { type: "step_end", stepIndex: 0, inputTokens: 1, outputTokens: 2 },
      {
        type: "done",
        stopReason: "complete",
        costCents: 0.1,
        threadTokens: 3,
        threadCostCents: 0.1,
      },
      { type: "error", error: "turn_failed", message: "boom" },
    ];
    for (const frame of frames) {
      expect(chatStreamEventSchema.safeParse(frame).success, frame.type).toBe(true);
    }
    expect(chatStreamEventSchema.safeParse({ type: "not_a_frame" }).success).toBe(false);
  });
});

describe("the Sprint 42 proposal surface is gone", () => {
  it("no longer exports the copilot write vocabulary", async () => {
    const contracts = (await import("../src/index")) as Record<string, unknown>;
    expect(contracts.COPILOT_WRITE_TOOLS).toBeUndefined();
    expect(contracts.confirmChatProposalInputSchema).toBeUndefined();
  });

  it("and what Sprint 78 reintroduced under the same name is a different thing", async () => {
    // Sprint 42's `chatProposalSchema` described a copilot's own write tool,
    // with its own confirm token and its own execution path. Sprint 78's
    // describes a PAUSE in front of the shared Sprint 69 propose tools — which
    // is why it is keyed on `PROPOSE_TOOL_NAMES` and carries no token.
    const { chatProposalSchema, PROPOSE_TOOL_NAMES } = await import("../src/index");
    expect(chatProposalSchema).toBeDefined();
    const keys = Object.keys(chatProposalSchema.shape);
    expect(keys).toContain("tool");
    expect(keys).toContain("quarantined");
    expect(keys).not.toContain("confirmToken");
    // Six since Sprint 77 added propose_campaign.
    expect(PROPOSE_TOOL_NAMES).toHaveLength(6);
  });
});
