import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_TOOL_NAMES,
  ASK_TOOL_NAMES,
  PROPOSE_TOOL_NAMES,
  READ_TOOL_NAMES,
  toolInputSchemas,
} from "@tuezday/contracts";
import { toAgentTools } from "../src/agents/adapter";
import { jsonSchemaFor } from "../src/llm/json-schema";
import {
  compactText,
  DEFAULT_TOOL_BUDGET,
  type AnyTool,
  type ToolContext,
} from "../src/agents/registry";
import { AgentRunner } from "../src/agents/runner";
import { workspaces } from "../src/db/schema";
import { ScriptedGateway } from "../src/llm/scripted";
import { createTestDb } from "./helpers";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: null as unknown as ToolContext["db"],
    evidence: null as unknown as ToolContext["evidence"],
    safeFetch: null as unknown as ToolContext["safeFetch"],
    workspaceId: "ws-1",
    actor: { userId: "user-1", label: "Founder" },
    budget: { maxCalls: 20 },
    ...overrides,
  };
}

function echoTool(name: AnyTool["name"], input: z.ZodTypeAny = z.object({ q: z.string() })): {
  tool: AnyTool;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const tool: AnyTool = {
    name,
    description: `echo tool ${name}`,
    input,
    access: "read",
    run: async (_ctx, parsed) => {
      calls.push(parsed);
      return { echoed: parsed };
    },
  };
  return { tool, calls };
}

describe("jsonSchemaFor", () => {
  it("converts every contracts tool input schema without throwing", () => {
    for (const name of AGENT_TOOL_NAMES) {
      const schema = jsonSchemaFor(toolInputSchemas[name]);
      expect(schema.type, name).toBe("object");
      expect(schema.properties, name).toBeTypeOf("object");
    }
  });

  it("derives required, integer bounds and enums", () => {
    const schema = jsonSchemaFor(toolInputSchemas.search_evidence);
    expect(schema.required).toEqual(["query"]);
    expect((schema.properties as Record<string, unknown>).limit).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 10,
    });

    const brain = jsonSchemaFor(toolInputSchemas.get_brain_section);
    expect(brain.required).toBeUndefined();
    const docType = (brain.properties as Record<string, { enum?: string[] }>).docType!;
    expect(docType.enum).toEqual(["soul", "icp", "voice", "history", "now"]);
  });

  it("throws loudly on unsupported constructs", () => {
    expect(() => jsonSchemaFor(z.object({ bad: z.record(z.string()) }))).toThrow(/unsupported/);
    expect(() => jsonSchemaFor(z.string())).toThrow(/must be zod objects/);
  });
});

describe("compactText", () => {
  it("passes short text through and truncates long text with a marker", () => {
    expect(compactText("short")).toBe("short");
    const long = compactText("x".repeat(5000));
    expect(long.length).toBeLessThan(2100);
    expect(long.endsWith("… (truncated)")).toBe(true);
  });
});

describe("toAgentTools", () => {
  it("dispatches valid calls with parsed input and the shared context", async () => {
    const { tool, calls } = echoTool("search_evidence");
    const [agentTool] = toAgentTools([tool], makeCtx());
    const result = await agentTool!.handler({ q: "hello" });
    expect(result).toEqual({ echoed: { q: "hello" } });
    expect(calls).toEqual([{ q: "hello" }]);
  });

  it("returns zod issues as error data instead of throwing", async () => {
    const { tool, calls } = echoTool("search_evidence");
    const [agentTool] = toAgentTools([tool], makeCtx());
    const result = (await agentTool!.handler({ q: 42 })) as { error: string; issues: string[] };
    expect(result.error).toBe("invalid_arguments");
    expect(result.issues.join(" ")).toContain("q");
    expect(calls).toEqual([]);
  });

  it("exhausts the total budget and stops calling the tool", async () => {
    const { tool, calls } = echoTool("search_evidence");
    const [agentTool] = toAgentTools([tool], makeCtx({ budget: { maxCalls: 2 } }));
    await agentTool!.handler({ q: "one" });
    await agentTool!.handler({ q: "two" });
    const third = (await agentTool!.handler({ q: "three" })) as { error: string; maxCalls: number };
    expect(third.error).toBe("tool_budget_exhausted");
    expect(third.maxCalls).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("failed calls still consume budget (retry loops are the point)", async () => {
    const { tool, calls } = echoTool("search_evidence");
    const [agentTool] = toAgentTools([tool], makeCtx({ budget: { maxCalls: 1 } }));
    await agentTool!.handler({ q: 42 }); // invalid — still counted
    const second = (await agentTool!.handler({ q: "valid" })) as { error: string };
    expect(second.error).toBe("tool_budget_exhausted");
    expect(calls).toEqual([]);
  });

  it("enforces per-tool caps from the default budget", async () => {
    const fetchy = echoTool("safe_fetch_url");
    const other = echoTool("search_evidence");
    const tools = toAgentTools([fetchy.tool, other.tool], makeCtx({ budget: DEFAULT_TOOL_BUDGET }));
    const fetchTool = tools[0]!;
    for (let i = 0; i < 3; i += 1) await fetchTool.handler({ q: `call ${i}` });
    const fourth = (await fetchTool.handler({ q: "four" })) as { error: string; maxCalls: number };
    expect(fourth.error).toBe("tool_budget_exhausted");
    expect(fourth.maxCalls).toBe(3);
    expect(fetchy.calls).toHaveLength(3);
    // The shared pool is not exhausted — other tools still run.
    expect(await tools[1]!.handler({ q: "still fine" })).toEqual({ echoed: { q: "still fine" } });
  });

  it("guards against oversized results", async () => {
    const tool: AnyTool = {
      name: "search_evidence",
      description: "flood",
      input: z.object({}),
      access: "read",
      run: async () => ({ blob: "x".repeat(50_000) }),
    };
    const [agentTool] = toAgentTools([tool], makeCtx());
    const result = (await agentTool!.handler({})) as { error: string };
    expect(result.error).toBe("result_too_large");
  });

  it("drives a registry tool through a full AgentRunner loop", async () => {
    const db = createTestDb();
    db.insert(workspaces)
      .values({ id: "ws-run", name: "Registry", createdAt: 1, updatedAt: 1 })
      .run();

    const { tool } = echoTool("search_evidence", z.object({ query: z.string() }));
    const gateway = new ScriptedGateway([
      { toolCalls: [{ name: "search_evidence", arguments: { query: "positioning" } }] },
      { text: "Answer based on the tool result." },
    ]);
    const runner = new AgentRunner(db, gateway);
    const result = await runner.run({
      workspaceId: "ws-run",
      task: "registry-test",
      createdBy: "user:founder",
      system: "You are a test agent.",
      messages: [{ role: "user", content: "What is our positioning?" }],
      tools: toAgentTools([tool], makeCtx()),
      maxSteps: 3,
      maxTokens: 10_000,
      timeoutMs: 5_000,
    });

    expect(result.stopReason).toBe("complete");
    expect(result.output).toBe("Answer based on the tool result.");
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("echoed");
    // The model-facing declaration carried the derived JSON Schema.
    const declared = gateway.calls[0]!.tools?.find((t) => t.name === "search_evidence");
    expect(declared?.inputSchema.required).toEqual(["query"]);
  });
});

describe("tool whitelist", () => {
  it("stays in lockstep with the contracts vocabulary, tier by tier", async () => {
    const { ALL_TOOLS, ASK_TOOLS, PROPOSE_TOOLS, READ_TOOLS, getTool } = await import(
      "../src/agents/tools/index"
    );
    expect(ALL_TOOLS.map((t) => t.name)).toEqual([...AGENT_TOOL_NAMES]);
    expect(READ_TOOLS.map((t) => t.name)).toEqual([...READ_TOOL_NAMES]);
    expect(PROPOSE_TOOLS.map((t) => t.name)).toEqual([...PROPOSE_TOOL_NAMES]);
    expect(ASK_TOOLS.map((t) => t.name)).toEqual([...ASK_TOOL_NAMES]);
    for (const tool of READ_TOOLS) expect(tool.access, tool.name).toBe("read");
    // Sprint 69: the access tier is what the adapter's proposal budget keys
    // off, so a propose tool mislabelled `read` would silently escape the cap.
    for (const tool of PROPOSE_TOOLS) expect(tool.access, tool.name).toBe("propose");
    // Sprint 70: and the tier is what decides whether a tool is offered at all
    // when nothing can answer a question (the engine filters on it).
    for (const tool of ASK_TOOLS) expect(tool.access, tool.name).toBe("ask");
    for (const tool of ALL_TOOLS) {
      expect(tool.input, tool.name).toBe(toolInputSchemas[tool.name]);
      // Every declared schema derives cleanly for the model.
      expect(() => jsonSchemaFor(tool.input), tool.name).not.toThrow();
    }
    expect(getTool("search_evidence")).toBeDefined();
    expect(getTool("propose_publication")).toBeDefined();
    expect(getTool("ask_founder")).toBeDefined();
    expect(getTool("rm_rf")).toBeUndefined();
  });
});

describe("safe_fetch_url", () => {
  function fetchCtx(fetchImpl: ToolContext["safeFetch"]["fetch"]): ToolContext {
    return makeCtx({
      safeFetch: { validateUrl: (u: string) => new URL(u), fetch: fetchImpl },
    });
  }

  it("returns final url, status, content type and bounded text", async () => {
    const { safeFetchUrlTool } = await import("../src/agents/tools/safe-fetch-url");
    const ctx = fetchCtx(async (request) => {
      expect(request.profile).toBe("website");
      return {
        finalUrl: "https://example.com/post",
        status: 200,
        contentType: "text/html",
        bytes: new Uint8Array(),
        text: () => `<p>${"long ".repeat(2000)}</p>`,
        json: <T = unknown>() => ({}) as T,
      };
    });
    const result = (await safeFetchUrlTool.run(ctx, { url: "https://example.com/post" })) as {
      finalUrl: string;
      status: number;
      text: string;
    };
    expect(result.finalUrl).toBe("https://example.com/post");
    expect(result.status).toBe(200);
    expect(result.text.length).toBeLessThan(5100);
    expect(result.text.endsWith("… (truncated)")).toBe(true);
  });

  it("serializes failures to public messages only", async () => {
    const { safeFetchUrlTool } = await import("../src/agents/tools/safe-fetch-url");
    const { SafeFetchError } = await import("../src/safe-fetch/index");
    const blocked = fetchCtx(async () => {
      throw new SafeFetchError("destination_blocked");
    });
    const blockedResult = (await safeFetchUrlTool.run(blocked, {
      url: "https://internal.example",
    })) as { error: string; note: string };
    expect(blockedResult).toEqual({
      error: "destination_blocked",
      note: "The destination is not allowed.",
    });

    // A raw transport error must not leak its message.
    const raw = fetchCtx(async () => {
      throw new Error("ECONNREFUSED 10.0.0.7:443 (internal-billing.svc)");
    });
    const rawResult = (await safeFetchUrlTool.run(raw, { url: "https://example.com" })) as {
      error: string;
      note: string;
    };
    expect(rawResult.error).toBe("transport_failed");
    expect(JSON.stringify(rawResult)).not.toContain("10.0.0.7");
  });
});
