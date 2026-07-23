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
  outreachEnrollments,
  outreachMessages,
  outreachSequences,
  personas,
  workspaceEmailSenders,
} from "../db/schema";
import type { OutboundEmailProvider } from "../outbound-email/provider";
import type { GmailMailboxProvider } from "../outbound-email/gmail";
import { createUnsubscribeToken } from "../outbound-email/unsubscribe";
import { createClickToken, createOpenToken } from "../outbound-email/tracking";
import { escapeHtml } from "../routes/email-recipient-safety";
import type {
  ExternalActionAdapter,
  ExternalActionCommand,
  ExternalActionIntent,
} from "./external-action-coordinator";
import { checkEmailRecipientSafety } from "./email-recipient-safety";
import { getConnection } from "./connections";
import { getPostalAddress } from "./compliance";
import { getMailbox, mailboxDailySendCount } from "./mailboxes";

export const emailActionPayloadSchema = z.object({
  channel: z.literal("email"),
  origin: z.enum(["launch_message", "outbound_draft", "pr_draft", "outreach_step"]),
  originId: z.string().uuid(),
  draftId: z.string().uuid(),
  to: z.string().email(),
  from: z.string(),
  senderAddress: z.string().email(),
  replyTo: z.string().email().nullable(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().nullable(),
  /** Present = send from this connected Gmail mailbox instead of Resend (Sprint 47). */
  mailboxId: z.string().uuid().optional(),
  /** Reply into an existing Gmail thread — outreach follow-ups (Sprint 48). */
  threadId: z.string().optional(),
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
  mailboxId?: string,
): ExternalActionIntent {
  let draftId: string;
  let recipient: string;
  let recipientName: string;
  let campaignId: string | null = null;
  let personaId: string | null = null;
  // Outreach follow-ups thread into the recipient's existing Gmail conversation.
  let threadId: string | undefined;

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
  } else if (origin === "outreach_step") {
    const message = db.select().from(outreachMessages).where(and(
      eq(outreachMessages.workspaceId, workspaceId),
      eq(outreachMessages.id, originId),
    )).get();
    if (!message?.draftId) throw new Error("Outreach step message not found.");
    const enrollment = db.select().from(outreachEnrollments).where(
      eq(outreachEnrollments.id, message.enrollmentId),
    ).get();
    if (!enrollment) throw new Error("Outreach enrollment not found.");
    const sequence = db.select().from(outreachSequences).where(
      eq(outreachSequences.id, enrollment.sequenceId),
    ).get();
    if (!sequence) throw new Error("Outreach sequence not found.");
    draftId = message.draftId;
    recipient = enrollment.recipientEmail;
    recipientName = enrollment.recipientEmail;
    campaignId = sequence.campaignId;
    personaId = sequence.personaId;
    threadId = enrollment.lastThreadId ?? undefined;
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
  const content = parseEmailContent(draft.content);
  const campaign = campaignId ? db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get() : undefined;
  const persona = personaId ? db.select().from(personas).where(eq(personas.id, personaId)).get() : undefined;

  // Sender identity: a connected Gmail mailbox (Sprint 47) or the workspace's
  // verified Resend sender — the two send paths coexist.
  let from: string;
  let senderAddress: string;
  let replyTo: string | null;
  let connectionId: string | null = null;
  let connectionName: string;
  if (mailboxId) {
    const mailbox = getMailbox(db, workspaceId, mailboxId);
    if (!mailbox) throw new Error("Mailbox not found.");
    from = mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address;
    senderAddress = mailbox.address;
    replyTo = mailbox.replyTo;
    connectionId = mailbox.connectionId;
    connectionName = `Gmail mailbox ${mailbox.address}`;
  } else {
    const sender = db.select().from(workspaceEmailSenders).where(eq(workspaceEmailSenders.workspaceId, workspaceId)).get();
    from = sender ? `${sender.fromName} <${sender.fromAddress}>` : "Unconfigured sender <missing@example.invalid>";
    senderAddress = sender?.fromAddress ?? "missing@example.invalid";
    replyTo = sender?.replyTo ?? null;
    connectionName = "Verified email sender";
  }

  const payload: EmailActionPayload = {
    channel: "email",
    origin,
    originId,
    draftId,
    to: recipient.toLowerCase(),
    from,
    senderAddress,
    replyTo,
    subject: content.subject,
    text: content.text,
    html: null,
    ...(mailboxId ? { mailboxId } : {}),
    ...(threadId ? { threadId } : {}),
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
      connectionId,
      connectionName,
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
  input: {
    origin: EmailActionPayload["origin"];
    originId: string;
    idempotencyKey: string;
    mailboxId?: string;
  },
): ExternalActionCommand {
  return {
    workspaceId,
    kind: "send",
    idempotencyKey: input.idempotencyKey,
    ...emailIntent(db, workspaceId, input.origin, input.originId, input.mailboxId),
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

/** Gmail-path guard: recipient safety (unchanged) + mailbox health + per-mailbox cap. */
function gmailBlocker(
  db: Db,
  action: ExternalAction,
  payload: EmailActionPayload,
): ExternalActionBlocker | null {
  const mailbox = getMailbox(db, action.workspaceId, payload.mailboxId!);
  if (!mailbox || mailbox.status !== "connected") {
    return {
      code: "mailbox_unavailable",
      message: "Reconnect the Gmail mailbox before sending from it.",
      retryable: true,
    };
  }
  const safety = checkEmailRecipientSafety(db, action.workspaceId, payload.to);
  if (!safety.ok) {
    return { code: safety.code, message: safety.message, retryable: safety.code !== "suppressed" };
  }
  const sentToday = mailboxDailySendCount(db, action.workspaceId, mailbox.id);
  if (sentToday >= mailbox.dailyCap) {
    return {
      code: "mailbox_cap_reached",
      message: `The ${mailbox.address} mailbox reached its daily cap of ${mailbox.dailyCap}.`,
      retryable: true,
    };
  }
  if (!process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim()) {
    return {
      code: "unsubscribe_unconfigured",
      message: "Set EMAIL_UNSUBSCRIBE_SECRET — every mailbox send carries an unsubscribe link.",
      retryable: true,
    };
  }
  return null;
}

/** Where tracking pixels/redirects are served — a dedicated subdomain if set. */
function trackingBaseUrl(): string {
  return (
    process.env.TRACKING_BASE_URL ||
    process.env.APP_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

/** Escape a block of plain text to HTML, turning newlines into <br>. */
function textBlockToHtml(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br>\n");
}

interface TrackingConfig {
  deliveryId: string;
  trackOpens: boolean;
  trackClicks: boolean;
}

/**
 * The HTML alternative for a tracked send (Sprint 50). Mirrors the plain-text
 * body but escaped, with http(s) links optionally rewritten through the signed
 * click-redirect and an optional 1×1 open pixel appended. The click URL is
 * carried inside the signed token, never as a query param (no open-redirect).
 */
function composeTrackedHtml(
  workspaceId: string,
  bodyText: string,
  signature: string,
  unsubscribeUrl: string,
  postalAddress: string,
  tracking: TrackingConfig,
): string {
  const trackingBase = trackingBaseUrl();

  // Escape a block, and rewrite each http(s) link through /t/c when tracking.
  const renderBlock = (value: string): string => {
    const urlRe = /https?:\/\/[^\s<>"]+/g;
    let out = "";
    let last = 0;
    for (const match of value.matchAll(urlRe)) {
      const url = match[0];
      const start = match.index ?? 0;
      out += textBlockToHtml(value.slice(last, start));
      if (tracking.trackClicks) {
        const token = createClickToken(workspaceId, tracking.deliveryId, url);
        const href = `${trackingBase}/t/c/${token}`;
        out += `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
      } else {
        out += escapeHtml(url);
      }
      last = start + url.length;
    }
    out += textBlockToHtml(value.slice(last));
    return out;
  };

  const parts = [renderBlock(bodyText)];
  if (signature.trim()) parts.push(renderBlock(signature.trim()));
  const footer = [
    "--",
    `Don't want these emails? Unsubscribe: <a href="${escapeHtml(unsubscribeUrl)}">${escapeHtml(unsubscribeUrl)}</a>`,
  ];
  if (postalAddress.trim()) footer.push(textBlockToHtml(postalAddress.trim()));
  parts.push(footer.join("<br>\n"));

  let body = parts.join("<br><br>\n");
  if (tracking.trackOpens) {
    const openToken = createOpenToken(workspaceId, tracking.deliveryId);
    body += `<img src="${escapeHtml(`${trackingBase}/t/o/${openToken}`)}" width="1" height="1" alt="">`;
  }
  return `<!doctype html><html><body>${body}</body></html>`;
}

/**
 * The body a Gmail send actually carries: the approved draft text, the
 * mailbox signature, the unsubscribe footer (founder decision: from send #1),
 * and the workspace's CAN-SPAM postal address (Sprint 49). The delivery row
 * keeps the exact action-authorized text; the footer is deterministic, so
 * retries recompose the identical body. `postalAddress` is resolved by the
 * caller (from workspace_compliance) — keep this function pure.
 *
 * Returns `{ text, html }`: `text` is the plain-text body (unchanged, always
 * the authorized/stored body). `html` is non-null only when the sequence tracks
 * (Sprint 50) — an untracked send stays byte-identical plain text (`html` null).
 */
export function composeGmailBody(
  workspaceId: string,
  payload: Pick<EmailActionPayload, "to" | "text">,
  signature: string,
  postalAddress = "",
  tracking?: TrackingConfig,
): { text: string; html: string | null } {
  const token = createUnsubscribeToken(workspaceId, payload.to);
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const unsubscribeUrl = `${base}/u/${token}`;
  const parts = [payload.text];
  if (signature.trim()) parts.push(signature.trim());
  const footer = [`--`, `Don't want these emails? Unsubscribe: ${unsubscribeUrl}`];
  if (postalAddress.trim()) footer.push(postalAddress.trim());
  parts.push(footer.join("\n"));
  const text = parts.join("\n\n");

  const trackingOn = !!tracking && (tracking.trackOpens || tracking.trackClicks);
  const html = trackingOn
    ? composeTrackedHtml(workspaceId, payload.text, signature, unsubscribeUrl, postalAddress, tracking!)
    : null;
  return { text, html };
}

/**
 * Resolve a sequence's open/click tracking flags for a send (Sprint 50).
 * Tracking is a per-sequence opt-in, so only outreach-step sends can be tracked;
 * every other origin returns `undefined` → plain-text, byte-identical to today.
 */
function resolveTrackingConfig(
  db: Db,
  workspaceId: string,
  payload: EmailActionPayload,
  deliveryId: string,
): TrackingConfig | undefined {
  if (payload.origin !== "outreach_step") return undefined;
  const message = db
    .select({ enrollmentId: outreachMessages.enrollmentId })
    .from(outreachMessages)
    .where(and(eq(outreachMessages.workspaceId, workspaceId), eq(outreachMessages.id, payload.originId)))
    .get();
  if (!message) return undefined;
  const enrollment = db
    .select({ sequenceId: outreachEnrollments.sequenceId })
    .from(outreachEnrollments)
    .where(eq(outreachEnrollments.id, message.enrollmentId))
    .get();
  if (!enrollment) return undefined;
  const sequence = db
    .select({ trackOpens: outreachSequences.trackOpens, trackClicks: outreachSequences.trackClicks })
    .from(outreachSequences)
    .where(eq(outreachSequences.id, enrollment.sequenceId))
    .get();
  if (!sequence) return undefined;
  return {
    deliveryId,
    trackOpens: sequence.trackOpens === 1,
    trackClicks: sequence.trackClicks === 1,
  };
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

/**
 * Flip an outreach step message to `sent` on execute (Sprint 48), copying the
 * delivery's Gmail thread id onto the message so the engine can thread the next
 * step. The engine reads this to advance the enrollment. Mirrors
 * `markLaunchMessageAccepted`; no-ops for other origins.
 */
function markOutreachStepAccepted(
  db: Db,
  workspaceId: string,
  payload: EmailActionPayload,
  actionId: string,
  sentAt: number,
): void {
  if (payload.origin !== "outreach_step") return;
  const delivery = db
    .select({ providerThreadId: emailDeliveries.providerThreadId })
    .from(emailDeliveries)
    .where(eq(emailDeliveries.externalActionId, actionId))
    .get();
  db.update(outreachMessages)
    .set({
      externalActionId: actionId,
      status: "sent",
      sentAt,
      providerThreadId: delivery?.providerThreadId ?? null,
      lastError: null,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(outreachMessages.workspaceId, workspaceId),
        eq(outreachMessages.id, payload.originId),
      ),
    )
    .run();
}

export function emailActionAdapter(
  db: Db,
  provider: OutboundEmailProvider | undefined,
  gmail?: GmailMailboxProvider,
): ExternalActionAdapter {
  return {
    async revalidate(action, rawPayload) {
      const payload = emailActionPayloadSchema.parse(rawPayload);
      return emailIntent(db, action.workspaceId, payload.origin, payload.originId, payload.mailboxId);
    },
    async guard(action, rawPayload) {
      const payload = emailActionPayloadSchema.parse(rawPayload);
      if (payload.mailboxId) {
        if (!gmail) {
          return {
            code: "gmail_unavailable",
            message: "Gmail sending is not configured on this deployment.",
            retryable: false,
          };
        }
        return gmailBlocker(db, action, payload);
      }
      if (!provider) {
        return {
          code: "outbound_email_unavailable",
          message: "Native email is not configured on this deployment.",
          retryable: false,
        };
      }
      return blocker(db, action, payload);
    },
    async execute(action, rawPayload) {
      const payload = emailActionPayloadSchema.parse(rawPayload);
      if (payload.mailboxId) {
        if (!gmail) throw new Error("Gmail sending is not configured on this deployment.");
      } else if (!provider) {
        throw new Error("Native email is not configured on this deployment.");
      }
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
        markOutreachStepAccepted(
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
          provider: payload.mailboxId ? "gmail" : "resend",
          providerMessageId: null,
          providerThreadId: null,
          mailboxId: payload.mailboxId ?? null,
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
      if (payload.mailboxId) {
        // Gmail path (Sprint 47): send from the connected mailbox with the
        // signature + unsubscribe footer, keep the thread id for reply matching.
        const mailbox = getMailbox(db, action.workspaceId, payload.mailboxId);
        if (!mailbox) throw new Error("Mailbox not found.");
        const connection = getConnection(db, action.workspaceId, mailbox.connectionId);
        if (!connection) throw new Error("The mailbox's Gmail connection no longer exists.");
        // Open/click tracking (Sprint 50) is a per-sequence opt-in, so it only
        // applies to outreach steps: message → enrollment → sequence flags.
        const tracking = resolveTrackingConfig(db, action.workspaceId, payload, delivery.id);
        const body = composeGmailBody(
          action.workspaceId,
          payload,
          mailbox.signature,
          getPostalAddress(db, action.workspaceId),
          tracking,
        );
        const sent = await gmail!.sendEmail(connection.nangoConnectionId, {
          from: mailbox.address,
          fromName: mailbox.displayName,
          to: payload.to,
          subject: payload.subject,
          text: body.text,
          ...(body.html ? { html: body.html } : {}),
          replyTo: mailbox.replyTo,
          // Outreach follow-ups thread into the recipient's conversation (S48).
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
        });
        const acceptedAt = Date.now();
        db.update(emailDeliveries).set({
          providerMessageId: sent.messageId,
          providerThreadId: sent.threadId,
          status: "accepted",
          acceptedAt,
          lastError: null,
          updatedAt: acceptedAt,
        }).where(eq(emailDeliveries.id, delivery.id)).run();
        markLaunchMessageAccepted(db, action.workspaceId, payload, action.id, acceptedAt);
        markOutreachStepAccepted(db, action.workspaceId, payload, action.id, acceptedAt);
        return receipt(db.select().from(emailDeliveries).where(eq(emailDeliveries.id, delivery.id)).get()!);
      }
      const accepted = await provider!.send({
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
