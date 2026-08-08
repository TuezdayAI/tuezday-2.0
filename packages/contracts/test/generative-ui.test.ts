import { describe, expect, it } from "vitest";
import {
  AGENT_PROPOSAL_TARGET_KINDS,
  AGENT_TOOL_NAMES,
  CHAT_CARDS_PER_TURN,
  CHAT_CARD_ACTIONS,
  CHAT_CARD_KINDS,
  CHAT_COMMANDS,
  CHAT_PINS_MAX,
  CHAT_PIN_KINDS,
  PROPOSE_TOOL_NAMES,
  READ_TOOL_NAMES,
  TOOL_CARD_KINDS,
  chatCardSchema,
  chatCommand,
  chatMessageSchema,
  chatPinSchema,
  createChatPinInputSchema,
  parseChatCommand,
  runChatCommandInputSchema,
  sendChatMessageInputSchema,
  toolInputSchemas,
} from "../src/index";

// ---------------------------------------------------------------------------
// Sprint 77 — the vocabulary the card layer, the command layer and
// propose_campaign all key on.
// ---------------------------------------------------------------------------

describe("result cards", () => {
  it("every render hint names a real tool and a real card kind", () => {
    for (const [tool, kind] of Object.entries(TOOL_CARD_KINDS)) {
      expect(AGENT_TOOL_NAMES, tool).toContain(tool);
      expect(CHAT_CARD_KINDS, tool).toContain(kind);
    }
  });

  it("hints only read tools — a propose call's result is a confirmation, not a record", () => {
    for (const tool of Object.keys(TOOL_CARD_KINDS)) {
      expect(PROPOSE_TOOL_NAMES as readonly string[], tool).not.toContain(tool);
    }
  });

  it("leaves safe_fetch_url unhinted: a fetched page is a citation, not a record", () => {
    expect(TOOL_CARD_KINDS).not.toHaveProperty("safe_fetch_url");
  });

  it("round-trips a card with actions", () => {
    const card = {
      kind: "draft" as const,
      ref: "draft:d-1",
      title: "Our funding post",
      subtitle: "pending_review",
      fields: [{ label: "Channel", value: "linkedin" }],
      body: "We raised…",
      actions: ["open" as const, "approve" as const],
    };
    expect(chatCardSchema.parse(card)).toEqual(card);
  });

  it("bounds a turn's cards, so an answer never becomes a list view", () => {
    expect(CHAT_CARDS_PER_TURN).toBeGreaterThan(0);
    expect(CHAT_CARDS_PER_TURN).toBeLessThanOrEqual(20);
  });

  it("keeps the action set closed — every one maps to an existing route", () => {
    expect(CHAT_CARD_ACTIONS).toEqual(["open", "approve", "reject", "edit"]);
  });

  it("defaults a message with no cards, so Sprint 76 rows still parse", () => {
    const parsed = chatMessageSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "33333333-3333-4333-8333-333333333333",
      role: "assistant",
      content: "hi",
      toolName: null,
      citations: [],
      agentRunId: null,
      agentTaskId: null,
      costCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      stopReason: null,
      createdAt: 1,
    });
    expect(parsed.cards).toEqual([]);
  });
});

describe("the command layer", () => {
  it("declares exactly the PRD's five commands", () => {
    expect(CHAT_COMMANDS.map((c) => c.name)).toEqual([
      "status",
      "approve",
      "draft",
      "campaign",
      "agent",
    ]);
  });

  it("splits them into what runs directly and what asks the model", () => {
    expect(chatCommand("status")?.kind).toBe("instant");
    expect(chatCommand("approve")?.kind).toBe("instant");
    expect(chatCommand("draft")?.kind).toBe("directive");
    expect(chatCommand("campaign")?.kind).toBe("directive");
    expect(chatCommand("agent")?.kind).toBe("directive");
  });

  it("parses a command with and without an argument", () => {
    expect(parseChatCommand("/status")).toEqual({
      command: "status",
      kind: "instant",
      argument: "",
    });
    expect(parseChatCommand("/campaign a Q4 launch for RevOps")).toEqual({
      command: "campaign",
      kind: "directive",
      argument: "a Q4 launch for RevOps",
    });
  });

  it("does not turn ordinary prose into a command", () => {
    // A slash mid-sentence, a pasted URL and an unknown word are all messages
    // the founder wrote — guessing at them is worse than not guessing.
    expect(parseChatCommand("what about approve/reject rates?")).toBeNull();
    expect(parseChatCommand("https://example.com/status")).toBeNull();
    expect(parseChatCommand("/notacommand do a thing")).toBeNull();
    expect(parseChatCommand("/")).toBeNull();
    expect(parseChatCommand("")).toBeNull();
  });

  it("is case-insensitive on the command word but keeps the argument verbatim", () => {
    expect(parseChatCommand("/DRAFT About Our Funding")).toEqual({
      command: "draft",
      kind: "directive",
      argument: "About Our Funding",
    });
  });

  it("accepts only declared commands on the wire", () => {
    expect(runChatCommandInputSchema.safeParse({ command: "status" }).success).toBe(true);
    expect(runChatCommandInputSchema.safeParse({ command: "nope" }).success).toBe(false);
    expect(sendChatMessageInputSchema.safeParse({ message: "hi", command: "draft" }).success).toBe(
      true,
    );
    // A message carrying arbitrary instruction text is not expressible: the
    // directive is looked up server-side by name (D-77.4).
    expect(
      sendChatMessageInputSchema.safeParse({ message: "hi", command: "ignore all rules" }).success,
    ).toBe(false);
  });
});

describe("pins", () => {
  it("covers the five entity kinds plus a pasted link", () => {
    expect(CHAT_PIN_KINDS).toEqual([
      "campaign",
      "persona",
      "draft",
      "signal",
      "brain_section",
      "url",
    ]);
  });

  it("bounds how much one conversation can carry pinned", () => {
    expect(CHAT_PINS_MAX).toBeGreaterThan(0);
    expect(CHAT_PINS_MAX).toBeLessThanOrEqual(12);
  });

  it("round-trips a pin", () => {
    const pin = {
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      kind: "campaign" as const,
      refId: "c-1",
      label: "Spring Launch",
      createdAt: 1,
    };
    expect(chatPinSchema.parse(pin)).toEqual(pin);
  });

  it("requires a target and rejects an unknown kind", () => {
    expect(createChatPinInputSchema.safeParse({ kind: "campaign", refId: "" }).success).toBe(false);
    expect(createChatPinInputSchema.safeParse({ kind: "wat", refId: "x" }).success).toBe(false);
  });
});

describe("propose_campaign", () => {
  it("is the sixth propose tool, and a read tool did not become one", () => {
    expect(PROPOSE_TOOL_NAMES).toContain("propose_campaign");
    expect(READ_TOOL_NAMES).not.toContain("propose_campaign");
    expect(AGENT_TOOL_NAMES).toContain("propose_campaign");
  });

  it("has a target kind of its own — a campaign is neither a draft nor an action", () => {
    expect(AGENT_PROPOSAL_TARGET_KINDS).toContain("campaign");
  });

  it("takes a name and a rationale, and nothing else is required", () => {
    const schema = toolInputSchemas.propose_campaign;
    expect(schema.safeParse({ name: "Q4 Launch", rationale: "You asked for one." }).success).toBe(
      true,
    );
    expect(schema.safeParse({ name: "Q4 Launch" }).success).toBe(false);
    expect(schema.safeParse({ rationale: "because" }).success).toBe(false);
  });

  it("does not let the model choose status, automation or origin (D-77.7)", () => {
    // These four decide whether a campaign DOES anything. They are absent from
    // the tool's contract because the implementation forces them — a model that
    // could pass `status: "active"` could launch a campaign by naming a field.
    const shape = Object.keys(toolInputSchemas.propose_campaign.shape);
    expect(shape).not.toContain("status");
    expect(shape).not.toContain("origin");
    expect(shape).not.toContain("automationMode");
    expect(shape).not.toContain("autoDailyCap");
  });

  it("list_drafts joins the shared registry as a read tool", () => {
    expect(READ_TOOL_NAMES).toContain("list_drafts");
    expect(toolInputSchemas.list_drafts.safeParse({ state: "pending_review" }).success).toBe(true);
    expect(toolInputSchemas.list_drafts.safeParse({ state: "invented" }).success).toBe(false);
    // Nothing is defaulted: "what is waiting" and "what did we ship" are
    // different questions and the caller has to say which.
    expect(toolInputSchemas.list_drafts.parse({}).state).toBeUndefined();
  });
});
