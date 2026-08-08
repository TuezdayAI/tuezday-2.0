import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  AGENT_TASKS_PER_WORKSPACE,
  agentTaskDetailSchema,
  agentTaskSchema,
  type AgentTask,
  type AgentTaskCreated,
  type ChatSession,
} from "@tuezday/contracts";
import type { Db } from "../src/db";
import { agentTasks } from "../src/db/schema";
import type { AddDocumentInput, EvidenceStore, StoreSearchResult } from "../src/evidence/store";
import { ScriptedGateway } from "../src/llm/scripted";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

// ---------------------------------------------------------------------------
// The agent-task routes (Sprint 79). The executor has its own suite; what is
// asserted here is the transport: detaching from a thread, the caps as HTTP
// statuses, tenant scoping, and the SSE progress frames.
// ---------------------------------------------------------------------------

class NoEvidence implements EvidenceStore {
  async health() {
    return { healthy: false };
  }
  async createCollection(n: string) {
    return n;
  }
  async addDocument(_i: AddDocumentInput) {
    return "d";
  }
  async attachDocument() {}
  async deleteDocument() {}
  async search(): Promise<StoreSearchResult[]> {
    return [];
  }
}

let db: Db;

async function appWith() {
  const app = await buildAuthedApp({
    db,
    llm: new ScriptedGateway([]),
    evidence: new NoEvidence(),
  });
  const workspaceId = (
    await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })
  ).json().id as string;
  return { app, workspaceId };
}

type App = Awaited<ReturnType<typeof appWith>>["app"];

async function newThread(app: App, workspaceId: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/chat/sessions`,
    payload: {},
  });
  return created.json<ChatSession>().id;
}

async function newTask(app: App, workspaceId: string, request = "Do the thing."): Promise<AgentTask> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/agent-tasks`,
    payload: { request },
  });
  return res.json<AgentTaskCreated>().task;
}

function parseFrames(payload: string): { type: string; data: Record<string, unknown> }[] {
  return payload
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0 && !frame.startsWith(":"))
    .map((frame) => {
      const type = /^event: (.+)$/m.exec(frame)?.[1] ?? "";
      const data = /^data: (.+)$/m.exec(frame)?.[1] ?? "{}";
      return { type, data: JSON.parse(data) as Record<string, unknown> };
    });
}

beforeEach(async () => {
  db = await createTestDb();
});

describe("detaching from a thread", () => {
  it("writes both thread messages and returns the task", async () => {
    const { app, workspaceId } = await appWith();
    const sessionId = await newThread(app, workspaceId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/detach`,
      payload: { message: "Research what our top three competitors shipped this quarter." },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<AgentTaskCreated>();
    expect(agentTaskSchema.parse(body.task).sessionId).toBe(sessionId);
    // The founder's request and the acknowledgement, so the thread still reads
    // as a conversation after the work moved elsewhere.
    expect(body.userMessage?.role).toBe("user");
    expect(body.message?.role).toBe("assistant");
    expect(body.message?.agentTaskId).toBe(body.task.id);
  });

  it("404s on a thread that is not this workspace's", async () => {
    const { app, workspaceId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/00000000-0000-4000-8000-000000000000/detach`,
      payload: { message: "Anything" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an empty request rather than starting an empty run", async () => {
    const { app, workspaceId } = await appWith();
    const sessionId = await newThread(app, workspaceId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/detach`,
      payload: { message: "   " },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("creating without a thread", () => {
  it("accepts a bare request", async () => {
    const { app, workspaceId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-tasks`,
      payload: { request: "Audit the brain." },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentTaskCreated>();
    expect(body.task.sessionId).toBeNull();
    expect(body.userMessage).toBeNull();
    expect(body.message).toBeNull();
  });

  it("409s past the cap and names it, rather than queueing work nobody sees", async () => {
    const { app, workspaceId } = await appWith();
    for (let i = 0; i < AGENT_TASKS_PER_WORKSPACE; i += 1) await newTask(app, workspaceId, `T${i}`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-tasks`,
      payload: { request: "One more" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "agent_task_limit_reached",
      limit: AGENT_TASKS_PER_WORKSPACE,
    });
  });
});

describe("reading", () => {
  it("lists a workspace's tasks and filters by status", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    await db.update(agentTasks).set({ status: "succeeded" }).where(eq(agentTasks.id, task.id));
    await newTask(app, workspaceId, "Still going");

    const all = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/agent-tasks` });
    expect(all.json<AgentTask[]>()).toHaveLength(2);

    const done = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-tasks?status=succeeded`,
    });
    expect(done.json<AgentTask[]>().map((t) => t.id)).toEqual([task.id]);
  });

  it("rejects a status that is not one", async () => {
    const { app, workspaceId } = await appWith();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-tasks?status=nonsense`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns the detail with every list the panel renders", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}`,
    });
    expect(res.statusCode).toBe(200);
    const detail = agentTaskDetailSchema.parse(res.json());
    expect(detail.steps).toEqual([]);
    expect(detail.subagents).toEqual([]);
    expect(detail.questions).toEqual([]);
    expect(detail.proposals).toEqual([]);
  });

  it("404s a task belonging to someone else's workspace", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    const other = await registerUser(app, "other@example.com");
    const otherApp = asUser(app, other.token);
    const otherWorkspace = (
      await otherApp.inject({ method: "POST", url: "/workspaces", payload: { name: "Other" } })
    ).json().id as string;

    const res = await otherApp.inject({
      method: "GET",
      url: `/workspaces/${otherWorkspace}/agent-tasks/${task.id}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("steering and stopping", () => {
  it("records a steer without touching the run", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}/steer`,
      payload: { message: "Only LinkedIn." },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: "steer", consumedAt: null });
  });

  it("409s a steer aimed at a task that already finished", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    await db.update(agentTasks).set({ status: "succeeded" }).where(eq(agentTasks.id, task.id));
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}/steer`,
      payload: { message: "Too late" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("finished");
  });

  it("cancels a queued task outright", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AgentTask>().status).toBe("cancelled");
  });

  it("retries by starting a NEW task, leaving the old trace intact", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId, "Research the market.");
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}/cancel`,
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}/retry`,
    });
    expect(res.statusCode).toBe(201);
    const retried = res.json<AgentTaskCreated>().task;
    expect(retried.id).not.toBe(task.id);
    expect(retried.request).toBe(task.request);
    expect(retried.status).toBe("queued");
  });

  it("refuses to retry something still running", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}/retry`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("task_not_finished");
  });

  it("acknowledges a finished task, which is what clears it from the inbox", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    await db
      .update(agentTasks)
      .set({ status: "succeeded", finishedAt: 9 })
      .where(eq(agentTasks.id, task.id));
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}/acknowledge`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AgentTask>().acknowledgedAt).not.toBeNull();
  });
});

describe("the progress stream", () => {
  it("answers with the detail when the client did not ask for a stream", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}/stream`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(agentTaskDetailSchema.parse(res.json()).id).toBe(task.id);
  });

  it("streams the current state and a terminal frame for a task that already finished", async () => {
    const { app, workspaceId } = await appWith();
    const task = await newTask(app, workspaceId);
    await db
      .update(agentTasks)
      .set({ status: "succeeded", finishedAt: 9, outputText: "Done." })
      .where(eq(agentTasks.id, task.id));

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-tasks/${task.id}/stream`,
      headers: { accept: "text/event-stream" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = parseFrames(res.payload);
    expect(frames.map((f) => f.type)).toEqual(["status", "result", "done"]);
    expect(frames.at(-1)!.data).toMatchObject({ status: "succeeded" });
  });

  it("404s a stream for a task that does not exist", async () => {
    const { app, workspaceId } = await appWith();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-tasks/00000000-0000-4000-8000-000000000000/stream`,
      headers: { accept: "text/event-stream" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("auth", () => {
  it("refuses an unauthenticated caller", async () => {
    const { app, workspaceId } = await appWith();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-tasks`,
      headers: { authorization: "" },
    });
    expect(res.statusCode).toBe(401);
  });
});
