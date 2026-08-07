import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { NeedsHumanSignal } from "../runner";
import type { Tool, ToolContext } from "../registry";

// ---------------------------------------------------------------------------
// The ask tool (Sprint 70).
//
// The only tool that produces nothing. It records a question and throws
// NeedsHumanSignal, which the runner turns into `stopReason: "needs_human"` and
// the engine turns into an escalated pipeline run — the durable suspension
// Sprint 64 already built and nothing had yet used.
//
// Every other outcome — an answer it already has, a cap, a simulated run — is
// returned as data, because a tool that stops a run for anything other than a
// real open question is a tool that strands work (D-70.1, D-70.4).
// ---------------------------------------------------------------------------

const askInput = toolInputSchemas.ask_founder;
type AskInput = z.infer<typeof askInput>;

export const askFounderTool: Tool<AskInput, unknown> = {
  name: "ask_founder",
  description:
    "Stop and ask the founder a question you cannot answer from the workspace. Use it when the instruction has more than one reasonable reading, when the plan does not say whether something is allowed, when a fact you need is not recorded anywhere, or when acting would go beyond what you were configured to do. The run pauses until they answer, so ask one specific question that a single sentence can settle — never ask to confirm something you could look up.",
  input: askInput,
  access: "ask",
  async run(ctx: ToolContext, args: AskInput): Promise<unknown> {
    if (!ctx.questions || !ctx.agentRunId) {
      return {
        ok: false,
        error: "asking_unavailable",
        note: "This run cannot ask questions. Proceed on your best reading, or fail the step and say why.",
      };
    }

    const result = await ctx.questions.ask(
      {
        workspaceId: ctx.workspaceId,
        agentRunId: ctx.agentRunId,
        pipelineRunId: ctx.pipelineRunId ?? null,
        stepKey: ctx.stepKey ?? null,
      },
      args,
    );

    switch (result.status) {
      case "answered":
        return {
          ok: true,
          answered: true,
          answer: result.answer,
          note: "You already asked this and it was answered. Use the answer; do not ask again.",
        };
      case "simulated":
        return { ok: true, answered: true, answer: result.answer, simulated: true };
      case "refused":
        return { ok: false, error: result.error, note: result.note };
      case "suspend":
        // The one legitimate way a tool ends a run early.
        throw new NeedsHumanSignal(`question:${result.questionId}`);
    }
  },
};
