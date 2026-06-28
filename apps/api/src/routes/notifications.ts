import { z } from "zod";
import type { TuezdayApp } from "../app";
import type { Db } from "../db";
import type { FastifyReply } from "fastify";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    reply.status(404).send({ error: "workspace_not_found" });
    return null;
  }
  return workspace;
}
import {
  createNotificationChannelInputSchema,
} from "@tuezday/contracts";
import {
  listChannels,
  upsertChannel,
  deleteChannel,
  notifyDraftPending,
} from "../services/notifications";
import type { Mailer } from "../mail/mailer";
import { verifyAndBurn } from "../notifications/tokens";
import { applyDraftAction, getDraft } from "../services/drafts";
import { answerCallback } from "../notifications/telegram";

export function registerNotificationRoutes(
  app: TuezdayApp,
  db: Db,
  mailer: Mailer,
  fetcher: typeof fetch,
): void {
  // Config UI routes (Session guarded via /workspaces context)
  app.get<{ Params: { id: string } }>("/workspaces/:id/notifications", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listChannels(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/notifications", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createNotificationChannelInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input" });
    }
    const channel = upsertChannel(db, request.params.id, parsed.data);
    return reply.status(201).send(channel);
  });

  app.put<{ Params: { id: string; channelId: string } }>(
    "/workspaces/:id/notifications/:channelId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_input" });
      }
      // Just load and re-upsert to change enabled status
      const existing = listChannels(db, request.params.id).find((c) => c.id === request.params.channelId);
      if (!existing) return reply.status(404).send({ error: "not_found" });

      const updated = upsertChannel(db, request.params.id, {
        type: existing.type as "telegram" | "email",
        target: existing.target,
        enabled: parsed.data.enabled,
      });
      return updated;
    },
  );

  app.delete<{ Params: { id: string; channelId: string } }>(
    "/workspaces/:id/notifications/:channelId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      deleteChannel(db, request.params.id, request.params.channelId);
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; channelId: string } }>(
    "/workspaces/:id/notifications/:channelId/test",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const existing = listChannels(db, request.params.id).find((c) => c.id === request.params.channelId);
      if (!existing) return reply.status(404).send({ error: "not_found" });

      const draft = {
        id: "test-draft-123",
        workspaceId: request.params.id,
        taskType: "linkedin_post",
        channel: "linkedin",
        content: "This is a test notification from Tuezday.",
      };

      await notifyDraftPending(db, mailer, fetcher, draft).catch(() => {});
      return reply.status(202).send({ ok: true });
    },
  );

  // Public Action Route: Email one-click approve/reject
  app.get<{ Params: { token: string } }>("/a/:token", async (request, reply) => {
    reply.type("text/html");

    const result = verifyAndBurn(db, request.params.token);
    if (!result.ok) {
      if (result.error === "used") {
        return `<h1>Already Handled</h1><p>This action has already been completed.</p>`;
      }
      return `<h1>Link Expired or Invalid</h1><p>Please check your Tuezday dashboard.</p>`;
    }

    const draft = getDraft(db, result.workspaceId, result.draftId);
    if (!draft) return `<h1>Draft Not Found</h1>`;

    try {
      applyDraftAction(
        db,
        draft,
        result.action,
        { userId: null, label: "Founder (via Mobile Notification)" },
        undefined,
      );
      return `<h1>Success!</h1><p>The draft has been ${result.action}d.</p>`;
    } catch (err: any) {
      if (err.name === "InvalidTransitionError") {
        return `<h1>Action Not Allowed</h1><p>${err.message}</p>`;
      }
      return `<h1>Error</h1><p>An unexpected error occurred.</p>`;
    }
  });

  // Telegram Webhook
  app.post("/telegram/webhook", async (request, reply) => {
    const body = request.body as any;

    if (body.callback_query) {
      const queryId = body.callback_query.id;
      const data = body.callback_query.data; // e.g. "approve:<token>"

      if (typeof data === "string") {
        const [action, token] = data.split(":");
        if ((action === "approve" || action === "reject") && token) {
          const result = verifyAndBurn(db, token);

          if (!result.ok) {
            await answerCallback(fetcher, queryId, `Action failed: ${result.error}`).catch(() => {});
            return reply.status(200).send();
          }

          const draft = getDraft(db, result.workspaceId, result.draftId);
          if (draft) {
            try {
              applyDraftAction(
                db,
                draft,
                action,
                { userId: null, label: "Founder (via Telegram)" },
                undefined,
              );
              await answerCallback(fetcher, queryId, `Draft ${action}d!`).catch(() => {});
            } catch (err: any) {
              await answerCallback(fetcher, queryId, `Action not allowed: ${err.message}`).catch(() => {});
            }
          } else {
            await answerCallback(fetcher, queryId, `Draft not found`).catch(() => {});
          }
        }
      }
    }

    return reply.status(200).send();
  });
}
