import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type {
  ExternalAction,
  ExternalActionBlocker,
  ExternalActionExecutionRef,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  campaigns,
  drafts,
  emailDeliveries,
  launchMessages,
  launches,
  leads,
  mediaContacts,
  personas,
  workspaceEmailSenders,
} from "../db/schema";
import type { OutboundEmailProvider } from "../outbound-email/provider";
import type {
  ExternalActionAdapter,
  ExternalActionCommand,
  ExternalActionIntent,
} from "./external-action-coordinator";
import { checkEmailRecipientSafety } from "./email-recipient-safety";

export const emailActionPayloadSchema = z.object({
  channel: z.literal("email"),
  origin: z.enum(["launch_message", "outbound_draft", "pr_draft"]),
  originId: z.string().uuid(),
  draftId: z.string().uuid(),
  to: z.string().email(),
  from: z.string(),
  senderAddress: z.string().email(),
  replyTo: z.string().email().nullable(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().nullable(),
});
export type EmailActionPayload = z.infer<typeof emailActionPayloadSchema>;

export function deriveEmailSendIdempotencyKey(
  originId: string,
  input: { draftId: string; content: string; stepNumber: number | null },
): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ originId, ...input }))
    .digest("hex");
  return `email/${originId}/${fingerprint}`;
}

function parseEmailContent(content: string): { subject: string; text: string } {
  const lines = content.split(/\r?\n/);
  const subjectIndex = lines.findIndex((line) => line.trim().length > 0);
  if (subjectIndex < 0) throw new Error("Email content is empty.");
  const subjectLine = lines[subjectIndex]!.trim();
  const subject = subjectLine.replace(/^Subject:\s*/i, "").trim() || subjectLine;
  const text = lines.slice(subjectIndex + 1).join("\n").trim() || subject;
  return { subject, text };
}

function emailIntent(
  db: Db,
  workspaceId: string,
  origin: EmailActionPayload["origin"],
  originId: string,
): ExternalActionIntent {
  let draftId: string;
  let recipient: string;
  let recipientName: string;
  let campaignId: string | null = null;
  let personaId: string | null = null;

  if (origin === "launch_message") {
    const message = db.select().from(launchMessages).where(and(
      eq(launchMessages.workspaceId, workspaceId),
      eq(launchMessages.id, originId),
    )).get();
    if (!message?.draftId || message.channel !== "email") throw new Error("Email launch message not found.");
    const launch = db.select().from(launches).where(eq(launches.id, message.launchId)).get();
    if (!launch) throw new Error("Launch not found.");
    draftId = message.draftId;
    recipient = message.recipientEmail;
    recipientName = message.recipientName || recipient;
    campaignId = launch.campaignId;
    personaId = launch.personaId;
  } else {
    draftId = originId;
    const draft = db.select().from(drafts).where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId))).get();
    if (!draft) throw new Error("Email draft not found.");
    if (origin === "outbound_draft") {
      const lead = draft.leadId ? db.select().from(leads).where(eq(leads.id, draft.leadId)).get() : undefined;
      if (!lead) throw new Error("The draft is not linked to a lead.");
      recipient = lead.email;
      recipientName = lead.name || lead.email;
    } else {
      const contact = draft.mediaContactId
        ? db.select().from(mediaContacts).where(eq(mediaContacts.id, draft.mediaContactId)).get()
        : undefined;
      if (!contact) throw new Error("The draft is not linked to a media contact.");
      recipient = contact.email;
      recipientName = contact.name || contact.email;
    }
    campaignId = draft.campaignId;
    personaId = draft.personaId;
  }

  const draft = db.select().from(drafts).where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId))).get();
  const expectedDraftChannel = origin === "pr_draft" ? "pr" : "email";
  if (!draft || draft.state !== "approved" || draft.channel !== expectedDraftChannel) {
    throw new Error("An approved email draft is required.");
  }
  const sender = db.select().from(workspaceEmailSenders).where(eq(workspaceEmailSenders.workspaceId, workspaceId)).get();
  const content = parseEmailContent(draft.content);
  const campaign = campaignId ? db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get() : undefined;
  const persona = personaId ? db.select().from(personas).where(eq(personas.id, personaId)).get() : undefined;
  const payload: EmailActionPayload = {
    channel: "email",
    origin,
    originId,
    draftId,
    to: recipient.toLowerCase(),
    from: sender ? `${sender.fromName} <${sender.fromAddress}>` : "Unconfigured sender <missing@example.invalid>",
    senderAddress: sender?.fromAddress ?? "missing@example.invalid",
    replyTo: sender?.replyTo ?? null,
    subject: content.subject,
    text: content.text,
    html: null,
  };
  return {
    subject: {
      kind: origin === "launch_message" ? "launch_message" : "draft",
      id: originId,
      title: content.subject,
      summary: content.text,
      channel: "email",
      destination: payload.to,
    },
    context: {
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? null,
      personaId: persona?.id ?? null,
      personaName: persona?.name ?? null,
      connectionId: null,
      connectionName: "Verified email sender",
      laneRevisionId: null,
      laneName: null,
    },
    payload,
    requestedFor: null,
    links: { draftId },
  };
}

export function prepareEmailAction(
  db: Db,
  workspaceId: string,
  input: { origin: EmailActionPayload["origin"]; originId: string; idempotencyKey: string },
): ExternalActionCommand {
  return {
    workspaceId,
    kind: "send",
    idempotencyKey: input.idempotencyKey,
    ...emailIntent(db, workspaceId, input.origin, input.originId),
  };
}

function blocker(db: Db, action: ExternalAction, payload: EmailActionPayload): ExternalActionBlocker | null {
  const sender = db.select().from(workspaceEmailSenders).where(eq(workspaceEmailSenders.workspaceId, action.workspaceId)).get();
  if (!sender || sender.status !== "verified") {
    return { code: "sender_unverified", message: "Verify the workspace email sender before sending.", retryable: true };
  }
  const safety = checkEmailRecipientSafety(db, action.workspaceId, payload.to);
  return safety.ok ? null : { code: safety.code, message: safety.message, retryable: safety.code !== "suppressed" };
}

function receipt(delivery: { id: string; status: string; lastError: string | null }): ExternalActionExecutionRef {
  return { kind: "email_delivery", id: delivery.id, status: delivery.status, url: null, error: delivery.lastError };
}

function markLaunchMessageAccepted(
  db: Db,
  workspaceId: string,
  payload: EmailActionPayload,
  actionId: string,
  sentAt: number,
): void {
  if (payload.origin !== "launch_message") return;
  const message = db.select({
    launchId: launchMessages.launchId,
    sequenceRecipientId: launchMessages.sequenceRecipientId,
  }).from(launchMessages).where(
    and(
      eq(launchMessages.workspaceId, workspaceId),
      eq(launchMessages.id, payload.originId),
    ),
  ).get();
  if (!message) return;
  db.update(launchMessages)
    .set({
      externalActionId: actionId,
      status: "sent",
      sentAt,
      lastError: null,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(launchMessages.workspaceId, workspaceId),
        eq(launchMessages.id, payload.originId),
      ),
    )
    .run();
  if (message.sequenceRecipientId) return;
  const pending = db.select({ id: launchMessages.id })
    .from(launchMessages)
    .where(
      and(
        eq(launchMessages.launchId, message.launchId),
        eq(launchMessages.status, "pending"),
      ),
    )
    .get();
  if (!pending) {
    db.update(launches)
      .set({ status: "completed", updatedAt: Date.now() })
      .where(eq(launches.id, message.launchId))
      .run();
  }
}

export function emailActionAdapter(
  db: Db,
  provider: OutboundEmailProvider | undefined,
): ExternalActionAdapter {
  return {
    async revalidate(action, rawPayload) {
      const payload = emailActionPayloadSchema.parse(rawPayload);
      return emailIntent(db, action.workspaceId, payload.origin, payload.originId);
    },
    async guard(action, rawPayload) {
      if (!provider) {
        return {
          code: "outbound_email_unavailable",
          message: "Native email is not configured on this deployment.",
          retryable: false,
        };
      }
      return blocker(db, action, emailActionPayloadSchema.parse(rawPayload));
    },
    async execute(action, rawPayload) {
      const payload = emailActionPayloadSchema.parse(rawPayload);
      if (!provider) throw new Error("Native email is not configured on this deployment.");
      let delivery = db.select().from(emailDeliveries).where(eq(emailDeliveries.externalActionId, action.id)).get();
      if (delivery?.providerMessageId) {
        if (delivery.status === "queued") {
          const now = Date.now();
          db.update(emailDeliveries).set({ status: "accepted", acceptedAt: delivery.acceptedAt ?? now, updatedAt: now }).where(eq(emailDeliveries.id, delivery.id)).run();
          delivery = db.select().from(emailDeliveries).where(eq(emailDeliveries.id, delivery.id)).get()!;
        }
        markLaunchMessageAccepted(
          db,
          action.workspaceId,
          payload,
          action.id,
          delivery.acceptedAt ?? Date.now(),
        );
        return receipt(delivery);
      }
      if (!delivery) {
        const now = Date.now();
        const id = randomUUID();
        db.insert(emailDeliveries).values({
          id,
          workspaceId: action.workspaceId,
          externalActionId: action.id,
          origin: payload.origin,
          originId: payload.originId,
          normalizedRecipient: payload.to,
          senderAddress: payload.senderAddress,
          replyTo: payload.replyTo,
          subject: payload.subject,
          text: payload.text,
          html: payload.html,
          idempotencyKey: `send/${action.id}`,
          provider: "resend",
          providerMessageId: null,
          status: "queued",
          acceptedAt: null,
          completedAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        }).run();
        delivery = db.select().from(emailDeliveries).where(eq(emailDeliveries.id, id)).get()!;
        if (payload.origin === "launch_message") {
          db.update(launchMessages).set({ externalActionId: action.id, updatedAt: now }).where(eq(launchMessages.id, payload.originId)).run();
        }
      }
      const accepted = await provider.send({
        from: payload.from,
        replyTo: payload.replyTo,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        idempotencyKey: `send/${action.id}`,
      });
      db.update(emailDeliveries).set({
        providerMessageId: accepted.messageId,
        status: "accepted",
        acceptedAt: accepted.acceptedAt,
        lastError: null,
        updatedAt: Date.now(),
      }).where(eq(emailDeliveries.id, delivery.id)).run();
      markLaunchMessageAccepted(
        db,
        action.workspaceId,
        payload,
        action.id,
        accepted.acceptedAt,
      );
      return receipt(db.select().from(emailDeliveries).where(eq(emailDeliveries.id, delivery.id)).get()!);
    },
  };
}

export function isEmailActionPayload(value: unknown): value is EmailActionPayload {
  return !!value && typeof value === "object" && (value as { channel?: unknown }).channel === "email";
}
