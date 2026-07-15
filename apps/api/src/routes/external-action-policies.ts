import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  EXTERNAL_ACTION_POLICY_SCOPES,
  upsertExternalActionPoliciesInputSchema,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  ExternalActionPolicyConflictError,
  ExternalActionPolicyInputError,
  ExternalActionPolicyScopeNotFoundError,
  deleteExternalActionPolicy,
  listExternalActionPolicies,
  upsertExternalActionPolicies,
} from "../services/external-action-policy";
import { getWorkspace } from "../services/workspaces";

const policyQuerySchema = z.object({
  scope: z.enum(EXTERNAL_ACTION_POLICY_SCOPES),
  scopeId: z.string().uuid(),
});

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

function policyError(error: unknown, reply: FastifyReply) {
  if (error instanceof ExternalActionPolicyConflictError) {
    return reply.status(409).send({ error: "policy_conflict", current: error.current });
  }
  if (error instanceof ExternalActionPolicyScopeNotFoundError) {
    return reply.status(404).send({ error: "not_found" });
  }
  if (error instanceof ExternalActionPolicyInputError) {
    return reply.status(400).send({ error: "invalid_input", message: error.message });
  }
  throw error;
}

export function registerExternalActionPolicyRoutes(app: FastifyInstance, db: Db): void {
  app.get<{
    Params: { id: string };
    Querystring: { scope?: string; scopeId?: string };
  }>("/workspaces/:id/external-action-policies", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = policyQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.issues);
    try {
      return listExternalActionPolicies(
        db,
        request.params.id,
        parsed.data.scope,
        parsed.data.scopeId,
      );
    } catch (error) {
      return policyError(error, reply);
    }
  });

  app.put<{ Params: { id: string } }>(
    "/workspaces/:id/external-action-policies",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = upsertExternalActionPoliciesInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      try {
        return upsertExternalActionPolicies(
          db,
          request.params.id,
          parsed.data,
          request.actor.userId,
        );
      } catch (error) {
        return policyError(error, reply);
      }
    },
  );

  app.delete<{ Params: { id: string; ruleId: string } }>(
    "/workspaces/:id/external-action-policies/:ruleId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsedRuleId = z.string().uuid().safeParse(request.params.ruleId);
      if (!parsedRuleId.success) return invalid(reply, parsedRuleId.error.issues);
      try {
        if (!deleteExternalActionPolicy(db, request.params.id, parsedRuleId.data)) {
          return reply.status(404).send({ error: "not_found" });
        }
        return reply.status(204).send();
      } catch (error) {
        return policyError(error, reply);
      }
    },
  );
}
