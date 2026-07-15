import type { FastifyInstance, FastifyReply } from "fastify";
import { updateInboxItemStatusInputSchema, type InboxItemStatus } from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { ConnectorFabric } from "../connectors/fabric";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import {
  generateReplyForItem,
  getInboxItem,
  listInbox,
  runInbox,
  setInboxStatus,
} from "../services/inbox";
import {
  ExternalActionPreparationError,
  deriveReplyIdempotencyKey,
  prepareReplyAction,
} from "../services/external-action-adapters";
import type { ExternalActionRuntime } from "../services/external-action-coordinator";
import { getDraft } from "../services/drafts";
import { getWorkspace } from "../services/workspaces";
import { externalActionError } from "./external-actions";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

const STATUS_FILTERS = new Set(["unread", "read", "replied", "dismissed"]);

export function registerInboxRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  connectors: ConnectorFabric,
  runtime: ExternalActionRuntime,
): void {
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    "/workspaces/:id/inbox",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const status = request.query.status;
      if (status && !STATUS_FILTERS.has(status)) {
        return reply.status(400).send({ error: "invalid_input", message: "Unknown status filter." });
      }
      return listInbox(db, request.params.id, status as InboxItemStatus | undefined);
    },
  );

  app.patch<{ Params: { id: string; itemId: string } }>(
    "/workspaces/:id/inbox/:itemId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateInboxItemStatusInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "invalid_input", message: parsed.error.issues.map((i) => i.message).join("; ") });
      }
      const item = setInboxStatus(db, request.params.id, request.params.itemId, parsed.data.status);
      if (!item) return reply.status(404).send({ error: "inbox_item_not_found" });
      return item;
    },
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    "/workspaces/:id/inbox/:itemId/reply",
    async (request, reply) => {
      const workspace = workspaceOr404(db, request.params.id, reply);
      if (!workspace) return reply;
      const item = getInboxItem(db, request.params.id, request.params.itemId);
      if (!item) return reply.status(404).send({ error: "inbox_item_not_found" });
      return generateReplyForItem(db, llm, evidence, workspace, item, actorOf(request));
    },
  );

  // Proposes a `reply` external action for the approved reply draft; the action
  // policy decides whether it posts immediately or waits in Review.
  app.post<{ Params: { id: string; itemId: string } }>(
    "/workspaces/:id/inbox/:itemId/post-reply",
    async (request, reply) => {
      const workspace = workspaceOr404(db, request.params.id, reply);
      if (!workspace) return reply;
      const item = getInboxItem(db, request.params.id, request.params.itemId);
      if (!item) return reply.status(404).send({ error: "inbox_item_not_found" });
      if (item.postedReplyExternalId) {
        return reply.status(409).send({ error: "already_replied" });
      }
      if (!item.replyDraftId) {
        return reply.status(409).send({ error: "reply_not_approved", message: "Draft a reply first." });
      }
      const draft = getDraft(db, request.params.id, item.replyDraftId);
      if (!draft || draft.state !== "approved") {
        return reply.status(409).send({ error: "reply_not_approved" });
      }
      try {
        const command = prepareReplyAction(db, request.params.id, item.id, {
          idempotencyKey: deriveReplyIdempotencyKey(item.id, draft),
          automated: false,
        });
        const submission = await runtime.propose(command, actorOf(request));
        return reply
          .status(submission.action.status === "authorization_required" ? 202 : 201)
          .send(submission);
      } catch (error) {
        if (error instanceof ExternalActionPreparationError) {
          return reply.status(error.statusCode).send({
            error: error.code,
            message: error.message,
            ...(error.details as object | undefined),
          });
        }
        return externalActionError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/inbox/run", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return runInbox(db, llm, evidence, connectors, runtime, request.params.id);
  });
}
