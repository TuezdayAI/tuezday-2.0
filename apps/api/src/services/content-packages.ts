import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import {
  PACKAGE_DECISION_TARGETS,
  PACKAGE_NOVELTY_WINDOW_DAYS,
  canTransitionOpportunity,
  canTransitionPackage,
  contentPackageSchema,
  laneEligibilityDecisionSchema,
  packageEventSchema,
  packageSourceSchema,
  sufficiencyAssessmentSchema,
  type ContentPackage,
  type LaneEligibilityDecision,
  type OpportunityStatus,
  type PackageDecisionAction,
  type PackageDetail,
  type PackageEvent,
  type PackageSource,
  type PackageStatus,
  type SufficiencyAssessment,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import {
  campaignLaneRevisions,
  campaignLanes,
  campaignOpportunities,
  campaignOpportunityEvents,
  campaigns,
  canonicalExternalStories,
  contentPackageEvents,
  contentPackages,
  discoverySourceOccurrences,
  laneEligibilityDecisions,
  packageSources,
  sufficiencyAssessments,
  type ContentPackageRow,
  type SufficiencyAssessmentRow,
} from "../db/schema";
import {
  InvalidOpportunityTransitionError,
  OpportunityNotFoundError,
} from "./opportunities";
import { blockDeliverablesForCancelledPackage } from "./deliverables";
import { loadStoryRoutingContext, tokenize } from "./opportunity-matching";

export class PackageNotFoundError extends Error {}
export class InvalidPackageTransitionError extends Error {
  constructor(
    readonly from: PackageStatus,
    readonly to: PackageStatus,
  ) {
    super(`Cannot transition a package from ${from} to ${to}.`);
  }
}

export const PACKAGE_LIST_DEFAULT_LIMIT = 50;
export const PACKAGE_LIST_MAX_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXCERPT_MAX_CHARS = 2000;

/**
 * Deterministic novelty v1 (D-62.3): 100 minus the highest token-overlap
 * percentage (Jaccard) against angles of packages created for the same
 * campaign inside the novelty window. An identical normalized angle scores 0.
 */
export function noveltyFor(
  db: DbExecutor,
  campaignId: string,
  angle: string,
  angleHash: string,
  now: number,
): number {
  const recent = db
    .select({ angle: contentPackages.angle, angleHash: contentPackages.angleHash })
    .from(contentPackages)
    .where(
      and(
        eq(contentPackages.campaignId, campaignId),
        gte(contentPackages.createdAt, now - PACKAGE_NOVELTY_WINDOW_DAYS * DAY_MS),
      ),
    )
    .all();
  const tokens = tokenize(angle);
  let maxOverlap = 0;
  for (const row of recent) {
    if (row.angleHash === angleHash) return 0;
    const other = tokenize(row.angle);
    if (tokens.size === 0 || other.size === 0) continue;
    let shared = 0;
    for (const token of other) if (tokens.has(token)) shared += 1;
    const union = tokens.size + other.size - shared;
    maxOverlap = Math.max(maxOverlap, Math.round((shared / union) * 100));
  }
  return 100 - maxOverlap;
}

export function insertPackageEvent(
  tx: DbExecutor,
  input: {
    workspaceId: string;
    packageId: string;
    fromStatus: PackageStatus | null;
    toStatus: PackageStatus;
    actorUserId?: string | null;
    reason?: string | null;
    createdAt: number;
  },
): void {
  tx.insert(contentPackageEvents)
    .values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      packageId: input.packageId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorUserId: input.actorUserId ?? null,
      reason: input.reason ?? null,
      createdAt: input.createdAt,
    })
    .run();
}

/**
 * Consume a qualified opportunity into a package (design §8.7, D-62.1/2):
 * one transaction transitions the opportunity to package_created, snapshots
 * trigger + evidence sources, computes novelty, and inserts the assessing
 * package. The opportunity's status fence plus the partial unique make the
 * pairing 1:1 under races. Returns the new package id.
 */
export function createPackageFromOpportunity(
  db: Db,
  workspaceId: string,
  opportunityId: string,
  actor: { userId: string | null },
): string {
  const now = Date.now();
  return db.transaction((tx) => {
    const opportunity = tx
      .select()
      .from(campaignOpportunities)
      .where(
        and(
          eq(campaignOpportunities.id, opportunityId),
          eq(campaignOpportunities.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!opportunity) throw new OpportunityNotFoundError();
    const from = opportunity.status as OpportunityStatus;
    if (!canTransitionOpportunity(from, "package_created")) {
      throw new InvalidOpportunityTransitionError(from, "package_created");
    }
    const fenced = tx
      .update(campaignOpportunities)
      .set({
        status: "package_created",
        decidedByUserId: actor.userId,
        decidedAt: now,
        decisionReason: "package created",
        updatedAt: now,
      })
      .where(
        and(
          eq(campaignOpportunities.id, opportunityId),
          eq(campaignOpportunities.status, from),
        ),
      )
      .run();
    if (fenced.changes !== 1) {
      throw new InvalidOpportunityTransitionError(from, "package_created");
    }
    tx.insert(campaignOpportunityEvents)
      .values({
        id: randomUUID(),
        workspaceId,
        opportunityId,
        fromStatus: from,
        toStatus: "package_created",
        actorUserId: actor.userId,
        reason: "package created",
        createdAt: now,
      })
      .run();

    const packageId = randomUUID();
    const novelty = noveltyFor(
      tx,
      opportunity.campaignId,
      opportunity.angle,
      opportunity.angleHash,
      now,
    );
    tx.insert(contentPackages)
      .values({
        id: packageId,
        workspaceId,
        campaignId: opportunity.campaignId,
        planRevisionId: opportunity.planRevisionId,
        opportunityId,
        canonicalStoryId: opportunity.canonicalStoryId,
        angle: opportunity.angle,
        angleHash: opportunity.angleHash,
        novelty,
        status: "assessing",
        assessmentState: "pending",
        assessmentAttempts: 0,
        createdByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Trigger source: the canonical story, snapshotted so later mutation or
    // deletion never destroys provenance (design §1.3).
    if (opportunity.canonicalStoryId) {
      const story = tx
        .select()
        .from(canonicalExternalStories)
        .where(eq(canonicalExternalStories.id, opportunity.canonicalStoryId))
        .get();
      if (story) {
        const context = loadStoryRoutingContext(tx, story);
        tx.insert(packageSources)
          .values({
            id: randomUUID(),
            workspaceId,
            packageId,
            role: "trigger",
            canonicalStoryId: story.id,
            title: story.title,
            url: story.canonicalUrl,
            excerpt: context.excerpt.slice(0, EXCERPT_MAX_CHARS),
            snapshotJson: JSON.stringify({
              corroborationCount: context.corroborationCount,
              titleVariants: context.titleVariants,
              capturedAt: now,
            }),
            createdAt: now,
          })
          .run();
      }
    }

    // Evidence sources: one row per distinct occurrence the opportunity's
    // supported claims cite, with the claims that cite it in the snapshot.
    const claims = JSON.parse(opportunity.supportedClaimsJson) as {
      claim: string;
      occurrenceIds: string[];
    }[];
    const claimsByOccurrence = new Map<string, string[]>();
    for (const entry of claims) {
      for (const occurrenceId of entry.occurrenceIds) {
        const existing = claimsByOccurrence.get(occurrenceId) ?? [];
        existing.push(entry.claim);
        claimsByOccurrence.set(occurrenceId, existing);
      }
    }
    for (const [occurrenceId, citedBy] of claimsByOccurrence) {
      const occurrence = tx
        .select()
        .from(discoverySourceOccurrences)
        .where(eq(discoverySourceOccurrences.id, occurrenceId))
        .get();
      if (!occurrence) continue;
      tx.insert(packageSources)
        .values({
          id: randomUUID(),
          workspaceId,
          packageId,
          role: "evidence",
          canonicalStoryId: opportunity.canonicalStoryId,
          occurrenceId,
          title: occurrence.title,
          url: occurrence.url,
          excerpt: occurrence.excerpt.slice(0, EXCERPT_MAX_CHARS),
          snapshotJson: JSON.stringify({
            sourceType: occurrence.sourceType,
            sourceName: occurrence.sourceName,
            observedAt: occurrence.observedAt,
            claims: citedBy,
            capturedAt: now,
          }),
          createdAt: now,
        })
        .run();
    }

    insertPackageEvent(tx, {
      workspaceId,
      packageId,
      fromStatus: null,
      toStatus: "assessing",
      actorUserId: actor.userId,
      reason: "created from opportunity",
      createdAt: now,
    });
    return packageId;
  });
}

interface PackageJoinRow {
  pkg: ContentPackageRow;
  campaignName: string;
  storyTitle: string | null;
  latestVerdict: string | null;
}

function projectPackage(row: PackageJoinRow): ContentPackage {
  const p = row.pkg;
  return contentPackageSchema.parse({
    id: p.id,
    workspaceId: p.workspaceId,
    campaignId: p.campaignId,
    planRevisionId: p.planRevisionId,
    opportunityId: p.opportunityId,
    canonicalStoryId: p.canonicalStoryId,
    angle: p.angle,
    angleHash: p.angleHash,
    novelty: p.novelty,
    status: p.status,
    assessmentState: p.assessmentState,
    assessmentAttempts: p.assessmentAttempts,
    assessedAt: p.assessedAt,
    createdByUserId: p.createdByUserId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    campaignName: row.campaignName,
    storyTitle: row.storyTitle,
    latestVerdict: row.latestVerdict,
  });
}

const latestVerdictSql = sql<string | null>`(
  SELECT sa.verdict FROM sufficiency_assessments sa
  WHERE sa.package_id = ${contentPackages.id}
  ORDER BY sa.assessment_version DESC LIMIT 1
)`;

function joinedSelect(db: DbExecutor) {
  return db
    .select({
      pkg: contentPackages,
      campaignName: campaigns.name,
      storyTitle: canonicalExternalStories.title,
      latestVerdict: latestVerdictSql,
    })
    .from(contentPackages)
    .innerJoin(campaigns, eq(contentPackages.campaignId, campaigns.id))
    .leftJoin(
      canonicalExternalStories,
      eq(contentPackages.canonicalStoryId, canonicalExternalStories.id),
    );
}

export function listPackages(
  db: Db,
  workspaceId: string,
  options: {
    status?: PackageStatus;
    campaignId?: string;
    limit?: number;
    offset?: number;
  } = {},
): { packages: ContentPackage[]; total: number } {
  const limit = Math.min(
    Math.max(options.limit ?? PACKAGE_LIST_DEFAULT_LIMIT, 1),
    PACKAGE_LIST_MAX_LIMIT,
  );
  const offset = Math.max(options.offset ?? 0, 0);
  const where = and(
    eq(contentPackages.workspaceId, workspaceId),
    options.status ? eq(contentPackages.status, options.status) : undefined,
    options.campaignId
      ? eq(contentPackages.campaignId, options.campaignId)
      : undefined,
  );
  const rows = joinedSelect(db)
    .where(where)
    .orderBy(desc(contentPackages.createdAt), asc(contentPackages.id))
    .limit(limit)
    .offset(offset)
    .all();
  const total =
    db
      .select({ n: sql<number>`COUNT(*)` })
      .from(contentPackages)
      .where(where)
      .get()?.n ?? 0;
  return { packages: rows.map(projectPackage), total };
}

export function projectAssessment(
  row: SufficiencyAssessmentRow,
): SufficiencyAssessment {
  return sufficiencyAssessmentSchema.parse({
    id: row.id,
    packageId: row.packageId,
    assessmentVersion: row.assessmentVersion,
    verdict: row.verdict,
    confidence: row.confidence,
    supportedClaims: JSON.parse(row.supportedClaimsJson),
    missingFacts: JSON.parse(row.missingFactsJson),
    missingMedia: JSON.parse(row.missingMediaJson),
    eligibleFormats: JSON.parse(row.eligibleFormatsJson),
    ineligibleFormats: JSON.parse(row.ineligibleFormatsJson),
    researchActions: JSON.parse(row.researchActionsJson),
    assessorVersion: row.assessorVersion,
    createdAt: row.createdAt,
  });
}

function sourceRows(db: DbExecutor, packageId: string): PackageSource[] {
  return db
    .select()
    .from(packageSources)
    .where(eq(packageSources.packageId, packageId))
    .orderBy(asc(packageSources.createdAt), asc(packageSources.id))
    .all()
    .map((row) =>
      packageSourceSchema.parse({
        id: row.id,
        packageId: row.packageId,
        role: row.role,
        canonicalStoryId: row.canonicalStoryId,
        occurrenceId: row.occurrenceId,
        signalId: row.signalId,
        title: row.title,
        url: row.url,
        excerpt: row.excerpt,
        createdAt: row.createdAt,
      }),
    );
}

function eligibilityRows(
  db: DbExecutor,
  packageId: string,
): LaneEligibilityDecision[] {
  return db
    .select({
      decision: laneEligibilityDecisions,
      laneName: campaignLanes.name,
      channel: campaignLaneRevisions.channel,
      format: campaignLaneRevisions.format,
    })
    .from(laneEligibilityDecisions)
    .innerJoin(
      campaignLanes,
      eq(laneEligibilityDecisions.laneId, campaignLanes.id),
    )
    .innerJoin(
      campaignLaneRevisions,
      eq(laneEligibilityDecisions.laneRevisionId, campaignLaneRevisions.id),
    )
    .where(eq(laneEligibilityDecisions.packageId, packageId))
    .orderBy(
      asc(laneEligibilityDecisions.createdAt),
      asc(laneEligibilityDecisions.id),
    )
    .all()
    .map((row) =>
      laneEligibilityDecisionSchema.parse({
        id: row.decision.id,
        packageId: row.decision.packageId,
        assessmentId: row.decision.assessmentId,
        laneId: row.decision.laneId,
        laneRevisionId: row.decision.laneRevisionId,
        eligible: row.decision.eligible,
        checks: JSON.parse(row.decision.checksJson),
        evaluatorVersion: row.decision.evaluatorVersion,
        createdAt: row.decision.createdAt,
        laneName: row.laneName,
        channel: row.channel,
        format: row.format,
      }),
    );
}

function eventRows(db: DbExecutor, packageId: string): PackageEvent[] {
  return db
    .select()
    .from(contentPackageEvents)
    .where(eq(contentPackageEvents.packageId, packageId))
    .orderBy(
      asc(contentPackageEvents.createdAt),
      // Creation (fromStatus null) precedes same-millisecond dispositions.
      sql`${contentPackageEvents.fromStatus} IS NOT NULL`,
      asc(contentPackageEvents.id),
    )
    .all()
    .map((row) =>
      packageEventSchema.parse({
        id: row.id,
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        actorUserId: row.actorUserId,
        reason: row.reason,
        createdAt: row.createdAt,
      }),
    );
}

export function getPackageDetail(
  db: Db,
  workspaceId: string,
  packageId: string,
): PackageDetail {
  const row = joinedSelect(db)
    .where(
      and(
        eq(contentPackages.id, packageId),
        eq(contentPackages.workspaceId, workspaceId),
      ),
    )
    .get();
  if (!row) throw new PackageNotFoundError();
  const assessments = db
    .select()
    .from(sufficiencyAssessments)
    .where(eq(sufficiencyAssessments.packageId, packageId))
    .orderBy(desc(sufficiencyAssessments.assessmentVersion))
    .all()
    .map(projectAssessment);
  return {
    package: projectPackage(row),
    sources: sourceRows(db, packageId),
    assessments,
    eligibility: eligibilityRows(db, packageId),
    events: eventRows(db, packageId),
  };
}

/**
 * Apply an operator decision through the contracts transition machine.
 * `reassess` re-opens the sufficiency queue (attempts reset); `cancel` is
 * terminal. Judgment records (assessments, decisions) stay immutable.
 */
export function decidePackage(
  db: Db,
  workspaceId: string,
  packageId: string,
  input: {
    action: PackageDecisionAction;
    reason?: string;
    actorUserId: string | null;
  },
): PackageDetail {
  db.transaction((tx) => {
    const row = tx
      .select()
      .from(contentPackages)
      .where(
        and(
          eq(contentPackages.id, packageId),
          eq(contentPackages.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!row) throw new PackageNotFoundError();
    const from = row.status as PackageStatus;
    const to = PACKAGE_DECISION_TARGETS[input.action];
    // Reassessing an `assessing` package is only meaningful when its queue
    // exhausted retries (`failed`) — a queue reset, not a status transition.
    const failedQueueReset =
      input.action === "reassess" &&
      from === "assessing" &&
      row.assessmentState === "failed";
    if (!failedQueueReset && !canTransitionPackage(from, to)) {
      throw new InvalidPackageTransitionError(from, to);
    }
    const now = Date.now();
    tx.update(contentPackages)
      .set({
        status: to,
        ...(input.action === "reassess"
          ? {
              assessmentState: "pending",
              assessmentAttempts: 0,
              assessmentLeaseExpiresAt: null,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(contentPackages.id, packageId))
      .run();
    insertPackageEvent(tx, {
      workspaceId,
      packageId,
      fromStatus: from,
      toStatus: to,
      actorUserId: input.actorUserId,
      reason: input.reason ?? null,
      createdAt: now,
    });
    // D-63.9: a cancelled package blocks its undelivered deliverables in the
    // same transaction; candidates already generated stay for the operator.
    if (input.action === "cancel") {
      blockDeliverablesForCancelledPackage(tx, workspaceId, packageId, now);
    }
  });
  return getPackageDetail(db, workspaceId, packageId);
}
