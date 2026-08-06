import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  type Channel,
  type Connection,
  type CreateLaunchInput,
  type DispatchChannelInput,
  type ExternalActionActor,
  type ExternalActionSubmission,
  type GenerateLaunchInput,
  type Launch,
  type LaunchChannel,
  type LaunchDetail,
  type LaunchMessage,
  type LaunchMessageKind,
  type LaunchMessageStatus,
  type Person,
  type TaskType,
  type UpdateLaunchSequenceConfigInput,
} from "@tuezday/contracts";
import { resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db, DbExecutor } from "../db";
import {
  drafts,
  launchMessages,
  launches,
  type DraftRow,
  type LaunchMessageRow,
  type LaunchRow,
} from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { meteredLlm } from "../llm/metered";
import { getAudienceDetail, loadPeople } from "./audiences";
import { getBrain } from "./brain";
import { getCampaign } from "./campaigns";
import {
  ExternalActionPreparationError,
  deriveSendIdempotencyKey,
  prepareSendAction,
} from "./external-action-adapters";
import type {
  ExternalActionRuntime,
  ExternalActionRuntimeActor,
} from "./external-action-coordinator";
import { getExternalAction } from "./external-actions";
import {
  deriveEmailSendIdempotencyKey,
  prepareEmailAction,
} from "./external-action-email";
import { resolveChannelGuidance } from "./guidance";
import { campaignResolveInputs, selectiveContextInputs } from "./resolve-input";
import { listConnections } from "./connections";
import type { DraftActor } from "./drafts";
import { submitDraftInTransaction } from "./drafts";
import { retrieveEvidence } from "./evidence";
import { storeGeneration } from "./generations";
import type { OutboundExporter, OutboundExport } from "../outbound/exporter";
import { getPersona, toResolvePersona } from "./personas";
import { resolveDraftAccount } from "./resolve-account";
import { resolvePersonaSocialConnection } from "./persona-social-accounts";
import { hasSequence, listSequenceRecipients, listSequenceSteps } from "./launch-sequences";
import { getWorkspace } from "./workspaces";
import { enqueueBackgroundJob } from "./background-jobs";

/** Channel → connector provider key. Native email uses the outbound provider. */
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
    automationMode: row.automationMode as Launch["automationMode"],
    stopOnReply: row.stopOnReply === 1,
    xConnectionId: row.xConnectionId,
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
    externalActionId: row.externalActionId,
    status: row.status as LaunchMessageStatus,
    skipReason: row.skipReason,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    sentAt: row.sentAt,
    lastError: row.lastError,
    stepNumber: row.stepNumber,
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
    automationMode: input.automationMode,
    stopOnReply: input.stopOnReply ? 1 : 0,
    xConnectionId: null,
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
  return {
    launch: rowToLaunch(row, messages.length),
    messages,
    steps: listSequenceSteps(db, launchId),
    sequenceRecipients: listSequenceRecipients(db, launchId),
    recipientCount,
  };
}

/** Patch the launch's sequence config (mode / stop-on-reply / X connection) without
 * touching anything else — a name edit never resets automation (the S28 pattern). */
export function updateLaunchSequenceConfig(
  db: Db,
  workspaceId: string,
  launchId: string,
  input: UpdateLaunchSequenceConfigInput,
): Launch | undefined {
  const row = getLaunchRow(db, workspaceId, launchId);
  if (!row) return undefined;
  const set: Partial<LaunchRow> = { updatedAt: Date.now() };
  if (input.automationMode !== undefined) set.automationMode = input.automationMode;
  if (input.stopOnReply !== undefined) set.stopOnReply = input.stopOnReply ? 1 : 0;
  if (input.xConnectionId !== undefined) set.xConnectionId = input.xConnectionId;
  db.update(launches).set(set).where(eq(launches.id, launchId)).run();
  return getLaunch(db, workspaceId, launchId);
}

export function deleteLaunch(db: Db, workspaceId: string, launchId: string): boolean {
  if (!getLaunchRow(db, workspaceId, launchId)) return false;
  db.delete(launches).where(eq(launches.id, launchId)).run();
  return true;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function launchGenerationUnitId(input: {
  launchId: string;
  channel: LaunchChannel;
  kind: LaunchMessageKind;
  recipientType?: string | null;
  recipientId?: string | null;
}): string {
  const hash = createHash("sha256")
    .update([
      "launch-generation:v1",
      input.launchId,
      input.channel,
      input.kind,
      input.recipientType ?? "broadcast",
      input.recipientId ?? "broadcast",
    ].join(":"))
    .digest("hex")
    .slice(0, 32)
    .split("");
  // A stable RFC-4122-shaped id remains compatible with every existing
  // launch-message path while the primary key acts as the replay fence.
  hash[12] = "5";
  hash[16] = ["8", "9", "a", "b"][Number.parseInt(hash[16]!, 16) % 4]!;
  const hex = hash.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function insertMessage(db: DbExecutor, id: string, fields: Partial<LaunchMessageRow> & {
  workspaceId: string;
  launchId: string;
  channel: LaunchChannel;
  kind: LaunchMessageKind;
}): boolean {
  const now = Date.now();
  return Boolean(db.insert(launchMessages)
    .values({
      id,
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
    .onConflictDoNothing({ target: launchMessages.id })
    .returning({ id: launchMessages.id })
    .get());
}

function setStatus(db: Db, launchId: string, status: Launch["status"]): void {
  db.update(launches).set({ status, updatedAt: Date.now() }).where(eq(launches.id, launchId)).run();
}

export type EnqueueLaunchGenerationResult =
  | { ok: true; launch: Launch; jobId: string }
  | { ok: false; error: "launch_not_found" | "not_draft" | "audience_not_found" | "is_sequence" };

/** Validate and admit launch generation without doing any LLM work. */
export function enqueueLaunchGeneration(
  db: Db,
  workspaceId: string,
  launchId: string,
  input: GenerateLaunchInput,
  actor: DraftActor,
): EnqueueLaunchGenerationResult {
  const launchRow = getLaunchRow(db, workspaceId, launchId);
  if (!launchRow) return { ok: false, error: "launch_not_found" };
  if (hasSequence(db, launchId)) return { ok: false, error: "is_sequence" };
  if (launchRow.status !== "draft") return { ok: false, error: "not_draft" };
  const audience = launchRow.audienceId
    ? getAudienceDetail(db, workspaceId, launchRow.audienceId)
    : undefined;
  if (!audience) return { ok: false, error: "audience_not_found" };

  return db.transaction((tx): EnqueueLaunchGenerationResult => {
    const now = Date.now();
    const generating = tx
      .update(launches)
      .set({ status: "generating", updatedAt: now })
      .where(and(
        eq(launches.workspaceId, workspaceId),
        eq(launches.id, launchId),
        eq(launches.status, "draft"),
      ))
      .returning()
      .get();
    if (!generating) return { ok: false, error: "not_draft" };
    const job = enqueueBackgroundJob(tx, {
      payload: { kind: "launch_generate", workspaceId, launchId, input, actor },
      idempotencyKey: `launch-generate:v1:${launchId}`,
    });
    return { ok: true, launch: rowToLaunch(generating, 0), jobId: job.id };
  });
}

export type GenerateLaunchResult =
  | { ok: true; detail: LaunchDetail }
  | { ok: false; error: "launch_not_found" | "not_draft" | "audience_not_found" | "is_sequence" };

export interface ResumeLaunchGenerationOptions {
  signal?: AbortSignal;
  heartbeat?: () => boolean;
}

interface LaunchGenerationUnit {
  id: string;
  lead?: Person;
  message: Partial<LaunchMessageRow> & {
    workspaceId: string;
    launchId: string;
    channel: LaunchChannel;
    kind: LaunchMessageKind;
  };
  skipReason?: string;
}

class LaunchGenerationUnitConflict extends Error {}

function assertLaunchGenerationActive(options: ResumeLaunchGenerationOptions): void {
  if (options.signal?.aborted) throw new Error("launch_generation_aborted");
  if (options.heartbeat && !options.heartbeat()) {
    throw new Error("launch_generation_lease_lost");
  }
}

/**
 * Resolve the audience to recipients, then per channel: a brain-resolved,
 * approval-gated draft per recipient (email, X DM) or one broadcast draft
 * (LinkedIn, Instagram). X recipients without a handle are skipped, no LLM call.
 */
export async function resumeLaunchGeneration(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  workspaceId: string,
  launchId: string,
  input: GenerateLaunchInput,
  actor: DraftActor,
  options: ResumeLaunchGenerationOptions = {},
): Promise<GenerateLaunchResult> {
  const launchRow = getLaunchRow(db, workspaceId, launchId);
  if (!launchRow) return { ok: false, error: "launch_not_found" };
  if (hasSequence(db, launchId)) return { ok: false, error: "is_sequence" };
  if (launchRow.status !== "draft" && launchRow.status !== "generating") {
    return { ok: false, error: "not_draft" };
  }
  const audience = launchRow.audienceId
    ? getAudienceDetail(db, workspaceId, launchRow.audienceId)
    : undefined;
  if (!audience) return { ok: false, error: "audience_not_found" };

  if (launchRow.status === "draft") setStatus(db, launchId, "generating");

  const workspace = getWorkspace(db, workspaceId)!;
  const channels = parseChannels(launchRow);
  const campaign = launchRow.campaignId ? getCampaign(db, workspaceId, launchRow.campaignId) : undefined;
  const persona = launchRow.personaId ? getPersona(db, workspaceId, launchRow.personaId) : undefined;
  const personaArg = persona ? toResolvePersona(persona) : undefined;
  const campaignArgs = campaignResolveInputs(db, workspaceId, campaign);
  const { docs } = getBrain(db, workspaceId);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  const selective = selectiveContextInputs(db, workspaceId);
  const recipients = audience.members;
  const requiredUnitIds: string[] = [];

  for (const channel of channels) {
    const gen = CHANNEL_GEN[channel];
    const units: LaunchGenerationUnit[] = gen.kind === "personalized"
      ? recipients.map((recipient) => {
          const id = launchGenerationUnitId({
            launchId,
            channel,
            kind: gen.kind,
            recipientType: recipient.type,
            recipientId: recipient.id,
          });
          const handle = channel === "x" ? recipient.xHandle?.trim() : undefined;
          return {
            id,
            lead: recipient,
            message: {
              workspaceId,
              launchId,
              channel,
              kind: gen.kind,
              recipientType: recipient.type,
              recipientId: recipient.id,
              recipientName: recipient.name,
              recipientEmail: recipient.email,
              ...(handle ? { recipientHandle: handle } : {}),
            },
            ...(channel === "x" && !handle
              ? {
                  skipReason: recipient.type === "contact"
                    ? "No X handle (CRM contact)."
                    : "No X handle on this lead.",
                }
              : {}),
          };
        })
      : [{
          id: launchGenerationUnitId({ launchId, channel, kind: gen.kind }),
          message: {
            workspaceId,
            launchId,
            channel,
            kind: gen.kind,
            recipientName: campaign?.name ?? launchRow.name,
          },
        }];
    requiredUnitIds.push(...units.map((unit) => unit.id));

    const storedIds = new Set(
      db.select({ id: launchMessages.id })
        .from(launchMessages)
        .where(eq(launchMessages.launchId, launchId))
        .all()
        .map((row) => row.id),
    );
    const missing = units.filter((unit) => !storedIds.has(unit.id));
    for (const unit of missing.filter((candidate) => candidate.skipReason)) {
      insertMessage(db, unit.id, {
        ...unit.message,
        status: "skipped",
        skipReason: unit.skipReason,
      });
    }
    const draftUnits = missing.filter((unit) => !unit.skipReason);
    if (draftUnits.length === 0) continue;

    assertLaunchGenerationActive(options);
    // Sprint 43: pass the workspace's channel guidance — this path previously
    // fell back to the built-in default even when an override existed.
    // Sprint 44: scoped to the launch's persona/campaign, most-specific-wins.
    const channelGuidance = resolveChannelGuidance(db, workspaceId, gen.channel, {
      personaId: launchRow.personaId,
      campaignId: launchRow.campaignId,
    });
    const account = resolveDraftAccount(db, workspaceId, {
      personaId: launchRow.personaId,
      channel: gen.channel,
    });
    const evidenceResolution = await retrieveEvidence(
      db,
      evidence,
      workspaceId,
      { taskType: gen.taskType, channel: gen.channel, campaignObjective: campaign?.objective },
      input.useEvidence ?? true,
    );

    const persistDraftUnit = async (unit: LaunchGenerationUnit): Promise<void> => {
      const lead = unit.lead;
      const resolved = resolveContext({
        workspaceName: workspace.name,
        docs: contents,
        taskType: gen.taskType,
        channel: gen.channel,
        channelGuidance: {
          content: channelGuidance.content,
          source: channelGuidance.source,
          scope: channelGuidance.scopeLabel,
        },
        persona: personaArg,
        ...campaignArgs,
        account,
        lead: lead ? { name: lead.name, company: lead.company, role: lead.role, notes: "" } : undefined,
        ...selective,
        evidence: evidenceResolution.evidence,
        evidenceExclusionReason: evidenceResolution.exclusionReason,
        tokenBudget: input.tokenBudget,
      });
      try {
        const result = await meteredLlm(llm, db, {
          workspaceId,
          pipeline: "launch",
          campaignId: launchRow.campaignId ?? null,
        }).generate({ prompt: resolved.prompt });
        assertLaunchGenerationActive(options);
        try {
          db.transaction((tx) => {
            const generation = storeGeneration(tx, {
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
            const draft = submitDraftInTransaction(tx, {
              workspaceId,
              sourceGenerationId: generation.id,
              campaignId: launchRow.campaignId,
              leadId: lead?.type === "lead" ? lead.id : null,
              taskType: gen.taskType,
              channel: gen.channel,
              personaId: launchRow.personaId,
              content: result.text,
            }, actor);
            if (!insertMessage(tx, unit.id, {
              ...unit.message,
              draftId: draft.id,
              status: "pending",
            })) {
              throw new LaunchGenerationUnitConflict();
            }
          });
        } catch (error) {
          if (!(error instanceof LaunchGenerationUnitConflict)) throw error;
        }
      } catch (err) {
        if (err instanceof GatewayError) {
          insertMessage(db, unit.id, {
            ...unit.message,
            status: "failed",
            lastError: err.message,
          });
          return;
        }
        throw err;
      }
    };

    for (const unit of draftUnits) {
      await persistDraftUnit(unit);
    }
  }

  const terminalIds = new Set(
    db.select({ id: launchMessages.id })
      .from(launchMessages)
      .where(eq(launchMessages.launchId, launchId))
      .all()
      .map((row) => row.id),
  );
  if (!requiredUnitIds.every((id) => terminalIds.has(id))) {
    throw new Error("launch_generation_incomplete");
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

function resolveLaunchConnection(
  db: Db,
  workspaceId: string,
  launchRow: LaunchRow,
  channel: LaunchChannel,
  connectionId: string | undefined,
): ConnResolution {
  const providerKey = LAUNCH_CHANNEL_PROVIDER[channel];
  if (!providerKey) return { ok: false, error: "no_connection" };
  const routed = resolvePersonaSocialConnection(db, workspaceId, {
    personaId: launchRow.personaId,
    providerKey,
    channel,
    explicitConnectionId: connectionId,
  });
  if (routed.ok) return { ok: true, connection: routed.connection };
  if (routed.error === "persona_account_missing" && !launchRow.personaId) {
    return resolveConnection(db, workspaceId, providerKey, connectionId);
  }
  return {
    ok: false,
    error: routed.error === "persona_account_ambiguous" ? "ambiguous_connection" : "no_connection",
  };
}

export type DispatchResult =
  | { ok: true; submissions: ExternalActionSubmission[] }
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
  for (const row of rows) {
    const draft = draftRow(db, row.draftId);
    if (draft?.state !== "approved" || row.status === "sent" || row.status === "skipped") continue;
    const person = pool.get(`${row.recipientType}:${row.recipientId}`);
    messages.push({
      name: row.recipientName,
      email: row.recipientEmail,
      company: person?.company ?? "",
      role: person?.role ?? "",
      body: draft.content,
    });
  }
  return { ok: true, export: exporter.export(messages) };
}

// ---------------------------------------------------------------------------
// Native and social dispatch — proposes one
// durable `send` external action per eligible message; the action policy
// decides whether each executes immediately or waits for authorization.
// ---------------------------------------------------------------------------

export async function dispatchChannel(
  db: Db,
  runtime: ExternalActionRuntime,
  workspaceId: string,
  launchId: string,
  channel: LaunchChannel,
  input: DispatchChannelInput,
  actor: ExternalActionRuntimeActor,
): Promise<DispatchResult> {
  const launchRow = getLaunchRow(db, workspaceId, launchId);
  if (!launchRow) return { ok: false, error: "launch_not_found" };
  if (!parseChannels(launchRow).includes(channel)) {
    return { ok: false, error: "channel_not_selected" };
  }
  if (launchRow.status === "draft") return { ok: false, error: "not_generated" };

  const rows = db
    .select()
    .from(launchMessages)
    .where(and(eq(launchMessages.launchId, launchId), eq(launchMessages.channel, channel)))
    .all();

  // A message is dispatchable while its human-approved content has not gone
  // out: pending or failed, never skipped. Already-sent messages report their
  // governing action instead of being re-proposed.
  const eligible = rows.filter(
    (row) =>
      row.status !== "skipped" &&
      (channel === "linkedin" || channel === "instagram" ? row.kind === "broadcast" : true) &&
      isApproved(db, row.draftId),
  );

  const submissions: ExternalActionSubmission[] = [];

  if (channel === "email") {
    for (const row of eligible) {
      const draft = draftRow(db, row.draftId)!;
      const idempotencyKey = input.idempotencyKey
        ? `${input.idempotencyKey}:${row.id}`
        : deriveEmailSendIdempotencyKey(row.id, {
            draftId: draft.id,
            content: draft.content,
            stepNumber: row.stepNumber,
          });
      const existing = row.externalActionId
        ? getExternalAction(db, workspaceId, row.externalActionId)
        : undefined;
      let submission: ExternalActionSubmission;
      if (existing && (existing.status === "blocked" || existing.status === "stale")) {
        submission = await runtime.repropose(
          existing.id,
          workspaceId,
          `${idempotencyKey}:retry:${existing.id}`,
          actor,
        );
      } else if (existing) {
        submissions.push({ action: existing, execution: existing.execution });
        continue;
      } else {
        submission = await runtime.propose(
          prepareEmailAction(db, workspaceId, {
            origin: "launch_message",
            originId: row.id,
            idempotencyKey,
          }),
          actor,
        );
      }
      db.update(launchMessages)
        .set({ externalActionId: submission.action.id, updatedAt: Date.now() })
        .where(eq(launchMessages.id, row.id))
        .run();
      submissions.push(submission);
    }
    return { ok: true, submissions };
  }

  const conn = resolveLaunchConnection(db, workspaceId, launchRow, channel, input.connectionId);
  if (!conn.ok) return { ok: false, error: conn.error };
  const connection = conn.connection;
  const media = input.media?.map((m) => ({ url: m.url, type: m.type })) ?? null;

  for (const row of eligible) {
    if (row.status === "sent") {
      const existing = row.externalActionId
        ? getExternalAction(db, workspaceId, row.externalActionId)
        : undefined;
      if (existing) submissions.push({ action: existing, execution: existing.execution });
      continue;
    }
    const draft = draftRow(db, row.draftId)!;
    const idempotencyKey = input.idempotencyKey
      ? `${input.idempotencyKey}:${row.id}`
      : deriveSendIdempotencyKey(row.id, {
          connectionId: connection.id,
          draftId: draft.id,
          content: draft.content,
        });
    try {
      const command = prepareSendAction(db, workspaceId, launchId, row.id, {
        idempotencyKey,
        connectionId: connection.id,
        media,
        automated: false,
      });
      submissions.push(await runtime.propose(command, actor));
    } catch (err) {
      if (err instanceof ExternalActionPreparationError) {
        if (err.code === "media_required") return { ok: false, error: "media_required" };
        if (err.code === "validation_failed") {
          return { ok: false, error: "validation_failed", message: err.message };
        }
        continue; // a message that became ineligible mid-dispatch is skipped
      }
      throw err;
    }
  }
  return { ok: true, submissions };
}

/** Flip a launch to completed once no message is still pending. Coarse — the
 * per-message status is the real detail. Also called by the send adapter. */
export function maybeCompleteLaunch(db: Db, workspaceId: string, launchId: string): void {
  if (!getLaunchRow(db, workspaceId, launchId)) return;
  const pending = db
    .select()
    .from(launchMessages)
    .where(and(eq(launchMessages.launchId, launchId), eq(launchMessages.status, "pending")))
    .all();
  if (pending.length === 0) setStatus(db, launchId, "completed");
}
