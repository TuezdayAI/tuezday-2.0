import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentMessage } from "@tuezday/contracts";
import { agentRuns, agentRunSteps, evidenceDocuments, workspaces } from "../src/db/schema";
import type { Db } from "../src/db";
import type {
  AddDocumentInput,
  EvidenceStore,
  StoreSearchResult,
} from "../src/evidence/store";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import type { AgentStepParams, AgentStepResult } from "../src/llm/gateway";
import {
  AgentRunner,
  NeedsHumanSignal,
  type AgentRunEvent,
  type AgentRunParams,
  type AgentTool,
} from "../src/agents/runner";
import { toAgentTools } from "../src/agents/adapter";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../src/agents/registry";
import { searchEvidenceTool } from "../src/agents/tools/search-evidence";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "workspace-agents";

async function fixture(script: ScriptedStep[]) {
  const db = await createTestDb();
  await db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Agents", createdAt: 1, updatedAt: 1 });
  const gateway = new ScriptedGateway(script);
  const runner = new AgentRunner(db, gateway);
  return { db, gateway, runner };
}

function baseParams(overrides: Partial<AgentRunParams> = {}): AgentRunParams {
  return {
    workspaceId: WORKSPACE_ID,
    task: "proof",
    createdBy: "user:founder",
    system: "You are a test agent.",
    messages: [{ role: "user", content: "Do the thing." }],
    maxSteps: 10,
    maxTokens: 100_000,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function lookupTool(): { tool: AgentTool; received: unknown[] } {
  const received: unknown[] = [];
  return {
    received,
    tool: {
      definition: {
        name: "lookup",
        description: "Look up a value.",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      handler: async (args) => {
        received.push(args);
        return { value: `${(args as { q: string }).q}!` };
      },
    },
  };
}

async function runRows(db: Db, runId: string) {
  const run = ((await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0])!;
  const steps = await db
    .select()
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(agentRunSteps.stepIndex);
  return { run, steps };
}

describe("AgentRunner", () => {
  it("drives a three-step tool-using loop and persists the full transcript", async () => {
    const { db, gateway, runner } = await fixture([
      { toolCalls: [{ name: "lookup", arguments: { q: "alpha" } }] },
      { text: "Need one more.", toolCalls: [{ name: "lookup", arguments: { q: "beta" } }] },
      { text: "Final answer.", usage: { inputTokens: 40, outputTokens: 20 } },
    ]);
    const { tool, received } = lookupTool();

    const result = await runner.run(baseParams({ tools: [tool] }));

    expect(result.stopReason).toBe("complete");
    expect(result.output).toBe("Final answer.");
    expect(result.toolCalls.map((c) => c.name)).toEqual(["lookup", "lookup"]);
    expect(received).toEqual([{ q: "alpha" }, { q: "beta" }]);
    // Transcript: user, assistant(call), tool, assistant(call), tool, assistant.
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(result.usage).toEqual({
      inputTokens: 10 + 10 + 40,
      outputTokens: 5 + 5 + 20,
      cachedTokens: 0,
      costCents: 0, // "scripted" model has no pricing entry
    });

    // The model saw the tool declarations and the growing history.
    expect(gateway.calls[0]!.tools?.map((t) => t.name)).toEqual(["lookup"]);
    expect(gateway.calls[0]!.system).toBe("You are a test agent.");
    expect(gateway.calls[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "lookup",
      content: JSON.stringify({ value: "alpha!" }),
    });

    // Persisted trace: run totals plus interleaved model/tool steps in order.
    const { run, steps } = await runRows(db, result.runId);
    expect(run.status).toBe("done");
    expect(run.stopReason).toBe("complete");
    expect(run.workspaceId).toBe(WORKSPACE_ID);
    expect(run.task).toBe("proof");
    expect(run.createdBy).toBe("user:founder");
    expect(run.inputTokens).toBe(60);
    expect(run.outputTokens).toBe(30);
    expect(run.stepCount).toBe(5);
    expect(run.outputJson).toBe(JSON.stringify("Final answer."));
    expect(run.finishedAt).not.toBeNull();
    expect(JSON.parse(run.inputMessages)).toEqual([{ role: "user", content: "Do the thing." }]);

    expect(steps.map((s) => s.kind)).toEqual([
      "model_call",
      "tool_call",
      "model_call",
      "tool_call",
      "model_call",
    ]);
    expect(steps.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3, 4]);
    const firstTool = steps[1]!;
    expect(firstTool.toolName).toBe("lookup");
    expect(JSON.parse(firstTool.toolArgsJson!)).toEqual({ q: "alpha" });
    expect(JSON.parse(firstTool.toolResultJson!)).toEqual({ value: "alpha!" });
    expect(firstTool.toolError).toBeNull();
    const firstModel = steps[0]!;
    expect(JSON.parse(firstModel.messageJson!).toolCalls).toHaveLength(1);
    expect(firstModel.inputTokens).toBe(10);
    expect(firstModel.outputTokens).toBe(5);
  });

  it("records max_steps as the stop reason when the loop never finishes", async () => {
    const { db, runner } = await fixture([
      { toolCalls: [{ name: "lookup", arguments: { q: "a" } }] },
      { toolCalls: [{ name: "lookup", arguments: { q: "b" } }] },
      { toolCalls: [{ name: "lookup", arguments: { q: "c" } }] },
    ]);
    const { tool } = lookupTool();

    const result = await runner.run(baseParams({ tools: [tool], maxSteps: 2 }));

    expect(result.stopReason).toBe("max_steps");
    const { run } = await runRows(db, result.runId);
    expect(run.stopReason).toBe("max_steps");
    expect(run.status).toBe("done");
  });

  it("records max_tokens when cumulative usage crosses the budget", async () => {
    const { db, runner } = await fixture([
      { toolCalls: [{ name: "lookup", arguments: { q: "a" } }], usage: { inputTokens: 600 } },
      { toolCalls: [{ name: "lookup", arguments: { q: "b" } }], usage: { inputTokens: 600 } },
    ]);
    const { tool } = lookupTool();

    const result = await runner.run(baseParams({ tools: [tool], maxTokens: 1_000 }));

    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage.inputTokens).toBe(1_200);
    expect((await runRows(db, result.runId)).run.stopReason).toBe("max_tokens");
  });

  it("records timeout when the deadline passes mid-call", async () => {
    const { db, runner } = await fixture([{ text: "too slow", delayMs: 100 }]);

    const result = await runner.run(baseParams({ timeoutMs: 25 }));

    expect(result.stopReason).toBe("timeout");
    const { run } = await runRows(db, result.runId);
    expect(run.stopReason).toBe("timeout");
    expect(run.status).toBe("done"); // never left stuck "running"
  });

  it("feeds tool errors back to the model instead of crashing the run", async () => {
    const { db, runner } = await fixture([
      { toolCalls: [{ name: "explode", arguments: {} }] },
      { text: "Recovered without the tool." },
    ]);
    const tool: AgentTool = {
      definition: { name: "explode", description: "Always fails.", inputSchema: { type: "object" } },
      handler: async () => {
        throw new Error("boom");
      },
    };

    const result = await runner.run(baseParams({ tools: [tool] }));

    expect(result.stopReason).toBe("complete");
    const toolMessage = result.messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content).toBe("Error: boom");
    const { steps } = await runRows(db, result.runId);
    const toolStep = steps.find((s) => s.kind === "tool_call")!;
    expect(toolStep.toolError).toBe("boom");
    expect(toolStep.toolResultJson).toBeNull();
  });

  it("answers unknown tool calls with an error result and keeps going", async () => {
    const { runner } = await fixture([
      { toolCalls: [{ name: "no_such_tool", arguments: {} }] },
      { text: "Done anyway." },
    ]);

    const result = await runner.run(baseParams());

    expect(result.stopReason).toBe("complete");
    expect(result.messages.find((m) => m.role === "tool")!.content).toContain(
      'Unknown tool "no_such_tool"',
    );
  });

  it("stops with needs_human when a tool raises the signal", async () => {
    const { db, runner } = await fixture([{ toolCalls: [{ name: "spend", arguments: { cents: 500 } }] }]);
    const tool: AgentTool = {
      definition: { name: "spend", description: "Spend money.", inputSchema: { type: "object" } },
      handler: async () => {
        throw new NeedsHumanSignal("budget approval required");
      },
    };

    const result = await runner.run(baseParams({ tools: [tool] }));

    expect(result.stopReason).toBe("needs_human");
    expect(result.error).toBe("budget approval required");
    const { run, steps } = await runRows(db, result.runId);
    expect(run.stopReason).toBe("needs_human");
    expect(run.error).toBe("budget approval required");
    expect(steps.find((s) => s.kind === "tool_call")!.toolError).toBe(
      "needs_human: budget approval required",
    );
  });

  it("finalizes the run with stop reason error on a gateway failure", async () => {
    const { db, runner } = await fixture([]); // exhausted script throws GatewayError

    const result = await runner.run(baseParams());

    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("script exhausted");
    const { run } = await runRows(db, result.runId);
    expect(run.status).toBe("done");
    expect(run.stopReason).toBe("error");
    expect(run.error).toContain("script exhausted");
  });

  it("parses structured output when a responseSchema is given", async () => {
    const { db, runner } = await fixture([{ text: '{"score": 7, "verdict": "good"}' }]);
    const responseSchema = {
      type: "object",
      properties: { score: { type: "integer" }, verdict: { type: "string" } },
    };

    const result = await runner.run(baseParams({ responseSchema }));

    expect(result.stopReason).toBe("complete");
    expect(result.output).toEqual({ score: 7, verdict: "good" });
    expect(JSON.parse((await runRows(db, result.runId)).run.outputJson!)).toEqual({
      score: 7,
      verdict: "good",
    });
  });

  it("stops with error when structured output is not valid JSON", async () => {
    const { runner } = await fixture([{ text: "definitely not json" }]);

    const result = await runner.run(
      baseParams({ responseSchema: { type: "object", properties: {} } }),
    );

    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("not valid JSON");
  });

  it("throws (not a run result) when the gateway lacks agentStep", async () => {
    const db = await createTestDb();
    await db.insert(workspaces)
      .values({ id: WORKSPACE_ID, name: "Agents", createdAt: 1, updatedAt: 1 });
    const runner = new AgentRunner(db, {
      generate: async () => ({ text: "x", model: "m", provider: "p", durationMs: 0 }),
    });

    await expect(runner.run(baseParams())).rejects.toThrow(/agentStep/);
  });
});

// Sprint 79: the runner gained a step boundary, so a long detached run can be
// heartbeated, redirected and stopped without any of that leaking into the
// tool loop. All three ride the same hook.
describe("AgentRunner step boundaries", () => {
  it("stops with `cancelled` when the signal aborts, keeping the steps it took", async () => {
    const { db, runner } = await fixture([
      { toolCalls: [{ name: "lookup", arguments: { q: "alpha" } }] },
      { text: "Never reached." },
    ]);
    const { tool } = lookupTool();
    const controller = new AbortController();

    const runId = randomUUID();
    const result = await runner.run(
      baseParams({
        runId,
        tools: [tool],
        signal: controller.signal,
        onStepBoundary: ({ modelCalls }) => {
          // After the first model call and its tool dispatch: the founder
          // pressed stop while it was mid-run, not before it started.
          if (modelCalls === 1) controller.abort(new Error("cancelled"));
          return Promise.resolve({});
        },
      }),
    );

    expect(result.stopReason).toBe("cancelled");
    const { run, steps } = await runRows(db, runId);
    expect(run.stopReason).toBe("cancelled");
    // The partial trace survives: a cancelled run is still a run somebody paid
    // for, and the founder gets to see what it did before they stopped it.
    expect(steps.length).toBeGreaterThan(0);
  });

  it("stops when the hook itself asks to, without needing a signal", async () => {
    const { runner } = await fixture([{ text: "Never reached." }]);
    const result = await runner.run(
      baseParams({ onStepBoundary: () => Promise.resolve({ cancel: true }) }),
    );
    expect(result.stopReason).toBe("cancelled");
  });

  it("injects a message at the boundary and persists it as its own step", async () => {
    const { db, gateway, runner } = await fixture([{ text: "Understood." }]);
    const runId = randomUUID();
    let injected = false;

    const result = await runner.run(
      baseParams({
        runId,
        onStepBoundary: () => {
          if (injected) return Promise.resolve({});
          injected = true;
          return Promise.resolve({
            inject: [{ role: "user" as const, content: "Change of plan: LinkedIn only." }],
          });
        },
      }),
    );

    expect(result.stopReason).toBe("complete");
    // The model saw it on the very next call — that is the whole contract.
    expect(gateway.calls[0]!.messages.at(-1)?.content).toContain("LinkedIn only");
    const { steps } = await runRows(db, runId);
    expect(steps.some((step) => step.kind === "steer")).toBe(true);
  });

  it("records a subagent run as a child of the run that spawned it", async () => {
    const { db, runner } = await fixture([{ text: "Report." }]);
    const parentRunId = randomUUID();
    const runId = randomUUID();
    await runner.run(baseParams({ runId, parentRunId }));
    const { run } = await runRows(db, runId);
    expect(run.parentRunId).toBe(parentRunId);
  });
});

describe("AgentRunner streaming", () => {
  it("emits deltas, tool boundaries, step boundaries and the stop reason in order", async () => {
    const { runner } = await fixture([
      { text: "Hello", toolCalls: [{ name: "lookup", arguments: { q: "x" } }] },
      { text: "Done" },
    ]);
    const { tool } = lookupTool();
    const events: AgentRunEvent[] = [];

    const result = await runner.run(
      baseParams({ tools: [tool], onEvent: (e) => events.push(e) }),
    );

    expect(result.stopReason).toBe("complete");
    expect(events.map((e) => e.type)).toEqual([
      "run_start",
      "step_start",
      "text_delta",
      "text_delta",
      "step_end",
      "tool_call_start",
      "tool_call_end",
      "step_start",
      "text_delta",
      "text_delta",
      "step_end",
      "run_end",
    ]);
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.text);
    expect(deltas.join("")).toBe("HelloDone");
    const runEnd = events.at(-1) as Extract<AgentRunEvent, { type: "run_end" }>;
    expect(runEnd.stopReason).toBe("complete");
    expect(runEnd.usage.inputTokens).toBe(20);
    const toolStart = events.find((e) => e.type === "tool_call_start") as Extract<
      AgentRunEvent,
      { type: "tool_call_start" }
    >;
    expect(toolStart.call.name).toBe("lookup");
    const toolEnd = events.find((e) => e.type === "tool_call_end") as Extract<
      AgentRunEvent,
      { type: "tool_call_end" }
    >;
    expect(toolEnd.result).toEqual({ value: "x!" });
  });

  it("degrades to one whole-text delta when the gateway cannot stream", async () => {
    const db = await createTestDb();
    await db.insert(workspaces)
      .values({ id: WORKSPACE_ID, name: "Agents", createdAt: 1, updatedAt: 1 });
    const scripted = new ScriptedGateway([{ text: "All at once" }]);
    // agentStep only — no agentStepStream.
    const runner = new AgentRunner(db, {
      generate: scripted.generate.bind(scripted),
      agentStep: async (params: AgentStepParams): Promise<AgentStepResult> =>
        await scripted.agentStep(params),
    });
    const events: AgentRunEvent[] = [];

    const result = await runner.run(baseParams({ onEvent: (e) => events.push(e) }));

    expect(result.stopReason).toBe("complete");
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.text).toBe("All at once");
  });
});

describe("search_evidence proof tool", () => {
  class FakeEvidenceStore implements EvidenceStore {
    private docs = new Map<string, AddDocumentInput>();
    private nextId = 1;

    async health() {
      return { healthy: true };
    }
    async createCollection(name: string) {
      return `collection-${name}`;
    }
    async addDocument(input: AddDocumentInput) {
      const id = `store-doc-${this.nextId++}`;
      this.docs.set(id, input);
      return id;
    }
    async attachDocument() {}
    async deleteDocument(documentId: string) {
      this.docs.delete(documentId);
    }
    async search(query: string, collectionId: string, limit: number): Promise<StoreSearchResult[]> {
      const terms = query.toLowerCase().split(/\s+/);
      return [...this.docs.entries()]
        .filter(([, doc]) => doc.collectionId === collectionId)
        .filter(([, doc]) => terms.some((t) => doc.content.toLowerCase().includes(t)))
        .slice(0, limit)
        .map(([documentId, doc]) => ({ documentId, text: doc.content, score: 0.9 }));
    }
  }

  // Sprint 57: the proof tool became a registry Tool — wrap it the way
  // production does (toAgentTools) to get the runner-facing AgentTool.
  function evidenceAgentTool(db: Db, store: EvidenceStore): AgentTool {
    const ctx: ToolContext = {
      db,
      evidence: store,
      safeFetch: null as unknown as ToolContext["safeFetch"],
      workspaceId: WORKSPACE_ID,
      actor: { userId: "founder", label: "Founder" },
      budget: DEFAULT_TOOL_BUDGET,
    };
    return toAgentTools([searchEvidenceTool], ctx)[0]!;
  }

  async function seededEvidence() {
    const db = await createTestDb();
    await db.insert(workspaces)
      .values({ id: WORKSPACE_ID, name: "Agents", createdAt: 1, updatedAt: 1 });
    const store = new FakeEvidenceStore();
    const collectionId = await store.createCollection(WORKSPACE_ID);
    const storeDocId = await store.addDocument({
      title: "Pricing research",
      content: "Enterprise buyers expect usage-based pricing with an annual floor.",
      collectionId,
      metadata: {},
    });
    // evidence_collections is created lazily by ensureWorkspaceCollection; the
    // document row is what marks it ready and workspace-owned.
    await db.insert(evidenceDocuments)
      .values({
        id: "doc-1",
        workspaceId: WORKSPACE_ID,
        r2rDocumentId: storeDocId,
        title: "Pricing research",
        chars: 60,
        status: "ready",
        kind: "manual",
        createdAt: 1,
      });
    return { db, store };
  }

  it("lets an agent search workspace evidence end to end", async () => {
    const { db, store } = await seededEvidence();
    const gateway = new ScriptedGateway([
      { toolCalls: [{ name: "search_evidence", arguments: { query: "pricing" } }] },
      { text: "Buyers want usage-based pricing." },
    ]);
    const runner = new AgentRunner(db, gateway);

    const result = await runner.run(
      baseParams({ tools: [evidenceAgentTool(db, store)] }),
    );

    expect(result.stopReason).toBe("complete");
    const toolMessage = result.messages.find((m: AgentMessage) => m.role === "tool")!;
    const payload = JSON.parse(toolMessage.content) as {
      results: Array<{ title: string; text: string }>;
    };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]!.title).toBe("Pricing research");
    expect(payload.results[0]!.text).toContain("usage-based pricing");
  });

  it("reports an empty corpus instead of failing", async () => {
    const db = await createTestDb();
    await db.insert(workspaces)
      .values({ id: WORKSPACE_ID, name: "Agents", createdAt: 1, updatedAt: 1 });
    const store = new FakeEvidenceStore();
    const tool = evidenceAgentTool(db, store);

    const outcome = (await tool.handler({ query: "anything" })) as { results: unknown[] };

    expect(outcome.results).toEqual([]);
  });

  it("returns malformed arguments as error data via its input schema", async () => {
    const { db, store } = await seededEvidence();
    const tool = evidenceAgentTool(db, store);

    const outcome = (await tool.handler({ limit: 3 })) as { error: string };
    expect(outcome.error).toBe("invalid_arguments");
  });
});
