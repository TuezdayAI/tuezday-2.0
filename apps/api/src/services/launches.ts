import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  SOCIAL_POST_CONSTRAINTS,
  validateSocialPost,
  type Channel,
  type Connection,
  type CreateLaunchInput,
  type SocialPostConstraints,
  type DispatchChannelInput,
  type GenerateLaunchInput,
  type Launch,
  type LaunchChannel,
  type LaunchDetail,
  type LaunchMessage,
  type LaunchMessageKind,
  type LaunchMessageStatus,
  type Person,
  type TaskType,
} from "@tuezday/contracts";
import { resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import {
  drafts,
  launchMessages,
  launches,
  type DraftRow,
  type LaunchMessageRow,
  type LaunchRow,
} from "../db/schema";
import type { ConnectorFabric } from "../connectors/fabric";
import { socialAdapterFor, type PublishMedia } from "../connectors/social";
import type { EvidenceStore } from "../evidence/store";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { getAudienceDetail, loadPeople } from "./audiences";
import { getBrain } from "./brain";
import { composeCampaignOverlay, getCampaign } from "./campaigns";
import { listConnections, providerByKey } from "./connections";
import type { DraftActor } from "./drafts";
import { submitDraft } from "./drafts";
import { retrieveEvidence } from "./evidence";
import { storeGeneration } from "./generations";
import type { OutboundExporter, OutboundExport } from "../outbound/exporter";
import { getPersona } from "./personas";
import { createPublication } from "./publications";
import { getWorkspace } from "./workspaces";

type Fetcher = typeof fetch;

/** Channel → connector provider key. email has no connector (CSV export). */
export const LAUNCH_CHANNEL_PROVIDER: Record<LaunchChannel, string | null> = {
  email: null,
  linkedin: "linkedin",
  instagram: "instagram",
  x: "twitter",
};

/** Per-channel generation shape: which task type / resolver channel / message kind. */
const CHANNEL_GEN: Record<
  LaunchChannel,
  { taskType: TaskType; channel: Channel; kind: LaunchMessageKind }
> = {
  email: { taskType: "outbound_email", channel: "email", kind: "personalized" },
  x: { taskType: "x_dm", channel: "x", kind: "personalized" },
  linkedin: { taskType: "linkedin_post", channel: "linkedin", kind: "broadcast" },
  instagram: { taskType: "instagram_post", channel: "instagram", kind: "broadcast" },
};

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function parseChannels(row: LaunchRow): LaunchChannel[] {
  return JSON.parse(row.channelsJson) as LaunchChannel[];
}

function rowToLaunch(row: LaunchRow, messageCount: number): Launch {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    audienceId: row.audienceId,
    campaignId: row.campaignId,
    personaId: row.personaId,
    channels: parseChannels(row),
    status: row.status as Launch["status"],
    messageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToMessage(row: LaunchMessageRow, draft: DraftRow | null): LaunchMessage {
  return {
    id: row.id,
    launchId: row.launchId,
    channel: row.channel as LaunchChannel,
    kind: row.kind as LaunchMessageKind,
    recipientType: row.recipientType as LaunchMessage["recipientType"],
    recipientId: row.recipientId,
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmail,
    recipientHandle: row.recipientHandle,
    draftId: row.draftId,
    status: row.status as LaunchMessageStatus,
    skipReason: row.skipReason,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    sentAt: row.sentAt,
    lastError: row.lastError,
    draftState: draft ? (draft.state as LaunchMessage["draftState"]) : null,
    draftContent: draft ? draft.content : null,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function getLaunchRow(db: Db, workspaceId: string, launchId: string): LaunchRow | undefined {
  return db
    .select()
    .from(launches)
    .where(and(eq(launches.workspaceId, workspaceId), eq(launches.id, launchId)))
    .get();
}

function countMessages(db: Db, launchId: string): number {
  return db.select().from(launchMessages).where(eq(launchMessages.launchId, launchId)).all().length;
}

export function createLaunch(db: Db, workspaceId: string, input: CreateLaunchInput): Launch {
  const now = Date.now();
  const row: LaunchRow = {
    id: randomUUID(),
    workspaceId,
    name: input.name,
    audienceId: input.audienceId,
    campaignId: input.campaignId ?? null,
    personaId: input.personaId ?? null,
    channelsJson: JSON.stringify(input.channels),
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(launches).values(row).run();
  return rowToLaunch(row, 0);
}

export function listLaunches(db: Db, workspaceId: string): Launch[] {
  return db
    .select()
    .from(launches)
    .where(eq(launches.workspaceId, workspaceId))
    .orderBy(desc(launches.createdAt))
    .all()
    .map((row) => rowToLaunch(row, countMessages(db, row.id)));
}

export function getLaunch(db: Db, workspaceId: string, launchId: string): Launch | undefined {
  const row = getLaunchRow(db, workspaceId, launchId);
  return row ? rowToLaunch(row, countMessages(db, row.id)) : undefined;
}

export function getLaunchDetail(
  db: Db,
  workspaceId: string,
  launchId: string,
): LaunchDetail | undefined {
  const row = getLaunchRow(db, workspaceId, launchId);
  if (!row) return undefined;
  const joined = db
    .select({ message: launchMessages, draft: drafts })
    .from(launchMessages)
    .leftJoin(drafts, eq(launchMessages.draftId, drafts.id))
    .where(eq(launchMessages.launchId, launchId))
    .orderBy(launchMessages.createdAt)
    .all();
  const messages = joined.map(({ message, draft }) => rowToMessage(message, draft ?? null));
  const recipientCount = new Set(
    messages.filter((m) => m.recipientId).map((m) => `${m.recipientType}:${m.recipientId}`),
  ).size;
  return { launch: rowToLaunch(row, messages.length), messages, recipientCount };
}

export function deleteLaunch(db: Db, workspaceId: string, launchId: string): boolean {
  if (!getLaunchRow(db, workspaceId, launchId)) return false;
  db.delete(launches).where(eq(launches.id, launchId)).run();
  return true;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function insertMessage(db: Db, fields: Partial<LaunchMessageRow> & {
  workspaceId: string;
  launchId: string;
  channel: LaunchChannel;
  kind: LaunchMessageKind;
}): void {
  const now = Date.now();
  db.insert(launchMessages)
    .values({
      id: randomUUID(),
      recipientType: null,
      recipientId: null,
      recipientName: "",
      recipientEmail: "",
      recipientHandle: null,
      draftId: null,
      status: "pending",
      skipReason: null,
      externalId: null,
      externalUrl: null,
      publicationId: null,
      sentAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      ...fields,
    })
    .run();
}

function setStatus(db: Db, launchId: string, status: Launch["status"]): void {
  db.update(launches).set({ status, updatedAt: Date.now() }).where(eq(launches.id, launchId)).run();
}

export type GenerateLaunchResult =
  | { ok: true; detail: LaunchDetail }
  | { ok: false; error: "launch_not_found" | "not_draft" | "audience_not_found" };

/**
 * Resolve the audience to recipients, then per channel: a brain-resolved,
 * approval-gated draft per recipient (email, X DM) or one broadcast draft
 * (LinkedIn, Instagram). X recipients without a handle are skipped, no LLM call.
 */
export async function generateLaunch(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  workspaceId: string,
  launchId: string,
  input: GenerateLaunchInput,
  actor: DraftActor,
): Promise<GenerateLaunchResult> {
  const launchRow = getLaunchRow(db, workspaceId, launchId);
  if (!launchRow) return { ok: false, error: "launch_not_found" };
  if (launchRow.status !== "draft") return { ok: false, error: "not_draft" };
  const audience = launchRow.audienceId
    ? getAudienceDetail(db, workspaceId, launchRow.audienceId)
    : undefined;
  if (!audience) return { ok: false, error: "audience_not_found" };

  setStatus(db, launchId, "generating");

  const workspace = getWorkspace(db, workspaceId)!;
  const channels = parseChannels(launchRow);
  const campaign = launchRow.campaignId ? getCampaign(db, workspaceId, launchRow.campaignId) : undefined;
  const persona = launchRow.personaId ? getPersona(db, workspaceId, launchRow.personaId) : undefined;
  const personaArg = persona
    ? { name: persona.name, description: persona.description, overlay: persona.overlay }
    : undefined;
  const campaignArg = campaign
    ? { name: campaign.name, overlay: composeCampaignOverlay(campaign) }
    : undefined;
  const { docs } = getBrain(db, workspaceId);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  const recipients = audience.members;

  for (const channel of channels) {
    const gen = CHANNEL_GEN[channel];
    const evidenceResolution = await retrieveEvidence(
      db,
      evidence,
      workspaceId,
      { taskType: gen.taskType, channel: gen.channel, campaignObjective: campaign?.objective },
      input.useEvidence ?? true,
    );

    const draftFrom = async (lead: Person | undefined): Promise<string | { error: string }> => {
      const resolved = resolveContext({
        workspaceName: workspace.name,
        docs: contents,
        taskType: gen.taskType,
        channel: gen.channel,
        persona: personaArg,
        campaign: campaignArg,
        lead: lead ? { name: lead.name, company: lead.company, role: lead.role, notes: "" } : undefined,
        evidence: evidenceResolution.evidence,
        evidenceExclusionReason: evidenceResolution.exclusionReason,
        tokenBudget: input.tokenBudget,
      });
      try {
        const result = await llm.generate({ prompt: resolved.prompt });
        const generation = storeGeneration(db, {
          workspaceId,
          taskType: gen.taskType,
          channel: gen.channel,
          personaId: launchRow.personaId,
          campaignId: launchRow.campaignId,
          leadId: lead?.type === "lead" ? lead.id : null,
          resolved,
          output: result.text,
          model: result.model,
          provider: result.provider,
          durationMs: result.durationMs,
        });
        const draft = submitDraft(
          db,
          {
            workspaceId,
            sourceGenerationId: generation.id,
            campaignId: launchRow.campaignId,
            leadId: lead?.type === "lead" ? lead.id : null,
            taskType: gen.taskType,
            channel: gen.channel,
            personaId: launchRow.personaId,
            content: result.text,
          },
          actor,
        );
        return draft.id;
      } catch (err) {
        if (err instanceof GatewayError) return { error: err.message };
        throw err;
      }
    };

    if (gen.kind === "personalized") {
      for (const r of recipients) {
        const base = {
          workspaceId,
          launchId,
          channel,
          kind: gen.kind,
          recipientType: r.type,
          recipientId: r.id,
          recipientName: r.name,
          recipientEmail: r.email,
        };
        if (channel === "x") {
          const handle = r.xHandle?.trim();
          if (!handle) {
            insertMessage(db, {
              ...base,
              status: "skipped",
              skipReason: r.type === "contact" ? "No X handle (CRM contact)." : "No X handle on this lead.",
            });
            continue;
          }
          const made = await draftFrom(r);
          if (typeof made === "string") {
            insertMessage(db, { ...base, recipientHandle: handle, draftId: made, status: "pending" });
          } else {
            insertMessage(db, { ...base, recipientHandle: handle, status: "failed", lastError: made.error });
          }
        } else {
          const made = await draftFrom(r);
          if (typeof made === "string") {
            insertMessage(db, { ...base, draftId: made, status: "pending" });
          } else {
            insertMessage(db, { ...base, status: "failed", lastError: made.error });
          }
        }
      }
    } else {
      const made = await draftFrom(undefined);
      const base = {
        workspaceId,
        launchId,
        channel,
        kind: gen.kind,
        recipientName: campaign?.name ?? launchRow.name,
      };
      if (typeof made === "string") {
        insertMessage(db, { ...base, draftId: made, status: "pending" });
      } else {
        insertMessage(db, { ...base, status: "failed", lastError: made.error });
      }
    }
  }

  setStatus(db, launchId, "ready");
  return { ok: true, detail: getLaunchDetail(db, workspaceId, launchId)! };
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

function draftRow(db: Db, draftId: string | null): DraftRow | undefined {
  if (!draftId) return undefined;
  return db.select().from(drafts).where(eq(drafts.id, draftId)).get();
}

function isApproved(db: Db, draftId: string | null): boolean {
  return draftRow(db, draftId)?.state === "approved";
}

type ConnResolution =
  | { ok: true; connection: Connection }
  | { ok: false; error: "no_connection" | "ambiguous_connection" };

function resolveConnection(
  db: Db,
  workspaceId: string,
  providerKey: string,
  connectionId: string | undefined,
): ConnResolution {
  const candidates = listConnections(db, workspaceId).filter(
    (c) => c.providerKey === providerKey && c.status === "connected",
  );
  if (connectionId) {
    const found = candidates.find((c) => c.id === connectionId);
    return found ? { ok: true, connection: found } : { ok: false, error: "no_connection" };
  }
  if (candidates.length === 0) return { ok: false, error: "no_connection" };
  if (candidates.length > 1) return { ok: false, error: "ambiguous_connection" };
  return { ok: true, connection: candidates[0]! };
}

export interface DispatchMessageResult {
  messageId: string;
  recipient: string;
  status: LaunchMessageStatus;
  url?: string | null;
  error?: string | null;
}

export type DispatchResult =
  | { ok: true; results: DispatchMessageResult[] }
  | {
      ok: false;
      error:
        | "launch_not_found"
        | "channel_not_selected"
        | "not_generated"
        | "media_required"
        | "no_connection"
        | "ambiguous_connection"
        | "validation_failed";
      message?: string;
    };

// ---------------------------------------------------------------------------
// Email export
// ---------------------------------------------------------------------------

export type ExportEmailResult =
  | { ok: true; export: OutboundExport }
  | { ok: false; error: "launch_not_found" | "channel_not_selected" };

export function exportLaunchEmail(
  db: Db,
  exporter: OutboundExporter,
  workspaceId: string,
  launchId: string,
): ExportEmailResult {
  const launchRow = getLaunchRow(db, workspaceId, launchId);
  if (!launchRow) return { ok: false, error: "launch_not_found" };
  if (!parseChannels(launchRow).includes("email")) {
    return { ok: false, error: "channel_not_selected" };
  }
  const pool = new Map(loadPeople(db, workspaceId).map((p) => [`${p.type}:${p.id}`, p]));
  const rows = db
    .select()
    .from(launchMessages)
    .where(and(eq(launchMessages.launchId, launchId), eq(launchMessages.channel, "email")))
    .all();

  const messages = [];
  const now = Date.now();
  for (const row of rows) {
    const draft = draftRow(db, row.draftId);
    if (draft?.state !== "approved") continue;
    const person = pool.get(`${row.recipientType}:${row.recipientId}`);
    messages.push({
      name: row.recipientName,
      email: row.recipientEmail,
      company: person?.company ?? "",
      role: person?.role ?? "",
      body: draft.content,
    });
    db.update(launchMessages)
      .set({ status: "sent", sentAt: now, updatedAt: now })
      .where(eq(launchMessages.id, row.id))
      .run();
  }
  return { ok: true, export: exporter.export(messages) };
}

// ---------------------------------------------------------------------------
// Social dispatch (LinkedIn / Instagram broadcast, X DMs)
// ---------------------------------------------------------------------------

export async function dispatchChannel(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  launchId: string,
  channel: LaunchChannel,
  input: DispatchChannelInput,
): Promise<DispatchResult> {
  const launchRow = getLaunchRow(db, workspaceId, launchId);
  if (!launchRow) return { ok: false, error: "launch_not_found" };
  if (!parseChannels(launchRow).includes(channel)) {
    return { ok: false, error: "channel_not_selected" };
  }
  if (launchRow.status === "draft") return { ok: false, error: "not_generated" };

  const providerKey = LAUNCH_CHANNEL_PROVIDER[channel];
  if (!providerKey) {
    // email is exported, not dispatched here.
    return { ok: false, error: "channel_not_selected", message: "Use the CSV export for email." };
  }
  const conn = resolveConnection(db, workspaceId, providerKey, input.connectionId);
  if (!conn.ok) return { ok: false, error: conn.error };
  const connection = conn.connection;

  const rows = db
    .select()
    .from(launchMessages)
    .where(and(eq(launchMessages.launchId, launchId), eq(launchMessages.channel, channel)))
    .all();

  const results: DispatchMessageResult[] = [];
  const now = Date.now();

  if (channel === "linkedin" || channel === "instagram") {
    const row = rows.find((r) => r.kind === "broadcast");
    if (!row) return { ok: true, results };
    const draft = draftRow(db, row.draftId);
    if (draft?.state !== "approved") {
      results.push({ messageId: row.id, recipient: "Broadcast post", status: row.status as LaunchMessageStatus, error: "Draft is not approved yet." });
      return { ok: true, results };
    }
    const media: PublishMedia[] | undefined = input.media?.map((m) => ({ url: m.url, type: m.type }));
    const constraints = SOCIAL_POST_CONSTRAINTS[
      providerKey as keyof typeof SOCIAL_POST_CONSTRAINTS
    ] as SocialPostConstraints | undefined;
    if (constraints?.requiresMedia && (!media || media.length === 0)) {
      return { ok: false, error: "media_required" };
    }
    const validation = validateSocialPost(providerKey, {
      target: "feed",
      title: launchRow.name,
      body: draft.content,
    });
    if (!validation.ok) {
      return { ok: false, error: "validation_failed", message: validation.violations.map((v) => v.message).join(" ") };
    }
    const publication = await createPublication(
      db,
      fabric,
      fetcher,
      workspaceId,
      draft.id,
      connection,
      { connectionId: connection.id, target: "feed", title: launchRow.name },
      media,
    );
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
        .where(eq(launchMessages.id, row.id))
        .run();
      results.push({ messageId: row.id, recipient: "Broadcast post", status: "sent", url: publication.externalUrl });
    } else {
      db.update(launchMessages)
        .set({ status: "failed", publicationId: publication.id, lastError: publication.lastError, updatedAt: now })
        .where(eq(launchMessages.id, row.id))
        .run();
      results.push({ messageId: row.id, recipient: "Broadcast post", status: "failed", error: publication.lastError });
    }
    maybeComplete(db, workspaceId, launchId);
    return { ok: true, results };
  }

  // channel === "x": per-recipient DM
  const provider = providerByKey(providerKey)!;
  const adapter = socialAdapterFor(fabric, provider, connection);
  for (const row of rows) {
    if (row.status === "skipped") continue;
    const draft = draftRow(db, row.draftId);
    if (draft?.state !== "approved") {
      results.push({ messageId: row.id, recipient: row.recipientName, status: row.status as LaunchMessageStatus, error: "Draft is not approved yet." });
      continue;
    }
    try {
      if (!adapter?.sendDm) throw new Error("The X connection is not available — reconnect it on the Integrations page.");
      const res = await adapter.sendDm({ recipientHandle: row.recipientHandle ?? "", body: draft.content });
      db.update(launchMessages)
        .set({ status: "sent", sentAt: now, externalId: res.externalId, externalUrl: res.url || null, lastError: null, updatedAt: now })
        .where(eq(launchMessages.id, row.id))
        .run();
      results.push({ messageId: row.id, recipient: row.recipientName, status: "sent" });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      db.update(launchMessages)
        .set({ status: "failed", lastError: message, updatedAt: now })
        .where(eq(launchMessages.id, row.id))
        .run();
      results.push({ messageId: row.id, recipient: row.recipientName, status: "failed", error: message });
    }
  }
  maybeComplete(db, workspaceId, launchId);
  return { ok: true, results };
}

/** Flip a launch to completed once no message is still pending. Coarse — the
 * per-message status is the real detail. */
function maybeComplete(db: Db, workspaceId: string, launchId: string): void {
  const pending = db
    .select()
    .from(launchMessages)
    .where(and(eq(launchMessages.launchId, launchId), eq(launchMessages.status, "pending")))
    .all();
  if (pending.length === 0) setStatus(db, launchId, "completed");
}
