import type { FastifyInstance, FastifyReply } from "fastify";
import type { AnalyticsSink } from "../analytics/sink";
import { track } from "../analytics/track";
import { publishDraftInputSchema, validateSocialPost } from "@tuezday/contracts";
import type { Db } from "../db";
import type { ConnectorFabric } from "../connectors/fabric";
import { getConnection, providerByKey } from "../services/connections";
import { getDraft } from "../services/drafts";
import {
  attemptPublication,
  createPublication,
  deletePublication,
  findLivePublication,
  getPublication,
  listPublications,
  runDuePublications,
} from "../services/publications";
import { getWorkspace } from "../services/workspaces";

type Fetcher = typeof fetch;

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
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
): void {
  app.post<{ Params: { id: string; draftId: string } }>(
    "/workspaces/:id/drafts/:draftId/publish",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const draft = getDraft(db, request.params.id, request.params.draftId);
      if (!draft) return reply.status(404).send({ error: "draft_not_found" });
      if (draft.state !== "approved") {
        return reply.status(409).send({
          error: "draft_not_approved",
          message: "Only approved drafts can be published — run it through Review first.",
        });
      }

      const parsed = publishDraftInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const input = parsed.data;
      if (input.scheduledFor !== undefined && input.scheduledFor <= Date.now()) {
        return reply.status(400).send({
          error: "invalid_input",
          message: "The scheduled time must be in the future.",
        });
      }

      const connection = getConnection(db, request.params.id, input.connectionId);
      if (!connection) return reply.status(404).send({ error: "connection_not_found" });
      const provider = providerByKey(connection.providerKey);
      if (
        connection.status !== "connected" ||
        !provider ||
        !provider.categories?.includes("social")
      ) {
        return reply.status(400).send({
          error: "not_social",
          message: "Pick a connected social account to publish to.",
        });
      }

      const validation = validateSocialPost(provider.key, {
        target: input.target,
        title: input.title,
        body: draft.content,
      });
      if (!validation.ok) {
        return reply.status(400).send({
          error: "publish_validation",
          message: validation.violations.map((v) => v.message).join(" "),
          violations: validation.violations,
        });
      }

      if (findLivePublication(db, draft.id, connection.id, input.target)) {
        return reply.status(409).send({
          error: "already_published",
          message: "This draft is already published (or scheduled) to that destination.",
        });
      }

      const publication = await createPublication(
        db,
        fabric,
        fetcher,
        request.params.id,
        draft.id,
        connection,
        input,
      );

      track(db, analytics, {
        event: "publication.started",
        distinctId: request.actor.userId!,
        workspaceId: request.params.id,
        properties: { channel: draft.channel },
      });

      return reply.status(201).send(publication);
    },
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id/publications", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listPublications(db, request.params.id);
  });

  app.post<{ Params: { id: string; publicationId: string } }>(
    "/workspaces/:id/publications/:publicationId/retry",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const publication = getPublication(db, request.params.id, request.params.publicationId);
      if (!publication) return reply.status(404).send({ error: "publication_not_found" });
      if (publication.status !== "failed") {
        return reply.status(409).send({
          error: "not_failed",
          message: "Only failed publications can be retried.",
        });
      }
      return attemptPublication(db, fabric, fetcher, request.params.id, publication.id);
    },
  );

  app.delete<{ Params: { id: string; publicationId: string } }>(
    "/workspaces/:id/publications/:publicationId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const publication = getPublication(db, request.params.id, request.params.publicationId);
      if (!publication) return reply.status(404).send({ error: "publication_not_found" });
      if (publication.status !== "scheduled") {
        return reply.status(409).send({
          error: "not_scheduled",
          message: "Only scheduled publications can be canceled.",
        });
      }
      deletePublication(db, publication.id);
      return reply.status(204).send();
    },
  );

  // Worker entry point: fire everything due.
  app.post<{ Params: { id: string } }>("/workspaces/:id/publish/run", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const results = await runDuePublications(db, fabric, fetcher, request.params.id);
    return { results };
  });
}
