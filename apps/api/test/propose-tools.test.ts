import { describe, expect, it } from "vitest";
import { AGENT_PROPOSALS_PER_RUN, PROPOSE_TOOL_NAMES } from "@tuezday/contracts";
import { toAgentTools } from "../src/agents/adapter";
import { simulatedAgentProposals, type AgentProposalService } from "../src/agents/proposals";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../src/agents/registry";
import { ALL_TOOLS, PROPOSE_TOOLS } from "../src/agents/tools/index";
import type { Db } from "../src/db";
import { createTestDb } from "./helpers";

const RUN_ID = "88888888-8888-4888-8888-888888888888";

function context(db: Db, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    evidence: {} as ToolContext["evidence"],
    safeFetch: {} as ToolContext["safeFetch"],
    workspaceId: "ws-1",
    actor: { userId: null, label: "system" },
    budget: DEFAULT_TOOL_BUDGET,
    proposals: simulatedAgentProposals(),
    agentRunId: RUN_ID,
    ...overrides,
  };
}

function toolsFor(ctx: ToolContext) {
  const wrapped = toAgentTools(ALL_TOOLS, ctx);
  return new Map(wrapped.map((tool) => [tool.definition.name, tool]));
}

describe("propose tools through the adapter (Sprint 69)", () => {
  it("declares all five to the model with a derivable schema", () => {
    const tools = toolsFor(context(createTestDb()));
    for (const name of PROPOSE_TOOL_NAMES) {
      const tool = tools.get(name);
      expect(tool, name).toBeDefined();
      expect(tool!.definition.inputSchema.type, name).toBe("object");
      expect(tool!.definition.description.length, name).toBeGreaterThan(40);
    }
  });

  it("returns invalid arguments as data, not as a thrown step failure", async () => {
    const tools = toolsFor(context(createTestDb()));
    const result = (await tools.get("propose_draft")!.handler({ content: "hi" })) as {
      error?: string;
      issues?: string[];
    };
    expect(result.error).toBe("invalid_arguments");
    expect(result.issues?.join(" ")).toContain("channel");
  });

  it("shares one proposal budget across every propose tool (D-69.8)", async () => {
    const tools = toolsFor(context(createTestDb()));
    const calls = [
      () => tools.get("propose_draft")!.handler({ content: "a", channel: "linkedin", rationale: "r" }),
      () => tools.get("propose_reply")!.handler({ inboxItemId: "i-1", rationale: "r" }),
      () => tools.get("propose_ad_mutation")!.handler({ launchId: "l-1", dailyBudgetCents: 100, rationale: "r" }),
      () => tools.get("propose_publication")!.handler({ draftId: "d-1", rationale: "r" }),
    ];
    const results = [] as Array<{ error?: string; ok?: boolean }>;
    for (const call of calls) results.push((await call()) as { error?: string; ok?: boolean });

    // Three different tools, one shared budget: the fourth is refused even
    // though no single tool was called more than once.
    expect(results.slice(0, AGENT_PROPOSALS_PER_RUN).every((r) => r.ok)).toBe(true);
    expect(results[AGENT_PROPOSALS_PER_RUN]!.error).toBe("proposal_cap_reached");
  });

  it("does not spend the proposal budget on read tools", async () => {
    const db = createTestDb();
    const tools = toolsFor(context(db, { budget: { maxCalls: 20, maxProposals: 1 } }));
    await tools.get("list_channel_guardrails")!.handler({});
    await tools.get("list_channel_guardrails")!.handler({});
    const result = (await tools
      .get("propose_draft")!
      .handler({ content: "a", channel: "linkedin", rationale: "r" })) as { ok?: boolean };
    expect(result.ok).toBe(true);
  });

  it("refuses rather than writing when no propose seam was injected (D-69.7)", async () => {
    const ctx = context(createTestDb());
    delete (ctx as { proposals?: AgentProposalService }).proposals;
    const tools = toolsFor(ctx);
    const result = (await tools
      .get("propose_publication")!
      .handler({ draftId: "d-1", rationale: "r" })) as { ok?: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("proposals_unavailable");
  });

  it("tells the model plainly that a simulated proposal changed nothing", async () => {
    const tools = toolsFor(context(createTestDb()));
    const result = (await tools
      .get("propose_draft")!
      .handler({ content: "a", channel: "linkedin", rationale: "r" })) as {
      simulated?: boolean;
      note?: string;
      id?: string | null;
    };
    expect(result.simulated).toBe(true);
    expect(result.id).toBeNull();
    expect(result.note).toContain("nothing was created");
  });

  it("tells it just as plainly not to re-propose a real one", async () => {
    const stub: AgentProposalService = {
      ...simulatedAgentProposals(),
      async proposeDraft() {
        return {
          ok: true,
          targetKind: "draft",
          id: "d-9",
          status: "pending_review",
          summary: "Submitted.",
          simulated: false,
        };
      },
    };
    const tools = toolsFor(context(createTestDb(), { proposals: stub }));
    const result = (await tools
      .get("propose_draft")!
      .handler({ content: "a", channel: "linkedin", rationale: "r" })) as { note?: string };
    // Without this the obvious agent failure mode is proposing the same thing
    // every step until the budget runs out.
    expect(result.note).toContain("do not propose it again");
  });
});
