import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  DELIVERABLE_SLOT_HORIZON_DAYS,
  DELIVERABLE_STALE_GRACE_MS,
  canTransitionDeliverable,
  canTransitionVariant,
  contextSnapshotSchema,
  deliverableEventSchema,
  deliverableSchema,
  laneScheduleSchema,
  variantSchema,
  type ContextSnapshot,
  type Deliverable,
  type DeliverableDecisionAction,
  type DeliverableDetail,
  type DeliverableEvent,
  type DeliverableProductionStatus,
  type FanOutResult,
  type Variant,
  type VariantStatus,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import {
  campaignLaneRevisions,
  campaignLanes,
  campaignPlanRevisions,
  campaigns,
  contentPackages,
  contextSnapshots,
  deliverableEvents,
  deliverables,
  laneEligibilityDecisions,
  sufficiencyAssessments,
  variants,
  type DeliverableRow,
  type VariantRow,
} from "../db/schema";
import { localDate, slotsBetween, zonedWallClockToUtc } from "./cadences";
import { PackageNotFoundError } from "./content-packages";

export class DeliverableNotFoundError extends Error {}
export class VariantNotFoundError extends Error {}
export class SnapshotNotFoundError extends Error {}
export class InvalidDeliverableTransitionError extends Error {
  constructor(
    readonly from: DeliverableProductionStatus,
    readonly action: string,
  ) {
    super(`Cannot ${action} a ${from} deliverable.`);
  }
}
export class InvalidPackageStateError extends Error {
  constructor(status: string) {
    super(`Only a ready package can fan out (current status: ${status}).`);
  }
}

export const DELIVERABLE_LIST_DEFAULT_LIMIT = 50;
export const DELIVERABLE_LIST_MAX_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Rolling reactive-cap windows per REACTIVE_PERIODS member (D-63.3). */
const REACTIVE_WINDOW_MS: Record<string, number> = {
  day: DAY_MS,
  week: WEEK_MS,
  month: 30 * DAY_MS,
};

export function insertDeliverableEvent(
  tx: DbExecutor,
  input: {
    workspaceId: string;
    deliverableId: string;
    fromStatus: DeliverableProductionStatus | null;
    toStatus: DeliverableProductionStatus;
    actorUserId?: string | null;
    reason?: string | null;
    createdAt: number;
  },
): void {
  tx.insert(deliverableEvents)
    .values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      deliverableId: input.deliverableId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorUserId: input.actorUserId ?? null,
      reason: input.reason ?? null,
      createdAt: input.createdAt,
    })
    .run();
}

/** The UTC start of the local week (Sunday 00:00) containing the instant. */
function weekStartUtc(timezone: string, ms: number): number {
  const lp = localDate(timezone, ms);
  const midnight = zonedWallClockToUtc(lp.year, lp.month, lp.day, 0, 0, timezone);
  // Walk back to Sunday in whole local days (DST drift is corrected below).
  const sundayGuess = midnight - lp.weekday * DAY_MS;
  const sp = localDate(timezone, sundayGuess);
  return zonedWallClockToUtc(sp.year, sp.month, sp.day, 0, 0, timezone);
}

/**
 * Materialize planned deliverable slots (design §8.10, D-63.2): for every
 * active lane revision of an active plan revision of an active campaign with
 * planned delivery, walk the recurrence schedule over the horizon and keep at
 * most `plannedQuantity` slots per local calendar week (existing slots in the
 * week count toward the cap). The partial unique makes re-runs no-ops.
 */
export function materializePlannedSlots(
  db: Db,
  input: { workspaceId: string; now?: number },
): number {
  const now = input.now ?? Date.now();
  const lanes = db
    .select({
      laneId: campaignLanes.id,
      laneRevisionId: campaignLaneRevisions.id,
      campaignId: campaignLanes.campaignId,
      planRevisionId: campaignLaneRevisions.planRevisionId,
      deliveryMode: campaignLaneRevisions.deliveryMode,
      plannedQuantity: campaignLaneRevisions.plannedQuantity,
      scheduleJson: campaignLaneRevisions.scheduleJson,
    })
    .from(campaignLaneRevisions)
    .innerJoin(campaignLanes, eq(campaignLaneRevisions.laneId, campaignLanes.id))
    .innerJoin(
      campaignPlanRevisions,
      eq(campaignLaneRevisions.planRevisionId, campaignPlanRevisions.id),
    )
    .innerJoin(campaigns, eq(campaignLanes.campaignId, campaigns.id))
    .where(
      and(
        eq(campaignLanes.workspaceId, input.workspaceId),
        eq(campaignLanes.status, "active"),
        eq(campaignLaneRevisions.status, "active"),
        eq(campaignPlanRevisions.status, "active"),
        eq(campaigns.status, "active"),
        ne(campaignLaneRevisions.deliveryMode, "reactive"),
      ),
    )
    .all();

  let created = 0;
  for (const lane of lanes) {
    if (!lane.scheduleJson || lane.plannedQuantity < 1) continue;
    const parsed = laneScheduleSchema.safeParse(JSON.parse(lane.scheduleJson));
    if (!parsed.success) continue;
    const schedule = parsed.data;
    const slots = slotsBetween(
      schedule,
      now,
      now + DELIVERABLE_SLOT_HORIZON_DAYS * DAY_MS,
    );
    const byWeek = new Map<number, number[]>();
    for (const slot of slots) {
      const week = weekStartUtc(schedule.timezone, slot);
      const list = byWeek.get(week) ?? [];
      list.push(slot);
      byWeek.set(week, list);
    }
    for (const [week, weekSlots] of byWeek) {
      const existing =
        db
          .select({ n: sql<number>`COUNT(*)` })
          .from(deliverables)
          .where(
            and(
              eq(deliverables.laneRevisionId, lane.laneRevisionId),
              gte(deliverables.originalScheduledFor, week),
              lt(deliverables.originalScheduledFor, week + WEEK_MS),
            ),
          )
          .get()?.n ?? 0;
      let room = lane.plannedQuantity - existing;
      for (const slot of weekSlots) {
        if (room <= 0) break;
        const id = randomUUID();
        const inserted = db
          .insert(deliverables)
          .values({
            id,
            workspaceId: input.workspaceId,
            campaignId: lane.campaignId,
            planRevisionId: lane.planRevisionId,
            laneId: lane.laneId,
            laneRevisionId: lane.laneRevisionId,
            kind: "planned",
            originalScheduledFor: slot,
            status: "planned",
            generationState: "pending",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
        if (inserted.changes !== 1) continue;
        insertDeliverableEvent(db, {
          workspaceId: input.workspaceId,
          deliverableId: id,
          fromStatus: null,
          toStatus: "planned",
          reason: "slot materialized from the lane schedule",
          createdAt: now,
        });
        created += 1;
        room -= 1;
      }
    }
  }
  return created;
}

/**
 * §9.5 fan-out for one ready package: consume the latest assessment's
 * eligible lane decisions (never re-derived), fill the oldest compatible
 * planned slot per lane first, fall back to a reactive deliverable when the
 * lane supports it and the rolling period cap has room, and never give one
 * package two deliverables on one lane thread. One transaction; fences plus
 * the partial uniques make concurrent fan-outs lose cleanly.
 */
export function fanOutPackage(
  db: Db,
  workspaceId: string,
  packageId: string,
  actor: { userId: string | null },
  options: { now?: number } = {},
): FanOutResult {
  const now = options.now ?? Date.now();
  return db.transaction((tx) => {
    const pkg = tx
      .select()
      .from(contentPackages)
      .where(
        and(
          eq(contentPackages.id, packageId),
          eq(contentPackages.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!pkg) throw new PackageNotFoundError();
    if (pkg.status !== "ready") throw new InvalidPackageStateError(pkg.status);
    // Stamp the attempt first — the fence for concurrent fan-outs.
    const fenced = tx
      .update(contentPackages)
      .set({ fannedOutAt: now, updatedAt: now })
      .where(
        and(
          eq(contentPackages.id, packageId),
          eq(contentPackages.status, "ready"),
          eq(contentPackages.updatedAt, pkg.updatedAt),
        ),
      )
      .run();
    if (fenced.changes !== 1) throw new InvalidPackageStateError(pkg.status);

    const latestAssessment = tx
      .select({ id: sufficiencyAssessments.id })
      .from(sufficiencyAssessments)
      .where(eq(sufficiencyAssessments.packageId, packageId))
      .orderBy(desc(sufficiencyAssessments.assessmentVersion))
      .limit(1)
      .get();
    const result: FanOutResult = { deliverablesCreated: 0, skipped: [] };
    if (!latestAssessment) return result;

    const eligibleLanes = tx
      .select({
        laneId: laneEligibilityDecisions.laneId,
        laneRevisionId: laneEligibilityDecisions.laneRevisionId,
        laneName: campaignLanes.name,
        deliveryMode: campaignLaneRevisions.deliveryMode,
        reactivePeriod: campaignLaneRevisions.reactivePeriod,
        reactiveCap: campaignLaneRevisions.reactiveCap,
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
      .where(
        and(
          eq(laneEligibilityDecisions.packageId, packageId),
          eq(laneEligibilityDecisions.assessmentId, latestAssessment.id),
          eq(laneEligibilityDecisions.eligible, true),
        ),
      )
      .orderBy(asc(campaignLanes.name), asc(laneEligibilityDecisions.laneId))
      .all();

    for (const lane of eligibleLanes) {
      // Invariant 3: one deliverable per package per lane thread.
      const delivered = tx
        .select({ id: deliverables.id })
        .from(deliverables)
        .where(
          and(
            eq(deliverables.packageId, packageId),
            eq(deliverables.laneId, lane.laneId),
          ),
        )
        .get();
      if (delivered) {
        result.skipped.push({
          laneRevisionId: lane.laneRevisionId,
          reason: "already_delivered",
        });
        continue;
      }

      // Planned first (§9.5 rule 2): oldest open slot on this lane revision.
      if (lane.deliveryMode !== "reactive") {
        const slot = tx
          .select()
          .from(deliverables)
          .where(
            and(
              eq(deliverables.laneRevisionId, lane.laneRevisionId),
              eq(deliverables.status, "planned"),
              isNull(deliverables.packageId),
            ),
          )
          .orderBy(asc(deliverables.originalScheduledFor), asc(deliverables.id))
          .limit(1)
          .get();
        if (slot && canTransitionDeliverable("planned", "ready")) {
          const assigned = tx
            .update(deliverables)
            .set({
              packageId,
              angle: pkg.angle,
              angleHash: pkg.angleHash,
              status: "ready",
              generationState: "pending",
              generationAttempts: 0,
              generationLeaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(deliverables.id, slot.id),
                eq(deliverables.status, "planned"),
                isNull(deliverables.packageId),
              ),
            )
            .run();
          if (assigned.changes === 1) {
            insertDeliverableEvent(tx, {
              workspaceId,
              deliverableId: slot.id,
              fromStatus: "planned",
              toStatus: "ready",
              actorUserId: actor.userId,
              reason: "package assigned to planned slot",
              createdAt: now,
            });
            result.deliverablesCreated += 1;
            continue;
          }
        }
      }

      // Reactive fallback (§9.5 rule 3), rolling period cap (D-63.3).
      if (
        lane.deliveryMode !== "planned" &&
        lane.reactivePeriod !== null &&
        lane.reactiveCap !== null
      ) {
        const window = REACTIVE_WINDOW_MS[lane.reactivePeriod] ?? WEEK_MS;
        const recent =
          tx
            .select({ n: sql<number>`COUNT(*)` })
            .from(deliverables)
            .where(
              and(
                eq(deliverables.laneRevisionId, lane.laneRevisionId),
                eq(deliverables.kind, "reactive"),
                ne(deliverables.status, "cancelled"),
                gte(deliverables.createdAt, now - window),
              ),
            )
            .get()?.n ?? 0;
        if (recent >= lane.reactiveCap) {
          result.skipped.push({
            laneRevisionId: lane.laneRevisionId,
            reason: "reactive_cap",
          });
          continue;
        }
        const id = randomUUID();
        tx.insert(deliverables)
          .values({
            id,
            workspaceId,
            campaignId: pkg.campaignId,
            planRevisionId: pkg.planRevisionId,
            laneId: lane.laneId,
            laneRevisionId: lane.laneRevisionId,
            kind: "reactive",
            originalScheduledFor: null,
            packageId,
            angle: pkg.angle,
            angleHash: pkg.angleHash,
            status: "ready",
            generationState: "pending",
            createdByUserId: actor.userId,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        insertDeliverableEvent(tx, {
          workspaceId,
          deliverableId: id,
          fromStatus: null,
          toStatus: "ready",
          actorUserId: actor.userId,
          reason: "reactive fan-out",
          createdAt: now,
        });
        result.deliverablesCreated += 1;
        continue;
      }

      result.skipped.push({
        laneRevisionId: lane.laneRevisionId,
        reason: "no_planned_slot",
      });
    }
    return result;
  });
}

/** Ready packages whose §9.5 fan-out has not been attempted yet. */
export function fanOutDuePackages(
  db: Db,
  input: { workspaceId: string; limit: number; now?: number },
): { packagesFannedOut: number; deliverablesCreated: number } {
  const result = { packagesFannedOut: 0, deliverablesCreated: 0 };
  if (input.limit <= 0) return result;
  const due = db
    .select({ id: contentPackages.id })
    .from(contentPackages)
    .where(
      and(
        eq(contentPackages.workspaceId, input.workspaceId),
        eq(contentPackages.status, "ready"),
        isNull(contentPackages.fannedOutAt),
      ),
    )
    .orderBy(asc(contentPackages.createdAt), asc(contentPackages.id))
    .limit(input.limit)
    .all();
  for (const pkg of due) {
    try {
      const fanned = fanOutPackage(
        db,
        input.workspaceId,
        pkg.id,
        { userId: null },
        { now: input.now },
      );
      result.packagesFannedOut += 1;
      result.deliverablesCreated += fanned.deliverablesCreated;
    } catch (error) {
      // A concurrent fan-out or status change losing the race is not a failure.
      if (
        error instanceof InvalidPackageStateError ||
        error instanceof PackageNotFoundError
      ) {
        continue;
      }
      throw error;
    }
  }
  return result;
}

/**
 * D-63.10: planned slots that passed unfulfilled go stale after the grace
 * window. In-flight generation is left to finish (no generating→stale edge).
 */
export function sweepStaleDeliverables(
  db: Db,
  input: { workspaceId: string; now?: number },
): number {
  const now = input.now ?? Date.now();
  const due = db
    .select()
    .from(deliverables)
    .where(
      and(
        eq(deliverables.workspaceId, input.workspaceId),
        eq(deliverables.kind, "planned"),
        lt(deliverables.originalScheduledFor, now - DELIVERABLE_STALE_GRACE_MS),
        inArray(deliverables.status, ["planned", "ready", "candidate_ready"]),
      ),
    )
    .all();
  let staled = 0;
  for (const row of due) {
    const from = row.status as DeliverableProductionStatus;
    if (!canTransitionDeliverable(from, "stale")) continue;
    const changed = db.transaction((tx) => {
      const fenced = tx
        .update(deliverables)
        .set({ status: "stale", updatedAt: now })
        .where(and(eq(deliverables.id, row.id), eq(deliverables.status, from)))
        .run();
      if (fenced.changes !== 1) return false;
      insertDeliverableEvent(tx, {
        workspaceId: input.workspaceId,
        deliverableId: row.id,
        fromStatus: from,
        toStatus: "stale",
        reason: "slot passed unfulfilled",
        createdAt: now,
      });
      return true;
    });
    if (changed) staled += 1;
  }
  return staled;
}

/**
 * D-63.9: cancelling a package blocks its undelivered (`ready`) deliverables.
 * Runs inside the package-decision transaction.
 */
export function blockDeliverablesForCancelledPackage(
  tx: DbExecutor,
  workspaceId: string,
  packageId: string,
  now: number,
): void {
  const rows = tx
    .select()
    .from(deliverables)
    .where(
      and(
        eq(deliverables.packageId, packageId),
        eq(deliverables.status, "ready"),
      ),
    )
    .all();
  for (const row of rows) {
    if (!canTransitionDeliverable("ready", "blocked")) continue;
    const fenced = tx
      .update(deliverables)
      .set({ status: "blocked", updatedAt: now })
      .where(and(eq(deliverables.id, row.id), eq(deliverables.status, "ready")))
      .run();
    if (fenced.changes !== 1) continue;
    insertDeliverableEvent(tx, {
      workspaceId,
      deliverableId: row.id,
      fromStatus: "ready",
      toStatus: "blocked",
      reason: "package cancelled",
      createdAt: now,
    });
  }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

interface DeliverableJoinRow {
  deliverable: DeliverableRow;
  laneName: string;
  channel: string;
  format: string;
  campaignName: string;
  variantCount: number;
  latestVariantStatus: string | null;
}

const variantCountSql = sql<number>`(
  SELECT COUNT(*) FROM variants v WHERE v.deliverable_id = ${deliverables.id}
)`;
const latestVariantStatusSql = sql<string | null>`(
  SELECT v.status FROM variants v
  WHERE v.deliverable_id = ${deliverables.id}
  ORDER BY v.variant_version DESC LIMIT 1
)`;

function joinedSelect(db: DbExecutor) {
  return db
    .select({
      deliverable: deliverables,
      laneName: campaignLanes.name,
      channel: campaignLaneRevisions.channel,
      format: campaignLaneRevisions.format,
      campaignName: campaigns.name,
      variantCount: variantCountSql,
      latestVariantStatus: latestVariantStatusSql,
    })
    .from(deliverables)
    .innerJoin(campaignLanes, eq(deliverables.laneId, campaignLanes.id))
    .innerJoin(
      campaignLaneRevisions,
      eq(deliverables.laneRevisionId, campaignLaneRevisions.id),
    )
    .innerJoin(campaigns, eq(deliverables.campaignId, campaigns.id));
}

function projectDeliverable(row: DeliverableJoinRow): Deliverable {
  const d = row.deliverable;
  return deliverableSchema.parse({
    id: d.id,
    workspaceId: d.workspaceId,
    campaignId: d.campaignId,
    planRevisionId: d.planRevisionId,
    laneId: d.laneId,
    laneRevisionId: d.laneRevisionId,
    kind: d.kind,
    originalScheduledFor: d.originalScheduledFor,
    packageId: d.packageId,
    angle: d.angle,
    angleHash: d.angleHash,
    status: d.status,
    generationState: d.generationState,
    generationAttempts: d.generationAttempts,
    generatedAt: d.generatedAt,
    createdByUserId: d.createdByUserId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    laneName: row.laneName,
    channel: row.channel,
    format: row.format,
    campaignName: row.campaignName,
    variantCount: row.variantCount,
    latestVariantStatus: row.latestVariantStatus,
  });
}

export function projectVariant(row: VariantRow): Variant {
  return variantSchema.parse({
    id: row.id,
    deliverableId: row.deliverableId,
    variantVersion: row.variantVersion,
    contextSnapshotId: row.contextSnapshotId,
    status: row.status,
    content: row.content,
    model: row.model,
    provider: row.provider,
    durationMs: row.durationMs,
    createdByUserId: row.createdByUserId,
    selectedAt: row.selectedAt,
    createdAt: row.createdAt,
  });
}

export function listDeliverables(
  db: Db,
  workspaceId: string,
  options: {
    status?: DeliverableProductionStatus;
    campaignId?: string;
    laneId?: string;
    limit?: number;
    offset?: number;
  } = {},
): { deliverables: Deliverable[]; total: number } {
  const limit = Math.min(
    Math.max(options.limit ?? DELIVERABLE_LIST_DEFAULT_LIMIT, 1),
    DELIVERABLE_LIST_MAX_LIMIT,
  );
  const offset = Math.max(options.offset ?? 0, 0);
  const where = and(
    eq(deliverables.workspaceId, workspaceId),
    options.status ? eq(deliverables.status, options.status) : undefined,
    options.campaignId
      ? eq(deliverables.campaignId, options.campaignId)
      : undefined,
    options.laneId ? eq(deliverables.laneId, options.laneId) : undefined,
  );
  const rows = joinedSelect(db)
    .where(where)
    .orderBy(desc(deliverables.createdAt), asc(deliverables.id))
    .limit(limit)
    .offset(offset)
    .all();
  const total =
    db
      .select({ n: sql<number>`COUNT(*)` })
      .from(deliverables)
      .where(where)
      .get()?.n ?? 0;
  return { deliverables: rows.map(projectDeliverable), total };
}

function eventRows(db: DbExecutor, deliverableId: string): DeliverableEvent[] {
  return db
    .select()
    .from(deliverableEvents)
    .where(eq(deliverableEvents.deliverableId, deliverableId))
    .orderBy(
      asc(deliverableEvents.createdAt),
      // Creation (fromStatus null) precedes same-millisecond dispositions.
      sql`${deliverableEvents.fromStatus} IS NOT NULL`,
      asc(deliverableEvents.id),
    )
    .all()
    .map((row) =>
      deliverableEventSchema.parse({
        id: row.id,
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        actorUserId: row.actorUserId,
        reason: row.reason,
        createdAt: row.createdAt,
      }),
    );
}

export function getDeliverableDetail(
  db: Db,
  workspaceId: string,
  deliverableId: string,
): DeliverableDetail {
  const row = joinedSelect(db)
    .where(
      and(
        eq(deliverables.id, deliverableId),
        eq(deliverables.workspaceId, workspaceId),
      ),
    )
    .get();
  if (!row) throw new DeliverableNotFoundError();
  const variantRows = db
    .select()
    .from(variants)
    .where(eq(variants.deliverableId, deliverableId))
    .orderBy(desc(variants.variantVersion))
    .all()
    .map(projectVariant);
  return {
    deliverable: projectDeliverable(row),
    variants: variantRows,
    events: eventRows(db, deliverableId),
  };
}

export function getVariantSnapshot(
  db: Db,
  workspaceId: string,
  deliverableId: string,
  variantId: string,
): ContextSnapshot {
  const variant = db
    .select()
    .from(variants)
    .where(
      and(
        eq(variants.id, variantId),
        eq(variants.deliverableId, deliverableId),
        eq(variants.workspaceId, workspaceId),
      ),
    )
    .get();
  if (!variant) throw new VariantNotFoundError();
  const snapshot = db
    .select()
    .from(contextSnapshots)
    .where(eq(contextSnapshots.id, variant.contextSnapshotId))
    .get();
  if (!snapshot) throw new SnapshotNotFoundError();
  return contextSnapshotSchema.parse({
    id: snapshot.id,
    deliverableId: snapshot.deliverableId,
    packageId: snapshot.packageId,
    resolvedContext: JSON.parse(snapshot.resolvedContextJson),
    inputs: JSON.parse(snapshot.inputsJson),
    model: snapshot.model,
    provider: snapshot.provider,
    createdAt: snapshot.createdAt,
  });
}

/**
 * Apply an operator decision (D-63.7). `regenerate` is a queue action — it
 * re-opens generation without a status change; `select` fulfills the
 * deliverable and supersedes sibling candidates; `cancel` is terminal via the
 * machine. Variant rows and snapshots stay immutable (invariant 4).
 */
export function decideDeliverable(
  db: Db,
  workspaceId: string,
  deliverableId: string,
  input: {
    action: DeliverableDecisionAction;
    variantId?: string;
    reason?: string;
    actorUserId: string | null;
  },
): DeliverableDetail {
  db.transaction((tx) => {
    const row = tx
      .select()
      .from(deliverables)
      .where(
        and(
          eq(deliverables.id, deliverableId),
          eq(deliverables.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!row) throw new DeliverableNotFoundError();
    const from = row.status as DeliverableProductionStatus;
    const now = Date.now();

    if (input.action === "regenerate") {
      // A queue reset, not a status transition: legal while awaiting a first
      // variant (ready, incl. the failed queue) or holding candidates.
      if (from !== "ready" && from !== "candidate_ready") {
        throw new InvalidDeliverableTransitionError(from, "regenerate");
      }
      tx.update(deliverables)
        .set({
          generationState: "pending",
          generationAttempts: 0,
          generationLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(deliverables.id, deliverableId))
        .run();
      return;
    }

    if (input.action === "select") {
      if (!canTransitionDeliverable(from, "fulfilled")) {
        throw new InvalidDeliverableTransitionError(from, "select");
      }
      const variant = tx
        .select()
        .from(variants)
        .where(
          and(
            eq(variants.id, input.variantId ?? ""),
            eq(variants.deliverableId, deliverableId),
          ),
        )
        .get();
      if (!variant) throw new VariantNotFoundError();
      if (!canTransitionVariant(variant.status as VariantStatus, "selected")) {
        throw new InvalidDeliverableTransitionError(from, "select");
      }
      tx.update(variants)
        .set({ status: "selected", selectedAt: now })
        .where(and(eq(variants.id, variant.id), eq(variants.status, "candidate")))
        .run();
      tx.update(variants)
        .set({ status: "superseded" })
        .where(
          and(
            eq(variants.deliverableId, deliverableId),
            eq(variants.status, "candidate"),
            ne(variants.id, variant.id),
          ),
        )
        .run();
      tx.update(deliverables)
        .set({ status: "fulfilled", updatedAt: now })
        .where(and(eq(deliverables.id, deliverableId), eq(deliverables.status, from)))
        .run();
      insertDeliverableEvent(tx, {
        workspaceId,
        deliverableId,
        fromStatus: from,
        toStatus: "fulfilled",
        actorUserId: input.actorUserId,
        reason: input.reason ?? `variant v${variant.variantVersion} selected`,
        createdAt: now,
      });
      return;
    }

    // cancel
    if (!canTransitionDeliverable(from, "cancelled")) {
      throw new InvalidDeliverableTransitionError(from, "cancel");
    }
    tx.update(deliverables)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(eq(deliverables.id, deliverableId), eq(deliverables.status, from)))
      .run();
    insertDeliverableEvent(tx, {
      workspaceId,
      deliverableId,
      fromStatus: from,
      toStatus: "cancelled",
      actorUserId: input.actorUserId,
      reason: input.reason ?? null,
      createdAt: now,
    });
  });
  return getDeliverableDetail(db, workspaceId, deliverableId);
}
