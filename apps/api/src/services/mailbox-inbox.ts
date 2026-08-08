import { and, eq, isNotNull } from "drizzle-orm";
import {
  EMAIL_REPLY_LABELS,
  emailReplyClassificationResponseSchema,
  type MailboxInboxRunResult,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { emailDeliveries, inboxItems, mailboxes } from "../db/schema";
import type { GmailMailboxProvider } from "../outbound-email/gmail";
import type { LlmGateway } from "../llm/gateway";
import { meteredLlm } from "../llm/metered";
import { generateStructured } from "../llm/structured";
import { llmBudgetExhausted } from "./entitlements";
import { getConnection } from "./connections";
import { inboxItemExists, insertInboxItem } from "./inbox";
import { listConnectedMailboxes } from "./mailboxes";

/** Re-scan window behind the cursor so a poll that raced a delivery misses nothing. */
const POLL_OVERLAP_MS = 24 * 60 * 60 * 1000;
const POLL_MAX_RESULTS = 100;
const CLASSIFY_BATCH_SIZE = 10;

interface NewEmailItem {
  id: string;
  fromAddress: string;
  subject: string;
  content: string;
}

/**
 * The threads this workspace's mailboxes started — the privacy invariant's
 * allowlist. Only inbound messages on these thread ids are ever ingested;
 * unrelated mail in the connected Gmail account is never read into Tuezday.
 */
async function sentThreadDeliveries(db: Db, workspaceId: string): Promise<Map<string, { id: string; providerMessageId: string | null }>> {
  const rows = await db
    .select({
      id: emailDeliveries.id,
      providerThreadId: emailDeliveries.providerThreadId,
      providerMessageId: emailDeliveries.providerMessageId,
    })
    .from(emailDeliveries)
    .where(
      and(
        eq(emailDeliveries.workspaceId, workspaceId),
        eq(emailDeliveries.provider, "gmail"),
        isNotNull(emailDeliveries.providerThreadId),
      ),
    );
  const byThread = new Map<string, { id: string; providerMessageId: string | null }>();
  for (const row of rows) {
    if (row.providerThreadId) {
      byThread.set(row.providerThreadId, { id: row.id, providerMessageId: row.providerMessageId });
    }
  }
  return byThread;
}

function classificationPrompt(items: NewEmailItem[]): string {
  const itemsBlock = items
    .map(
      (item, i) =>
        `ITEM ${i}\nFrom: ${item.fromAddress}\nSubject: ${item.subject || "(none)"}\nBody:\n${item.content.slice(0, 1500) || "(empty)"}`,
    )
    .join("\n\n");
  return [
    "You label inbound email replies to B2B outreach emails.",
    `Labels: ${EMAIL_REPLY_LABELS.join(" | ")}.`,
    "- positive: interested, asks questions, wants a call/demo, warm response.",
    "- not_interested: declines, says no, asks to stop contact politely.",
    "- out_of_office: an automatic out-of-office / vacation autoresponder.",
    "- unsubscribe_request: explicitly asks to unsubscribe / be removed from the list.",
    "- bounce: a delivery failure / mailer-daemon non-delivery report.",
    "- other: anything that fits none of the above.",
    "",
    itemsBlock,
    "",
    `Reply with ONLY a JSON array, one entry per item: [{"index": 0, "label": "positive"}]`,
  ].join("\n");
}

/**
 * Best-effort LLM classification (discovery-scoring shape): one structured
 * call per batch; on any failure — gateway down or post-repair malformed
 * output — the batch stays unlabeled and the run continues. Classification
 * assists, it never gates or aborts the poll.
 */
async function classifyNewItems(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  items: NewEmailItem[],
  nowMs: number,
): Promise<number> {
  // Budget degradation (Sprint 59): items stay unlabeled and the next poll
  // retries them once budget frees — labeling assists, it never fails the run.
  if (await llmBudgetExhausted(db, workspaceId)) return 0;
  const metered = meteredLlm(llm, db, { workspaceId, pipeline: "mailbox_classification" });
  let labeled = 0;
  for (let offset = 0; offset < items.length; offset += CLASSIFY_BATCH_SIZE) {
    const batch = items.slice(offset, offset + CLASSIFY_BATCH_SIZE);
    try {
      const result = await generateStructured(metered, emailReplyClassificationResponseSchema, {
        prompt: classificationPrompt(batch),
        tier: "cheap",
      });
      for (const entry of result.value) {
        const item = batch[entry.index];
        if (!item) continue;
        await db.update(inboxItems)
          .set({
            replyLabel: entry.label,
            replyLabeledAt: nowMs,
            updatedAt: nowMs,
          })
          .where(eq(inboxItems.id, item.id));
        labeled += 1;
      }
    } catch {
      // Gateway or structured-output failure: batch stays unlabeled, run continues.
    }
  }
  return labeled;
}

/**
 * One mailbox-inbox cycle (Sprint 47): per connected mailbox, list recent
 * inbound Gmail messages, keep only replies to threads this workspace sent
 * (the privacy invariant), skip the mailbox's own messages, insert deduped
 * `kind:"email"` inbox items threaded to the exact sent delivery, then
 * classify the new items best-effort. The worker + "Run now" entry point.
 */
export async function runMailboxInbox(
  db: Db,
  llm: LlmGateway,
  gmail: GmailMailboxProvider,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<MailboxInboxRunResult> {
  let mailboxesPolled = 0;
  let messagesSeen = 0;
  let newItems = 0;
  const created: NewEmailItem[] = [];

  const byThread = await sentThreadDeliveries(db, workspaceId);
  for (const mailbox of await listConnectedMailboxes(db, workspaceId)) {
    const connection = await getConnection(db, workspaceId, mailbox.connectionId);
    if (!connection || connection.status !== "connected") continue;
    mailboxesPolled += 1;
    try {
      const sinceMs = Math.max((mailbox.lastPolledAt ?? 0) - POLL_OVERLAP_MS, 0);
      const metas = await gmail.listInboundSince(
        connection.nangoConnectionId,
        sinceMs,
        POLL_MAX_RESULTS,
      );
      for (const meta of metas) {
        messagesSeen += 1;
        const delivery = byThread.get(meta.threadId);
        // PRIVACY INVARIANT: mail outside Tuezday-sent threads is never read in.
        if (!delivery) continue;
        if (await inboxItemExists(db, mailbox.connectionId, meta.id)) continue;
        const message = await gmail.getMessage(connection.nangoConnectionId, meta.id);
        // Our own messages in the thread (the outreach itself, manual replies)
        // are not inbound items.
        if (message.fromAddress.toLowerCase() === mailbox.address.toLowerCase()) continue;
        const inserted = await insertInboxItem(db, {
          workspaceId,
          connectionId: mailbox.connectionId,
          providerKey: "gmail",
          kind: "email",
          channel: "email",
          externalId: message.id,
          parentExternalId: delivery.providerMessageId,
          publicationId: null,
          launchMessageId: null,
          emailDeliveryId: delivery.id,
          authorHandle: message.fromAddress,
          authorName: message.fromName || message.fromAddress,
          content: message.bodyText,
          url: null,
          externalCreatedAt: message.internalDateMs || nowMs,
        });
        if (inserted) {
          newItems += 1;
          const row = (await db
            .select({ id: inboxItems.id })
            .from(inboxItems)
            .where(
              and(
                eq(inboxItems.connectionId, mailbox.connectionId),
                eq(inboxItems.externalId, message.id),
              ),
            ))[0];
          if (row) {
            created.push({
              id: row.id,
              fromAddress: message.fromAddress,
              subject: message.subject,
              content: message.bodyText,
            });
          }
        }
      }
      await db.update(mailboxes)
        .set({ lastPolledAt: nowMs, lastError: null, updatedAt: nowMs })
        .where(eq(mailboxes.id, mailbox.id));
    } catch (err) {
      // A failing mailbox never aborts the run; the cursor stays put so the
      // next poll retries the same window.
      await db.update(mailboxes)
        .set({
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          updatedAt: nowMs,
        })
        .where(eq(mailboxes.id, mailbox.id));
    }
  }

  const labeled = await classifyNewItems(db, llm, workspaceId, created, nowMs);
  return { mailboxesPolled, messagesSeen, newItems, labeled, ranAt: nowMs };
}
