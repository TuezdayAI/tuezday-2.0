import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createChatSessionInputSchema,
  sendChatMessageInputSchema,
  updateChatSessionInputSchema,
  type ChatSessionDetail,
  type ChatStreamEvent,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import type { SafeFetchService } from "../safe-fetch/index";
import {
  createSession,
  deleteSession,
  getSession,
  isThreadBudgetExhausted,
  listMessages,
  listSessions,
  updateSession,
} from "../services/chat";
import { runChatTurn } from "../services/chat-turn";
import { EntitlementError, assertLlmBudget } from "../services/entitlements";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

const DEFAULT_TITLE = "";

/** Keeps an idle stream alive through a long tool call. */
const HEARTBEAT_MS = 15_000;

function wantsStream(request: FastifyRequest): boolean {
  return (request.headers.accept ?? "").includes("text/event-stream");
}

/**
 * The platform's first SSE endpoint (Sprint 76). Fastify's reply is hijacked
 * so frames can be written as they happen; the route stays a thin adapter over
 * `runChatTurn`, which is the testable unit and takes the same `onEvent`
 * callback whether or not anyone is streaming (D-76.10).
 */
function openStream(reply: FastifyReply): {
  send: (event: ChatStreamEvent) => void;
  close: () => void;
} {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Proxies that buffer defeat the entire point of streaming.
    "X-Accel-Buffering": "no",
  });
  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(":\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    send(event) {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      if (!reply.raw.writableEnded) reply.raw.end();
    },
  };
}

export function registerChatRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  safeFetch: SafeFetchService,
): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/chat/sessions", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createChatSessionInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const actor = actorOf(request);
    const session = createSession(db, request.params.id, actor.userId, {
      ...parsed.data,
      title: parsed.data.title?.trim() || DEFAULT_TITLE,
    });
    return reply.status(201).send(session);
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/chat/sessions", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listSessions(db, request.params.id);
  });

  app.get<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const session = getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });
      const detail: ChatSessionDetail = {
        ...session,
        messages: listMessages(db, session.id),
      };
      return detail;
    },
  );

  app.patch<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateChatSessionInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const session = updateSession(
        db,
        request.params.id,
        request.params.sessionId,
        parsed.data,
      );
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });
      return session;
    },
  );

  app.delete<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const deleted = deleteSession(db, request.params.id, request.params.sessionId);
      if (!deleted) return reply.status(404).send({ error: "chat_session_not_found" });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId/messages",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const session = getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });

      const parsed = sendChatMessageInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }

      // Both budgets are checked before a single token is spent, and both are
      // refusals rather than degradations: a turn that starts is a turn the
      // founder gets to finish.
      try {
        assertLlmBudget(db, request.params.id);
      } catch (err) {
        if (err instanceof EntitlementError) {
          return reply
            .status(402)
            .send({ error: "upgrade_required", key: err.key, limit: err.limit });
        }
        throw err;
      }
      if (isThreadBudgetExhausted(session)) {
        return reply.status(409).send({
          error: "thread_budget_exhausted",
          message:
            "This conversation has reached its token limit. Start a new one — its scope and goal carry over from here.",
        });
      }

      const deps = { llm, evidence, safeFetch };
      const actor = actorOf(request);

      if (!wantsStream(request)) {
        const result = await runChatTurn(
          db,
          deps,
          request.params.id,
          actor,
          session.id,
          parsed.data.message,
        );
        if (!result) return reply.status(404).send({ error: "chat_session_not_found" });
        return reply.status(201).send(result);
      }

      const stream = openStream(reply);
      try {
        await runChatTurn(
          db,
          deps,
          request.params.id,
          actor,
          session.id,
          parsed.data.message,
          stream.send,
        );
      } catch (err) {
        // runChatTurn degrades rather than throwing, so reaching here means
        // something structural broke. The client still gets a terminal frame.
        stream.send({
          type: "error",
          error: "turn_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        stream.close();
      }
      return reply;
    },
  );
}
