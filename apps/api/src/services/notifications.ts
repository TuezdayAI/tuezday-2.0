import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { notificationChannels, type NotificationChannelRow } from "../db/schema";
import type { CreateNotificationChannelInput } from "@tuezday/contracts";
import { mintActionToken } from "../notifications/tokens";
import { sendApprovalMessage } from "../notifications/telegram";
import type { Mailer } from "../mail/mailer";

export async function listChannels(db: Db, workspaceId: string): Promise<NotificationChannelRow[]> {
  return await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.workspaceId, workspaceId));
}

export async function upsertChannel(
  db: Db,
  workspaceId: string,
  input: CreateNotificationChannelInput,
): Promise<NotificationChannelRow> {
  // Try to find if one with same type/target exists
  const existing = (await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.workspaceId, workspaceId),
        eq(notificationChannels.type, input.type),
        eq(notificationChannels.target, input.target),
      ),
    ))[0];

  if (existing) {
    await db.update(notificationChannels)
      .set({ enabled: input.enabled })
      .where(eq(notificationChannels.id, existing.id));
    return { ...existing, enabled: input.enabled };
  }

  const id = randomUUID();
  const now = Date.now();
  await db.insert(notificationChannels)
    .values({
      id,
      workspaceId,
      type: input.type,
      target: input.target,
      enabled: input.enabled,
      createdAt: now,
    });

  return {
    id,
    workspaceId,
    type: input.type,
    target: input.target,
    enabled: input.enabled,
    createdAt: now,
  };
}

export async function deleteChannel(db: Db, workspaceId: string, channelId: string): Promise<void> {
  await db.delete(notificationChannels)
    .where(
      and(
        eq(notificationChannels.workspaceId, workspaceId),
        eq(notificationChannels.id, channelId),
      ),
    );
}

export async function notifyDraftPending(
  db: Db,
  mailer: Mailer,
  fetcher: typeof fetch,
  draft: {
    id: string;
    workspaceId: string;
    taskType: string;
    channel: string;
    content: string;
  },
): Promise<void> {
  const channels = (await listChannels(db, draft.workspaceId)).filter((c) => c.enabled);
  if (channels.length === 0) return;

  const baseUrl = process.env.APP_BASE_URL || "http://localhost:3000";

  // Fan out
  await Promise.all(
    channels.map(async (c) => {
      try {
        const approveToken = await mintActionToken(db, draft.workspaceId, draft.id, "approve");
        const rejectToken = await mintActionToken(db, draft.workspaceId, draft.id, "reject");

        if (c.type === "telegram") {
          await sendApprovalMessage(fetcher, c.target, draft, approveToken, rejectToken);
        } else if (c.type === "email") {
          await mailer.send({
            to: c.target,
            subject: `Approval Required: ${draft.taskType} (${draft.channel})`,
            text: `A new draft is ready for review.\n\nTask: ${draft.taskType}\nChannel: ${draft.channel}\n\nContent:\n${draft.content}\n\nApprove: ${baseUrl}/a/${approveToken}\nReject: ${baseUrl}/a/${rejectToken}`,
          });
        }
      } catch (err) {
        // Best-effort: swallow errors (e.g. invalid Telegram bot token or chat ID)
      }
    })
  );
}

/**
 * Notify the founder of an outreach reply outcome (Sprint 49) — chiefly a hot
 * positive reply. Fans out to the same enabled channels as draft approvals;
 * no approve/reject tokens, just a summary + a deep link to the inbox item.
 * Best-effort (swallows channel errors). The in-app surface is the inbox
 * item itself with its label chip.
 */
export async function notifyReplyOutcome(
  db: Db,
  mailer: Mailer,
  fetcher: typeof fetch,
  input: {
    workspaceId: string;
    recipientEmail: string;
    label: string;
    snippet: string;
    inboxItemId: string;
  },
): Promise<void> {
  const channels = (await listChannels(db, input.workspaceId)).filter((c) => c.enabled);
  if (channels.length === 0) return;
  const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const link = `${baseUrl}/workspaces/${input.workspaceId}/review?tab=inbox`;
  const headline =
    input.label === "positive"
      ? `Positive reply from ${input.recipientEmail}`
      : `Outreach reply (${input.label}) from ${input.recipientEmail}`;

  // Founder decision: notify via in-app inbox + email. The inbox item is the
  // in-app surface; here we fan out to the email channels.
  void fetcher;
  await Promise.all(
    channels
      .filter((c) => c.type === "email")
      .map(async (c) => {
        try {
          await mailer.send({
            to: c.target,
            subject: headline,
            text: `${headline}\n\n${input.snippet ? `"${input.snippet.slice(0, 500)}"\n\n` : ""}Open the inbox: ${link}`,
          });
        } catch {
          // Best-effort per channel.
        }
      }),
  );
}
