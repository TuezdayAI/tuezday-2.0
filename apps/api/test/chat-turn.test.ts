import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_THREAD_TOKEN_CAP,
  upsertCampaignInputSchema,
  type ChatStreamEvent,
} from "@tuezday/contracts";
import { PROPOSE_TOOLS, ASK_TOOLS } from "../src/agents/tools/index";
import { agentRunSteps, agentRuns, chatSessions, workspaces } from "../src/db/schema";
import type { Db } from "../src/db";
import type { AddDocumentInput, EvidenceStore, StoreSearchResult } from "../src/evidence/store";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import type { SafeFetchService } from "../src/safe-fetch/index";
import { updateBrainDoc } from "../src/services/brain";
import { createCampaign } from "../src/services/campaigns";
import { createSession, getSession, listMessages } from "../src/services/chat";
import { CHAT_TOOLS, runChatTurn } from "../src/services/chat-turn";
import { createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// One chat turn (Sprint 76). The turn service is the testable unit: the SSE
// route is a thin adapter over the same `onEvent` these tests collect.
// ---------------------------------------------------------------------------

class FakeEvidenceStore implements EvidenceStore {
  async health() {
    return { healthy: false, detail: "not configured in this test" };
  }
  async createCollection(name: string) {
    return `collection-${name}`;
  }
  async addDocument(_input: AddDocumentInput) {
    return "doc-1";
  }
  async attachDocument() {}
  async deleteDocument() {}
  async search(): Promise<StoreSearchResult[]> {
    return [];
  }
}

const safeFetch = null as unknown as SafeFetchService;

let db: Db;
let workspaceId: string;
let campaignId: string;

function deps(llm: LlmGateway) {
  return { llm, evidence: new FakeEvidenceStore(), safeFetch };
}

const ACTOR = { userId: "user-1", label: "user:user-1" };

/**
 * The turn makes an auto-title call before the answer, so every script starts
 * with the title step. Kept explicit rather than hidden in a helper default —
 * a test that forgets it should fail loudly on an exhausted script.
 */
function titleStep(): ScriptedStep {
  return { text: JSON.stringify({ title: "Engagement drop", goal: "" }) };
}

async function newThread(goal = ""): Promise<string> {
  // userId is null: these tests seed no users table, and the turn attributes
  // its run through the actor label rather than the FK.
  const session = await createSession(db, workspaceId, null, { goal });
  return session.id;
}

beforeEach(async () => {
  db = await createTestDb();
  workspaceId = randomUUID();
  await db.insert(workspaces)
    .values({ id: workspaceId, name: "Acme", createdAt: 1, updatedAt: 1 });
  await updateBrainDoc(db, workspaceId, "soul", "## Why\n\nWe make GTM legible.\n");
  campaignId = (await createCampaign(
    db,
    workspaceId,
    upsertCampaignInputSchema.parse({ name: "Launch", objective: "Ship the new product" }),
  )).id;
});

// Sprint 78 note: ACTOR carries no workspace role, so `actorMayPropose` is
// false and every turn in this file is still the read-only path. That is the
// safe default under test here — the write path has its own suite
// (chat-write-turn.test.ts), which is where a role is supplied.
describe("read-only by construction for an actor who may not write (D-76.9)", () => {
  it("offers only read tools", () => {
    expect(CHAT_TOOLS.length).toBeGreaterThan(0);
    for (const tool of CHAT_TOOLS) {
      expect(tool.access, tool.name).toBe("read");
    }
  });

  it("offers none of the propose or ask tools", () => {
    const offered = new Set(CHAT_TOOLS.map((t) => t.name));
    for (const tool of [...PROPOSE_TOOLS, ...ASK_TOOLS]) {
      expect(offered.has(tool.name), tool.name).toBe(false);
    }
  });

  it("hands the runner a tool list that contains no write tool", async () => {
    const llm = new ScriptedGateway([titleStep(), { text: "Nothing to change." }]);
    const sessionId = await newThread();
    await runChatTurn(db, deps(llm), workspaceId, ACTOR, sessionId, "Publish this now");

    // calls[0] is the auto-title (no tools); calls[1] is the answer turn.
    const answerCall = llm.calls[1]!;
    expect(answerCall.tools?.length).toBe(CHAT_TOOLS.length);
    const names = new Set(answerCall.tools?.map((t) => t.name));
    for (const tool of [...PROPOSE_TOOLS, ...ASK_TOOLS]) {
      expect(names.has(tool.name), tool.name).toBe(false);
    }
  });
});

describe("a grounded turn", () => {
  it("calls a tool, cites the record it read, and answers", async () => {
    const llm = new ScriptedGateway([
      titleStep(),
      { toolCalls: [{ name: "list_campaigns", arguments: {} }] },
      { text: "You have one campaign: Launch." },
    ]);
    const sessionId = await newThread();

    const result = await runChatTurn(
      db,
      deps(llm),
      workspaceId,
      ACTOR,
      sessionId,
      "Which campaigns do we have?",
    );

    expect(result?.answer).toContain("Launch");
    expect(result?.toolCalls).toEqual([{ tool: "list_campaigns", ok: true }]);
    expect(result?.stopReason).toBe("complete");
    // The citation points at the actual record, not at the tool.
    expect(result?.citations).toContainEqual(
      expect.objectContaining({ kind: "data", ref: `campaign:${campaignId}`, label: "Launch" }),
    );
  });

  it("resolves its system prefix through the Context Resolver, not a hand-written preamble", async () => {
    const llm = new ScriptedGateway([titleStep(), { text: "Noted." }]);
    const sessionId = await newThread("Launch across LinkedIn and email");

    await runChatTurn(db, deps(llm), workspaceId, ACTOR, sessionId, "Help me plan the launch");

    const system = llm.calls[1]!.system;
    expect(system).toContain("THREAD GOAL: Launch across LinkedIn and email");
    // Brain content and the conversation directive both travel in the bundle.
    expect(system).toContain("We make GTM legible.");
    expect(system).toContain("Ground every factual claim in a tool result");
    expect(system).toContain("You cannot change anything");
  });

  it("persists the turn as an agent_run with inspectable steps", async () => {
    const llm = new ScriptedGateway([
      titleStep(),
      { toolCalls: [{ name: "list_personas", arguments: {} }] },
      { text: "No personas yet." },
    ]);
    const sessionId = await newThread();

    const result = await runChatTurn(db, deps(llm), workspaceId, ACTOR, sessionId, "Who do we target?");

    expect(result?.agentRunId).toBeTruthy();
    const run = (await db.select().from(agentRuns).where(eq(agentRuns.id, result!.agentRunId!)))[0];
    expect(run?.task).toBe("chat");
    expect(run?.createdBy).toBe("user:user-1");
    expect(run?.workspaceId).toBe(workspaceId);

    const steps = await db
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, result!.agentRunId!));
    expect(steps.some((s) => s.kind === "tool_call" && s.toolName === "list_personas")).toBe(true);

    // The assistant message links to it — this is the Agent Inspector entry.
    const assistant = (await listMessages(db, sessionId)).find((m) => m.role === "assistant");
    expect(assistant?.agentRunId).toBe(result!.agentRunId);
  });

  it("streams step, tool and text events before the terminal frames", async () => {
    const llm = new ScriptedGateway([
      titleStep(),
      { toolCalls: [{ name: "list_campaigns", arguments: {} }] },
      { text: "One campaign." },
    ]);
    const sessionId = await newThread();
    const events: ChatStreamEvent[] = [];

    await runChatTurn(
      db,
      deps(llm),
      workspaceId,
      ACTOR,
      sessionId,
      "Which campaigns?",
      (e) => events.push(e),
    );

    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe("session");
    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_end");
    expect(kinds).toContain("text_delta");
    expect(kinds.at(-2)).toBe("message");
    expect(kinds.at(-1)).toBe("done");

    // Deltas actually arrive in pieces, not as one whole-answer blob.
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => (d as { text: string }).text).join("")).toContain("One campaign.");
  });
});

describe("failure is a result, never a throw", () => {
  it("degrades when the gateway fails", async () => {
    const failing: LlmGateway = {
      async generate() {
        throw new GatewayError("provider_error", "down");
      },
      async agentStep() {
        throw new GatewayError("provider_error", "down");
      },
    };
    const sessionId = await newThread();

    const result = await runChatTurn(db, deps(failing), workspaceId, ACTOR, sessionId, "Hello?");

    expect(result?.stopReason).toBe("error");
    expect(result?.answer.length).toBeGreaterThan(0);
    // The founder is told, rather than shown an empty bubble.
    expect(result?.answer).toContain("couldn't finish");
  });

  it("states the bound when a turn runs out of steps, keeping what it did say", async () => {
    const script: ScriptedStep[] = [titleStep()];
    // Eight tool-calling steps: the turn's maxSteps, never reaching an answer.
    for (let i = 0; i < 8; i++) {
      script.push({ text: `thinking ${i}`, toolCalls: [{ name: "list_campaigns", arguments: {} }] });
    }
    const sessionId = await newThread();

    const result = await runChatTurn(
      db,
      deps(new ScriptedGateway(script)),
      workspaceId,
      ACTOR,
      sessionId,
      "Loop forever",
    );

    expect(result?.stopReason).toBe("max_steps");
    expect(result?.answer).toContain("ran out of steps");
  });

  it("treats a tool failure as data the model answers around", async () => {
    const llm = new ScriptedGateway([
      titleStep(),
      // An unknown campaign id: the tool returns not_found rather than throwing.
      { toolCalls: [{ name: "get_campaign_insights", arguments: { campaignId: "nope" } }] },
      { text: "I couldn't find that campaign." },
    ]);
    const sessionId = await newThread();

    const result = await runChatTurn(
      db,
      deps(llm),
      workspaceId,
      ACTOR,
      sessionId,
      "How is campaign nope doing?",
    );

    expect(result?.stopReason).toBe("complete");
    expect(result?.toolCalls).toEqual([{ tool: "get_campaign_insights", ok: true }]);
    // A not_found result names no record, so it produces no citation.
    expect(result?.citations).toEqual([]);
  });
});

describe("thread accounting", () => {
  it("accumulates lifetime usage across turns, including the auto-title call", async () => {
    const llm = new ScriptedGateway([titleStep(), { text: "Hi." }, { text: "Again." }]);
    const sessionId = await newThread();

    await runChatTurn(db, deps(llm), workspaceId, ACTOR, sessionId, "First");
    const afterOne = (await getSession(db, workspaceId, sessionId))!;
    // Two model calls: the title and the answer.
    expect(afterOne.totalInputTokens).toBe(20);
    expect(afterOne.totalOutputTokens).toBe(10);

    await runChatTurn(db, deps(llm), workspaceId, ACTOR, sessionId, "Second");
    const afterTwo = (await getSession(db, workspaceId, sessionId))!;
    // The title is already set, so the second turn is one model call.
    expect(afterTwo.totalInputTokens).toBe(30);
    expect(afterTwo.totalOutputTokens).toBe(15);
  });

  it("auto-titles and derives the goal from the opening message", async () => {
    const llm = new ScriptedGateway([
      { text: JSON.stringify({ title: "Product launch plan", goal: "Launch across LinkedIn" }) },
      { text: "Let's start with the audience." },
    ]);
    const sessionId = await newThread();

    await runChatTurn(db, deps(llm), workspaceId, ACTOR, sessionId, "I want to launch our product");

    const session = (await getSession(db, workspaceId, sessionId))!;
    expect(session.title).toBe("Product launch plan");
    expect(session.goal).toBe("Launch across LinkedIn");
  });

  it("never overwrites a title or goal the founder set", async () => {
    const llm = new ScriptedGateway([{ text: "Fine." }]);
    const session = await createSession(db, workspaceId, null, {
      title: "My thread",
      goal: "My goal",
    });

    await runChatTurn(db, deps(llm), workspaceId, ACTOR, session.id, "Hello");

    const after = (await getSession(db, workspaceId, session.id))!;
    expect(after.title).toBe("My thread");
    expect(after.goal).toBe("My goal");
    // And with both already set, no title call was made at all.
    expect(llm.calls).toHaveLength(1);
  });

  it("reports the thread as exhausted once the cap is spent", async () => {
    const sessionId = await newThread();
    await db.update(chatSessions)
      .set({ totalInputTokens: CHAT_THREAD_TOKEN_CAP, totalOutputTokens: 0 })
      .where(eq(chatSessions.id, sessionId));

    const session = (await getSession(db, workspaceId, sessionId))!;
    const { isThreadBudgetExhausted } = await import("../src/services/chat");
    expect(isThreadBudgetExhausted(session)).toBe(true);
  });

  it("returns undefined for a thread in another workspace", async () => {
    const other = randomUUID();
    await db.insert(workspaces).values({ id: other, name: "Other", createdAt: 1, updatedAt: 1 });
    const sessionId = await newThread();

    const result = await runChatTurn(
      db,
      deps(new ScriptedGateway([])),
      other,
      ACTOR,
      sessionId,
      "Leak me something",
    );
    expect(result).toBeUndefined();
  });
});
