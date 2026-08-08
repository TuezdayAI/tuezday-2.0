import {
  AGENT_TASK_BOUNDS,
  AGENT_TASK_STEERS_PER_TASK,
  isAgentTaskTerminal,
  type AgentRunStep,
  type AgentRunSummary,
  type AgentTask,
  type AgentTaskBudgetWarning,
  type AgentTaskDetail,
  type AgentTaskStreamEvent,
  type AgentQuestion,
  type ChatProposal,
  type SubagentReport,
} from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// Pure view model for the background-task panel (Sprint 79).
//
// Kept out of the component for the same reason Sprint 78's proposal card was:
// the part that decides whether a founder understands what a detached agent is
// doing is the copy and the state machine, and neither needs React to be
// tested. The component below this file renders; it does not decide.
// ---------------------------------------------------------------------------

export type AgentTaskTone = "queued" | "running" | "blocked" | "done" | "failed" | "stopped";

export function taskTone(task: AgentTask): AgentTaskTone {
  switch (task.status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "awaiting_answer":
      return "blocked";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
  }
}

/** The one-line status a founder reads first. */
export function taskStatusLabel(task: AgentTask): string {
  switch (task.status) {
    case "queued":
      return "Queued";
    case "running":
      return task.stepCount > 0 ? `Working — step ${task.stepCount}` : "Working";
    case "awaiting_answer":
      return "Waiting on you";
    case "succeeded":
      return "Done";
    case "failed":
      return "Stopped early";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * The sentence under the status. Says what is true rather than what is hoped:
 * a queued task behind the workspace's concurrency cap is not "starting soon",
 * it is waiting for a slot, and saying so is the difference between a founder
 * who waits and one who clicks the button again.
 */
export function taskStatusDetail(task: AgentTask): string {
  switch (task.status) {
    case "queued":
      return "Waiting for a slot. It starts on its own — you can close this drawer.";
    case "running":
      return task.subagentCount > 0
        ? `Delegated to ${task.subagentCount} ${task.subagentCount === 1 ? "worker" : "workers"} so far.`
        : "You can steer it or stop it at any point.";
    case "awaiting_answer":
      return "It hit something only you can settle. Answer the question and it picks up where it left off.";
    case "succeeded":
      return "Anything it proposed is waiting for you to confirm — nothing was published, sent or spent.";
    case "failed":
      return failureDetail(task);
    case "cancelled":
      return "You stopped it. Everything it had done up to that point is in the trace.";
  }
}

function failureDetail(task: AgentTask): string {
  switch (task.error) {
    case "max_steps":
      return `It used all ${AGENT_TASK_BOUNDS.maxSteps} of its steps. A narrower request usually finishes.`;
    case "max_tokens":
      return "It reached this task's token limit before finishing.";
    case "timeout":
      return "It ran out of time. Splitting the request in two usually helps.";
    case "lease_lost":
      return "A restart interrupted it. Nothing it proposed was lost — you can retry.";
    default:
      return task.error ? `It stopped: ${task.error}` : "It stopped before finishing.";
  }
}

// ---------------------------------------------------------------------------
// What the panel offers
// ---------------------------------------------------------------------------

export interface TaskControls {
  canSteer: boolean;
  canCancel: boolean;
  canRetry: boolean;
  /** Why steering is off, when it is — shown instead of a dead button. */
  steerDisabledReason: string | null;
}

export function taskControls(task: AgentTask): TaskControls {
  const terminal = isAgentTaskTerminal(task.status);
  const steersLeft = AGENT_TASK_STEERS_PER_TASK - task.steerCount;
  return {
    canSteer: !terminal && steersLeft > 0,
    // A cancel on a queued task is honoured immediately; on a running one it
    // lands at the next step boundary. Both are worth offering.
    canCancel: !terminal,
    canRetry: terminal,
    steerDisabledReason: terminal
      ? "This one has finished."
      : steersLeft > 0
        ? null
        : "You have redirected this as many times as it allows. Stop it and start again with a clearer request.",
  };
}

/** Remaining steers, for the hint under the steer box. */
export function steersRemaining(task: AgentTask): number {
  return Math.max(0, AGENT_TASK_STEERS_PER_TASK - task.steerCount);
}

/**
 * The pre-flight warning copy (D-79.3). Returns null when there is nothing
 * worth saying — a warning shown every time is a warning nobody reads.
 */
export function budgetWarningText(warning: AgentTaskBudgetWarning | null): string | null {
  return warning ? warning.message : null;
}

// ---------------------------------------------------------------------------
// The trace, summarized
// ---------------------------------------------------------------------------

export interface TaskActivityRow {
  id: string;
  kind: "thinking" | "tool" | "steer" | "delegate";
  label: string;
  ok: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  delegate: "Delegated to a worker",
  ask_founder: "Asked you a question",
  safe_fetch_url: "Read a page",
};

/**
 * The steps as a founder-readable activity list. Model calls that produced no
 * tool call collapse into one "thinking" row rather than N of them — the
 * interesting shape of a background run is what it DID, and a wall of
 * identical rows hides it.
 */
export function taskActivity(steps: AgentRunStep[]): TaskActivityRow[] {
  const rows: TaskActivityRow[] = [];
  for (const step of steps) {
    if (step.kind === "steer") {
      rows.push({ id: step.id, kind: "steer", label: "You redirected it", ok: true });
      continue;
    }
    if (step.kind === "tool_call") {
      const name = step.toolName ?? "tool";
      rows.push({
        id: step.id,
        kind: name === "delegate" ? "delegate" : "tool",
        label: TOOL_LABELS[name] ?? humanizeTool(name),
        ok: step.toolError === null,
      });
      continue;
    }
    const previous = rows[rows.length - 1];
    if (previous?.kind === "thinking") continue;
    rows.push({ id: step.id, kind: "thinking", label: "Thinking", ok: true });
  }
  return rows;
}

function humanizeTool(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface SubagentRow {
  id: string;
  label: string;
  running: boolean;
  ok: boolean;
  /** The distilled report, when the parent's trace carried one back. */
  summary: string | null;
}

/**
 * The delegation tree, one row per worker. The report text comes from the
 * PARENT's `delegate` tool results rather than the child's row, because the
 * distilled summary is what the orchestrator actually received — showing the
 * child's raw output would show the founder something the parent never saw.
 */
export function subagentRows(
  subagents: AgentRunSummary[],
  parentSteps: AgentRunStep[],
): SubagentRow[] {
  const reports = new Map<string, string>();
  for (const step of parentSteps) {
    if (step.kind !== "tool_call" || step.toolName !== "delegate") continue;
    // The tool spreads the report flat into its result, so `summary` sits at
    // the top level beside `runId`.
    const result = step.toolResult as (Partial<SubagentReport> & { runId?: string }) | null;
    if (result?.runId && result.summary) reports.set(result.runId, result.summary);
  }

  return subagents.map((run) => ({
    id: run.id,
    label: run.task.replace(/^subagent:/, "").replace(/_/g, " "),
    running: run.finishedAt === null,
    ok: run.stopReason === "complete",
    summary: reports.get(run.id) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Applying the progress stream
// ---------------------------------------------------------------------------

/**
 * Fold one stream frame into the panel's state. Written as a reducer so the
 * frames can be tested in any order — the stream re-sends a subagent row when
 * it finishes and a question when it is answered, and a client that appended
 * blindly would show each of them twice.
 */
export function applyTaskEvent(state: AgentTaskDetail, event: AgentTaskStreamEvent): AgentTaskDetail {
  switch (event.type) {
    case "status":
    case "result":
      return { ...state, ...event.task };
    case "step":
      return { ...state, steps: upsertById(state.steps, event.step) };
    case "subagent":
      return { ...state, subagents: upsertById(state.subagents, event.run) };
    case "question":
      return { ...state, questions: upsertById(state.questions, event.question) };
    case "proposal":
      return { ...state, proposals: upsertById(state.proposals, event.proposal) };
    case "done":
      return { ...state, status: event.status };
  }
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
}

/** The open question a blocked task is waiting on, if any. */
export function blockingQuestion(detail: AgentTaskDetail): AgentQuestion | null {
  if (detail.status !== "awaiting_answer") return null;
  return detail.questions.find((question) => question.status === "open") ?? null;
}

/** Proposals still waiting for a person. What the founder has to act on. */
export function pendingProposals(detail: AgentTaskDetail): ChatProposal[] {
  return detail.proposals.filter((proposal) => proposal.status === "pending");
}

/** Whether the panel should keep a stream open. */
export function shouldStream(task: AgentTask): boolean {
  return task.status === "queued" || task.status === "running";
}
