import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { SUBAGENT_PROFILES } from "../subagents";
import type { Tool, ToolContext } from "../registry";

// ---------------------------------------------------------------------------
// The delegate tool (Sprint 79).
//
// Kept out of READ_TOOL_NAMES even though `read` is its honest access tier:
// array membership is what decides who is offered a tool, and only a
// background task should be offered this one. A chat turn is bounded at 120
// seconds and a worker at 180, so a delegating chat turn would time out by
// construction.
//
// Every outcome is DATA — a refused cap, a worker that tripped a bound, a
// report that did not validate. One failed worker is not a failed task, and
// the orchestrator is the thing that should decide what to do about it.
// ---------------------------------------------------------------------------

const delegateInput = toolInputSchemas.delegate;
type DelegateInput = z.infer<typeof delegateInput>;

const ROLE_SUMMARY = Object.entries(SUBAGENT_PROFILES)
  .map(([role, profile]) => `${role} (${profile.label.toLowerCase()})`)
  .join(", ");

export const delegateTool: Tool<DelegateInput, unknown> = {
  name: "delegate",
  description:
    `Hand one self-contained piece of work to a bounded worker and get back a short report: ${ROLE_SUMMARY}. ` +
    "The worker does not see this conversation, so `objective` must state everything it needs in full — a worker told to 'do the same for the second one' has no idea what the first one was. Use it when a job is large enough that doing it here would fill your own context with material you will not need again: reading a competitor's site, pulling a quarter of metrics, generating angles to choose between. It cannot write anything, cannot ask the founder anything, and cannot delegate further, so anything that has to be proposed or asked stays with you.",
  input: delegateInput,
  access: "read",
  async run(ctx: ToolContext, args: DelegateInput): Promise<unknown> {
    if (!ctx.subagents || !ctx.agentRunId) {
      return {
        ok: false,
        error: "delegation_unavailable",
        note: "This run cannot delegate. Do the work yourself, or say what you could not cover.",
      };
    }

    const outcome = await ctx.subagents.delegate(
      {
        workspaceId: ctx.workspaceId,
        parentRunId: ctx.agentRunId,
        agentTaskId: ctx.agentTaskId ?? null,
        system: ctx.system ?? "",
      },
      args,
    );

    switch (outcome.status) {
      case "ok":
        return {
          ok: true,
          role: outcome.role,
          runId: outcome.runId,
          ...outcome.report,
          note: "This is the worker's whole report. It is not going to elaborate — delegate again with a sharper objective if you need more.",
        };
      case "failed":
        return {
          ok: false,
          role: outcome.role,
          error: outcome.error,
          note: "That worker returned nothing usable. Either cover it yourself or record it as something you could not establish.",
        };
      case "refused":
        return { ok: false, role: outcome.role, error: outcome.error, note: outcome.note };
    }
  },
};
