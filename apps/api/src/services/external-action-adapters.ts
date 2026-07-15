import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  LAUNCH_CHANNELS,
  LAUNCH_MESSAGE_KINDS,
  SOCIAL_POST_CONSTRAINTS,
  budgetChangeIntentSchema,
  publishDraftInputSchema,
  targetingChangeIntentSchema,
  validateSocialPost,
  type TargetingChangeIntent,
  type ExternalAction,
  type ExternalActionBlocker,
  type ExternalActionExecutionRef,
  type BudgetChangeIntent,
  type ProposeBudgetChangeInput,
  type ProposeTargetingChangeInput,
  type PublishDraftInput,
  type SocialPostConstraints,
} from "@tuezday/contracts";
import { adsExecutionAdapterFor, type AdsExecutionAdapter } from "../connectors/ads";
import type { ConnectorFabric } from "../connectors/fabric";
import { socialAdapterFor, type PublishMedia } from "../connectors/social";
import type { Db } from "../db";
import {
  adLaunches,
  inboxItems,
  launchMessages,
  launches,
  publications,
  sequenceRecipients,
  type LaunchMessageRow,
} from "../db/schema";
import {
  checkSpendGuardrails,
  creativeFieldsFrom,
  getLaunch as getAdLaunch,
  persistLaunchTargeting,
  performLaunch,
} from "./ad-launches";
import { getAdAccount } from "./ads";
import {
  checkPostGuardrails,
  getSocialAutomationSettings,
} from "./automation";
import { getCampaign } from "./campaigns";
import { emitEvent } from "./events";
import { getConnection, providerByKey } from "./connections";
import type {
  ExternalActionAdapter,
  ExternalActionAdapterRegistry,
  ExternalActionCommand,
  ExternalActionIntent,
} from "./external-action-coordinator";
import { canonicalActionFingerprint } from "./external-action-fingerprint";
import { countTerminalExternalActionsForSubject } from "./external-actions";
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

// ---------------------------------------------------------------------------
// Paid launch actions (Meta ad launches)
// ---------------------------------------------------------------------------

const paidLaunchActionPayloadSchema = z.object({
  launchId: z.string().uuid(),
  adAccountId: z.string().uuid(),
  externalAccountId: z.string().min(1),
  creativeDraftId: z.string().uuid(),
  creative: z.object({
    primaryText: z.string().min(1),
    headline: z.string().min(1),
    description: z.string(),
  }),
  imageUrl: z.string().nullable(),
  name: z.string().min(1),
  objective: z.string().min(1),
  pageId: z.string().min(1),
  linkUrl: z.string().min(1),
  dailyBudgetCents: z.number().int(),
  startAt: z.number().int().nullable(),
  endAt: z.number().int().nullable(),
  countries: z.array(z.string()),
  ageMin: z.number().int(),
  ageMax: z.number().int(),
  /** The setup-gate status at proposal time — a pulled-back gate goes stale. */
  setupStatus: z.string().min(1),
});

type PaidLaunchActionPayload = z.infer<typeof paidLaunchActionPayloadSchema>;

function paidLaunchIntent(db: Db, workspaceId: string, launchId: string): ExternalActionIntent {
  const launch = getAdLaunch(db, workspaceId, launchId);
  if (!launch) {
    throw new ExternalActionPreparationError("launch_not_found", "Launch not found.", 404);
  }
  const account = getAdAccount(db, workspaceId, launch.adAccountId);
  if (!account) {
    throw new ExternalActionPreparationError("account_not_found", "No such ad account.", 404);
  }
  const draft = getDraft(db, workspaceId, launch.creativeDraftId);
  const creative = draft ? creativeFieldsFrom(draft.content) : null;
  if (!creative) {
    throw new ExternalActionPreparationError(
      "creative_unparseable",
      "The creative draft behind this launch is gone or no longer parses.",
      400,
    );
  }
  const campaign = launch.campaignId ? getCampaign(db, workspaceId, launch.campaignId) : undefined;
  const payload: PaidLaunchActionPayload = {
    launchId: launch.id,
    adAccountId: account.id,
    externalAccountId: account.externalId,
    creativeDraftId: launch.creativeDraftId,
    creative,
    imageUrl: draft?.media?.[0]?.url ?? null,
    name: launch.name,
    objective: launch.objective,
    pageId: launch.pageId,
    linkUrl: launch.linkUrl,
    dailyBudgetCents: launch.dailyBudgetCents,
    startAt: launch.startAt,
    endAt: launch.endAt,
    countries: launch.countries,
    ageMin: launch.ageMin,
    ageMax: launch.ageMax,
    setupStatus: launch.status,
  };
  return {
    subject: {
      kind: "ad_launch",
      id: launch.id,
      title: launch.name,
      summary: `${creative.primaryText}\n${creative.headline}`,
      channel: "ads",
      destination: `${account.name} · ${account.externalId}`,
    },
    context: {
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? null,
      personaId: null,
      personaName: null,
      connectionId: account.connectionId,
      connectionName: account.name,
      laneRevisionId: null,
      laneName: null,
    },
    payload,
    requestedFor: null,
    links: { draftId: launch.creativeDraftId },
  };
}

export function preparePaidLaunchAction(
  db: Db,
  workspaceId: string,
  launchId: string,
): ExternalActionCommand {
  const launch = getAdLaunch(db, workspaceId, launchId);
  if (!launch) {
    throw new ExternalActionPreparationError("launch_not_found", "Launch not found.", 404);
  }
  if (launch.status === "launched") {
    throw new ExternalActionPreparationError(
      "already_launched",
      "This launch already went out.",
      409,
    );
  }
  if (launch.status !== "approved") {
    throw new ExternalActionPreparationError(
      "launch_not_approved",
      "A launch must clear the approval gate before it can spend.",
      409,
    );
  }
  // Each terminal attempt (failed, blocked, denied, stale) frees the founder to
  // retry from the launch page with a fresh action, exactly like before.
  const attempt = countTerminalExternalActionsForSubject(db, workspaceId, "paid_launch", launchId);
  return {
    workspaceId,
    kind: "paid_launch",
    idempotencyKey: `paid_launch:${launchId}:${attempt}`,
    ...paidLaunchIntent(db, workspaceId, launchId),
  };
}

function asPaidLaunchPayload(payload: unknown): PaidLaunchActionPayload {
  return paidLaunchActionPayloadSchema.parse(payload);
}

function resolveAdsExecution(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  adAccountId: string,
): { adapter: AdsExecutionAdapter; externalAccountId: string } | null {
  const account = getAdAccount(db, workspaceId, adAccountId);
  if (!account) return null;
  const connection = account.connectionId
    ? getConnection(db, workspaceId, account.connectionId)
    : undefined;
  const provider = connection ? providerByKey(connection.providerKey) : undefined;
  const adapter =
    connection && provider && connection.status === "connected"
      ? adsExecutionAdapterFor(fabric, provider, connection, fetcher)
      : undefined;
  return adapter ? { adapter, externalAccountId: account.externalId } : null;
}

export function paidLaunchActionAdapter(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): ExternalActionAdapter {
  return {
    async revalidate(action, rawPayload) {
      const payload = asPaidLaunchPayload(rawPayload);
      return paidLaunchIntent(db, action.workspaceId, payload.launchId);
    },

    async guard(action, rawPayload): Promise<ExternalActionBlocker | null> {
      const payload = asPaidLaunchPayload(rawPayload);
      const launch = getAdLaunch(db, action.workspaceId, payload.launchId);
      if (!launch) {
        return {
          code: "launch_missing",
          message: "The ad launch behind this action no longer exists.",
          retryable: false,
        };
      }
      if (launch.status === "launched" && launch.externalActionId !== action.id) {
        return {
          code: "already_launched",
          message: "This launch already went out.",
          retryable: false,
        };
      }
      if (!resolveAdsExecution(db, fabric, fetcher, action.workspaceId, payload.adAccountId)) {
        return {
          code: "account_not_launchable",
          message:
            "This ad account has no connected ads platform behind it — launches need a live connection.",
          retryable: true,
        };
      }
      const guardrails = checkSpendGuardrails(db, launch);
      if (!guardrails.ok) {
        return { code: guardrails.error, message: guardrails.message, retryable: true };
      }
      return null;
    },

    async execute(action, rawPayload): Promise<ExternalActionExecutionRef> {
      const payload = asPaidLaunchPayload(rawPayload);
      const launch = getAdLaunch(db, action.workspaceId, payload.launchId);
      if (!launch) {
        return {
          kind: "ad_launch",
          id: payload.launchId,
          status: "failed",
          url: null,
          error: "The ad launch behind this action no longer exists.",
        };
      }
      if (launch.status === "launched" && launch.externalActionId === action.id) {
        return { kind: "ad_launch", id: launch.id, status: "launched", url: null, error: null };
      }
      db.update(adLaunches)
        .set({ externalActionId: action.id, updatedAt: Date.now() })
        .where(eq(adLaunches.id, launch.id))
        .run();
      const resolved = resolveAdsExecution(db, fabric, fetcher, action.workspaceId, payload.adAccountId);
      if (!resolved) {
        return {
          kind: "ad_launch",
          id: launch.id,
          status: "failed",
          url: null,
          error: "This ad account has no connected ads platform behind it.",
        };
      }
      try {
        const launched = await performLaunch(
          db,
          resolved.adapter,
          launch,
          payload.externalAccountId,
          payload.creative,
          { userId: action.proposedBy.userId, label: action.proposedBy.label },
          payload.imageUrl,
        );
        await emitEvent(db, fetcher, action.workspaceId, "ad.launched", {
          launchId: launched.id,
          name: launched.name,
          objective: launched.objective,
          dailyBudgetCents: launched.dailyBudgetCents,
          externalCampaignId: launched.externalCampaignId,
          campaignId: launched.campaignId,
          actor: action.proposedBy.label,
        });
        return { kind: "ad_launch", id: launched.id, status: "launched", url: null, error: null };
      } catch (err) {
        return {
          kind: "ad_launch",
          id: launch.id,
          status: "failed",
          url: null,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Budget change actions (launched Meta ad sets)
// ---------------------------------------------------------------------------

function asBudgetChangePayload(payload: unknown): BudgetChangeIntent {
  return budgetChangeIntentSchema.parse(payload);
}

async function budgetChangeIntent(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  launchId: string,
  afterDailyBudgetCents: number,
  allowNoop: boolean,
): Promise<ExternalActionIntent> {
  const launch = getAdLaunch(db, workspaceId, launchId);
  if (!launch) {
    throw new ExternalActionPreparationError("launch_not_found", "Launch not found.", 404);
  }
  if (launch.status !== "launched" || !launch.externalAdSetId) {
    throw new ExternalActionPreparationError(
      "launch_not_eligible",
      "Budget can change only after the Meta ad set has launched.",
      409,
    );
  }
  const account = getAdAccount(db, workspaceId, launch.adAccountId);
  if (!account) {
    throw new ExternalActionPreparationError("account_not_found", "No such ad account.", 404);
  }
  const resolved = resolveAdsExecution(db, fabric, fetcher, workspaceId, launch.adAccountId);
  if (!resolved) {
    throw new ExternalActionPreparationError(
      "account_not_launchable",
      "Reconnect the Meta ad account before changing its budget.",
      409,
    );
  }
  const provider = await resolved.adapter.getAdSetState(
    resolved.externalAccountId,
    launch.externalAdSetId,
  );
  if (!allowNoop && provider.dailyBudgetCents === afterDailyBudgetCents) {
    throw new ExternalActionPreparationError(
      "budget_unchanged",
      "Choose a budget different from the current Meta budget.",
      400,
    );
  }
  const rawPayload = {
    launchId: launch.id,
    adAccountId: account.id,
    externalAccountId: account.externalId,
    externalAdSetId: launch.externalAdSetId,
    currency: account.currency,
    beforeDailyBudgetCents: provider.dailyBudgetCents,
    afterDailyBudgetCents,
    providerUpdatedAt: provider.updatedAt,
  };
  const payload = allowNoop ? rawPayload : budgetChangeIntentSchema.parse(rawPayload);
  const campaign = launch.campaignId ? getCampaign(db, workspaceId, launch.campaignId) : undefined;
  return {
    subject: {
      kind: "ad_launch",
      id: launch.id,
      title: `Change budget · ${launch.name}`,
      summary: `${account.currency} ${provider.dailyBudgetCents} → ${afterDailyBudgetCents} cents/day`,
      channel: "ads",
      destination: `${account.name} · ${launch.externalAdSetId}`,
    },
    context: {
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? null,
      personaId: null,
      personaName: null,
      connectionId: account.connectionId,
      connectionName: account.name,
      laneRevisionId: null,
      laneName: null,
    },
    payload,
    requestedFor: null,
  };
}

export async function prepareBudgetChangeAction(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  launchId: string,
  input: ProposeBudgetChangeInput,
): Promise<ExternalActionCommand> {
  return {
    workspaceId,
    kind: "budget_change",
    idempotencyKey: input.idempotencyKey,
    ...(await budgetChangeIntent(
      db,
      fabric,
      fetcher,
      workspaceId,
      launchId,
      input.dailyBudgetCents,
      false,
    )),
  };
}

export function budgetChangeActionAdapter(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): ExternalActionAdapter {
  return {
    async revalidate(action, rawPayload) {
      const payload = asBudgetChangePayload(rawPayload);
      return budgetChangeIntent(
        db,
        fabric,
        fetcher,
        action.workspaceId,
        payload.launchId,
        payload.afterDailyBudgetCents,
        true,
      );
    },

    async guard(action, rawPayload): Promise<ExternalActionBlocker | null> {
      const payload = asBudgetChangePayload(rawPayload);
      const launch = getAdLaunch(db, action.workspaceId, payload.launchId);
      if (!launch || launch.status !== "launched" || !launch.externalAdSetId) {
        return {
          code: "launch_not_eligible",
          message: "The launched Meta ad set is no longer available.",
          retryable: false,
        };
      }
      if (!resolveAdsExecution(db, fabric, fetcher, action.workspaceId, payload.adAccountId)) {
        return {
          code: "connection_unhealthy",
          message: "Reconnect the Meta ad account before changing its budget.",
          retryable: true,
        };
      }
      const guardrails = checkSpendGuardrails(db, {
        ...launch,
        dailyBudgetCents: payload.afterDailyBudgetCents,
      });
      if (!guardrails.ok) {
        return {
          code: guardrails.error === "kill_switch_on" ? "kill_switch" : guardrails.error,
          message: guardrails.message,
          retryable: true,
        };
      }
      return null;
    },

    async execute(action, rawPayload): Promise<ExternalActionExecutionRef> {
      const payload = asBudgetChangePayload(rawPayload);
      const resolved = resolveAdsExecution(
        db,
        fabric,
        fetcher,
        action.workspaceId,
        payload.adAccountId,
      );
      if (!resolved) {
        return {
          kind: "ad_mutation",
          id: payload.launchId,
          status: "failed",
          url: null,
          error: "The Meta ad account is not connected.",
        };
      }
      try {
        const updated = await resolved.adapter.updateDailyBudget(
          resolved.externalAccountId,
          payload.externalAdSetId,
          payload.afterDailyBudgetCents,
        );
        if (updated.dailyBudgetCents !== payload.afterDailyBudgetCents) {
          throw new Error("Meta did not confirm the requested daily budget.");
        }
        db.update(adLaunches)
          .set({ dailyBudgetCents: updated.dailyBudgetCents, updatedAt: Date.now() })
          .where(eq(adLaunches.id, payload.launchId))
          .run();
        return {
          kind: "ad_mutation",
          id: payload.launchId,
          status: "budget_updated",
          url: null,
          error: null,
        };
      } catch (error) {
        return {
          kind: "ad_mutation",
          id: payload.launchId,
          status: "failed",
          url: null,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Targeting change actions (launched Meta ad sets)
// ---------------------------------------------------------------------------

function asTargetingChangePayload(payload: unknown): TargetingChangeIntent {
  return targetingChangeIntentSchema.parse(payload);
}

function sameTargeting(
  left: { countries: string[]; ageMin: number; ageMax: number },
  right: { countries: string[]; ageMin: number; ageMax: number },
): boolean {
  return (
    left.ageMin === right.ageMin &&
    left.ageMax === right.ageMax &&
    left.countries.length === right.countries.length &&
    left.countries.every((country, index) => country === right.countries[index])
  );
}

async function targetingChangeIntent(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  launchId: string,
  after: TargetingChangeIntent["after"],
  allowNoop: boolean,
): Promise<ExternalActionIntent> {
  const launch = getAdLaunch(db, workspaceId, launchId);
  if (!launch) {
    throw new ExternalActionPreparationError("launch_not_found", "Launch not found.", 404);
  }
  if (launch.status !== "launched" || !launch.externalAdSetId) {
    throw new ExternalActionPreparationError(
      "launch_not_eligible",
      "Targeting can change only after the Meta ad set has launched.",
      409,
    );
  }
  const account = getAdAccount(db, workspaceId, launch.adAccountId);
  if (!account) {
    throw new ExternalActionPreparationError("account_not_found", "No such ad account.", 404);
  }
  const resolved = resolveAdsExecution(db, fabric, fetcher, workspaceId, launch.adAccountId);
  if (!resolved) {
    throw new ExternalActionPreparationError(
      "account_not_launchable",
      "Reconnect the Meta ad account before changing its targeting.",
      409,
    );
  }
  const provider = await resolved.adapter.getAdSetState(
    resolved.externalAccountId,
    launch.externalAdSetId,
  );
  const before = {
    countries: provider.countries,
    ageMin: provider.ageMin,
    ageMax: provider.ageMax,
  };
  if (!allowNoop && sameTargeting(before, after)) {
    throw new ExternalActionPreparationError(
      "targeting_unchanged",
      "Choose targeting different from the current Meta targeting.",
      400,
    );
  }
  const rawPayload = {
    launchId: launch.id,
    adAccountId: account.id,
    externalAccountId: account.externalId,
    externalAdSetId: launch.externalAdSetId,
    before,
    after,
    providerUpdatedAt: provider.updatedAt,
  };
  const payload = allowNoop ? rawPayload : targetingChangeIntentSchema.parse(rawPayload);
  const campaign = launch.campaignId ? getCampaign(db, workspaceId, launch.campaignId) : undefined;
  return {
    subject: {
      kind: "ad_launch",
      id: launch.id,
      title: `Change targeting · ${launch.name}`,
      summary: `${before.countries.join(", ")} · ages ${before.ageMin}–${before.ageMax} → ${after.countries.join(", ")} · ages ${after.ageMin}–${after.ageMax}`,
      channel: "ads",
      destination: `${account.name} · ${launch.externalAdSetId}`,
    },
    context: {
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? null,
      personaId: null,
      personaName: null,
      connectionId: account.connectionId,
      connectionName: account.name,
      laneRevisionId: null,
      laneName: null,
    },
    payload,
    requestedFor: null,
  };
}

export async function prepareTargetingChangeAction(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  launchId: string,
  input: ProposeTargetingChangeInput,
): Promise<ExternalActionCommand> {
  return {
    workspaceId,
    kind: "targeting_change",
    idempotencyKey: input.idempotencyKey,
    ...(await targetingChangeIntent(
      db,
      fabric,
      fetcher,
      workspaceId,
      launchId,
      {
        countries: input.countries,
        ageMin: input.ageMin,
        ageMax: input.ageMax,
      },
      false,
    )),
  };
}

export function targetingChangeActionAdapter(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): ExternalActionAdapter {
  return {
    async revalidate(action, rawPayload) {
      const payload = asTargetingChangePayload(rawPayload);
      return targetingChangeIntent(
        db,
        fabric,
        fetcher,
        action.workspaceId,
        payload.launchId,
        payload.after,
        true,
      );
    },

    async guard(action, rawPayload): Promise<ExternalActionBlocker | null> {
      const payload = asTargetingChangePayload(rawPayload);
      const launch = getAdLaunch(db, action.workspaceId, payload.launchId);
      if (!launch || launch.status !== "launched" || !launch.externalAdSetId) {
        return {
          code: "launch_not_eligible",
          message: "The launched Meta ad set is no longer available.",
          retryable: false,
        };
      }
      if (!resolveAdsExecution(db, fabric, fetcher, action.workspaceId, payload.adAccountId)) {
        return {
          code: "connection_unhealthy",
          message: "Reconnect the Meta ad account before changing its targeting.",
          retryable: true,
        };
      }
      const guardrails = checkSpendGuardrails(db, launch);
      if (!guardrails.ok) {
        return {
          code: guardrails.error === "kill_switch_on" ? "kill_switch" : guardrails.error,
          message: guardrails.message,
          retryable: true,
        };
      }
      return null;
    },

    async execute(action, rawPayload): Promise<ExternalActionExecutionRef> {
      const payload = asTargetingChangePayload(rawPayload);
      const resolved = resolveAdsExecution(
        db,
        fabric,
        fetcher,
        action.workspaceId,
        payload.adAccountId,
      );
      if (!resolved) {
        return {
          kind: "ad_mutation",
          id: payload.launchId,
          status: "failed",
          url: null,
          error: "The Meta ad account is not connected.",
        };
      }
      try {
        const updated = await resolved.adapter.updateTargeting(
          resolved.externalAccountId,
          payload.externalAdSetId,
          payload.after,
        );
        const confirmed = {
          countries: updated.countries,
          ageMin: updated.ageMin,
          ageMax: updated.ageMax,
        };
        if (!sameTargeting(confirmed, payload.after)) {
          throw new Error("Meta did not confirm the requested targeting.");
        }
        persistLaunchTargeting(db, payload.launchId, confirmed);
        return {
          kind: "ad_mutation",
          id: payload.launchId,
          status: "targeting_updated",
          url: null,
          error: null,
        };
      } catch (error) {
        return {
          kind: "ad_mutation",
          id: payload.launchId,
          status: "failed",
          url: null,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        };
      }
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
    paid_launch: paidLaunchActionAdapter(db, fabric, fetcher),
    budget_change: budgetChangeActionAdapter(db, fabric, fetcher),
    targeting_change: targetingChangeActionAdapter(db, fabric, fetcher),
  };
}
