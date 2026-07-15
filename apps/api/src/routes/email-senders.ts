import type { FastifyInstance, FastifyReply } from "fastify";
import { updateEmailSenderInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  OutboundEmailProviderError,
  type OutboundEmailProvider,
} from "../outbound-email/provider";
import {
  EmailSenderLifecycleError,
  getEmailSender,
  refreshEmailSender,
  updateEmailSender,
  verifyEmailSender,
} from "../services/email-senders";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply): boolean {
  if (getWorkspace(db, id)) return true;
  void reply.status(404).send({ error: "workspace_not_found" });
  return false;
}

function providerOr503(
  provider: OutboundEmailProvider | undefined,
  reply: FastifyReply,
): provider is OutboundEmailProvider {
  if (provider) return true;
  void reply.status(503).send({
    error: "outbound_email_unavailable",
    message: "Native email is not configured on this deployment.",
    retryable: false,
  });
  return false;
}

function sendLifecycleError(error: unknown, reply: FastifyReply) {
  if (error instanceof OutboundEmailProviderError) {
    return reply.status(error.retryable ? 503 : 502).send({
      error: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error instanceof EmailSenderLifecycleError) {
    return reply.status(error.status).send({ error: error.code, message: error.message });
  }
  throw error;
}

export function registerEmailSenderRoutes(
  app: FastifyInstance,
  db: Db,
  provider: OutboundEmailProvider | undefined,
): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/email-sender", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return getEmailSender(db, request.params.id);
  });

  app.put<{ Params: { id: string } }>("/workspaces/:id/email-sender", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    if (!providerOr503(provider, reply)) return reply;
    const parsed = updateEmailSenderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
    }
    try {
      return await updateEmailSender(db, provider, request.params.id, parsed.data);
    } catch (error) {
      return sendLifecycleError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/email-sender/verify",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!providerOr503(provider, reply)) return reply;
      try {
        return await verifyEmailSender(db, provider, request.params.id);
      } catch (error) {
        return sendLifecycleError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/email-sender/refresh",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!providerOr503(provider, reply)) return reply;
      try {
        return await refreshEmailSender(db, provider, request.params.id);
      } catch (error) {
        return sendLifecycleError(error, reply);
      }
    },
  );
}
