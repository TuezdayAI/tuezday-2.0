import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AGENT_QUESTION_STATUSES,
  answerAgentQuestionInputSchema,
  type AgentQuestionStatus,
  type AnswerAgentQuestionResult,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { buildAgentInboxFeed } from "../services/agent-inbox";
import { getAgentTask, requeueAgentTask } from "../services/agent-tasks";
import {
  answerAgentQuestion,
  getAgentQuestion,
  listAgentQuestions,
  AgentQuestionAlreadyClosedError,
  AgentQuestionNotFoundError,
} from "../services/agent-questions";
import {
  decidePipelineRun,
  InvalidPipelineRunTransitionError,
  PipelineRunNotFoundError,
  type PipelineEngineDeps,
} from "../services/pipeline-engine";
import { getWorkspace } from "../services/workspaces";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) void reply.status(404).send({ error: "workspace_not_found" });
  return workspace;
}

function invalidInput(reply: FastifyReply, issues: { message: string }[]) {
  return reply.status(400).send({
    error: "invalid_input",
    message: issues.map((issue) => issue.message).join("; "),
  });
}

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(AGENT_QUESTION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export interface QuestionRouteDeps {
  /** Needed only to resume the run an answer unblocks (D-70.7). */
  engine: PipelineEngineDeps;
}

/**
 * The agent inbox and the ask lane (Sprint 70).
 *
 * The feed is one read; answering is one write plus, when a run is waiting on
 * it, the same resume the operator decide route already performs. Nothing here
 * is a new execution path — the point of the ask lane is that the suspension it
 * uses was already built.
 */
export function registerQuestionRoutes(
  app: FastifyInstance,
  db: Db,
  deps: QuestionRouteDeps,
): void {
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/workspaces/:id/agent-inbox",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = feedQuerySchema.safeParse(request.query);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      return await buildAgentInboxFeed(db, request.params.id, { limit: parsed.data.limit });
    },
  );

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/workspaces/:id/questions",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      return {
        questions: await listAgentQuestions(db, request.params.id, {
          status: parsed.data.status as AgentQuestionStatus | undefined,
          limit: parsed.data.limit,
        }),
      };
    },
  );

  app.post<{ Params: { id: string; questionId: string }; Body: unknown }>(
    "/workspaces/:id/questions/:questionId/answer",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = answerAgentQuestionInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);

      const actor = actorOf(request);
      // D-70.13: the ask lane exists so a *person* decides. A system token
      // answering an agent's question would close the loop the sprint opened.
      if (!actor.human) {
        return reply.status(403).send({
          error: "human_required",
          message: "Only a workspace member can answer an agent's question.",
        });
      }

      let outcome;
      try {
        outcome = await answerAgentQuestion(
          db,
          request.params.id,
          request.params.questionId,
          parsed.data,
          { userId: actor.userId, label: actor.label },
        );
      } catch (err) {
        if (err instanceof AgentQuestionNotFoundError) {
          return reply.status(404).send({ error: "question_not_found" });
        }
        if (err instanceof AgentQuestionAlreadyClosedError) {
          return reply.status(409).send({ error: "question_closed", message: err.message });
        }
        throw err;
      }

      const result: AnswerAgentQuestionResult = {
        question: outcome.question,
        rule: outcome.rule,
        resumedRun: null,
        resumedTask: null,
      };

      // Sprint 79: a background task suspended on this question resumes from
      // its saved transcript (D-79.10). Unlike a pipeline resume this is a
      // re-enqueue, not a synchronous call — the task picks up wherever the
      // queue has room, which is the whole point of it being in the background.
      const agentTaskId = outcome.question.agentTaskId;
      if (parsed.data.action === "answer" && parsed.data.resume && agentTaskId) {
        if (await requeueAgentTask(db, agentTaskId)) {
          const task = await getAgentTask(db, request.params.id, agentTaskId);
          if (task) result.resumedTask = { id: task.id, status: task.status };
        }
      }

      const pipelineRunId = outcome.question.pipelineRunId;
      if (parsed.data.action === "answer" && parsed.data.resume && pipelineRunId) {
        try {
          const resumed = await decidePipelineRun(db, deps.engine, request.params.id, pipelineRunId, {
            action: "resume",
          });
          result.resumedRun = { id: resumed.run.id, status: resumed.run.status };
        } catch (err) {
          // The answer is recorded either way. A run that finished, failed or
          // was cancelled while the question sat open is not an error in
          // answering it — it just has nothing left to resume.
          if (
            !(err instanceof InvalidPipelineRunTransitionError) &&
            !(err instanceof PipelineRunNotFoundError)
          ) {
            throw err;
          }
        }
      }
      return result;
    },
  );
}
