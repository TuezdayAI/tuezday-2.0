// Sprint 79 (PRD §10, Move 9c): the live delegation service.
//
// One instance per background task, because the per-task delegation counter
// lives here — the same "budget state is per invocation" convention
// `toAgentTools` uses. The tool sees only `SubagentService`; this file is what
// actually drives an AgentRunner over a role's tool subset.
//
// Read `agents/subagents.ts` first: it states the two structural properties
// (no write/ask/delegate seams in a worker's context; a schema-enforced
// report) that this file has to preserve rather than re-argue.

import { randomUUID } from "node:crypto";
import {
  AGENT_TASK_SUBAGENTS_PER_TASK,
  subagentReportSchema,
  type SubagentReport,
} from "@tuezday/contracts";
import { toAgentTools } from "../agents/adapter";
import type { ToolActor, ToolContext } from "../agents/registry";
import { AgentRunner } from "../agents/runner";
import type {
  DelegateArgs,
  DelegateOrigin,
  DelegateOutcome,
  SubagentService,
} from "../agents/subagents";
import { SUBAGENT_PROFILES } from "../agents/subagents";
import { getTool } from "../agents/tools/index";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { responseJsonSchemaFor } from "../llm/json-schema";
import type { SafeFetchService } from "../safe-fetch/index";

export interface SubagentServiceDeps {
  db: Db;
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
  actor: ToolActor;
  /** Cancelling the task cancels its workers too — otherwise "cancel is
   * immediate" would be false for the three minutes a worker still had. */
  signal?: AbortSignal;
  /** Called as each worker finishes, so the task can keep its counters and
   * its progress panel current without polling the run table itself. */
  onDelegated?: (runId: string) => void | Promise<void>;
  maxDelegations?: number;
}

const REPORT_SCHEMA = responseJsonSchemaFor(subagentReportSchema);

/** A worker's tool budget: enough calls to use its steps, and the same tight
 * leash on the one tool that leaves the tenant. */
function budgetFor(maxSteps: number) {
  return {
    maxCalls: maxSteps * 2,
    perTool: { safe_fetch_url: 3 },
    // No propose tools are offered, so the proposal cap is moot — but stating
    // it as zero means a future wiring mistake fails closed rather than open.
    maxProposals: 0,
  };
}

function briefFor(args: DelegateArgs): string {
  const focus = args.focus?.trim();
  return focus
    ? `Objective: ${args.objective}\n\nHold to this scope: ${focus}`
    : `Objective: ${args.objective}`;
}

/**
 * Build the service for one task. `maxDelegations` defaults to the contract
 * cap; the tool budget's `perTool.delegate` is the same number, so the two
 * agree and either one alone would hold.
 */
export function createSubagentService(deps: SubagentServiceDeps): SubagentService {
  const max = deps.maxDelegations ?? AGENT_TASK_SUBAGENTS_PER_TASK;
  let delegated = 0;

  return {
    async delegate(origin: DelegateOrigin, args: DelegateArgs): Promise<DelegateOutcome> {
      if (delegated >= max) {
        return {
          status: "refused",
          role: args.role,
          error: "delegation_cap_reached",
          note: `This task has already used all ${max} of its workers. Finish with what you have.`,
        };
      }
      if (deps.signal?.aborted) {
        return {
          status: "refused",
          role: args.role,
          error: "cancelled",
          note: "This task was cancelled. Stop.",
        };
      }

      // Counted on the attempt, not on success: a worker that burns its
      // budget and returns nothing still cost the founder money, and a retry
      // loop is exactly what a cap exists to stop.
      delegated += 1;

      const profile = SUBAGENT_PROFILES[args.role];
      const runId = randomUUID();

      // The context a worker gets. Note what is NOT here: `proposals`,
      // `questions` and `subagents`. Those tools cannot be constructed for it,
      // which is what makes "only the orchestrator writes, only the
      // orchestrator asks, delegation cannot recurse" structural (D-79.4).
      const ctx: ToolContext = {
        db: deps.db,
        evidence: deps.evidence,
        safeFetch: deps.safeFetch,
        workspaceId: origin.workspaceId,
        actor: deps.actor,
        budget: budgetFor(profile.bounds.maxSteps),
        agentRunId: runId,
      };

      const tools = toAgentTools(
        profile.tools.flatMap((name) => {
          const tool = getTool(name);
          return tool ? [tool] : [];
        }),
        ctx,
      );

      const run = await new AgentRunner(deps.db, deps.llm).run({
        runId,
        workspaceId: origin.workspaceId,
        parentRunId: origin.parentRunId,
        task: `subagent:${args.role}`,
        createdBy: deps.actor.label,
        system: `${origin.system}\n\n${profile.system}`.trim(),
        messages: [{ role: "user", content: briefFor(args) }],
        tools,
        responseSchema: REPORT_SCHEMA,
        maxSteps: profile.bounds.maxSteps,
        maxTokens: profile.bounds.maxTokens,
        timeoutMs: profile.bounds.timeoutMs,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });

      await deps.onDelegated?.(runId);

      if (run.stopReason !== "complete") {
        return {
          status: "failed",
          runId,
          role: args.role,
          error: run.error ? `${run.stopReason}: ${run.error}` : run.stopReason,
        };
      }

      // The schema is the distillation (D-79.5), so a report that does not
      // validate is a failure rather than something to pass along loosely
      // typed — the orchestrator would quote it as fact either way.
      const parsed = subagentReportSchema.safeParse(run.output);
      if (!parsed.success) {
        return {
          status: "failed",
          runId,
          role: args.role,
          error: "report_did_not_validate",
        };
      }

      return { status: "ok", runId, role: args.role, report: trim(parsed.data) };
    },
  };
}

/** Belt to the schema's braces: zod bounds each field, this bounds the whole. */
function trim(report: SubagentReport): SubagentReport {
  return {
    ...report,
    findings: report.findings.slice(0, 8),
    gaps: report.gaps.slice(0, 5),
  };
}
