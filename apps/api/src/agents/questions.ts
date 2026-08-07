// Sprint 70 (PRD §8, Move 7a): the seam the ask tool writes through.
//
// Leaf module, and deliberately so. `agents/tools/index.ts` builds its
// TOOLS_BY_NAME map at module load, so anything a tool file reaches has to
// reach nothing back. The live implementation (services/agent-questions.ts)
// touches drizzle and the preference store; the tool only ever sees this
// interface, exactly as the propose tools only see AgentProposalService.

import type { AgentQuestionType } from "@tuezday/contracts";

/** Who is asking, and what is suspended if the question stops the run. */
export interface AskQuestionOrigin {
  workspaceId: string;
  agentRunId: string;
  /** Null for a one-shot run: there is nothing to resume, only to record. */
  pipelineRunId: string | null;
  stepKey: string | null;
}

export interface AskQuestionArgs {
  type: AgentQuestionType;
  question: string;
  why: string;
  options?: string[];
}

export type AskResult =
  /** Already answered in this run (D-70.3) — hand the answer back, do not stop. */
  | { status: "answered"; questionId: string; answer: string }
  /** Recorded and open. The tool turns this into a NeedsHumanSignal. */
  | { status: "suspend"; questionId: string }
  /** A cap was hit. Error data for the model, never a stop (D-70.4). */
  | { status: "refused"; error: string; note: string }
  /** Non-live mode: nothing recorded, nothing suspended (D-70.5). */
  | { status: "simulated"; answer: string };

export interface AgentQuestionService {
  ask(origin: AskQuestionOrigin, args: AskQuestionArgs): Promise<AskResult>;
}

/**
 * The non-live implementation (D-70.5). A dry run, a shadow run or an eval
 * replay that asks gets a canned answer and carries on, because a suspended
 * dry run would stall the eval harness and a shadow A/B would be comparing a
 * finished run against a stopped one. The interface is identical, so the model
 * sees the same tool in every mode.
 */
export function simulatedAgentQuestions(): AgentQuestionService {
  return {
    async ask() {
      return {
        status: "simulated",
        answer:
          "This is a simulated run, so nobody is there to answer. Proceed on your best reading and say in your output that you had to assume.",
      };
    },
  };
}
