import type { FastifyInstance, FastifyReply } from "fastify";
import { sendTestMailInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import type { Mailer } from "../mail/mailer";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) void reply.status(404).send({ error: "workspace_not_found" });
  return workspace;
}

export function registerMailRoutes(app: FastifyInstance, db: Db, mailer: Mailer): void {
  // Prove the mailer seam end-to-end (Resend in prod; logs in dev).
  app.post<{ Params: { id: string } }>("/workspaces/:id/mail/test", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    const parsed = sendTestMailInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const result = await mailer.send({
      to: parsed.data.to,
      subject: `Tuezday test email — ${workspace.name}`,
      text: `This is a test transactional email from Tuezday for the "${workspace.name}" workspace. If you received it, the mailer is configured correctly.`,
    });
    return result;
  });
}
