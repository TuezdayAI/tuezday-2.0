import type { FastifyInstance, FastifyReply } from "fastify";
import type { AnalyticsSink } from "../analytics/sink";
import { track } from "../analytics/track";
import { publishDraftInputSchema } from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import type { ConnectorFabric } from "../connectors/fabric";
import {
  ExternalActionPreparationError,
  preparePublicationAction,
} from "../services/external-action-adapters";
import type { ExternalActionRuntime } from "../services/external-action-coordinator";
import { canonicalActionFingerprint } from "../services/external-action-fingerprint";
import {
  attemptPublication,
  deletePublication,
  getPublication,
  listPublications,
  runDuePublications,
} from "../services/publications";
import { getWorkspace } from "../services/workspaces";
import { externalActionError } from "./external-actions";

type Fetcher = typeof fetch;

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerPublicationRoutes(
  app: FastifyInstance,
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  analytics: AnalyticsSink,
  runtime: ExternalActionRuntime,
): void {
  app.post<{ Params: { id: string; draftId: string } }>(
    "/workspaces/:id/drafts/:draftId/publish",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = publishDraftInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const input = parsed.data;
      const idempotencyKey =
        input.idempotencyKey ??
        `publish:${request.params.draftId}:${canonicalActionFingerprint({
          connectionId: input.connectionId,
          target: input.target,
          scheduledFor: input.scheduledFor ?? null,
        }).slice(0, 32)}`;
      try {
        const command = await preparePublicationAction(
          db,
          request.params.id,
          request.params.draftId,
          input,
          { idempotencyKey },
        );
        const result = await runtime.propose(command, actorOf(request));
        if (result.execution && request.actor.userId) {
          await track(db, analytics, {
            event: "publication.started",
            distinctId: request.actor.userId,
            workspaceId: request.params.id,
            properties: { channel: result.action.subject.channel ?? "unknown" },
          });
        }
        return reply
          .status(result.action.status === "authorization_required" ? 202 : 201)
          .send(result);
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

  app.get<{ Params: { id: string } }>("/workspaces/:id/publications", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    return await listPublications(db, request.params.id);
  });

  app.post<{ Params: { id: string; publicationId: string } }>(
    "/workspaces/:id/publications/:publicationId/retry",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const publication = await getPublication(db, request.params.id, request.params.publicationId);
      if (!publication) return reply.status(404).send({ error: "publication_not_found" });
      if (publication.status !== "failed") {
        return reply.status(409).send({
          error: "not_failed",
          message: "Only failed publications can be retried.",
        });
      }
      return await attemptPublication(db, fabric, fetcher, request.params.id, publication.id);
    },
  );

  app.delete<{ Params: { id: string; publicationId: string } }>(
    "/workspaces/:id/publications/:publicationId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const publication = await getPublication(db, request.params.id, request.params.publicationId);
      if (!publication) return reply.status(404).send({ error: "publication_not_found" });
      if (publication.status !== "scheduled") {
        return reply.status(409).send({
          error: "not_scheduled",
          message: "Only scheduled publications can be canceled.",
        });
      }
      await deletePublication(db, request.params.id, publication.id);
      return reply.status(204).send();
    },
  );

  // Legacy-receipt worker entry point. Governed receipts run through the
  // external-action route first so their action cannot finish prematurely.
  app.post<{ Params: { id: string } }>("/workspaces/:id/publish/run", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const results = await runDuePublications(db, fabric, fetcher, request.params.id);
    return { results };
  });
}
