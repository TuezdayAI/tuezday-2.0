import type { FastifyInstance, FastifyReply } from "fastify";
import {
  AGENT_TASK_STATUSES,
  createAgentTaskInputSchema,
  detachChatRequestInputSchema,
  isAgentTaskTerminal,
  steerAgentTaskInputSchema,
  type AgentTask,
  type AgentTaskCreated,
  type AgentTaskStatus,
  type AgentTaskDetail,
  type AgentTaskStreamEvent,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import {
  acknowledgeAgentTask,
  cancelAgentTask,
  createAgentTask,
  getAgentTask,
  getAgentTaskDetail,
  listAgentTasks,
  steerAgentTask,
} from "../services/agent-tasks";
import { appendMessage, getSession } from "../services/chat";
import { EntitlementError, assertLlmBudget } from "../services/entitlements";
import { getWorkspace } from "../services/workspaces";
import { openStream, wantsStream } from "./sse";

/**
 * Sprint 79 — background agent tasks.
 *
 * Everything here is an adapter. Creation, steering, cancelling and
 * acknowledging are all in `services/agent-tasks`; the one piece of behaviour
 * that lives in this file is the progress stream, because polling a database
 * on a timer is a transport concern and nothing else needs it (D-79.12).
 */

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

/** How often the stream looks for new rows, and how long it will hold a
 * connection open before telling the client to reconnect. A task can run for
 * fifteen minutes; a socket held that long through an unknown proxy cannot be
 * relied on, so the stream is deliberately resumable rather than long-lived. */
const POLL_MS = 1_000;
const STREAM_MAX_MS = 300_000;

function invalid(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: "invalid_input", message });
}

/** The refusal a founder sees when the workspace's monthly LLM budget is gone.
 * Checked before the task row exists: a task that is created is a task that
 * gets to run (the pre-flight *warning* in `createAgentTask` is the softer,
 * "this could get expensive" case, which does not block). */
async function budgetRefusal(db: Db, workspaceId: string, reply: FastifyReply): Promise<boolean> {
  try {
    await assertLlmBudget(db, workspaceId);
    return false;
  } catch (err) {
    if (err instanceof EntitlementError) {
      void reply.status(402).send({ error: "upgrade_required", key: err.key, limit: err.limit });
      return true;
    }
    throw err;
  }
}

export function registerAgentTaskRoutes(app: FastifyInstance, db: Db): void {
  // -------------------------------------------------------------------------
  // Detaching from a thread. The founder pressed a button; the model never
  // decides this (D-79.3). Two thread messages are written here so the
  // conversation reads as a conversation: what they asked, and the
  // acknowledgement that it moved to the background.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId/detach",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = detachChatRequestInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return invalid(reply, parsed.error.issues.map((i) => i.message).join("; "));
      }
      const session = await getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });
      if (await budgetRefusal(db, request.params.id, reply)) return reply;

      const actor = actorOf(request);
      const outcome = await createAgentTask(
        db,
        request.params.id,
        { userId: actor.userId, label: actor.label },
        { request: parsed.data.message, sessionId: session.id },
      );
      if (!outcome.ok) {
        return reply.status(409).send({
          error: outcome.error,
          limit: outcome.limit,
          message:
            `This workspace already has ${outcome.limit} background tasks going. ` +
            "Wait for one to finish, or cancel it.",
        });
      }

      const userMessage = await appendMessage(db, request.params.id, session.id, {
        role: "user",
        content: parsed.data.message,
      });
      const message = await appendMessage(db, request.params.id, session.id, {
        role: "assistant",
        content:
          "Working on that in the background. You can keep using this thread — " +
          "I'll post the answer here when it's done.",
        agentTaskId: outcome.task.id,
      });

      const body: AgentTaskCreated = {
        task: outcome.task,
        budgetWarning: outcome.budgetWarning,
        userMessage,
        message,
      };
      return reply.status(201).send(body);
    },
  );

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/workspaces/:id/agent-tasks", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createAgentTaskInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return invalid(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    if (parsed.data.sessionId) {
      const session = await getSession(db, request.params.id, parsed.data.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });
    }
    if (await budgetRefusal(db, request.params.id, reply)) return reply;

    const actor = actorOf(request);
    const outcome = await createAgentTask(
      db,
      request.params.id,
      { userId: actor.userId, label: actor.label },
      { request: parsed.data.request, sessionId: parsed.data.sessionId ?? null },
    );
    if (!outcome.ok) {
      return reply.status(409).send({
        error: outcome.error,
        limit: outcome.limit,
        message:
          `This workspace already has ${outcome.limit} background tasks going. ` +
          "Wait for one to finish, or cancel it.",
      });
    }
    const body: AgentTaskCreated = {
      task: outcome.task,
      budgetWarning: outcome.budgetWarning,
      userMessage: null,
      message: null,
    };
    return reply.status(201).send(body);
  });

  app.get<{
    Params: { id: string };
    Querystring: { status?: string; sessionId?: string; limit?: string };
  }>("/workspaces/:id/agent-tasks", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const status = request.query.status;
    if (status && !(AGENT_TASK_STATUSES as readonly string[]).includes(status)) {
      return invalid(reply, `status must be one of: ${AGENT_TASK_STATUSES.join(", ")}`);
    }
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return invalid(reply, "limit must be a positive number");
    }
    return await listAgentTasks(db, request.params.id, {
      ...(status ? { status: status as AgentTaskStatus } : {}),
      ...(request.query.sessionId ? { sessionId: request.query.sessionId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  });

  app.get<{ Params: { id: string; taskId: string } }>(
    "/workspaces/:id/agent-tasks/:taskId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = await getAgentTaskDetail(db, request.params.id, request.params.taskId);
      if (!detail) return reply.status(404).send({ error: "agent_task_not_found" });
      return detail;
    },
  );

  // -------------------------------------------------------------------------
  // Progress. Polled from the database rather than pushed from an in-process
  // bus, because the executor runs in whichever process claimed the queue job
  // and that is usually not this one (D-79.12).
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string; taskId: string } }>(
    "/workspaces/:id/agent-tasks/:taskId/stream",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const first = await getAgentTaskDetail(db, request.params.id, request.params.taskId);
      if (!first) return reply.status(404).send({ error: "agent_task_not_found" });
      if (!wantsStream(request)) return first;

      const stream = openStream<AgentTaskStreamEvent>(reply);
      // Everything already on the task goes out first, so a client that
      // connects late sees the same picture as one that was there from the
      // start. From then on only deltas are sent.
      const seenSteps = new Set<string>();
      const seenSubagents = new Set<string>();
      const seenQuestions = new Set<string>();
      const seenProposals = new Set<string>();
      let lastStatus: AgentTaskStatus | null = null;

      const emit = (detail: AgentTaskDetail) => {
        if (detail.status !== lastStatus) {
          lastStatus = detail.status;
          stream.send({ type: "status", task: taskOf(detail) });
        }
        for (const step of detail.steps) {
          if (seenSteps.has(step.id)) continue;
          seenSteps.add(step.id);
          stream.send({ type: "step", step });
        }
        for (const run of detail.subagents) {
          // A worker's row is written when it starts and updated when it
          // finishes, so it is emitted twice on purpose — the second frame is
          // what turns a spinner into a result.
          const key = `${run.id}:${run.stopReason ?? "running"}`;
          if (seenSubagents.has(key)) continue;
          seenSubagents.add(key);
          stream.send({ type: "subagent", run });
        }
        for (const question of detail.questions) {
          const key = `${question.id}:${question.status}`;
          if (seenQuestions.has(key)) continue;
          seenQuestions.add(key);
          stream.send({ type: "question", question });
        }
        for (const proposal of detail.proposals) {
          const key = `${proposal.id}:${proposal.status}`;
          if (seenProposals.has(key)) continue;
          seenProposals.add(key);
          stream.send({ type: "proposal", proposal });
        }
      };

      const deadline = Date.now() + STREAM_MAX_MS;
      try {
        emit(first);
        let detail = first;
        // `awaiting_answer` is a resting point, not a terminal one, but
        // nothing more will happen until a human answers — so the stream ends
        // there too and the client reconnects after posting the answer.
        while (
          !stream.closed() &&
          Date.now() < deadline &&
          !isAgentTaskTerminal(detail.status) &&
          detail.status !== "awaiting_answer"
        ) {
          await sleep(POLL_MS);
          const next = await getAgentTaskDetail(db, request.params.id, request.params.taskId);
          if (!next) break;
          detail = next;
          emit(detail);
        }
        stream.send({ type: "result", task: taskOf(detail) });
        stream.send({ type: "done", status: detail.status });
      } finally {
        stream.close();
      }
      return reply;
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    "/workspaces/:id/agent-tasks/:taskId/steer",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = steerAgentTaskInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return invalid(reply, parsed.error.issues.map((i) => i.message).join("; "));
      }
      const outcome = await steerAgentTask(
        db,
        request.params.id,
        request.params.taskId,
        parsed.data.message,
      );
      if (!outcome.ok) {
        if (outcome.error === "task_not_found") {
          return reply.status(404).send({ error: "agent_task_not_found" });
        }
        return reply.status(409).send({
          error: outcome.error,
          message:
            outcome.error === "task_finished"
              ? "That task already finished, so there is nothing to steer."
              : "That task has taken as many mid-run instructions as it can. Cancel it and start again with a clearer request.",
        });
      }
      return reply.status(201).send(outcome.message);
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    "/workspaces/:id/agent-tasks/:taskId/cancel",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const outcome = await cancelAgentTask(db, request.params.id, request.params.taskId);
      if (!outcome.ok) {
        if (outcome.error === "task_not_found") {
          return reply.status(404).send({ error: "agent_task_not_found" });
        }
        return reply.status(409).send({
          error: outcome.error,
          message: "That task already finished.",
        });
      }
      return outcome.task;
    },
  );

  /**
   * Retry creates a NEW task from the same request (D-79.9). Re-running the
   * old row would overwrite a trace the founder may still want, and it would
   * make "how many times did this cost me" unanswerable.
   */
  app.post<{ Params: { id: string; taskId: string } }>(
    "/workspaces/:id/agent-tasks/:taskId/retry",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const previous = await getAgentTask(db, request.params.id, request.params.taskId);
      if (!previous) return reply.status(404).send({ error: "agent_task_not_found" });
      if (!isAgentTaskTerminal(previous.status)) {
        return reply.status(409).send({
          error: "task_not_finished",
          message: "That task is still going. Cancel it first if you want to start over.",
        });
      }
      if (await budgetRefusal(db, request.params.id, reply)) return reply;

      const actor = actorOf(request);
      const outcome = await createAgentTask(
        db,
        request.params.id,
        { userId: actor.userId, label: actor.label },
        { request: previous.request, sessionId: previous.sessionId },
      );
      if (!outcome.ok) {
        return reply.status(409).send({
          error: outcome.error,
          limit: outcome.limit,
          message: `This workspace already has ${outcome.limit} background tasks going.`,
        });
      }
      const body: AgentTaskCreated = {
        task: outcome.task,
        budgetWarning: outcome.budgetWarning,
        userMessage: null,
        message: null,
      };
      return reply.status(201).send(body);
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    "/workspaces/:id/agent-tasks/:taskId/acknowledge",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const task = await acknowledgeAgentTask(db, request.params.id, request.params.taskId);
      if (!task) return reply.status(404).send({ error: "agent_task_not_found" });
      return task;
    },
  );
}

/** The detail's own fields, without the five arrays a status frame does not
 * carry — the client already has those from the step/subagent frames. */
function taskOf(detail: AgentTaskDetail): AgentTask {
  const { steps: _steps, subagents: _subagents, messages: _messages,
    questions: _questions, proposals: _proposals, ...task } = detail;
  return task;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
