import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  chatCommand,
  createChatPinInputSchema,
  createChatSessionInputSchema,
  runChatCommandInputSchema,
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
import type { AgentProposalService } from "../agents/proposals";
import {
  createSession,
  deleteSession,
  getSession,
  isThreadBudgetExhausted,
  listMessages,
  listSessions,
  updateSession,
} from "../services/chat";
import { runChatCommand } from "../services/chat-commands";
import { createChatPin, deleteChatPin, listChatPins } from "../services/chat-pins";
import {
  confirmChatProposal,
  declineChatProposal,
  listChatProposals,
} from "../services/chat-proposals";
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
  /**
   * Sprint 78: the LIVE Sprint 69 propose service, used only when a founder
   * confirms. A chat turn never sees it — the turn is given the recorder
   * instead — so there is no path from a model call to this object.
   */
  proposals?: AgentProposalService,
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
        proposals: listChatProposals(db, session.id),
        pins: listChatPins(db, session.id),
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
      // The role rides along: it is what decides whether this turn is offered
      // the propose tools at all (D-78.3), and it is set by the same guard
      // that already proved membership.
      const actor = { ...actorOf(request), role: request.actor.role };

      // Sprint 77: only a DIRECTIVE command may ride on a message. An instant
      // command sent here is refused rather than quietly turned into a model
      // turn the founder did not ask to pay for.
      const command = parsed.data.command;
      if (command && chatCommand(command)?.kind !== "directive") {
        return reply.status(400).send({
          error: "not_a_directive_command",
          message: `/${command} runs directly — POST it to .../command instead.`,
        });
      }
      const turnOptions = command ? { command } : {};

      if (!wantsStream(request)) {
        const result = await runChatTurn(
          db,
          deps,
          request.params.id,
          actor,
          session.id,
          parsed.data.message,
          undefined,
          turnOptions,
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
          turnOptions,
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

  // -------------------------------------------------------------------------
  // The command layer and pinned context (Sprint 77).
  //
  // An instant command runs registry read tools and returns cards; no model
  // runs, so no budget check is needed and no cost is incurred. Pins are
  // ordinary CRUD over the thread's own scope.
  // -------------------------------------------------------------------------

  app.post<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId/command",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const session = getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });

      const parsed = runChatCommandInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }

      const outcome = await runChatCommand(
        { db, evidence, safeFetch },
        request.params.id,
        actorOf(request),
        session.id,
        parsed.data.command,
        parsed.data.argument ?? "",
      );
      if (!outcome.ok) {
        return reply.status(400).send({
          error: outcome.error,
          message:
            outcome.error === "not_instant"
              ? "That command is answered by the assistant — send it as a message instead."
              : "Unknown command.",
        });
      }
      return reply.status(201).send({
        userMessage: outcome.userMessage,
        message: outcome.message,
        cards: outcome.cards,
      });
    },
  );

  app.get<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId/pins",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const session = getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });
      return listChatPins(db, session.id);
    },
  );

  app.post<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId/pins",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const session = getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });

      const parsed = createChatPinInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const outcome = createChatPin(db, safeFetch, request.params.id, session.id, parsed.data);
      if (!outcome.ok) {
        // A pin the founder cannot see the target of is refused where they can
        // read the refusal, rather than stored as a chip that renders nothing.
        return reply.status(outcome.error === "pin_limit_reached" ? 409 : 400).send({
          error: outcome.error,
        });
      }
      return reply.status(201).send(outcome.pin);
    },
  );

  app.delete<{ Params: { id: string; sessionId: string; pinId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId/pins/:pinId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const session = getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });
      const removed = deleteChatPin(db, request.params.id, session.id, request.params.pinId);
      if (!removed) return reply.status(404).send({ error: "chat_pin_not_found" });
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Confirm-before-propose (Sprint 78).
  //
  // These are the only routes in chat that can change anything, and they are
  // reachable only by a signed-in member of the workspace clicking a card. The
  // model has no path to them: it holds the recorder, which writes a pending
  // row and returns.
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId/proposals",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const session = getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });
      return listChatProposals(db, session.id);
    },
  );

  app.post<{ Params: { id: string; sessionId: string; proposalId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId/proposals/:proposalId/confirm",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const session = getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });
      if (!proposals) {
        // No live gate wired means no confirmation path — refusing is the only
        // honest answer, since the alternative is writing a second one here.
        return reply.status(503).send({ error: "proposals_unavailable" });
      }
      const actor = actorOf(request);
      if (!actor.human) {
        // Confirmation is the human step. A machine credential confirming its
        // own agent's proposal would empty the mechanism of meaning.
        return reply.status(403).send({ error: "confirmation_requires_a_person" });
      }

      const outcome = await confirmChatProposal(
        db,
        proposals,
        request.params.id,
        actor,
        request.params.proposalId,
      );
      if (!outcome.ok) {
        return outcome.error === "not_found"
          ? reply.status(404).send({ error: "chat_proposal_not_found" })
          : reply
              .status(409)
              .send({ error: "already_resolved", proposal: outcome.proposal });
      }
      // A refusal from the gate is a 200 with a `failed` proposal, not an HTTP
      // error: the request succeeded, and the answer is a governed "no" the
      // founder needs to read on the card.
      return reply.status(200).send(outcome.proposal);
    },
  );

  app.post<{ Params: { id: string; sessionId: string; proposalId: string } }>(
    "/workspaces/:id/chat/sessions/:sessionId/proposals/:proposalId/decline",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const session = getSession(db, request.params.id, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: "chat_session_not_found" });

      const outcome = declineChatProposal(
        db,
        request.params.id,
        actorOf(request),
        request.params.proposalId,
      );
      if (!outcome.ok) {
        return outcome.error === "not_found"
          ? reply.status(404).send({ error: "chat_proposal_not_found" })
          : reply
              .status(409)
              .send({ error: "already_resolved", proposal: outcome.proposal });
      }
      return reply.status(200).send(outcome.proposal);
    },
  );
}
