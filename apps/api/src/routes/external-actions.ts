import type { FastifyInstance, FastifyReply } from "fastify";
import {
  authorizeExternalActionInputSchema,
  denyExternalActionInputSchema,
  externalActionListFiltersSchema,
  reproposeExternalActionInputSchema,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import {
  ExternalActionIdempotencyConflictError,
  ExternalActionNotFoundError,
  StaleExternalActionError,
  type ExternalActionRuntime,
} from "../services/external-action-coordinator";
import {
  InvalidExternalActionTransitionError,
  getExternalActionDetail,
  listExternalActions,
} from "../services/external-actions";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) void reply.status(404).send({ error: "workspace_not_found" });
  return workspace;
}

function invalid(reply: FastifyReply, issues: { message: string }[]) {
  return reply.status(400).send({
    error: "invalid_input",
    message: issues.map((issue) => issue.message).join("; "),
  });
}

export function externalActionError(error: unknown, reply: FastifyReply) {
  if (error instanceof ExternalActionNotFoundError) {
    return reply.status(404).send({ error: "not_found" });
  }
  if (error instanceof StaleExternalActionError) {
    return reply.status(409).send({ error: "stale_action", action: error.action });
  }
  if (
    error instanceof InvalidExternalActionTransitionError ||
    error instanceof ExternalActionIdempotencyConflictError
  ) {
    return reply.status(409).send({ error: "conflict", message: error.message });
  }
  throw error;
}

export function registerExternalActionRoutes(
  app: FastifyInstance,
  db: Db,
  runtime: ExternalActionRuntime,
): void {
  app.get<{
    Params: { id: string };
    Querystring: Record<string, unknown>;
  }>("/workspaces/:id/external-actions", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = externalActionListFiltersSchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.issues);
    return { actions: listExternalActions(db, request.params.id, parsed.data) };
  });

  app.get<{ Params: { id: string; actionId: string } }>(
    "/workspaces/:id/external-actions/:actionId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = getExternalActionDetail(db, request.params.id, request.params.actionId);
      return detail ?? reply.status(404).send({ error: "not_found" });
    },
  );

  app.post<{ Params: { id: string; actionId: string } }>(
    "/workspaces/:id/external-actions/:actionId/authorize",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = authorizeExternalActionInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      try {
        return await runtime.authorize(request.params.actionId, request.params.id, actorOf(request));
      } catch (error) {
        return externalActionError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string; actionId: string } }>(
    "/workspaces/:id/external-actions/:actionId/deny",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = denyExternalActionInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      try {
        return await runtime.deny(
          request.params.actionId,
          request.params.id,
          actorOf(request),
          parsed.data.reason ?? null,
        );
      } catch (error) {
        return externalActionError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string; actionId: string } }>(
    "/workspaces/:id/external-actions/:actionId/repropose",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = reproposeExternalActionInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      try {
        return await runtime.repropose(
          request.params.actionId,
          request.params.id,
          parsed.data.idempotencyKey,
          actorOf(request),
        );
      } catch (error) {
        return externalActionError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/external-actions/run",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return { actions: await runtime.run(request.params.id) };
    },
  );
}
