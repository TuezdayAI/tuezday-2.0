import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  canTransitionDeliverable,
  formatCapability,
  type Channel,
  type DeliverableProductionStatus,
  type DeliverableRunResult,
} from "@tuezday/contracts";
import { resolveContext, type BrainContents, type ResolvedContext } from "@tuezday/brain";
import { type Db, rowsAffected } from "../db";
import {
  campaignLaneRevisions,
  contentPackages,
  contextSnapshots,
  deliverables,
  packageSources,
  sufficiencyAssessments,
  variants,
} from "../db/schema";
import type { LlmGateway } from "../llm/gateway";
import { meteredLlm } from "../llm/metered";
import { getBrain } from "./brain";
import {
  fanOutDuePackages,
  insertDeliverableEvent,
  materializePlannedSlots,
  sweepStaleDeliverables,
} from "./deliverables";
import { llmBudgetExhausted } from "./entitlements";
import { resolveChannelGuidance } from "./guidance";
import { getCampaign } from "./campaigns";
import { getPersona, toResolvePersona } from "./personas";
import { resolveDraftAccount } from "./resolve-account";
import { campaignResolveInputs, selectiveContextInputs } from "./resolve-input";
import { DATABASE_NOW_MS } from "./task-leases";
import { getWorkspace } from "./workspaces";
/** Consecutive retryable failures before the queue parks a deliverable `failed`. */
export const GENERATION_MAX_ATTEMPTS = 3;

export interface GenerationClaim {
  deliverableId: string;
  workspaceId: string;
  /** Status the claim moved the deliverable from (`ready` or `candidate_ready`). */
  fromStatus: DeliverableProductionStatus;
}

/**
 * Claim due deliverables: package attached and generation pending, or
 * in_progress with an expired lease. `ready` queues the first variant,
 * `candidate_ready` a regeneration (D-63.6); `failed` waits for an operator
 * regenerate. Claiming transitions the deliverable to `generating` through
 * the machine with an audit event.
 */
export async function claimGenerationBatch(
  db: Db,
  input: {
    workspaceId: string;
    limit: number;
    leaseMs: number;
    deliverableId?: string;
  },
): Promise<GenerationClaim[]> {
  if (input.limit <= 0) return [];
  const now = Date.now();
  return await db.transaction(async (tx) => {
    const claims: GenerationClaim[] = [];
    const due = await tx
      .select()
      .from(deliverables)
      .where(
        and(
          eq(deliverables.workspaceId, input.workspaceId),
          input.deliverableId
            ? eq(deliverables.id, input.deliverableId)
            : undefined,
          inArray(deliverables.status, ["ready", "candidate_ready"]),
          isNotNull(deliverables.packageId),
          or(
            eq(deliverables.generationState, "pending"),
            and(
              eq(deliverables.generationState, "in_progress"),
              lte(deliverables.generationLeaseExpiresAt, DATABASE_NOW_MS),
            ),
          ),
        ),
      )
      .orderBy(asc(deliverables.createdAt), asc(deliverables.id));
    for (const row of due) {
      if (claims.length >= input.limit) break;
      const from = row.status as DeliverableProductionStatus;
      if (!canTransitionDeliverable(from, "generating")) continue;
      const claimed = await tx
        .update(deliverables)
        .set({
          status: "generating",
          generationState: "in_progress",
          generationLeaseExpiresAt: sql`${DATABASE_NOW_MS} + ${input.leaseMs}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(deliverables.id, row.id),
            eq(deliverables.status, from),
            eq(deliverables.generationState, row.generationState),
            eq(deliverables.updatedAt, row.updatedAt),
          ),
        );
      if (rowsAffected(claimed) !== 1) continue;
      await insertDeliverableEvent(tx, {
        workspaceId: input.workspaceId,
        deliverableId: row.id,
        fromStatus: from,
        toStatus: "generating",
        reason: from === "candidate_ready" ? "regeneration" : "variant generation",
        createdAt: now,
      });
      claims.push({
        deliverableId: row.id,
        workspaceId: row.workspaceId,
        fromStatus: from,
      });
    }
    return claims;
  });
}

/**
 * Infra failure: return the deliverable to `ready` (the machine's retry
 * edge), bump attempts, park `failed` at the cap. Never a stored variant
 * (invariant 7).
 */
export async function markGenerationRetryable(db: Db, claim: GenerationClaim): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const row = (await tx
      .select()
      .from(deliverables)
      .where(
        and(
          eq(deliverables.id, claim.deliverableId),
          eq(deliverables.status, "generating"),
          eq(deliverables.generationState, "in_progress"),
        ),
      ))[0];
    if (!row) return false;
    if (!canTransitionDeliverable("generating", "ready")) return false;
    const attempts = row.generationAttempts + 1;
    const now = Date.now();
    await tx.update(deliverables)
      .set({
        status: "ready",
        generationState: attempts >= GENERATION_MAX_ATTEMPTS ? "failed" : "pending",
        generationAttempts: attempts,
        generationLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(deliverables.id, claim.deliverableId));
    await insertDeliverableEvent(tx, {
      workspaceId: claim.workspaceId,
      deliverableId: claim.deliverableId,
      fromStatus: "generating",
      toStatus: "ready",
      reason:
        attempts >= GENERATION_MAX_ATTEMPTS
          ? `generation failed after ${attempts} attempts — regenerate to retry`
          : "generation attempt failed",
      createdAt: now,
    });
    return true;
  });
}

export interface VariantContext {
  resolved: ResolvedContext;
  inputs: Record<string, unknown>;
  campaignId: string;
  packageId: string;
}

class VariantContextUnavailableError extends Error {}

/**
 * Build the Central Brain context for one deliverable (D-63.5): lane task
 * type/channel/persona, campaign + active plan, account, guidance, the
 * package angle, and the package's trigger source as the signal input with
 * the latest assessment's supported claims appended as grounding. Everything
 * that reaches the model is captured in the snapshot inputs.
 */
export async function buildVariantContext(
  db: Db,
  workspace: { id: string; name: string },
  deliverable: {
    id: string;
    laneRevisionId: string;
    campaignId: string;
    packageId: string | null;
    planRevisionId: string;
    angle: string;
  },
): Promise<VariantContext> {
  if (!deliverable.packageId) throw new VariantContextUnavailableError();
  const lane = (await db
    .select()
    .from(campaignLaneRevisions)
    .where(eq(campaignLaneRevisions.id, deliverable.laneRevisionId)))[0];
  if (!lane) throw new VariantContextUnavailableError();
  const capability = formatCapability(lane.channel, lane.format);
  if (!capability) throw new VariantContextUnavailableError();
  const channel = lane.channel as Channel;
  const persona = await getPersona(db, workspace.id, lane.personaId);
  const campaign = await getCampaign(db, workspace.id, deliverable.campaignId);
  if (!persona || !campaign) throw new VariantContextUnavailableError();

  const sources = await db
    .select()
    .from(packageSources)
    .where(eq(packageSources.packageId, deliverable.packageId))
    .orderBy(asc(packageSources.createdAt), asc(packageSources.id));
  const trigger = sources.find((source) => source.role === "trigger");
  const assessment = (await db
    .select()
    .from(sufficiencyAssessments)
    .where(eq(sufficiencyAssessments.packageId, deliverable.packageId))
    .orderBy(desc(sufficiencyAssessments.assessmentVersion))
    .limit(1))[0];
  const claims = assessment
    ? (JSON.parse(assessment.supportedClaimsJson) as { claim: string }[])
    : [];
  const signalContent = [
    trigger?.excerpt ?? "",
    claims.length > 0
      ? [
          "Supported claims (grounded in package sources — do not invent facts beyond these):",
          ...claims.map((entry) => `- ${entry.claim}`),
        ].join("\n")
      : "",
  ]
    .filter((block) => block.length > 0)
    .join("\n\n");

  const { docs } = await getBrain(db, workspace.id);
  const contents = Object.fromEntries(
    docs.map((d) => [d.docType, d.content]),
  ) as BrainContents;
  const channelGuidance = await resolveChannelGuidance(db, workspace.id, channel, {
    personaId: persona.id,
    campaignId: campaign.id,
  });
  const campaignInputs = await campaignResolveInputs(db, workspace.id, campaign);
  const resolved = resolveContext({
    workspaceName: workspace.name,
    docs: contents,
    taskType: capability.taskType,
    channel,
    channelGuidance: {
      content: channelGuidance.content,
      source: channelGuidance.source,
      scope: channelGuidance.scopeLabel,
    },
    persona: toResolvePersona(persona),
    ...campaignInputs,
    account: await resolveDraftAccount(db, workspace.id, {
      personaId: persona.id,
      channel,
    }),
    signal:
      signalContent.length > 0
        ? {
            content: signalContent,
            source: trigger?.title || "content package",
            sourceUrl: trigger?.url ?? null,
          }
        : undefined,
    angle: deliverable.angle || undefined,
    ...await selectiveContextInputs(db, workspace.id),
  });
  return {
    resolved,
    inputs: {
      deliverableId: deliverable.id,
      packageId: deliverable.packageId,
      planRevisionId: deliverable.planRevisionId,
      laneRevisionId: lane.id,
      personaId: persona.id,
      campaignId: campaign.id,
      channel,
      format: lane.format,
      taskType: capability.taskType,
      guidanceSource: channelGuidance.source,
      angle: deliverable.angle,
      supportedClaims: claims.map((entry) => entry.claim),
      packageSources: sources.map((source) => ({
        id: source.id,
        role: source.role,
        title: source.title,
        url: source.url,
        excerpt: source.excerpt,
      })),
    },
    campaignId: campaign.id,
    packageId: deliverable.packageId,
  };
}

class GenerationFenceError extends Error {}

/**
 * Commit one variant in a lease-fenced transaction: insert the immutable
 * context snapshot and the next-version variant row, then move the
 * deliverable to `candidate_ready` with an audit event. Lineage is
 * append-only (invariant 4).
 */
export async function commitVariant(
  db: Db,
  claim: GenerationClaim,
  input: {
    context: VariantContext;
    content: string;
    model: string;
    provider: string;
    durationMs: number;
    actorUserId: string | null;
  },
): Promise<{ committed: boolean; variantId: string | null }> {
  const now = Date.now();
  try {
    return await db.transaction(async (tx) => {
      const row = (await tx
        .select()
        .from(deliverables)
        .where(
          and(
            eq(deliverables.id, claim.deliverableId),
            eq(deliverables.workspaceId, claim.workspaceId),
            eq(deliverables.status, "generating"),
            eq(deliverables.generationState, "in_progress"),
          ),
        ))[0];
      if (!row) throw new GenerationFenceError();
      if (!canTransitionDeliverable("generating", "candidate_ready")) {
        throw new GenerationFenceError();
      }
      const snapshotId = randomUUID();
      await tx.insert(contextSnapshots)
        .values({
          id: snapshotId,
          workspaceId: claim.workspaceId,
          deliverableId: claim.deliverableId,
          packageId: input.context.packageId,
          resolvedContextJson: JSON.stringify(input.context.resolved),
          inputsJson: JSON.stringify(input.context.inputs),
          model: input.model,
          provider: input.provider,
          createdAt: now,
        });
      const version =
        (((await tx
          .select({ n: sql<number>`MAX(${variants.variantVersion})` })
          .from(variants)
          .where(eq(variants.deliverableId, claim.deliverableId)))[0])?.n ?? 0) + 1;
      const variantId = randomUUID();
      await tx.insert(variants)
        .values({
          id: variantId,
          workspaceId: claim.workspaceId,
          deliverableId: claim.deliverableId,
          variantVersion: version,
          contextSnapshotId: snapshotId,
          status: "candidate",
          content: input.content,
          model: input.model,
          provider: input.provider,
          durationMs: input.durationMs,
          createdByUserId: input.actorUserId,
          createdAt: now,
        });
      await tx.update(deliverables)
        .set({
          status: "candidate_ready",
          generationState: "complete",
          generationAttempts: 0,
          generationLeaseExpiresAt: null,
          generatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(deliverables.id, claim.deliverableId),
            eq(deliverables.generationState, "in_progress"),
          ),
        );
      await insertDeliverableEvent(tx, {
        workspaceId: claim.workspaceId,
        deliverableId: claim.deliverableId,
        fromStatus: "generating",
        toStatus: "candidate_ready",
        actorUserId: input.actorUserId,
        reason: `variant v${version} generated`,
        createdAt: now,
      });
      return { committed: true, variantId };
    });
  } catch (error) {
    if (error instanceof GenerationFenceError) {
      return { committed: false, variantId: null };
    }
    throw error;
  }
}

/**
 * Generate up to `limit` due variants for one workspace: one metered
 * single-shot brain-resolved call per deliverable (D-63.5), fenced commit.
 * Every failure path is retryable — never a stored variant.
 */
export async function runVariantGeneration(
  db: Db,
  llm: LlmGateway,
  input: {
    workspaceId: string;
    limit: number;
    leaseMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Restrict the claim to one deliverable (the synchronous route). */
    deliverableId?: string;
    actorUserId?: string | null;
  },
): Promise<{ generated: number; claimed: number; failures: number }> {
  const result = { generated: 0, claimed: 0, failures: 0 };
  const workspace = await getWorkspace(db, input.workspaceId);
  if (!workspace) return result;
  if (await llmBudgetExhausted(db, input.workspaceId)) return result;
  const claims = await claimGenerationBatch(db, {
    workspaceId: input.workspaceId,
    limit: input.limit,
    leaseMs: input.leaseMs,
    deliverableId: input.deliverableId,
  });
  result.claimed = claims.length;
  for (const claim of claims) {
    if (input.signal?.aborted) {
      if (await markGenerationRetryable(db, claim)) result.failures += 1;
      continue;
    }
    const row = (await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.id, claim.deliverableId)))[0];
    if (!row) continue;
    let context: VariantContext;
    let generated: { text: string; model: string; provider: string; durationMs: number };
    try {
      context = await buildVariantContext(db, workspace, row);
      const metered = meteredLlm(llm, db, {
        workspaceId: input.workspaceId,
        pipeline: "variant_generation",
        campaignId: context.campaignId,
      });
      const signals = [AbortSignal.timeout(input.timeoutMs)];
      if (input.signal) signals.push(input.signal);
      generated = await metered.generate({
        prompt: context.resolved.prompt,
        signal: AbortSignal.any(signals),
      });
    } catch {
      // Missing context, timeouts, aborts, and gateway trouble: retryable,
      // never a stored variant (invariant 7).
      if (await markGenerationRetryable(db, claim)) result.failures += 1;
      continue;
    }
    const committed = await commitVariant(db, claim, {
      context,
      content: generated.text,
      model: generated.model,
      provider: generated.provider,
      durationMs: generated.durationMs,
      actorUserId: input.actorUserId ?? null,
    });
    if (committed.committed) result.generated += 1;
  }
  return result;
}

/**
 * The Sprint 63 deliverable phase: materialize planned slots, fan out ready
 * packages, generate due variants, sweep stale slots — one shared bound
 * across fan-outs and generations. Deterministic phases always run; only
 * generation is budget-gated. Shared by the discovery tick and the
 * founder-triggered run route.
 */
export async function runDeliverablePipeline(
  db: Db,
  llm: LlmGateway,
  input: {
    workspaceId: string;
    limit: number;
    leaseMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    now?: number;
  },
): Promise<DeliverableRunResult> {
  const result: DeliverableRunResult = {
    slotsMaterialized: 0,
    packagesFannedOut: 0,
    deliverablesCreated: 0,
    variantsGenerated: 0,
    staled: 0,
    failures: 0,
  };
  if (!await getWorkspace(db, input.workspaceId)) return result;
  result.slotsMaterialized = await materializePlannedSlots(db, {
    workspaceId: input.workspaceId,
    now: input.now,
  });
  const fanned = await fanOutDuePackages(db, {
    workspaceId: input.workspaceId,
    limit: input.limit,
    now: input.now,
  });
  result.packagesFannedOut = fanned.packagesFannedOut;
  result.deliverablesCreated = fanned.deliverablesCreated;
  const generateLimit = input.limit - fanned.packagesFannedOut;
  if (generateLimit > 0) {
    const generation = await runVariantGeneration(db, llm, {
      workspaceId: input.workspaceId,
      limit: generateLimit,
      leaseMs: input.leaseMs,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    result.variantsGenerated = generation.generated;
    result.failures = generation.failures;
  }
  result.staled = await sweepStaleDeliverables(db, {
    workspaceId: input.workspaceId,
    now: input.now,
  });
  return result;
}
