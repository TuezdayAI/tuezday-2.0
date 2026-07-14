import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  LAUNCH_CHANNELS,
  LAUNCH_MESSAGE_KINDS,
  SOCIAL_POST_CONSTRAINTS,
  publishDraftInputSchema,
  validateSocialPost,
  type ExternalAction,
  type ExternalActionBlocker,
  type ExternalActionExecutionRef,
  type PublishDraftInput,
  type SocialPostConstraints,
} from "@tuezday/contracts";
import type { ConnectorFabric } from "../connectors/fabric";
import { socialAdapterFor, type PublishMedia } from "../connectors/social";
import type { Db } from "../db";
import {
  inboxItems,
  launchMessages,
  launches,
  publications,
  sequenceRecipients,
  type LaunchMessageRow,
} from "../db/schema";
import {
  checkPostGuardrails,
  getSocialAutomationSettings,
} from "./automation";
import { getCampaign } from "./campaigns";
import { getConnection, providerByKey } from "./connections";
import type {
  ExternalActionAdapter,
  ExternalActionAdapterRegistry,
  ExternalActionCommand,
  ExternalActionIntent,
} from "./external-action-coordinator";
import { canonicalActionFingerprint } from "./external-action-fingerprint";
import { getDraft } from "./drafts";
import {
  checkReplyGuardrails,
  getInboxItem,
  postReplyForItem,
  replyContext,
} from "./inbox";
import { LAUNCH_CHANNEL_PROVIDER, maybeCompleteLaunch } from "./launches";
import { countConnectionDmsForDay, hasInboundReply } from "./launch-sequences";
import { getPersona } from "./personas";
import { resolvePersonaSocialConnection } from "./persona-social-accounts";
import {
  createPublication,
  findLivePublication,
  getPublicationByExternalAction,
} from "./publications";
import { getWorkspace } from "./workspaces";

type Fetcher = typeof fetch;

const publishActionPayloadSchema = publishDraftInputSchema
  .omit({ idempotencyKey: true, scheduledFor: true })
  .extend({
    draftId: z.string().uuid(),
    scheduledFor: z.number().int().positive().nullable(),
    cadenceId: z.string().uuid().nullable(),
    automated: z.boolean(),
    media: z.array(z.unknown()).nullable(),
  });

type PublishActionPayload = z.infer<typeof publishActionPayloadSchema>;

export class ExternalActionPreparationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: 400 | 404 | 409,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ExternalActionPreparationError";
  }
}

function publishIntent(
  db: Db,
  workspaceId: string,
  payload: PublishActionPayload,
  options: { allowDueTime: boolean },
): ExternalActionIntent {
  const draft = getDraft(db, workspaceId, payload.draftId);
  if (!draft) {
    throw new ExternalActionPreparationError("draft_not_found", "Draft not found.", 404);
  }
  if (draft.state !== "approved") {
    throw new ExternalActionPreparationError(
      "draft_not_approved",
      "Only approved drafts can be published — run it through Review first.",
      409,
    );
  }
  if (
    !options.allowDueTime &&
    payload.scheduledFor !== null &&
    payload.scheduledFor <= Date.now()
  ) {
    throw new ExternalActionPreparationError(
      "invalid_input",
      "The scheduled time must be in the future.",
      400,
    );
  }

  const connection = getConnection(db, workspaceId, payload.connectionId);
  if (!connection) {
    throw new ExternalActionPreparationError("connection_not_found", "Connection not found.", 404);
  }
  const provider = providerByKey(connection.providerKey);
  if (!provider?.categories?.includes("social")) {
    throw new ExternalActionPreparationError(
      "not_social",
      "Pick a connected social account to publish to.",
      400,
    );
  }
  if (draft.personaId) {
    const routed = resolvePersonaSocialConnection(db, workspaceId, {
      personaId: draft.personaId,
      providerKey: connection.providerKey,
      channel: provider.key === "twitter" ? "x" : provider.key,
      explicitConnectionId: connection.id,
    });
    if (!routed.ok) {
      throw new ExternalActionPreparationError(
        routed.error,
        "This draft's persona is not assigned to the selected social account.",
        409,
      );
    }
  }

  const validation = validateSocialPost(provider.key, {
    target: payload.target,
    title: payload.title,
    body: draft.content,
  });
  if (!validation.ok) {
    throw new ExternalActionPreparationError(
      "publish_validation",
      validation.violations.map((violation) => violation.message).join(" "),
      400,
      { violations: validation.violations },
    );
  }

  const campaign = draft.campaignId ? getCampaign(db, workspaceId, draft.campaignId) : undefined;
  const persona = draft.personaId ? getPersona(db, workspaceId, draft.personaId) : undefined;
  const media = draft.media ?? null;
  return {
    subject: {
      kind: "draft",
      id: draft.id,
      title: payload.title,
      summary: draft.content,
      channel: draft.channel,
      destination: `${connection.displayName || connection.externalAccountName || provider.label} · ${payload.target}`,
    },
    context: {
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? null,
      personaId: persona?.id ?? null,
      personaName: persona?.name ?? null,
      connectionId: connection.id,
      connectionName: connection.displayName || connection.externalAccountName || provider.label,
      laneRevisionId: null,
      laneName: null,
    },
    payload: { ...payload, media },
    requestedFor: payload.scheduledFor,
    links: { draftId: draft.id },
  };
}

export function preparePublicationAction(
  db: Db,
  workspaceId: string,
  draftId: string,
  input: PublishDraftInput,
  options: {
    idempotencyKey: string;
    cadenceId?: string | null;
    automated?: boolean;
  },
): ExternalActionCommand {
  const payload = publishActionPayloadSchema.parse({
    draftId,
    connectionId: input.connectionId,
    target: input.target,
    title: input.title,
    scheduledFor: input.scheduledFor ?? null,
    cadenceId: options.cadenceId ?? null,
    automated: options.automated ?? false,
    media: null,
  });
  return {
    workspaceId,
    kind: "publish",
    idempotencyKey: options.idempotencyKey,
    ...publishIntent(db, workspaceId, payload, { allowDueTime: false }),
  };
}

function asPublishPayload(payload: unknown): PublishActionPayload {
  return publishActionPayloadSchema.parse(payload);
}

function publicationReceipt(publication: {
  id: string;
  status: string;
  externalUrl: string | null;
  lastError: string | null;
}): ExternalActionExecutionRef {
  return {
    kind: "publication",
    id: publication.id,
    status: publication.status,
    url: publication.externalUrl,
    error: publication.lastError,
  };
}

export function publishActionAdapter(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): ExternalActionAdapter {
  return {
    async revalidate(action, rawPayload) {
      return publishIntent(db, action.workspaceId, asPublishPayload(rawPayload), {
        allowDueTime: true,
      });
    },

    async guard(action, rawPayload): Promise<ExternalActionBlocker | null> {
      const payload = asPublishPayload(rawPayload);
      const connection = getConnection(db, action.workspaceId, payload.connectionId);
      if (!connection || connection.status !== "connected") {
        return {
          code: "connection_unhealthy",
          message: "Reconnect the selected social account before publishing.",
          retryable: true,
        };
      }
      const existing = findLivePublication(db, payload.draftId, payload.connectionId, payload.target);
      if (existing && existing.externalActionId !== action.id) {
        return {
          code: "already_published",
          message: "This draft already has a live publication for that destination.",
          retryable: false,
        };
      }
      if (payload.automated && action.context.campaignId) {
        const campaign = getCampaign(db, action.workspaceId, action.context.campaignId);
        if (!campaign) {
          return {
            code: "campaign_unavailable",
            message: "The campaign behind this automated publication is no longer available.",
            retryable: false,
          };
        }
        const check = checkPostGuardrails(
          db,
          getSocialAutomationSettings(db, action.workspaceId),
          {
            campaign,
            connectionId: connection.id,
            slotMs: action.requestedFor ?? Date.now(),
            excludeActionId: action.id,
          },
        );
        if (!check.ok) return { code: check.error, message: check.message, retryable: true };
      }
      return null;
    },

    async execute(action: ExternalAction, rawPayload): Promise<ExternalActionExecutionRef> {
      const payload = asPublishPayload(rawPayload);
      const existing = getPublicationByExternalAction(db, action.workspaceId, action.id);
      if (existing && existing.status !== "scheduled") return publicationReceipt(existing);
      const connection = getConnection(db, action.workspaceId, payload.connectionId);
      if (!connection) {
        return {
          kind: "publication",
          id: existing?.id ?? action.id,
          status: "failed",
          url: null,
          error: "The selected connection no longer exists.",
        };
      }
      const publication = await createPublication(
        db,
        fabric,
        fetcher,
        action.workspaceId,
        payload.draftId,
        connection,
        {
          connectionId: payload.connectionId,
          target: payload.target,
          title: payload.title,
          scheduledFor: payload.scheduledFor ?? undefined,
        },
        (payload.media ?? undefined) as PublishMedia[] | undefined,
        payload.cadenceId,
        action.id,
      );
      return publicationReceipt(publication);
    },
  };
}

// ---------------------------------------------------------------------------
// Reply actions (inbox comments / DMs)
// ---------------------------------------------------------------------------

const replyActionPayloadSchema = z.object({
  inboxItemId: z.string().uuid(),
  replyDraftId: z.string().uuid(),
  body: z.string().min(1),
  connectionId: z.string().uuid(),
  parentExternalId: z.string().min(1),
  target: z.string().nullable(),
  automated: z.boolean(),
});

type ReplyActionPayload = z.infer<typeof replyActionPayloadSchema>;

/** Deterministic manual/worker retry key: same reply text → same action. */
export function deriveReplyIdempotencyKey(
  itemId: string,
  draft: { id: string; content: string },
): string {
  return `reply:${itemId}:${canonicalActionFingerprint({
    draftId: draft.id,
    content: draft.content,
  }).slice(0, 32)}`;
}

function replyIntent(
  db: Db,
  workspaceId: string,
  itemId: string,
  automated: boolean,
): ExternalActionIntent {
  const item = getInboxItem(db, workspaceId, itemId);
  if (!item) {
    throw new ExternalActionPreparationError("inbox_item_not_found", "Inbox item not found.", 404);
  }
  if (!item.replyDraftId) {
    throw new ExternalActionPreparationError(
      "reply_not_approved",
      "Draft a reply first.",
      409,
    );
  }
  const draft = getDraft(db, workspaceId, item.replyDraftId);
  if (!draft || draft.state !== "approved") {
    throw new ExternalActionPreparationError(
      "reply_not_approved",
      "The reply draft must be approved before it can be posted.",
      409,
    );
  }
  const connection = getConnection(db, workspaceId, item.connectionId);
  if (!connection) {
    throw new ExternalActionPreparationError("connection_not_found", "Connection not found.", 404);
  }
  let target: string | null = null;
  if (item.kind === "dm") {
    target = item.authorHandle;
  } else if (item.publicationId) {
    const pub = db
      .select({ externalId: publications.externalId })
      .from(publications)
      .where(eq(publications.id, item.publicationId))
      .get();
    target = pub?.externalId ?? null;
  }
  const { campaign, persona } = replyContext(db, workspaceId, item);
  const connectionName =
    connection.displayName || connection.externalAccountName || connection.providerKey;
  const payload: ReplyActionPayload = {
    inboxItemId: item.id,
    replyDraftId: draft.id,
    body: draft.content,
    connectionId: connection.id,
    parentExternalId: item.externalId,
    target,
    automated,
  };
  return {
    subject: {
      kind: "inbox_item",
      id: item.id,
      title: `Reply to ${item.authorName || item.authorHandle || "engagement"}`,
      summary: draft.content,
      channel: item.channel,
      destination: `${connectionName} · ${item.kind === "dm" ? `@${item.authorHandle}` : "thread"}`,
    },
    context: {
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? null,
      personaId: persona?.id ?? null,
      personaName: persona?.name ?? null,
      connectionId: connection.id,
      connectionName,
      laneRevisionId: null,
      laneName: null,
    },
    payload,
    requestedFor: null,
    links: { draftId: draft.id },
  };
}

export function prepareReplyAction(
  db: Db,
  workspaceId: string,
  itemId: string,
  options: { idempotencyKey: string; automated: boolean },
): ExternalActionCommand {
  return {
    workspaceId,
    kind: "reply",
    idempotencyKey: options.idempotencyKey,
    ...replyIntent(db, workspaceId, itemId, options.automated),
  };
}

function asReplyPayload(payload: unknown): ReplyActionPayload {
  return replyActionPayloadSchema.parse(payload);
}

export function replyActionAdapter(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): ExternalActionAdapter {
  return {
    async revalidate(action, rawPayload) {
      const payload = asReplyPayload(rawPayload);
      return replyIntent(db, action.workspaceId, payload.inboxItemId, payload.automated);
    },

    async guard(action, rawPayload): Promise<ExternalActionBlocker | null> {
      const payload = asReplyPayload(rawPayload);
      const item = getInboxItem(db, action.workspaceId, payload.inboxItemId);
      if (!item) {
        return {
          code: "inbox_item_missing",
          message: "The inbound item behind this reply no longer exists.",
          retryable: false,
        };
      }
      if (item.postedReplyExternalId && item.externalActionId !== action.id) {
        return {
          code: "already_replied",
          message: "This item already has a posted reply.",
          retryable: false,
        };
      }
      const connection = getConnection(db, action.workspaceId, payload.connectionId);
      if (!connection || connection.status !== "connected") {
        return {
          code: "connection_unhealthy",
          message: "Reconnect the social account before posting this reply.",
          retryable: true,
        };
      }
      if (payload.automated) {
        const check = checkReplyGuardrails(
          db,
          getSocialAutomationSettings(db, action.workspaceId),
          item.connectionId,
          Date.now(),
        );
        if (!check.ok) {
          return {
            code: check.error,
            message:
              check.error === "kill_switch_on"
                ? "The automation kill switch is on."
                : "This account hit its daily activity cap.",
            retryable: true,
          };
        }
      }
      return null;
    },

    async execute(action, rawPayload): Promise<ExternalActionExecutionRef> {
      const payload = asReplyPayload(rawPayload);
      const item = getInboxItem(db, action.workspaceId, payload.inboxItemId);
      if (!item) {
        return {
          kind: "inbox_reply",
          id: payload.inboxItemId,
          status: "failed",
          url: null,
          error: "The inbound item behind this reply no longer exists.",
        };
      }
      if (item.postedReplyExternalId && item.externalActionId === action.id) {
        return {
          kind: "inbox_reply",
          id: item.id,
          status: "replied",
          url: item.postedReplyUrl,
          error: null,
        };
      }
      db.update(inboxItems)
        .set({ externalActionId: action.id, updatedAt: Date.now() })
        .where(eq(inboxItems.id, item.id))
        .run();
      const workspace = getWorkspace(db, action.workspaceId)!;
      try {
        const updated = await postReplyForItem(db, fabric, fetcher, workspace, item, payload.body);
        return {
          kind: "inbox_reply",
          id: updated.id,
          status: "replied",
          url: updated.postedReplyUrl,
          error: null,
        };
      } catch (err) {
        return {
          kind: "inbox_reply",
          id: item.id,
          status: "failed",
          url: null,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Send actions (launch broadcasts + X DMs, manual dispatch and sequences)
// ---------------------------------------------------------------------------

const sendActionPayloadSchema = z.object({
  launchId: z.string().uuid(),
  messageId: z.string().uuid(),
  draftId: z.string().uuid(),
  channel: z.enum(LAUNCH_CHANNELS),
  kind: z.enum(LAUNCH_MESSAGE_KINDS),
  connectionId: z.string().uuid(),
  target: z.string().nullable(),
  title: z.string(),
  body: z.string().min(1),
  media: z.array(z.unknown()).nullable(),
  automated: z.boolean(),
});

type SendActionPayload = z.infer<typeof sendActionPayloadSchema>;

/** Deterministic dispatch/worker retry key: same message content + destination
 * → same action; an edited draft yields a fresh proposal instead of a conflict. */
export function deriveSendIdempotencyKey(
  messageId: string,
  input: { connectionId: string; draftId: string; content: string },
): string {
  return `send:${messageId}:${canonicalActionFingerprint(input).slice(0, 32)}`;
}

function launchMessageRow(
  db: Db,
  workspaceId: string,
  launchId: string,
  messageId: string,
): LaunchMessageRow | undefined {
  return db
    .select()
    .from(launchMessages)
    .where(
      and(
        eq(launchMessages.workspaceId, workspaceId),
        eq(launchMessages.launchId, launchId),
        eq(launchMessages.id, messageId),
      ),
    )
    .get();
}

function sendIntent(
  db: Db,
  workspaceId: string,
  args: {
    launchId: string;
    messageId: string;
    connectionId: string;
    media: unknown[] | null;
    automated: boolean;
  },
): ExternalActionIntent {
  const launchRow = db
    .select()
    .from(launches)
    .where(and(eq(launches.workspaceId, workspaceId), eq(launches.id, args.launchId)))
    .get();
  if (!launchRow) {
    throw new ExternalActionPreparationError("launch_not_found", "Launch not found.", 404);
  }
  const message = launchMessageRow(db, workspaceId, args.launchId, args.messageId);
  if (!message) {
    throw new ExternalActionPreparationError("message_not_found", "Launch message not found.", 404);
  }
  const channel = message.channel as (typeof LAUNCH_CHANNELS)[number];
  const providerKey = LAUNCH_CHANNEL_PROVIDER[channel];
  if (!providerKey) {
    throw new ExternalActionPreparationError(
      "channel_not_selected",
      "Email is delivered via the CSV export, not a send action.",
      400,
    );
  }
  if (!message.draftId) {
    throw new ExternalActionPreparationError(
      "draft_not_approved",
      "This message has no draft to send.",
      409,
    );
  }
  const draft = getDraft(db, workspaceId, message.draftId);
  if (!draft || draft.state !== "approved") {
    throw new ExternalActionPreparationError(
      "draft_not_approved",
      "Only approved messages can be sent — run them through Review first.",
      409,
    );
  }
  const connection = getConnection(db, workspaceId, args.connectionId);
  if (!connection || connection.providerKey !== providerKey) {
    throw new ExternalActionPreparationError("no_connection", "Connection not found.", 404);
  }

  const kind = message.kind as (typeof LAUNCH_MESSAGE_KINDS)[number];
  let target: string | null;
  if (kind === "broadcast") {
    target = "feed";
    const constraints = SOCIAL_POST_CONSTRAINTS[
      providerKey as keyof typeof SOCIAL_POST_CONSTRAINTS
    ] as SocialPostConstraints | undefined;
    if (constraints?.requiresMedia && (!args.media || args.media.length === 0)) {
      throw new ExternalActionPreparationError(
        "media_required",
        "This platform requires at least one media attachment.",
        400,
      );
    }
    const validation = validateSocialPost(providerKey, {
      target: "feed",
      title: launchRow.name,
      body: draft.content,
    });
    if (!validation.ok) {
      throw new ExternalActionPreparationError(
        "validation_failed",
        validation.violations.map((violation) => violation.message).join(" "),
        400,
        { violations: validation.violations },
      );
    }
  } else {
    target = message.recipientHandle;
    if (!target) {
      throw new ExternalActionPreparationError(
        "no_recipient_handle",
        "This recipient has no handle to send to.",
        409,
      );
    }
  }

  const campaign = launchRow.campaignId
    ? getCampaign(db, workspaceId, launchRow.campaignId)
    : undefined;
  const persona = launchRow.personaId
    ? getPersona(db, workspaceId, launchRow.personaId)
    : undefined;
  const connectionName =
    connection.displayName || connection.externalAccountName || connection.providerKey;
  const payload: SendActionPayload = {
    launchId: launchRow.id,
    messageId: message.id,
    draftId: draft.id,
    channel,
    kind,
    connectionId: connection.id,
    target,
    title: launchRow.name,
    body: draft.content,
    media: args.media,
    automated: args.automated,
  };
  return {
    subject: {
      kind: "launch_message",
      id: message.id,
      title:
        kind === "broadcast"
          ? `${launchRow.name} broadcast`
          : `${launchRow.name} · ${message.recipientName || target}`,
      summary: draft.content,
      channel,
      destination: `${connectionName} · ${kind === "broadcast" ? "feed" : `@${target}`}`,
    },
    context: {
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? null,
      personaId: persona?.id ?? null,
      personaName: persona?.name ?? null,
      connectionId: connection.id,
      connectionName,
      laneRevisionId: null,
      laneName: null,
    },
    payload,
    requestedFor: null,
    links: { draftId: draft.id },
  };
}

export function prepareSendAction(
  db: Db,
  workspaceId: string,
  launchId: string,
  messageId: string,
  options: {
    idempotencyKey: string;
    connectionId: string;
    media?: unknown[] | null;
    automated?: boolean;
  },
): ExternalActionCommand {
  return {
    workspaceId,
    kind: "send",
    idempotencyKey: options.idempotencyKey,
    ...sendIntent(db, workspaceId, {
      launchId,
      messageId,
      connectionId: options.connectionId,
      media: options.media ?? null,
      automated: options.automated ?? false,
    }),
  };
}

function asSendPayload(payload: unknown): SendActionPayload {
  return sendActionPayloadSchema.parse(payload);
}

function launchMessageReceipt(message: {
  id: string;
  status: string;
  externalUrl: string | null;
  lastError: string | null;
}): ExternalActionExecutionRef {
  return {
    kind: "launch_message",
    id: message.id,
    status: message.status,
    url: message.externalUrl,
    error: message.lastError,
  };
}

/** Stop-on-reply + auto caps for a queued or dispatching send. */
function sendGuardBlocker(
  db: Db,
  action: ExternalAction,
  payload: SendActionPayload,
  message: LaunchMessageRow,
): ExternalActionBlocker | null {
  if (message.sequenceRecipientId && payload.channel === "x") {
    const launchRow = db
      .select({ stopOnReply: launches.stopOnReply })
      .from(launches)
      .where(eq(launches.id, payload.launchId))
      .get();
    const recipient = db
      .select()
      .from(sequenceRecipients)
      .where(eq(sequenceRecipients.id, message.sequenceRecipientId))
      .get();
    if (
      launchRow?.stopOnReply === 1 &&
      recipient &&
      hasInboundReply(
        db,
        action.workspaceId,
        recipient.recipientHandle,
        recipient.lastSentAt ?? 0,
      )
    ) {
      return {
        code: "recipient_replied",
        message: "This recipient already replied — the sequence stops here.",
        retryable: false,
      };
    }
  }
  if (payload.automated && payload.channel === "x") {
    const settings = getSocialAutomationSettings(db, action.workspaceId);
    if (settings.killSwitch) {
      return {
        code: "kill_switch_on",
        message: "The automation kill switch is on.",
        retryable: true,
      };
    }
    if (countConnectionDmsForDay(db, payload.connectionId, Date.now()) >= settings.perConnectionDailyCap) {
      return {
        code: "connection_cap",
        message: "This account hit its daily DM cap.",
        retryable: true,
      };
    }
  }
  return null;
}

export function sendActionAdapter(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): ExternalActionAdapter {
  async function executeBroadcast(
    action: ExternalAction,
    payload: SendActionPayload,
    message: LaunchMessageRow,
  ): Promise<ExternalActionExecutionRef> {
    const connection = getConnection(db, action.workspaceId, payload.connectionId);
    if (!connection) {
      return {
        kind: "launch_message",
        id: message.id,
        status: "failed",
        url: null,
        error: "The selected connection no longer exists.",
      };
    }
    const media = (payload.media ?? undefined) as PublishMedia[] | undefined;
    const publication = await createPublication(
      db,
      fabric,
      fetcher,
      action.workspaceId,
      payload.draftId,
      connection,
      { connectionId: connection.id, target: "feed", title: payload.title },
      media,
      null,
      action.id,
    );
    const now = Date.now();
    if (publication.status === "published") {
      db.update(launchMessages)
        .set({
          status: "sent",
          sentAt: now,
          publicationId: publication.id,
          externalId: publication.externalId,
          externalUrl: publication.externalUrl,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(launchMessages.id, message.id))
        .run();
    } else {
      db.update(launchMessages)
        .set({
          status: "failed",
          publicationId: publication.id,
          lastError: publication.lastError,
          updatedAt: now,
        })
        .where(eq(launchMessages.id, message.id))
        .run();
    }
    return launchMessageReceipt(
      launchMessageRow(db, action.workspaceId, payload.launchId, message.id)!,
    );
  }

  async function executeXDm(
    action: ExternalAction,
    payload: SendActionPayload,
    message: LaunchMessageRow,
  ): Promise<ExternalActionExecutionRef> {
    const connection = getConnection(db, action.workspaceId, payload.connectionId);
    const provider = connection ? providerByKey(connection.providerKey) : undefined;
    const adapter =
      connection && provider ? socialAdapterFor(fabric, provider, connection) : undefined;
    const now = Date.now();
    try {
      if (!adapter?.sendDm) {
        throw new Error("The X connection is not available — reconnect it on the Integrations page.");
      }
      const res = await adapter.sendDm({ recipientHandle: payload.target ?? "", body: payload.body });
      db.update(launchMessages)
        .set({
          status: "sent",
          sentAt: now,
          externalId: res.externalId,
          externalUrl: res.url || null,
          lastError: null,
          connectionId: connection!.id,
          updatedAt: now,
        })
        .where(eq(launchMessages.id, message.id))
        .run();
      // Keep the sequence's stop-on-reply window aligned with the actual send,
      // even when the send was authorized from Review rather than the engine.
      if (message.sequenceRecipientId) {
        db.update(sequenceRecipients)
          .set({ lastSentAt: now, updatedAt: now })
          .where(eq(sequenceRecipients.id, message.sequenceRecipientId))
          .run();
      }
    } catch (err) {
      const messageText = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      db.update(launchMessages)
        .set({ status: "failed", lastError: messageText, updatedAt: now })
        .where(eq(launchMessages.id, message.id))
        .run();
    }
    return launchMessageReceipt(
      launchMessageRow(db, action.workspaceId, payload.launchId, message.id)!,
    );
  }

  return {
    async revalidate(action, rawPayload) {
      const payload = asSendPayload(rawPayload);
      return sendIntent(db, action.workspaceId, {
        launchId: payload.launchId,
        messageId: payload.messageId,
        connectionId: payload.connectionId,
        media: payload.media,
        automated: payload.automated,
      });
    },

    async guard(action, rawPayload): Promise<ExternalActionBlocker | null> {
      const payload = asSendPayload(rawPayload);
      const message = launchMessageRow(db, action.workspaceId, payload.launchId, payload.messageId);
      if (!message) {
        return {
          code: "message_missing",
          message: "The launch message behind this send no longer exists.",
          retryable: false,
        };
      }
      if (message.status === "sent" && message.externalActionId !== action.id) {
        return {
          code: "already_sent",
          message: "This message was already sent.",
          retryable: false,
        };
      }
      const connection = getConnection(db, action.workspaceId, payload.connectionId);
      if (!connection || connection.status !== "connected") {
        return {
          code: "connection_unhealthy",
          message: "Reconnect the social account before sending.",
          retryable: true,
        };
      }
      return sendGuardBlocker(db, action, payload, message);
    },

    async execute(action, rawPayload): Promise<ExternalActionExecutionRef> {
      const payload = asSendPayload(rawPayload);
      const message = launchMessageRow(db, action.workspaceId, payload.launchId, payload.messageId);
      if (!message) {
        return {
          kind: "launch_message",
          id: payload.messageId,
          status: "failed",
          url: null,
          error: "The launch message behind this send no longer exists.",
        };
      }
      if (message.status === "sent" && message.externalActionId === action.id) {
        return launchMessageReceipt(message);
      }
      db.update(launchMessages)
        .set({ externalActionId: action.id, updatedAt: Date.now() })
        .where(eq(launchMessages.id, message.id))
        .run();
      const receipt =
        payload.kind === "broadcast"
          ? await executeBroadcast(action, payload, message)
          : await executeXDm(action, payload, message);
      // Sequence launches complete through the sequence engine, not here.
      if (!message.sequenceRecipientId) {
        maybeCompleteLaunch(db, action.workspaceId, payload.launchId);
      }
      return receipt;
    },
  };
}

export function createExternalActionAdapters(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): ExternalActionAdapterRegistry {
  return {
    publish: publishActionAdapter(db, fabric, fetcher),
    reply: replyActionAdapter(db, fabric, fetcher),
    send: sendActionAdapter(db, fabric, fetcher),
  };
}
