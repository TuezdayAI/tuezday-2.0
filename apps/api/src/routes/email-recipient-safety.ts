import type { FastifyInstance, FastifyReply } from "fastify";
import {
  importSuppressionsInputSchema,
  normalizedEmailAddressSchema,
  updateEmailPermissionInputSchema,
  updateEmailSafetyInputSchema,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { verifyUnsubscribeToken } from "../outbound-email/unsubscribe";
import {
  EmailSafetyConfigurationError,
  getEmailPermission,
  getEmailSafetySettings,
  importSuppressions,
  listSuppressions,
  unsubscribeEmailRecipient,
  updateEmailPermission,
  updateEmailSafetySettings,
} from "../services/email-recipient-safety";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply): boolean {
  if (getWorkspace(db, id)) return true;
  void reply.status(404).send({ error: "workspace_not_found" });
  return false;
}

function normalizedEmailOr400(value: string, reply: FastifyReply): string | null {
  const parsed = normalizedEmailAddressSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  void reply.status(400).send({ error: "invalid_email", message: parsed.error.issues[0]?.message });
  return null;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function unsubscribePage(email: string, complete: boolean): string {
  const safeEmail = escapeHtml(email);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribe</title></head><body><main><h1>${complete ? "Unsubscribed" : "Stop emails"}</h1><p>${safeEmail}</p>${complete ? "<p>You will not receive more governed email from this workspace.</p>" : '<form method="post"><button type="submit">Unsubscribe</button></form>'}</main></body></html>`;
}

export function registerEmailRecipientSafetyRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string; normalizedEmail: string } }>(
    "/workspaces/:id/email-permissions/:normalizedEmail",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const email = normalizedEmailOr400(request.params.normalizedEmail, reply);
      if (!email) return reply;
      return (
        getEmailPermission(db, request.params.id, email) ?? {
          workspaceId: request.params.id,
          normalizedEmail: email,
          status: "unknown",
          createdAt: 0,
          updatedAt: 0,
        }
      );
    },
  );

  app.put<{ Params: { id: string; normalizedEmail: string } }>(
    "/workspaces/:id/email-permissions/:normalizedEmail",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const email = normalizedEmailOr400(request.params.normalizedEmail, reply);
      if (!email) return reply;
      const parsed = updateEmailPermissionInputSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_input" });
      return updateEmailPermission(db, request.params.id, email, parsed.data);
    },
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id/email-safety", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return getEmailSafetySettings(db, request.params.id);
  });

  app.put<{ Params: { id: string } }>("/workspaces/:id/email-safety", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = updateEmailSafetyInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_input" });
    try {
      return updateEmailSafetySettings(db, request.params.id, parsed.data);
    } catch (error) {
      if (error instanceof EmailSafetyConfigurationError) {
        return reply.status(409).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  // Suppression list (Sprint 49): paste a batch of emails to block up front.
  app.get<{ Params: { id: string } }>("/workspaces/:id/suppressions", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listSuppressions(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/suppressions/import", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = importSuppressionsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input", issues: parsed.error.issues });
    }
    return importSuppressions(db, request.params.id, parsed.data.emails);
  });

  app.get<{ Params: { token: string } }>("/u/:token", async (request, reply) => {
    const verified = verifyUnsubscribeToken(request.params.token);
    if (!verified.ok) return reply.status(400).send({ error: verified.error });
    return reply.type("text/html; charset=utf-8").send(unsubscribePage(verified.value.normalizedEmail, false));
  });

  app.post<{ Params: { token: string } }>("/u/:token", async (request, reply) => {
    const verified = verifyUnsubscribeToken(request.params.token);
    if (!verified.ok) return reply.status(400).send({ error: verified.error });
    if (!getWorkspace(db, verified.value.workspaceId)) {
      return reply.status(400).send({ error: "invalid_token" });
    }
    unsubscribeEmailRecipient(db, verified.value.workspaceId, verified.value.normalizedEmail);
    return reply.type("text/html; charset=utf-8").send(unsubscribePage(verified.value.normalizedEmail, true));
  });
}
