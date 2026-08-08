import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_TASKS_PER_WORKSPACE,
  AGENT_TASK_STEERS_PER_TASK,
  AGENT_TASK_SUBAGENTS_PER_TASK,
} from "@tuezday/contracts";
import { agentRuns, agentTasks, backgroundJobs, workspaces } from "../src/db/schema";
import type { Db } from "../src/db";
import type { AddDocumentInput, EvidenceStore, StoreSearchResult } from "../src/evidence/store";
import type { LlmGateway } from "../src/llm/gateway";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import type { SafeFetchService } from "../src/safe-fetch/index";
import { createAgentQuestions, answerAgentQuestion } from "../src/services/agent-questions";
import { runAgentTask } from "../src/services/agent-task-executor";
import {
  acknowledgeAgentTask,
  boundTranscript,
  cancelAgentTask,
  createAgentTask,
  getAgentTask,
  getAgentTaskDetail,
  listAgentTasks,
  listUnacknowledgedAgentTasks,
  requeueAgentTask,
  steerAgentTask,
} from "../src/services/agent-tasks";
import { buildAgentInboxFeed } from "../src/services/agent-inbox";
import { updateBrainDoc } from "../src/services/brain";
import { createSession, listMessages } from "../src/services/chat";
import { createSubagentService } from "../src/services/subagents";
import { createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// Background agent tasks (Sprint 79).
//
// The executor is the testable unit, exactly as `runChatTurn` is for chat: the
// queue handler and the routes are thin adapters over it. Everything below
// drives a ScriptedGateway, so a "fifteen-minute background run" completes in
// milliseconds and nothing touches the network.
// ---------------------------------------------------------------------------

class FakeEvidenceStore implements EvidenceStore {
  async health() {
    return { healthy: false, detail: "not configured in this test" };
  }
  async createCollection(name: string) {
    return `collection-${name}`;
  }
  async addDocument(_input: AddDocumentInput) {
    return "doc-1";
  }
  async attachDocument() {}
  async deleteDocument() {}
  async search(): Promise<StoreSearchResult[]> {
    return [];
  }
}

const safeFetch = null as unknown as SafeFetchService;
const ACTOR = { userId: null, label: "user:founder" };

let db: Db;
let workspaceId: string;

function deps(llm: LlmGateway, extra: { questions?: boolean } = {}) {
  return {
    llm,
    evidence: new FakeEvidenceStore(),
    safeFetch,
    ...(extra.questions ? { questions: createAgentQuestions({ db }) } : {}),
  };
}

async function newTask(request = "Work out why engagement dropped.", sessionId?: string) {
  const outcome = await createAgentTask(db, workspaceId, ACTOR, {
    request,
    sessionId: sessionId ?? null,
  });
  if (!outcome.ok) throw new Error(`expected a task, got ${outcome.error}`);
  return outcome.task;
}

beforeEach(async () => {
  db = await createTestDb();
  workspaceId = randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, name: "Acme", createdAt: 1, updatedAt: 1 });
  await updateBrainDoc(db, workspaceId, "soul", "## Why\n\nWe make GTM legible.\n");
});

// ---------------------------------------------------------------------------

describe("creating a task", () => {
  it("enqueues the work in the same call, so a task always has a job", async () => {
    const task = await newTask();
    expect(task.status).toBe("queued");

    const jobs = await db.select().from(backgroundJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "agent_task", workspaceId, maxAttempts: 1 });
    expect(JSON.parse(jobs[0]!.payloadJson)).toMatchObject({ taskId: task.id });
  });

  it("titles the task from the request so a list is readable", async () => {
    const task = await newTask("Research what our top three competitors shipped this quarter.");
    expect(task.title.length).toBeGreaterThan(0);
    expect(task.title.length).toBeLessThanOrEqual(task.request.length);
  });

  it("refuses past the per-workspace cap, and names the cap", async () => {
    for (let i = 0; i < AGENT_TASKS_PER_WORKSPACE; i += 1) await newTask(`Task ${i}`);
    const refused = await createAgentTask(db, workspaceId, ACTOR, { request: "One more" });
    expect(refused).toMatchObject({ ok: false, error: "agent_task_limit_reached" });
    if (!refused.ok) expect(refused.limit).toBe(AGENT_TASKS_PER_WORKSPACE);
  });

  it("counts only live work against the cap — a finished task frees its slot", async () => {
    const first = await newTask("First");
    for (let i = 1; i < AGENT_TASKS_PER_WORKSPACE; i += 1) await newTask(`Task ${i}`);
    await db
      .update(agentTasks)
      .set({ status: "succeeded", finishedAt: 5 })
      .where(eq(agentTasks.id, first.id));
    const outcome = await createAgentTask(db, workspaceId, ACTOR, { request: "Another" });
    expect(outcome.ok).toBe(true);
  });
});

describe("running one to the end", () => {
  it("succeeds, records the answer, and posts it back into the thread", async () => {
    const session = await createSession(db, workspaceId, null, { goal: "" });
    const task = await newTask("Summarize our positioning.", session.id);
    const llm = new ScriptedGateway([{ text: "Positioning is clear and consistent." }]);

    const result = await runAgentTask(db, deps(llm), workspaceId, task.id);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.task.status).toBe("succeeded");
    expect(result.task.output).toContain("Positioning is clear");
    expect(result.task.finishedAt).not.toBeNull();

    const messages = await listMessages(db, session.id);
    expect(messages.at(-1)?.content).toContain("Positioning is clear");
    expect(messages.at(-1)?.agentRunId).toBe(result.task.agentRunId);
  });

  it("runs a threadless task rather than refusing it — it just has nowhere to post", async () => {
    const task = await newTask("Audit the brain.");
    const llm = new ScriptedGateway([{ text: "The brain is current." }]);
    const result = await runAgentTask(db, deps(llm), workspaceId, task.id);
    expect(result).toMatchObject({ status: "resolved" });
    if (result.status !== "resolved") return;
    expect(result.task.status).toBe("succeeded");
  });

  it("reports a tripped bound as a failure that names the bound", async () => {
    const task = await newTask();
    // Every step asks for a tool, so the run never completes and exhausts its
    // steps. The gateway is scripted long enough to reach the bound.
    const script: ScriptedStep[] = Array.from({ length: 60 }, () => ({
      toolCalls: [{ name: "get_brain_section", arguments: { section: "soul" } }],
    }));
    const result = await runAgentTask(db, deps(new ScriptedGateway(script)), workspaceId, task.id);
    if (result.status !== "resolved") throw new Error("expected a resolved task");
    expect(result.task.status).toBe("failed");
    expect(result.task.error).toBe("max_steps");
  });
});

describe("questions suspend and answers resume", () => {
  it("suspends on a question, keeps its transcript, and resumes from it", async () => {
    const task = await newTask("Draft the launch post.");
    const asking = new ScriptedGateway([
      {
        toolCalls: [
          {
            name: "ask_founder",
            arguments: {
              type: "missing_fact",
              question: "Which quarter?",
              why: "Two are plausible and the answer changes the post.",
            },
          },
        ],
      },
    ]);

    const suspended = await runAgentTask(db, deps(asking, { questions: true }), workspaceId, task.id);
    if (suspended.status !== "resolved") throw new Error("expected a resolved task");
    expect(suspended.task.status).toBe("awaiting_answer");
    expect(suspended.task.stopReason).toBe("needs_human");

    const detail = await getAgentTaskDetail(db, workspaceId, task.id);
    expect(detail?.questions).toHaveLength(1);
    const question = detail!.questions[0]!;
    expect(question.agentTaskId).toBe(task.id);

    // The transcript survives the suspend — that is what makes the resume a
    // continuation rather than a restart.
    const row = (await db.select().from(agentTasks).where(eq(agentTasks.id, task.id)))[0];
    expect(row?.transcriptJson).toBeTruthy();

    await answerAgentQuestion(
      db,
      workspaceId,
      question.id,
      { action: "answer", answer: "Q3.", resume: true },
      ACTOR,
    );
    expect(await requeueAgentTask(db, task.id)).toBe(true);
    expect((await getAgentTask(db, workspaceId, task.id))?.status).toBe("queued");

    const answering = new ScriptedGateway([{ text: "Here is the Q3 post." }]);
    const resumed = await runAgentTask(
      db,
      deps(answering, { questions: true }),
      workspaceId,
      task.id,
    );
    if (resumed.status !== "resolved") throw new Error("expected a resolved task");
    expect(resumed.task.status).toBe("succeeded");
    // The resumed run saw the earlier turn, not a blank slate.
    expect(answering.calls[0]!.messages.length).toBeGreaterThan(1);
  });

  it("will not requeue a task that is not waiting on anything", async () => {
    const task = await newTask();
    expect(await requeueAgentTask(db, task.id)).toBe(false);
  });
});

describe("steering", () => {
  it("reaches the model at the next step boundary, not mid-step", async () => {
    const task = await newTask();
    await steerAgentTask(db, workspaceId, task.id, "Focus on LinkedIn only.");

    const llm = new ScriptedGateway([
      { toolCalls: [{ name: "get_brain_section", arguments: { section: "soul" } }] },
      { text: "LinkedIn it is." },
    ]);
    const result = await runAgentTask(db, deps(llm), workspaceId, task.id);
    if (result.status !== "resolved") throw new Error("expected a resolved task");
    expect(result.task.status).toBe("succeeded");

    const sawSteer = llm.calls.some((call) =>
      call.messages.some((m) => m.content.includes("Focus on LinkedIn only.")),
    );
    expect(sawSteer).toBe(true);

    // It is recorded as a step, so the trace shows the founder intervened.
    const detail = await getAgentTaskDetail(db, workspaceId, task.id);
    expect(detail?.steps.some((step) => step.kind === "steer")).toBe(true);
  });

  it("refuses a steer on a finished task rather than storing one nobody will read", async () => {
    const task = await newTask();
    await db.update(agentTasks).set({ status: "succeeded" }).where(eq(agentTasks.id, task.id));
    expect(await steerAgentTask(db, workspaceId, task.id, "Too late")).toMatchObject({
      ok: false,
      error: "task_finished",
    });
  });

  it("caps how many times one task can be redirected", async () => {
    const task = await newTask();
    for (let i = 0; i < AGENT_TASK_STEERS_PER_TASK; i += 1) {
      expect((await steerAgentTask(db, workspaceId, task.id, `Steer ${i}`)).ok).toBe(true);
    }
    expect(await steerAgentTask(db, workspaceId, task.id, "One more")).toMatchObject({
      ok: false,
      error: "steer_cap_reached",
    });
  });
});

describe("cancelling", () => {
  it("resolves a queued task immediately — there is no run to interrupt", async () => {
    const task = await newTask();
    const outcome = await cancelAgentTask(db, workspaceId, task.id);
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.task.status).toBe("cancelled");
    expect(outcome.task.finishedAt).not.toBeNull();
  });

  it("stops a running task at its next step boundary and leaves a partial trace", async () => {
    const task = await newTask();
    const llm = new ScriptedGateway([
      { toolCalls: [{ name: "get_brain_section", arguments: { section: "soul" } }] },
      { text: "Never reached." },
    ]);

    // Cancelled after the first step has already happened. The heartbeat runs
    // at each boundary, so writing the request from its second call puts the
    // cancel exactly where a founder's click would land: between two steps.
    let boundaries = 0;
    const result = await runAgentTask(db, deps(llm), workspaceId, task.id, {
      heartbeat: async () => {
        boundaries += 1;
        if (boundaries === 2) {
          await db
            .update(agentTasks)
            .set({ cancelRequestedAt: Date.now() })
            .where(eq(agentTasks.id, task.id));
        }
        return true;
      },
    });

    if (result.status !== "resolved") throw new Error("expected a resolved task");
    expect(result.task.status).toBe("cancelled");
    expect(result.task.stopReason).toBe("cancelled");
    const detail = await getAgentTaskDetail(db, workspaceId, task.id);
    expect(detail!.steps.length).toBeGreaterThan(0);
  });

  it("skips a task cancelled before the queue reached it", async () => {
    const task = await newTask();
    await cancelAgentTask(db, workspaceId, task.id);
    const result = await runAgentTask(
      db,
      deps(new ScriptedGateway([{ text: "should not run" }])),
      workspaceId,
      task.id,
    );
    expect(result).toMatchObject({ status: "skipped" });
  });
});

describe("the lease", () => {
  it("fails the task when the heartbeat says this process no longer owns it", async () => {
    const task = await newTask();
    const llm = new ScriptedGateway([
      { toolCalls: [{ name: "get_brain_section", arguments: { section: "soul" } }] },
      { text: "Never reached." },
    ]);
    const result = await runAgentTask(db, deps(llm), workspaceId, task.id, {
      heartbeat: async () => false,
    });
    if (result.status !== "resolved") throw new Error("expected a resolved task");
    expect(result.task.status).toBe("failed");
    expect(result.task.error).toBe("lease_lost");
  });
});

describe("delegation", () => {
  const REPORT = JSON.stringify({
    summary: "They shipped two integrations.",
    findings: [{ claim: "Shipped a Slack app in March.", source: "https://example.com/changelog" }],
    confidence: "medium",
    gaps: ["Nothing found for the third competitor."],
  });

  it("hands the orchestrator a distilled report and records the worker as a child run", async () => {
    const task = await newTask("Scan the competitors.");
    const llm = new ScriptedGateway([
      {
        toolCalls: [
          {
            name: "delegate",
            arguments: { role: "competitor_scan", objective: "What did Acme ship in Q1?" },
          },
        ],
      },
      { text: REPORT },
      { text: "They shipped two integrations; here is what it means." },
    ]);

    const result = await runAgentTask(db, deps(llm), workspaceId, task.id);
    if (result.status !== "resolved") throw new Error("expected a resolved task");
    expect(result.task.status).toBe("succeeded");
    expect(result.task.subagentCount).toBe(1);

    const detail = await getAgentTaskDetail(db, workspaceId, task.id);
    expect(detail?.subagents).toHaveLength(1);
    expect(detail!.subagents[0]!.parentRunId).toBe(result.task.agentRunId);
    expect(detail!.subagents[0]!.task).toBe("subagent:competitor_scan");

    const delegateStep = detail!.steps.find((step) => step.toolName === "delegate");
    expect(delegateStep?.toolResult).toMatchObject({ ok: true, summary: "They shipped two integrations." });
  });

  it("fails one worker without failing the task when its report does not validate", async () => {
    const service = createSubagentService({
      db,
      llm: new ScriptedGateway([{ text: JSON.stringify({ nonsense: true }) }]),
      evidence: new FakeEvidenceStore(),
      safeFetch,
      actor: ACTOR,
    });
    const parentRunId = randomUUID();
    const outcome = await service.delegate(
      { workspaceId, parentRunId, agentTaskId: null, system: "" },
      { role: "research", objective: "Anything." },
    );
    expect(outcome).toMatchObject({ status: "failed", error: "report_did_not_validate" });
  });

  it("gives a worker no way to write, ask or delegate further", async () => {
    // Structural rather than behavioural: the tools a worker is offered are the
    // profile's read tools, and no profile lists a propose, ask or delegate tool.
    const { SUBAGENT_PROFILES } = await import("../src/agents/subagents");
    for (const profile of Object.values(SUBAGENT_PROFILES)) {
      for (const tool of profile.tools) {
        expect(tool.startsWith("propose_")).toBe(false);
        expect(tool).not.toBe("ask_founder");
        expect(tool).not.toBe("delegate");
      }
    }
  });

  it("refuses past the per-task worker cap", async () => {
    const service = createSubagentService({
      db,
      // Each worker takes one step; the script is long enough for the cap.
      llm: new ScriptedGateway(
        Array.from({ length: AGENT_TASK_SUBAGENTS_PER_TASK }, () => ({
          text: JSON.stringify({ summary: "ok", findings: [], confidence: "low", gaps: [] }),
        })),
      ),
      evidence: new FakeEvidenceStore(),
      safeFetch,
      actor: ACTOR,
    });
    const origin = { workspaceId, parentRunId: randomUUID(), agentTaskId: null, system: "" };
    for (let i = 0; i < AGENT_TASK_SUBAGENTS_PER_TASK; i += 1) {
      expect(
        (await service.delegate(origin, { role: "research", objective: `Objective ${i}` })).status,
      ).toBe("ok");
    }
    expect(await service.delegate(origin, { role: "research", objective: "One more" })).toMatchObject(
      { status: "refused", error: "delegation_cap_reached" },
    );
  });

  it("does not offer delegation to a run that has no delegation service", async () => {
    const runs = await db.select().from(agentRuns);
    expect(runs).toHaveLength(0);
    const { delegateTool } = await import("../src/agents/tools/delegate");
    const result = await delegateTool.run(
      {
        db,
        evidence: new FakeEvidenceStore(),
        safeFetch,
        workspaceId,
        actor: ACTOR,
        budget: { maxCalls: 1 },
      },
      { role: "research", objective: "Anything." },
    );
    expect(result).toMatchObject({ ok: false, error: "delegation_unavailable" });
  });
});

describe("the transcript bound", () => {
  it("drops the oldest tool results first and never the request or the tail", () => {
    const messages = [
      { role: "user" as const, content: "The original request." },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: "tool" as const,
        content: "x".repeat(8_000),
        toolCallId: `call-${i}`,
      })),
      { role: "assistant" as const, content: "Nearly there." },
      { role: "tool" as const, content: "last tool result", toolCallId: "call-last" },
      { role: "assistant" as const, content: "The answer." },
    ];
    const bounded = boundTranscript(messages);
    expect(bounded[0]?.content).toBe("The original request.");
    expect(bounded.at(-1)?.content).toBe("The answer.");
    expect(bounded.length).toBeLessThan(messages.length);
  });
});

describe("the inbox", () => {
  it("shows a finished task until somebody acknowledges it", async () => {
    const task = await newTask("Summarize positioning.");
    await runAgentTask(
      db,
      deps(new ScriptedGateway([{ text: "Done." }])),
      workspaceId,
      task.id,
    );

    expect(await listUnacknowledgedAgentTasks(db, workspaceId)).toHaveLength(1);
    const feed = await buildAgentInboxFeed(db, workspaceId);
    const item = feed.items.find((entry) => entry.kind === "agent_task_result");
    expect(item).toBeDefined();
    expect(item!.lane).toBe("notify");
    expect(item!.consequence).toContain("confirm");

    await acknowledgeAgentTask(db, workspaceId, task.id);
    expect(await listUnacknowledgedAgentTasks(db, workspaceId)).toHaveLength(0);
    const after = await buildAgentInboxFeed(db, workspaceId);
    expect(after.items.some((entry) => entry.kind === "agent_task_result")).toBe(false);
  });

  it("does not show a task that is still running", async () => {
    await newTask();
    const feed = await buildAgentInboxFeed(db, workspaceId);
    expect(feed.items.some((entry) => entry.kind === "agent_task_result")).toBe(false);
  });
});

describe("listing", () => {
  it("scopes by thread, so a drawer only sees its own work", async () => {
    const session = await createSession(db, workspaceId, null, { goal: "" });
    const mine = await newTask("Mine", session.id);
    await newTask("Someone else's");
    const listed = await listAgentTasks(db, workspaceId, { sessionId: session.id });
    expect(listed.map((task) => task.id)).toEqual([mine.id]);
  });
});

// ---------------------------------------------------------------------------
// The sprint's acceptance case, end to end (spec §7). Everything below the
// gateway script is real: the queue row, the delegation, the ask lane, the
// resume from a saved transcript, the recorded proposal, the thread message
// and the inbox item.
// ---------------------------------------------------------------------------

describe("acceptance: research the competitors and draft a positioning post", () => {
  const REPORT = JSON.stringify({
    summary: "Two of the three shipped integrations; the third went quiet.",
    findings: [
      { claim: "Acme shipped a Slack app in March.", source: "https://example.com/acme" },
      { claim: "Beta shipped SSO in February.", source: "https://example.com/beta" },
    ],
    confidence: "medium",
    gaps: ["Nothing found for Gamma this quarter."],
  });

  it("detaches, delegates, asks, resumes on the answer, and proposes a draft", async () => {
    const session = await createSession(db, workspaceId, null, { goal: "Launch" });
    const task = await newTask(
      "Research what our top 3 competitors shipped this quarter and draft a positioning post.",
      session.id,
    );

    // Attempt one: delegate, read the worker's report, then hit something only
    // the founder can settle.
    const first = new ScriptedGateway([
      {
        toolCalls: [
          {
            name: "delegate",
            arguments: {
              role: "competitor_scan",
              objective: "What did Acme, Beta and Gamma ship this quarter?",
            },
          },
        ],
      },
      { text: REPORT },
      {
        toolCalls: [
          {
            name: "ask_founder",
            arguments: {
              type: "disambiguation",
              question: "Should the post name the competitors?",
              why: "Naming them is a positioning choice, not a writing one.",
            },
          },
        ],
      },
    ]);

    const suspended = await runAgentTask(
      db,
      deps(first, { questions: true }),
      workspaceId,
      task.id,
    );
    if (suspended.status !== "resolved") throw new Error("expected a resolved task");
    expect(suspended.task.status).toBe("awaiting_answer");
    expect(suspended.task.subagentCount).toBe(1);

    const question = (await getAgentTaskDetail(db, workspaceId, task.id))!.questions[0]!;
    await answerAgentQuestion(
      db,
      workspaceId,
      question.id,
      { action: "answer", answer: "Yes, name them.", resume: true },
      ACTOR,
    );
    expect(await requeueAgentTask(db, task.id)).toBe(true);

    // Attempt two: resumed from the saved transcript, it proposes the draft.
    const second = new ScriptedGateway([
      {
        toolCalls: [
          {
            name: "propose_draft",
            arguments: {
              content: "Acme shipped Slack. Beta shipped SSO. Here is what we did instead.",
              channel: "linkedin",
              rationale: "The scan gives us a concrete contrast to lead with.",
            },
          },
        ],
      },
      { text: "Drafted a positioning post naming Acme and Beta. It is waiting for you." },
    ]);
    const finished = await runAgentTask(
      db,
      deps(second, { questions: true }),
      workspaceId,
      task.id,
    );
    if (finished.status !== "resolved") throw new Error("expected a resolved task");
    expect(finished.task.status).toBe("succeeded");

    // It proposed; it did not create. A person still confirms (D-78.1).
    const detail = await getAgentTaskDetail(db, workspaceId, task.id);
    expect(detail!.proposals).toHaveLength(1);
    expect(detail!.proposals[0]).toMatchObject({ tool: "propose_draft", status: "pending" });
    expect(detail!.proposals[0]!.agentTaskId).toBe(task.id);

    // It landed in the thread...
    const messages = await listMessages(db, session.id);
    expect(messages.at(-1)?.content).toContain("positioning post");

    // ...and in the inbox, until somebody reads it.
    const feed = await buildAgentInboxFeed(db, workspaceId);
    expect(feed.items.some((item) => item.kind === "agent_task_result")).toBe(true);
  });
});
