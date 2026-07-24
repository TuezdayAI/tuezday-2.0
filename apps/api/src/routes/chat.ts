import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createChatSessionInputSchema,
  sendChatMessageInputSchema,
  type ChatSessionDetail,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import {
  createSession,
  deleteSession,
  getSession,
  listMessages,
  listSessions,
} from "../services/chat";
import { runCopilotTurn } from "../services/copilot";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

const DEFAULT_TITLE = "New chat";

export function registerChatRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
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
    const session = createSession(
      db,
      request.params.id,
      actor.userId,
      parsed.data.title?.trim() || DEFAULT_TITLE,
    );
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

      const result = await runCopilotTurn(
        db,
        { llm, evidence },
        request.params.id,
        actorOf(request),
        session.id,
        parsed.data.message,
      );
      return reply.status(201).send(result);
    },
  );
}
