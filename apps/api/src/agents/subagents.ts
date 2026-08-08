// Sprint 79 (PRD §10, Move 9c): the delegation seam.
//
// Leaf module, and deliberately so — the same rule `agents/questions.ts` and
// `agents/proposals.ts` follow. `agents/tools/index.ts` builds TOOLS_BY_NAME at
// module load, so anything a tool file reaches has to reach nothing back. The
// live implementation (services/subagents.ts) drives an AgentRunner over the
// registry; the tool only ever sees the interface below.
//
// The two properties that make delegation safe are both structural, not
// prompted (D-79.4):
//
//   1. A worker's ToolContext carries no `proposals`, no `questions` and no
//      `subagents`, so those tools cannot be CONSTRUCTED for it. Only the
//      orchestrator can propose, only the orchestrator can ask, and delegation
//      cannot recurse.
//   2. A worker runs with a `responseSchema`, so what comes back is a bounded
//      report rather than a transcript (D-79.5). That is the context economy
//      the whole mechanism exists to buy, and a schema is a property where a
//      prompt instruction would be a hope.

import {
  SUBAGENT_BOUNDS,
  type AgentToolName,
  type SubagentReport,
  type SubagentRole,
} from "@tuezday/contracts";

export interface SubagentProfile {
  /** Shown in the Inspector and in the task's progress panel. */
  label: string;
  /** Appended to the resolved brain context that every run shares. A worker
   * is not a different agent with a different worldview — it is the same
   * context, pointed at one job. */
  system: string;
  /** The worker's tool allowlist, a subset of the read tools. */
  tools: readonly AgentToolName[];
  bounds: { maxSteps: number; maxTokens: number; timeoutMs: number };
}

/**
 * The catalogue (D-79.6). Four named roles rather than free-form "spawn an
 * agent that does X": a role is inspectable, individually tunable, and cheap
 * to reason about, where an open prompt surface inside a governance sprint is
 * none of those things. Adding a fifth is a one-object change.
 */
export const SUBAGENT_PROFILES: Record<SubagentRole, SubagentProfile> = {
  research: {
    label: "Research",
    system:
      "You are a research worker. You have one objective and no conversation. Gather what the evidence corpus, the discovery feed and (sparingly) the open web actually say about it, then report. Every claim you report must trace to something you read — if you could not establish it, put it in `gaps` rather than softening it into a finding. Do not speculate, do not recommend, and do not write marketing copy: something else decides what to do with what you find.",
    tools: [
      "search_evidence",
      "search_discovery_items",
      "get_brain_section",
      "get_campaign_plan",
      "safe_fetch_url",
    ],
    bounds: SUBAGENT_BOUNDS,
  },
  competitor_scan: {
    label: "Competitor scan",
    system:
      "You are a competitor-scanning worker. Establish what the named competitors have actually shipped, announced or changed in the window you were given. Prefer primary sources — their own posts and pages — over commentary about them, and say which you used. A competitor you could not find anything on is a `gap`, not a finding of 'no activity'. Report observations, not positioning advice.",
    tools: [
      "search_discovery_items",
      "search_evidence",
      "get_prior_posts_on_topic",
      "safe_fetch_url",
    ],
    bounds: SUBAGENT_BOUNDS,
  },
  variant_generation: {
    label: "Variant generation",
    system:
      "You are a variant-generation worker. Produce distinct angles on the objective you were given — genuinely different framings, not the same sentence reworded — grounded in the workspace's voice, its persona, and what has actually performed before. Each angle goes in `findings.claim` as a one-line description of the angle plus the line that carries it. You are drafting options for something else to choose between; you do not create, publish or approve anything.",
    tools: [
      "get_brain_section",
      "get_persona",
      "list_channel_guardrails",
      "find_similar_approved_drafts",
      "find_instructive_rejections",
      "get_prior_posts_on_topic",
    ],
    bounds: SUBAGENT_BOUNDS,
  },
  metrics_review: {
    label: "Metrics review",
    system:
      "You are a metrics worker. Answer the objective from the metric model and nothing else. State the window and the subject of every number you report — a figure without its window is not a fact — and never mix a cumulative metric with a periodic one in the same comparison. If the data does not support a conclusion, that belongs in `gaps`.",
    tools: [
      "get_metric_summary",
      "get_campaign_insights",
      "get_workspace_insights",
      "get_sequence_funnel",
      "list_recent_publications_with_metrics",
    ],
    bounds: SUBAGENT_BOUNDS,
  },
};

/** Who delegated, and what the child run should hang off. */
export interface DelegateOrigin {
  workspaceId: string;
  /** The orchestrator's run. Becomes the child's `parent_run_id`. */
  parentRunId: string;
  agentTaskId: string | null;
  /** The resolved context bundle the parent is running under, so the worker
   * shares the workspace's brain rather than inventing one. */
  system: string;
}

export interface DelegateArgs {
  role: SubagentRole;
  objective: string;
  focus?: string;
}

export type DelegateOutcome =
  /** The worker finished and its report validated against the schema. */
  | { status: "ok"; runId: string; role: SubagentRole; report: SubagentReport }
  /** It ran and did not produce a usable report — a bound tripped, or the
   * model's final answer did not fit the schema. Error DATA for the
   * orchestrator, never a throw: one failed worker is not a failed task. */
  | { status: "failed"; runId: string | null; role: SubagentRole; error: string }
  /** A cap stopped it before it started. */
  | { status: "refused"; role: SubagentRole; error: string; note: string };

export interface SubagentService {
  delegate(origin: DelegateOrigin, args: DelegateArgs): Promise<DelegateOutcome>;
}
