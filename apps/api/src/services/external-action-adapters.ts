import { z } from "zod";
import {
  publishDraftInputSchema,
  validateSocialPost,
  type ExternalAction,
  type ExternalActionBlocker,
  type ExternalActionExecutionRef,
  type PublishDraftInput,
} from "@tuezday/contracts";
import type { ConnectorFabric } from "../connectors/fabric";
import type { PublishMedia } from "../connectors/social";
import type { Db } from "../db";
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
import { getDraft } from "./drafts";
import { getPersona } from "./personas";
import { resolvePersonaSocialConnection } from "./persona-social-accounts";
import {
  createPublication,
  findLivePublication,
  getPublicationByExternalAction,
} from "./publications";

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

export function createExternalActionAdapters(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): ExternalActionAdapterRegistry {
  return { publish: publishActionAdapter(db, fabric, fetcher) };
}
