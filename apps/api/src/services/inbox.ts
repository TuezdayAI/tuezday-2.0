import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import {
  METRIC_WINDOWS,
  type Channel,
  type Draft,
  type InboxItem,
  type InboxItemKind,
  type InboxItemStatus,
  type InboxItemWithContext,
  type InboxRunResult,
  type MetricWindow,
  type PublicationMetric,
  type SocialAutomationSettings,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  drafts,
  inboxItems,
  launchMessages,
  publicationMetrics,
  publications,
  type InboxItemRow,
  type PublicationMetricRow,
} from "../db/schema";
import type { ConnectorFabric } from "../connectors/fabric";
import { socialAdapterFor } from "../connectors/social";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import {
  countConnectionPublicationsForDay,
  getSocialAutomationSettings,
  utcDayBounds,
} from "./automation";
import { getCampaign } from "./campaigns";
import { getConnection, listConnections, providerByKey } from "./connections";
import { applyDraftAction, getDraft, type DraftActor } from "./drafts";
import { generateEngagementReply } from "./engagement-reply";
import { emitEvent } from "./events";
import {
  deriveReplyIdempotencyKey,
  prepareReplyAction,
} from "./external-action-adapters";
import type { ExternalActionRuntime } from "./external-action-coordinator";
import { getPersona } from "./personas";
import { getWorkspace } from "./workspaces";

type Fetcher = typeof fetch;

/** Auto-replies are attributed to the system identity, like S28 auto-posts. */
const SYSTEM_ACTOR: DraftActor = { userId: null, label: "system" };

const WINDOW_MS: Record<MetricWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function rowToInboxItem(row: InboxItemRow): InboxItem {
  return {
    ...row,
    kind: row.kind as InboxItemKind,
    channel: row.channel as Channel,
    status: row.status as InboxItemStatus,
  };
}

function rowToMetric(row: PublicationMetricRow): PublicationMetric {
  return { ...row, window: row.window as MetricWindow };
}

// ---------------------------------------------------------------------------
// Internal queries
// ---------------------------------------------------------------------------

interface WorkspaceRef {
  id: string;
  name: string;
}

/** Connected connections whose provider is a social platform. */
function socialConnections(db: Db, workspaceId: string) {
  return listConnections(db, workspaceId).filter((c) => {
    const provider = providerByKey(c.providerKey);
    return c.status === "connected" && !!provider?.categories?.includes("social");
  });
}

/** Published receipts on a connection that carry a platform post id. */
function publishedPublications(db: Db, workspaceId: string, connectionId: string) {
  return db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.workspaceId, workspaceId),
        eq(publications.connectionId, connectionId),
        eq(publications.status, "published"),
        isNotNull(publications.externalId),
      ),
    )
    .all();
}

/** Ids of replies we've already posted — so the poller never re-ingests our own. */
function knownPostedReplyIds(db: Db, workspaceId: string): Set<string> {
  const rows = db
    .select({ id: inboxItems.postedReplyExternalId })
    .from(inboxItems)
    .where(and(eq(inboxItems.workspaceId, workspaceId), isNotNull(inboxItems.postedReplyExternalId)))
    .all();
  return new Set(rows.map((r) => r.id).filter((id): id is string => !!id));
}

function inboxItemExists(db: Db, connectionId: string, externalId: string): boolean {
  return (
    db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(and(eq(inboxItems.connectionId, connectionId), eq(inboxItems.externalId, externalId)))
      .get() !== undefined
  );
}

interface NewInboxItem {
  workspaceId: string;
  connectionId: string;
  providerKey: string;
  kind: InboxItemKind;
  channel: Channel;
  externalId: string;
  parentExternalId: string | null;
  publicationId: string | null;
  launchMessageId: string | null;
  authorHandle: string;
  authorName: string;
  content: string;
  url: string | null;
  externalCreatedAt: number;
}

/** Insert an inbound item if we haven't seen it before. Returns true when new. */
function insertInboxItem(db: Db, fields: NewInboxItem): boolean {
  if (inboxItemExists(db, fields.connectionId, fields.externalId)) return false;
  const now = Date.now();
  db.insert(inboxItems)
    .values({
      id: randomUUID(),
      ...fields,
      status: "unread",
      replyDraftId: null,
      postedReplyExternalId: null,
      postedReplyUrl: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return true;
}

/** Distinct X recipient handles we've DMed (so we can poll their replies). */
function outboundDmHandles(db: Db, workspaceId: string): string[] {
  const rows = db
    .select({ handle: launchMessages.recipientHandle })
    .from(launchMessages)
    .where(
      and(
        eq(launchMessages.workspaceId, workspaceId),
        eq(launchMessages.channel, "x"),
        isNotNull(launchMessages.recipientHandle),
      ),
    )
    .all();
  const handles = new Set<string>();
  for (const r of rows) {
    const h = r.handle?.trim();
    if (h) handles.add(h);
  }
  return [...handles];
}

function latestLaunchMessageIdForHandle(
  db: Db,
  workspaceId: string,
  handle: string,
): string | null {
  const row = db
    .select({ id: launchMessages.id })
    .from(launchMessages)
    .where(
      and(
        eq(launchMessages.workspaceId, workspaceId),
        eq(launchMessages.channel, "x"),
        eq(launchMessages.recipientHandle, handle),
      ),
    )
    .orderBy(desc(launchMessages.createdAt))
    .get();
  return row?.id ?? null;
}

/** Newest inbound DM we've recorded from a handle on this connection. */
function newestDmCreatedAt(db: Db, connectionId: string, handle: string): number {
  const row = db
    .select({ createdAt: inboxItems.externalCreatedAt })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.connectionId, connectionId),
        eq(inboxItems.kind, "dm"),
        eq(inboxItems.authorHandle, handle),
      ),
    )
    .orderBy(desc(inboxItems.externalCreatedAt))
    .get();
  return row?.createdAt ?? 0;
}

/** The original draft behind an inbox item (the post/DM it replies to). */
function draftBehindItem(db: Db, item: InboxItem) {
  if (item.publicationId) {
    const pub = db.select().from(publications).where(eq(publications.id, item.publicationId)).get();
    if (pub) return db.select().from(drafts).where(eq(drafts.id, pub.draftId)).get();
  }
  if (item.launchMessageId) {
    const lm = db
      .select()
      .from(launchMessages)
      .where(eq(launchMessages.id, item.launchMessageId))
      .get();
    if (lm?.draftId) return db.select().from(drafts).where(eq(drafts.id, lm.draftId)).get();
  }
  return undefined;
}

/** Campaign + persona + original-post context for generating a reply. Also
 * consumed by the reply action adapter to resolve policy context. */
export function replyContext(db: Db, workspaceId: string, item: InboxItem) {
  const draft = draftBehindItem(db, item);
  const campaign = draft?.campaignId ? getCampaign(db, workspaceId, draft.campaignId) : undefined;
  const persona = draft?.personaId ? getPersona(db, workspaceId, draft.personaId) : undefined;
  let post: { title: string; content: string } | undefined;
  if (item.publicationId) {
    const pub = db.select().from(publications).where(eq(publications.id, item.publicationId)).get();
    if (pub) post = { title: pub.title, content: draft?.content ?? "" };
  } else if (draft) {
    post = { title: "", content: draft.content };
  }
  return { campaign, persona, post };
}

// ---------------------------------------------------------------------------
// Engagement metrics
// ---------------------------------------------------------------------------

function metricExists(db: Db, publicationId: string, window: MetricWindow): boolean {
  return (
    db
      .select({ id: publicationMetrics.id })
      .from(publicationMetrics)
      .where(
        and(eq(publicationMetrics.publicationId, publicationId), eq(publicationMetrics.window, window)),
      )
      .get() !== undefined
  );
}

export function listPublicationMetrics(
  db: Db,
  workspaceId: string,
  publicationId: string,
): PublicationMetric[] {
  return db
    .select()
    .from(publicationMetrics)
    .where(
      and(
        eq(publicationMetrics.workspaceId, workspaceId),
        eq(publicationMetrics.publicationId, publicationId),
      ),
    )
    .orderBy(asc(publicationMetrics.capturedAt))
    .all()
    .map(rowToMetric);
}

/** All of a workspace's metrics grouped by publication — for the list endpoint. */
export function metricsByPublication(db: Db, workspaceId: string): Map<string, PublicationMetric[]> {
  const rows = db
    .select()
    .from(publicationMetrics)
    .where(eq(publicationMetrics.workspaceId, workspaceId))
    .orderBy(asc(publicationMetrics.capturedAt))
    .all();
  const byPub = new Map<string, PublicationMetric[]>();
  for (const row of rows) {
    const list = byPub.get(row.publicationId) ?? [];
    list.push(rowToMetric(row));
    byPub.set(row.publicationId, list);
  }
  return byPub;
}

// ---------------------------------------------------------------------------
// Guardrails (reuse the S28 kill switch + per-connection cap for replies)
// ---------------------------------------------------------------------------

/** Posted replies on a connection on the slot's UTC day. */
function countConnectionRepliesForDay(db: Db, connectionId: string, dayMs: number): number {
  const { start, end } = utcDayBounds(dayMs);
  return db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.connectionId, connectionId),
        isNotNull(inboxItems.postedReplyExternalId),
        gte(inboxItems.updatedAt, start),
        lt(inboxItems.updatedAt, end),
      ),
    )
    .all().length;
}

type ReplyGuardrailCheck =
  | { ok: true }
  | { ok: false; error: "kill_switch_on" | "connection_cap" };

/** Auto-replies obey the kill switch + the per-connection daily cap (posts +
 * replies share an account's daily allowance). The per-campaign post cap does
 * not apply — that bounds original posts, not responses. Also consumed by the
 * reply action adapter as a dispatch guardrail. */
export function checkReplyGuardrails(
  db: Db,
  settings: SocialAutomationSettings,
  connectionId: string,
  slotMs: number,
): ReplyGuardrailCheck {
  if (settings.killSwitch) return { ok: false, error: "kill_switch_on" };
  const used =
    countConnectionPublicationsForDay(db, connectionId, slotMs) +
    countConnectionRepliesForDay(db, connectionId, slotMs);
  if (used >= settings.perConnectionDailyCap) return { ok: false, error: "connection_cap" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

async function pollInbox(
  db: Db,
  fabric: ConnectorFabric,
  workspace: WorkspaceRef,
): Promise<{ polled: number; newItems: number }> {
  let polled = 0;
  let newItems = 0;
  const posted = knownPostedReplyIds(db, workspace.id);

  for (const conn of socialConnections(db, workspace.id)) {
    const provider = providerByKey(conn.providerKey)!;
    const adapter = socialAdapterFor(fabric, provider, conn);
    if (!adapter) continue;

    // Comments on our published posts.
    if (adapter.fetchReplies) {
      for (const pub of publishedPublications(db, workspace.id, conn.id)) {
        if (!pub.externalId) continue;
        polled += 1;
        try {
          const replies = await adapter.fetchReplies({ externalId: pub.externalId, target: pub.target });
          const draft = db.select().from(drafts).where(eq(drafts.id, pub.draftId)).get();
          const channel = (draft?.channel as Channel) ?? "web";
          for (const r of replies) {
            if (posted.has(r.externalId)) continue;
            const created = insertInboxItem(db, {
              workspaceId: workspace.id,
              connectionId: conn.id,
              providerKey: conn.providerKey,
              kind: "comment",
              channel,
              externalId: r.externalId,
              parentExternalId: r.parentExternalId ?? pub.externalId,
              publicationId: pub.id,
              launchMessageId: null,
              authorHandle: r.authorHandle ?? "",
              authorName: r.authorName ?? r.authorHandle ?? "",
              content: r.body,
              url: r.url ?? null,
              externalCreatedAt: r.createdAt,
            });
            if (created) newItems += 1;
          }
        } catch {
          // Per-post failures never abort the run.
        }
      }
    }

    // DM replies (X) on outbound conversations.
    if (adapter.fetchDmReplies) {
      for (const handle of outboundDmHandles(db, workspace.id)) {
        polled += 1;
        try {
          const since = newestDmCreatedAt(db, conn.id, handle);
          const replies = await adapter.fetchDmReplies({ recipientHandle: handle, sinceMs: since });
          const launchMessageId = latestLaunchMessageIdForHandle(db, workspace.id, handle);
          for (const r of replies) {
            if (posted.has(r.externalId)) continue;
            const created = insertInboxItem(db, {
              workspaceId: workspace.id,
              connectionId: conn.id,
              providerKey: conn.providerKey,
              kind: "dm",
              channel: "x",
              externalId: r.externalId,
              parentExternalId: r.parentExternalId ?? null,
              publicationId: null,
              launchMessageId,
              authorHandle: handle,
              authorName: handle,
              content: r.body,
              url: r.url ?? null,
              externalCreatedAt: r.createdAt,
            });
            if (created) newItems += 1;
          }
        } catch {
          // Per-handle failures never abort the run.
        }
      }
    }
  }
  return { polled, newItems };
}

async function refreshEngagement(
  db: Db,
  fabric: ConnectorFabric,
  workspace: WorkspaceRef,
  nowMs: number,
): Promise<{ metricsCaptured: number }> {
  let metricsCaptured = 0;
  for (const conn of socialConnections(db, workspace.id)) {
    const provider = providerByKey(conn.providerKey)!;
    const adapter = socialAdapterFor(fabric, provider, conn);
    if (!adapter?.fetchEngagement) continue;
    for (const pub of publishedPublications(db, workspace.id, conn.id)) {
      if (!pub.externalId || !pub.publishedAt) continue;
      for (const window of METRIC_WINDOWS) {
        const due = pub.publishedAt + WINDOW_MS[window] <= nowMs;
        if (!due || metricExists(db, pub.id, window)) continue;
        try {
          const eng = await adapter.fetchEngagement({ externalId: pub.externalId, target: pub.target });
          db.insert(publicationMetrics)
            .values({
              id: randomUUID(),
              workspaceId: workspace.id,
              publicationId: pub.id,
              window,
              likes: eng.likes ?? null,
              comments: eng.comments ?? null,
              shares: eng.shares ?? null,
              impressions: eng.impressions ?? null,
              clicks: eng.clicks ?? null,
              capturedAt: nowMs,
              createdAt: nowMs,
            })
            .run();
          metricsCaptured += 1;
        } catch {
          // A post whose metrics can't be read this tick is retried next tick.
        }
      }
    }
  }
  return { metricsCaptured };
}

// ---------------------------------------------------------------------------
// Reply orchestrator + posting
// ---------------------------------------------------------------------------

async function runReplyOrchestrator(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  workspace: WorkspaceRef,
  settings: SocialAutomationSettings,
  nowMs: number,
): Promise<{ repliesGenerated: number; repliesAutoApproved: number }> {
  if (!settings.autoReplyEnabled || settings.killSwitch) {
    return { repliesGenerated: 0, repliesAutoApproved: 0 };
  }
  let repliesGenerated = 0;
  let repliesAutoApproved = 0;

  const items = db
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, workspace.id),
        isNull(inboxItems.replyDraftId),
        inArray(inboxItems.status, ["unread", "read"]),
      ),
    )
    .orderBy(asc(inboxItems.externalCreatedAt))
    .all()
    .map(rowToInboxItem);

  for (const item of items) {
    const { campaign, persona, post } = replyContext(db, workspace.id, item);
    // Auto-reply only on scheduled_auto campaigns (the founder's per-campaign choice).
    if (!campaign || campaign.automationMode !== "scheduled_auto") continue;
    if (!checkReplyGuardrails(db, settings, item.connectionId, nowMs).ok) continue;
    try {
      const draft = await generateEngagementReply(
        db,
        llm,
        evidence,
        workspace,
        item,
        { post, persona, campaign },
        SYSTEM_ACTOR,
      );
      db.update(inboxItems)
        .set({ replyDraftId: draft.id, updatedAt: Date.now() })
        .where(eq(inboxItems.id, item.id))
        .run();
      repliesGenerated += 1;
      applyDraftAction(db, draft, "approve", SYSTEM_ACTOR);
      repliesAutoApproved += 1;
    } catch {
      // One bad reply never aborts the run.
    }
  }
  return { repliesGenerated, repliesAutoApproved };
}

/**
 * Post the (already-approved) reply behind an inbox item to the platform and
 * flip it to `replied`. Throws on an unavailable connection or platform refusal
 * so the caller can surface why; the draft stays approved for a later retry.
 */
export async function postReplyForItem(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspace: WorkspaceRef,
  item: InboxItem,
  body: string,
): Promise<InboxItem> {
  const conn = getConnection(db, workspace.id, item.connectionId);
  const provider = conn ? providerByKey(conn.providerKey) : undefined;
  const adapter =
    conn && provider && conn.status === "connected"
      ? socialAdapterFor(fabric, provider, conn)
      : undefined;
  if (!adapter?.postReply) {
    throw new Error(
      `The ${item.providerKey} connection can't post replies right now — reconnect it on the Integrations page.`,
    );
  }
  // For a comment we reply to the inbound comment; `target` carries the post id
  // (LinkedIn) / nothing (Reddit/IG). For a DM, `target` is the recipient handle.
  let target: string | undefined;
  if (item.kind === "dm") {
    target = item.authorHandle;
  } else if (item.publicationId) {
    const pub = db.select().from(publications).where(eq(publications.id, item.publicationId)).get();
    target = pub?.externalId ?? undefined;
  }
  const result = await adapter.postReply({ parentExternalId: item.externalId, body, target });
  db.update(inboxItems)
    .set({
      status: "replied",
      postedReplyExternalId: result.externalId,
      postedReplyUrl: result.url || null,
      updatedAt: Date.now(),
    })
    .where(eq(inboxItems.id, item.id))
    .run();
  await emitEvent(db, fetcher, workspace.id, "reply.posted", {
    inboxItemId: item.id,
    providerKey: item.providerKey,
    externalId: result.externalId,
    url: result.url,
  });
  return getInboxItem(db, workspace.id, item.id)!;
}

async function postApprovedReplies(
  db: Db,
  runtime: ExternalActionRuntime,
  workspace: WorkspaceRef,
  settings: SocialAutomationSettings,
  nowMs: number,
): Promise<{ repliesPosted: number }> {
  let repliesPosted = 0;
  const items = db
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, workspace.id),
        isNotNull(inboxItems.replyDraftId),
        isNull(inboxItems.postedReplyExternalId),
      ),
    )
    .all()
    .map(rowToInboxItem);

  for (const item of items) {
    if (!item.replyDraftId) continue;
    const draft = getDraft(db, workspace.id, item.replyDraftId);
    if (!draft || draft.state !== "approved") continue;
    // Auto items (scheduled_auto campaign) re-check the cap at post time; a
    // manually-approved reply on any campaign proposes without the cap. A
    // capped/switched-off item is skipped, not failed — it retries next cycle.
    const { campaign } = replyContext(db, workspace.id, item);
    const automated = campaign?.automationMode === "scheduled_auto";
    if (automated && !checkReplyGuardrails(db, settings, item.connectionId, nowMs).ok) continue;
    try {
      const command = prepareReplyAction(db, workspace.id, item.id, {
        idempotencyKey: deriveReplyIdempotencyKey(item.id, draft),
        automated,
      });
      const submission = await runtime.propose(command, SYSTEM_ACTOR);
      if (submission.action.status === "succeeded") repliesPosted += 1;
    } catch {
      // Leave the item for a later retry; the draft stays approved.
    }
  }
  return { repliesPosted };
}

// ---------------------------------------------------------------------------
// Public queries + entry points
// ---------------------------------------------------------------------------

export function listInbox(
  db: Db,
  workspaceId: string,
  status?: InboxItemStatus,
): InboxItemWithContext[] {
  const conditions = [eq(inboxItems.workspaceId, workspaceId)];
  if (status) conditions.push(eq(inboxItems.status, status));
  const rows = db
    .select()
    .from(inboxItems)
    .where(and(...conditions))
    .orderBy(desc(inboxItems.externalCreatedAt))
    .all();
  return rows.map((row) => {
    const item = rowToInboxItem(row);
    let replyDraft: InboxItemWithContext["replyDraft"] = null;
    if (item.replyDraftId) {
      const d = getDraft(db, workspaceId, item.replyDraftId);
      if (d) replyDraft = { id: d.id, state: d.state, content: d.content };
    }
    let post: InboxItemWithContext["post"] = null;
    if (item.publicationId) {
      const pub = db.select().from(publications).where(eq(publications.id, item.publicationId)).get();
      if (pub) post = { publicationId: pub.id, title: pub.title, url: pub.externalUrl };
    }
    return { ...item, replyDraft, post };
  });
}

export function getInboxItem(db: Db, workspaceId: string, itemId: string): InboxItem | undefined {
  const row = db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.id, itemId)))
    .get();
  return row ? rowToInboxItem(row) : undefined;
}

export function setInboxStatus(
  db: Db,
  workspaceId: string,
  itemId: string,
  status: "read" | "dismissed",
): InboxItem | undefined {
  const item = getInboxItem(db, workspaceId, itemId);
  if (!item) return undefined;
  db.update(inboxItems)
    .set({ status, updatedAt: Date.now() })
    .where(eq(inboxItems.id, itemId))
    .run();
  return { ...item, status };
}

/**
 * Generate a brain-resolved reply draft for an item (the manual "Draft reply"
 * path). Idempotent — returns the existing reply draft if one is already linked.
 */
export async function generateReplyForItem(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  workspace: WorkspaceRef,
  item: InboxItem,
  actor: DraftActor,
): Promise<Draft> {
  if (item.replyDraftId) {
    const existing = getDraft(db, workspace.id, item.replyDraftId);
    if (existing) return existing;
  }
  const { campaign, persona, post } = replyContext(db, workspace.id, item);
  const draft = await generateEngagementReply(
    db,
    llm,
    evidence,
    workspace,
    item,
    { post, persona, campaign },
    actor,
  );
  db.update(inboxItems)
    .set({
      replyDraftId: draft.id,
      status: item.status === "unread" ? "read" : item.status,
      updatedAt: Date.now(),
    })
    .where(eq(inboxItems.id, item.id))
    .run();
  return draft;
}

function emptyRun(nowMs: number): InboxRunResult {
  return {
    polled: 0,
    newItems: 0,
    metricsCaptured: 0,
    repliesGenerated: 0,
    repliesAutoApproved: 0,
    repliesPosted: 0,
    ranAt: nowMs,
  };
}

/**
 * One inbox cycle: poll inbound items, refresh engagement metrics, auto-generate
 * + auto-approve replies for scheduled_auto campaigns (when the master switch is
 * on), then propose a reply action for every approved reply — the action policy
 * decides whether it posts now or waits for authorization. The single worker +
 * "Run now" entry point.
 */
export async function runInbox(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  fabric: ConnectorFabric,
  runtime: ExternalActionRuntime,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<InboxRunResult> {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace) return emptyRun(nowMs);

  const poll = await pollInbox(db, fabric, workspace);
  const engagement = await refreshEngagement(db, fabric, workspace, nowMs);
  const settings = getSocialAutomationSettings(db, workspaceId);
  const orchestrated = await runReplyOrchestrator(db, llm, evidence, workspace, settings, nowMs);
  const posted = await postApprovedReplies(db, runtime, workspace, settings, nowMs);

  return {
    polled: poll.polled,
    newItems: poll.newItems,
    metricsCaptured: engagement.metricsCaptured,
    repliesGenerated: orchestrated.repliesGenerated,
    repliesAutoApproved: orchestrated.repliesAutoApproved,
    repliesPosted: posted.repliesPosted,
    ranAt: nowMs,
  };
}
