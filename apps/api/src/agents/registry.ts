import type { z } from "zod";
import { AGENT_PROPOSALS_PER_RUN, type AgentToolName, type ToolAccessLevel } from "@tuezday/contracts";
import type { Db } from "../db/index";
import type { EvidenceStore } from "../evidence/store";
import type { SafeFetchService } from "../safe-fetch/index";
import type { AgentProposalService } from "./proposals";
import type { AgentQuestionService } from "./questions";

// ---------------------------------------------------------------------------
// Internal tool registry (Sprint 57) — the platform's capability surface for
// the model. Distinct from apps/mcp (a customer-facing shim over the public
// API). Three access tiers: `read` tools are unrestricted inside the
// workspace — the same membership rule that scopes HTTP routes; `propose`
// tools never execute, they mint a gated item and return its id (Sprint 69);
// `ask` tools write nothing at all — they record a question and suspend the
// run until a human answers (Sprint 70). There is deliberately no "execute"
// tier: an agent cannot do anything ungoverned, by construction.
//
// The tool implementations and the READ_TOOLS whitelist live in
// ./tools/index.ts; ./adapter.ts wraps them into the runner's AgentTool.
// ---------------------------------------------------------------------------

/** Who the run is acting as — the actorOf(request) shape, carried into every
 * tool call. Read tools use it for attribution parity with routes; any future
 * propose tool attributes its minted item to it. Never `human` for
 * agent-initiated writes (auth/guard.ts fails that closed). */
export interface ToolActor {
  userId: string | null;
  label: string;
}

/** Per-run tool budget, enforced by the adapter. Consumption counts
 * attempted calls (a failed call still counts — retry loops are what
 * budgets exist for). Exhaustion is returned to the model as error data,
 * never a crash; the runner's own bounds remain the hard stops. */
export interface ToolBudget {
  /** Max tool calls per run, across all tools. */
  maxCalls: number;
  /** Per-tool caps overriding the shared pool (e.g. safe_fetch_url). */
  perTool?: Partial<Record<string, number>>;
  /** Sprint 69 (D-69.8): max calls to `propose`-tier tools per run, counted
   * across all of them. A per-tool cap would let one run make three
   * publications *and* three ad mutations — not what "three proposals" means
   * to the founder reading the queue. */
  maxProposals?: number;
}

export const DEFAULT_TOOL_BUDGET: ToolBudget = {
  maxCalls: 20,
  // The one tool that leaves the tenant and burns wall-clock (20s deadline
  // per call) — and the obvious probe vector for a prompt-injected model.
  perTool: { safe_fetch_url: 3 },
  maxProposals: AGENT_PROPOSALS_PER_RUN,
};

export interface ToolContext {
  db: Db;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
  workspaceId: string;
  actor: ToolActor;
  budget: ToolBudget;
  /** Sprint 69: the gated write seam. Absent means the propose tools are not
   * offered at all (D-69.7) — there is no "propose without a gate" state. */
  proposals?: AgentProposalService;
  /** Sprint 70: the ask seam. Absent means `ask_founder` is not offered — a
   * question nobody can answer is worse than no question. */
  questions?: AgentQuestionService;
  /** The run a propose tool attributes its proposal to. Set by the engine. */
  agentRunId?: string;
  /** What a question suspends (Sprint 70). Absent for a one-shot run: it
   * records the question but there is no resume point to carry an answer to. */
  pipelineRunId?: string;
  stepKey?: string;
}

export interface Tool<I = unknown, O = unknown> {
  name: AgentToolName;
  /** Written for the model, not for docs. */
  description: string;
  /** Single source of truth (packages/contracts toolInputSchemas) — the
   * model-facing JSON Schema is derived from it (../llm/json-schema.ts). */
  input: z.ZodType<I>;
  access: ToolAccessLevel;
  run(ctx: ToolContext, input: I): Promise<O>;
}

/** Heterogeneous registry entry — input/output types differ per tool. */
export type AnyTool = Tool<any, any>;

/** Shared free-text bound for tool output fields (copilot's convention). */
export const TOOL_TEXT_LIMIT = 2000;

export function compactText(text: string, max = TOOL_TEXT_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}… (truncated)`;
}
