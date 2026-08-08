import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_STEERS_PER_TASK,
  type AgentRunStep,
  type AgentRunSummary,
  type AgentTask,
  type AgentTaskDetail,
} from "@tuezday/contracts";
import {
  applyTaskEvent,
  blockingQuestion,
  budgetWarningText,
  pendingProposals,
  shouldStream,
  steersRemaining,
  subagentRows,
  taskActivity,
  taskControls,
  taskStatusDetail,
  taskStatusLabel,
  taskTone,
} from "./agent-task-view";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    workspaceId: "ws-1",
    sessionId: "session-1",
    userId: "user-1",
    createdBy: "Founder",
    request: "Work out why our LinkedIn engagement dropped and what to do about it.",
    title: "Work out why our LinkedIn engagement dropped",
    status: "running",
    agentRunId: RUN_ID,
    stopReason: null,
    error: null,
    output: null,
    stepCount: 3,
    subagentCount: 0,
    steerCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costCents: 0 },
    cancelRequestedAt: null,
    acknowledgedAt: null,
    createdAt: 1,
    startedAt: 2,
    finishedAt: null,
    ...overrides,
  };
}

function detail(overrides: Partial<AgentTaskDetail> = {}): AgentTaskDetail {
  return {
    ...task(),
    steps: [],
    subagents: [],
    messages: [],
    questions: [],
    proposals: [],
    ...overrides,
  };
}

function step(overrides: Partial<AgentRunStep> = {}): AgentRunStep {
  return {
    id: "step-1",
    stepIndex: 0,
    kind: "model_call",
    message: null,
    toolName: null,
    toolCallId: null,
    toolArgs: null,
    toolResult: null,
    toolError: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costCents: 0 },
    durationMs: 10,
    createdAt: 1,
    ...overrides,
  };
}

function subagent(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    id: "child-1",
    workspaceId: "ws-1",
    task: "subagent:competitor_scan",
    createdBy: "Founder",
    parentRunId: RUN_ID,
    status: "done",
    stopReason: "complete",
    error: null,
    model: "gemini-2.5-flash",
    provider: "google",
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costCents: 0 },
    stepCount: 3,
    startedAt: 1,
    finishedAt: 2,
    ...overrides,
  };
}

describe("status", () => {
  it("names every status without falling through to a default", () => {
    const statuses = [
      "queued",
      "running",
      "awaiting_answer",
      "succeeded",
      "failed",
      "cancelled",
    ] as const;
    for (const status of statuses) {
      const subject = task({ status });
      expect(taskStatusLabel(subject)).toBeTruthy();
      expect(taskStatusDetail(subject)).toBeTruthy();
      expect(taskTone(subject)).toBeTruthy();
    }
  });

  it("shows the step count while it is working, so progress is visible", () => {
    expect(taskStatusLabel(task({ status: "running", stepCount: 7 }))).toContain("7");
    expect(taskStatusLabel(task({ status: "running", stepCount: 0 }))).toBe("Working");
  });

  it("says a queued task is waiting for a slot rather than about to start", () => {
    // The concurrency cap is real and a founder who is told "starting" will
    // press the button again.
    expect(taskStatusDetail(task({ status: "queued" }))).toContain("slot");
  });

  it("names the bound a failed task tripped instead of saying it failed", () => {
    expect(taskStatusDetail(task({ status: "failed", error: "max_steps" }))).toContain("steps");
    expect(taskStatusDetail(task({ status: "failed", error: "timeout" }))).toContain("time");
    expect(taskStatusDetail(task({ status: "failed", error: "lease_lost" }))).toContain("retry");
  });

  it("tells a founder that a finished task still needs them to confirm", () => {
    expect(taskStatusDetail(task({ status: "succeeded" }))).toContain("confirm");
  });

  it("counts delegated workers once there are any", () => {
    expect(taskStatusDetail(task({ status: "running", subagentCount: 1 }))).toContain("1 worker");
    expect(taskStatusDetail(task({ status: "running", subagentCount: 3 }))).toContain("3 workers");
  });
});

describe("controls", () => {
  it("offers steering and stopping only while the task is live", () => {
    const live = taskControls(task({ status: "running" }));
    expect(live.canSteer).toBe(true);
    expect(live.canCancel).toBe(true);
    expect(live.canRetry).toBe(false);

    const finished = taskControls(task({ status: "succeeded" }));
    expect(finished.canSteer).toBe(false);
    expect(finished.canCancel).toBe(false);
    expect(finished.canRetry).toBe(true);
  });

  it("can still be stopped while it is queued or waiting on an answer", () => {
    expect(taskControls(task({ status: "queued" })).canCancel).toBe(true);
    expect(taskControls(task({ status: "awaiting_answer" })).canCancel).toBe(true);
  });

  it("explains why steering is off once the cap is spent", () => {
    const spent = task({ status: "running", steerCount: AGENT_TASK_STEERS_PER_TASK });
    const controls = taskControls(spent);
    expect(controls.canSteer).toBe(false);
    expect(controls.steerDisabledReason).toContain("clearer request");
    expect(steersRemaining(spent)).toBe(0);
  });

  it("counts the steers left", () => {
    expect(steersRemaining(task({ steerCount: 2 }))).toBe(AGENT_TASK_STEERS_PER_TASK - 2);
  });
});

describe("budget warning", () => {
  it("says nothing when there is nothing to say", () => {
    expect(budgetWarningText(null)).toBeNull();
  });

  it("passes the server's sentence through — the numbers are the server's", () => {
    expect(
      budgetWarningText({ remainingCents: 100, worstCaseCents: 400, message: "It could cost $4." }),
    ).toBe("It could cost $4.");
  });
});

describe("activity", () => {
  it("collapses consecutive thinking steps into one row", () => {
    const rows = taskActivity([
      step({ id: "a", kind: "model_call" }),
      step({ id: "b", kind: "model_call" }),
      step({ id: "c", kind: "tool_call", toolName: "list_drafts" }),
      step({ id: "d", kind: "model_call" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["thinking", "tool", "thinking"]);
  });

  it("marks a delegation as its own kind so the tree can hang off it", () => {
    const rows = taskActivity([step({ id: "a", kind: "tool_call", toolName: "delegate" })]);
    expect(rows[0]?.kind).toBe("delegate");
    expect(rows[0]?.label).toBe("Delegated to a worker");
  });

  it("shows a steer as something the founder did, not something the agent did", () => {
    const rows = taskActivity([step({ id: "a", kind: "steer" })]);
    expect(rows[0]).toMatchObject({ kind: "steer", label: "You redirected it" });
  });

  it("carries a failed tool call through as not-ok", () => {
    const rows = taskActivity([
      step({ id: "a", kind: "tool_call", toolName: "safe_fetch_url", toolError: "blocked" }),
    ]);
    expect(rows[0]?.ok).toBe(false);
  });
});

describe("subagents", () => {
  it("shows the distilled report the ORCHESTRATOR received, not the child's output", () => {
    const rows = subagentRows(
      [subagent({ id: "child-1" })],
      [
        step({
          id: "s",
          kind: "tool_call",
          toolName: "delegate",
          toolResult: { ok: true, runId: "child-1", summary: "They ship weekly.", findings: [] },
        }),
      ],
    );
    expect(rows[0]).toMatchObject({
      id: "child-1",
      label: "competitor scan",
      running: false,
      ok: true,
      summary: "They ship weekly.",
    });
  });

  it("shows a worker that is still going with no report yet", () => {
    const rows = subagentRows([subagent({ finishedAt: null, stopReason: null })], []);
    expect(rows[0]).toMatchObject({ running: true, ok: false, summary: null });
  });
});

describe("stream folding", () => {
  it("replaces a subagent row rather than appending it when it finishes", () => {
    const running = subagent({ finishedAt: null, stopReason: null });
    let state = applyTaskEvent(detail(), { type: "subagent", run: running });
    state = applyTaskEvent(state, { type: "subagent", run: subagent() });
    expect(state.subagents).toHaveLength(1);
    expect(state.subagents[0]?.finishedAt).toBe(2);
  });

  it("does not duplicate a step that arrives twice", () => {
    let state = applyTaskEvent(detail(), { type: "step", step: step() });
    state = applyTaskEvent(state, { type: "step", step: step() });
    expect(state.steps).toHaveLength(1);
  });

  it("takes the whole task from a status or result frame", () => {
    const state = applyTaskEvent(detail(), {
      type: "status",
      task: task({ status: "succeeded", output: "Here is why." }),
    });
    expect(state.status).toBe("succeeded");
    expect(state.output).toBe("Here is why.");
    // The arrays a status frame does not carry survive it.
    expect(state.steps).toEqual([]);
  });

  it("settles the status on the terminal frame", () => {
    expect(applyTaskEvent(detail(), { type: "done", status: "cancelled" }).status).toBe("cancelled");
  });
});

describe("what needs a person", () => {
  const question = {
    id: "q-1",
    workspaceId: "ws-1",
    agentRunId: RUN_ID,
    pipelineRunId: null,
    agentTaskId: "task-1",
    stepKey: null,
    type: "missing_fact" as const,
    question: "Which quarter?",
    why: "Two are plausible.",
    options: [],
    status: "open" as const,
    answer: null,
    answeredByUserId: null,
    answeredByLabel: null,
    answeredAt: null,
    ruleId: null,
    createdAt: 1,
  };

  it("surfaces the open question a blocked task is waiting on", () => {
    const blocked = detail({ status: "awaiting_answer", questions: [question] });
    expect(blockingQuestion(blocked)?.id).toBe("q-1");
  });

  it("surfaces nothing while the task is still working", () => {
    expect(blockingQuestion(detail({ status: "running", questions: [question] }))).toBeNull();
  });

  it("lists only the proposals still waiting for a person", () => {
    const pending = { id: "p-1", status: "pending" } as never;
    const confirmed = { id: "p-2", status: "confirmed" } as never;
    expect(pendingProposals(detail({ proposals: [pending, confirmed] }))).toHaveLength(1);
  });
});

describe("streaming", () => {
  it("streams while queued or running and stops at every resting point", () => {
    expect(shouldStream(task({ status: "queued" }))).toBe(true);
    expect(shouldStream(task({ status: "running" }))).toBe(true);
    // `awaiting_answer` is not terminal, but nothing more happens until a
    // person answers — holding a socket open for that is waste.
    expect(shouldStream(task({ status: "awaiting_answer" }))).toBe(false);
    expect(shouldStream(task({ status: "succeeded" }))).toBe(false);
  });
});
