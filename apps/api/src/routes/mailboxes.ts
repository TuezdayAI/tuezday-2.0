import type { FastifyInstance, FastifyReply } from "fastify";
import { createMailboxInputSchema, updateMailboxInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import type { LlmGateway } from "../llm/gateway";
import type { GmailMailboxProvider } from "../outbound-email/gmail";
import {
  MailboxError,
  createMailbox,
  deleteMailbox,
  listMailboxes,
  updateMailbox,
} from "../services/mailboxes";
import { runMailboxInbox } from "../services/mailbox-inbox";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply): boolean {
  if (getWorkspace(db, id)) return true;
  void reply.status(404).send({ error: "workspace_not_found" });
  return false;
}

function sendMailboxError(error: unknown, reply: FastifyReply) {
  if (error instanceof MailboxError) {
    return reply.status(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export function registerMailboxRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  gmail: GmailMailboxProvider,
): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/mailboxes", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listMailboxes(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/mailboxes", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createMailboxInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input", issues: parsed.error.issues });
    }
    try {
      const mailbox = await createMailbox(db, gmail, request.params.id, parsed.data);
      return reply.status(201).send(mailbox);
    } catch (error) {
      return sendMailboxError(error, reply);
    }
  });

  app.patch<{ Params: { id: string; mailboxId: string } }>(
    "/workspaces/:id/mailboxes/:mailboxId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateMailboxInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_input", issues: parsed.error.issues });
      }
      const mailbox = updateMailbox(db, request.params.id, request.params.mailboxId, parsed.data);
      if (!mailbox) return reply.status(404).send({ error: "mailbox_not_found" });
      return mailbox;
    },
  );

  app.delete<{ Params: { id: string; mailboxId: string } }>(
    "/workspaces/:id/mailboxes/:mailboxId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!deleteMailbox(db, request.params.id, request.params.mailboxId)) {
        return reply.status(404).send({ error: "mailbox_not_found" });
      }
      return reply.status(204).send();
    },
  );

  // Worker + "Run now" entry: poll the workspace's mailboxes for inbound replies.
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/mailbox-inbox/run",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return runMailboxInbox(db, llm, gmail, request.params.id);
    },
  );
}
