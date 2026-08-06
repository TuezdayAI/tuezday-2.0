import { describe, expect, it } from "vitest";
import { CHAT_THREAD_TOKEN_CAP, type ChatMessage, type ChatSession } from "@tuezday/contracts";
import {
  agentRunHref,
  citationHref,
  formatCost,
  formatTokens,
  scopeChips,
  stopReasonNote,
  threadBudgetView,
  threadTitle,
  visibleMessages,
} from "./chat-thread-view";

const WS = "ws-1";

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s-1",
    workspaceId: WS,
    userId: null,
    title: "",
    goal: "",
    campaignId: null,
    personaId: null,
    channel: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostCents: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m-1",
    sessionId: "s-1",
    workspaceId: WS,
    role: "assistant",
    content: "text",
    toolName: null,
    citations: [],
    cards: [],
    agentRunId: null,
    costCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    stopReason: null,
    producedRef: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("cost and token formatting", () => {
  it("never shows a real sub-cent turn as free", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.4)).toBe("<$0.01");
    expect(formatCost(120)).toBe("$1.20");
  });

  it("abbreviates token counts once they stop being readable", () => {
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(250_000)).toBe("250k");
  });
});

describe("the thread budget", () => {
  it("stays quiet well under the cap", () => {
    const view = threadBudgetView(session({ totalInputTokens: 1_000 }));
    expect(view.exhausted).toBe(false);
    expect(view.warning).toBeNull();
  });

  it("warns while there is still room to act on the warning", () => {
    const view = threadBudgetView(
      session({ totalInputTokens: Math.floor(CHAT_THREAD_TOKEN_CAP * 0.85) }),
    );
    expect(view.exhausted).toBe(false);
    expect(view.warning).toContain("near its limit");
  });

  it("reports exhaustion and tells the founder what to do", () => {
    const view = threadBudgetView(session({ totalInputTokens: CHAT_THREAD_TOKEN_CAP }));
    expect(view.exhausted).toBe(true);
    expect(view.warning).toContain("Start a new one");
  });

  it("counts both directions of the conversation", () => {
    const view = threadBudgetView(session({ totalInputTokens: 10, totalOutputTokens: 5 }));
    expect(view.tokens).toBe(15);
  });
});

describe("stop reasons", () => {
  it("says nothing for a turn that finished", () => {
    expect(stopReasonNote(null)).toBeNull();
    expect(stopReasonNote("complete")).toBeNull();
  });

  it("names the bound that tripped", () => {
    expect(stopReasonNote("max_steps")).toContain("step limit");
    expect(stopReasonNote("max_tokens")).toContain("token limit");
    expect(stopReasonNote("timeout")).toContain("too long");
    expect(stopReasonNote("error")).toContain("error");
  });
});

describe("citation links", () => {
  it("routes each record kind to the page that owns it", () => {
    expect(citationHref({ kind: "data", ref: "campaign:c1", label: "" }, WS)).toBe(
      "/workspaces/ws-1/campaigns/c1",
    );
    expect(citationHref({ kind: "data", ref: "publication:p1", label: "" }, WS)).toBe(
      "/workspaces/ws-1/content?publication=p1",
    );
    expect(citationHref({ kind: "data", ref: "draft:d1", label: "" }, WS)).toBe(
      "/workspaces/ws-1/review?draft=d1",
    );
    expect(citationHref({ kind: "brain", ref: "voice#tone", label: "" }, WS)).toBe(
      "/workspaces/ws-1/brain?doc=voice",
    );
    expect(citationHref({ kind: "evidence", ref: "doc-9", label: "" }, WS)).toBe(
      "/workspaces/ws-1/evidence?document=doc-9",
    );
  });

  it("passes a fetched page's URL through unchanged", () => {
    expect(citationHref({ kind: "data", ref: "https://example.com/a", label: "" }, WS)).toBe(
      "https://example.com/a",
    );
  });

  it("escapes ids rather than trusting them into a URL", () => {
    expect(citationHref({ kind: "data", ref: "campaign:a b/c", label: "" }, WS)).toBe(
      "/workspaces/ws-1/campaigns/a%20b%2Fc",
    );
  });

  it("returns null for a ref it cannot route — an unlinked chip beats a wrong link", () => {
    expect(citationHref({ kind: "data", ref: "unknown_kind:x", label: "" }, WS)).toBeNull();
    expect(citationHref({ kind: "data", ref: "no-separator", label: "" }, WS)).toBeNull();
    expect(citationHref({ kind: "data", ref: "campaign:", label: "" }, WS)).toBeNull();
  });

  it("links a turn to its trace in the Agent Inspector", () => {
    expect(agentRunHref(WS, "run-1")).toBe("/workspaces/ws-1/inspector?run=run-1");
  });
});

describe("thread header", () => {
  it("names an untitled thread rather than showing an empty header", () => {
    expect(threadTitle(session())).toBe("New conversation");
    expect(threadTitle(session({ title: "  Launch plan  " }))).toBe("Launch plan");
  });

  it("shows a chip per bound scope and nothing for unbound scope", () => {
    expect(scopeChips(session(), {})).toEqual([]);
    expect(
      scopeChips(session({ campaignId: "c1", channel: "linkedin" }), { campaignName: "Launch" }),
    ).toEqual([
      { key: "campaign", label: "Launch" },
      { key: "channel", label: "linkedin" },
    ]);
  });

  it("falls back to a generic chip label when the name has not loaded", () => {
    expect(scopeChips(session({ personaId: "p1" }), {})).toEqual([
      { key: "persona", label: "Persona" },
    ]);
  });
});

describe("transcript rendering", () => {
  it("hides tool messages — they are transcript, not conversation", () => {
    const shown = visibleMessages([
      message({ id: "a", role: "user" }),
      message({ id: "b", role: "tool", toolName: "list_campaigns" }),
      message({ id: "c", role: "assistant" }),
      message({ id: "d", role: "compaction" }),
    ]);
    expect(shown.map((m) => m.id)).toEqual(["a", "c", "d"]);
  });
});
