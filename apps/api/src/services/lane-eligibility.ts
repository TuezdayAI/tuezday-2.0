import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  LANE_ELIGIBILITY_EVALUATOR_VERSION,
  formatCapability,
  type LaneEligibilityCheck,
} from "@tuezday/contracts";
import type { DbExecutor } from "../db";
import {
  campaignLaneRevisions,
  campaignLanes,
  campaignOpportunities,
  contentPackages,
  laneEligibilityDecisions,
  type ContentPackageRow,
  type SufficiencyAssessmentRow,
} from "../db/schema";

/**
 * Deterministic lane eligibility (Sprint 62, design §8.8, D-62.5). Every
 * allow/block reason is recorded; the same (package, assessment, lane
 * revision) always evaluates identically, so re-runs are idempotent behind
 * the unique key. No LLM, no wall-clock inputs.
 */

interface LaneUnderEvaluation {
  laneId: string;
  laneRevisionId: string;
  laneStatus: string;
  revisionStatus: string;
  channel: string;
  format: string;
  personaId: string;
}

export interface LaneEvaluation {
  laneId: string;
  laneRevisionId: string;
  eligible: boolean;
  checks: LaneEligibilityCheck[];
}

function evaluateLane(
  lane: LaneUnderEvaluation,
  assessment: { eligibleFormats: string[]; ineligibleFormats: { format: string }[] },
  angleUsedOnLane: boolean,
  suggestedPersona: string | null,
): LaneEvaluation {
  const checks: LaneEligibilityCheck[] = [];

  const laneActive = lane.laneStatus === "active" && lane.revisionStatus === "active";
  checks.push({
    rule: "lane_active",
    passed: laneActive,
    ...(laneActive ? {} : { detail: `lane ${lane.laneStatus}, revision ${lane.revisionStatus}` }),
  });

  const capability = formatCapability(lane.channel, lane.format);
  const registered = capability !== undefined && capability.state === "active";
  checks.push({
    rule: "format_registered",
    passed: registered,
    ...(registered
      ? {}
      : { detail: `${lane.format} is not a registered ${lane.channel} format` }),
  });

  const supported =
    assessment.eligibleFormats.includes(lane.format) &&
    !assessment.ineligibleFormats.some((entry) => entry.format === lane.format);
  checks.push({
    rule: "format_supported",
    passed: supported,
    ...(supported
      ? {}
      : { detail: `sufficiency did not clear ${lane.format}` }),
  });

  // v1: packages carry no media sources yet, so media-requiring formats
  // block honestly (D-62.6). Unregistered formats have no media claim.
  const mediaAvailable = capability === undefined || !capability.requiresMedia;
  checks.push({
    rule: "media_available",
    passed: mediaAvailable,
    ...(mediaAvailable
      ? {}
      : { detail: `${lane.format} requires media the package does not have` }),
  });

  checks.push({
    rule: "angle_novel_for_lane",
    passed: !angleUsedOnLane,
    ...(angleUsedOnLane
      ? { detail: "this angle already targeted this lane (§9.5)" }
      : {}),
  });

  // Non-blocking (§7: the lane revision is the execution authority) — the
  // divergence is recorded for the operator, never enforced.
  const personaDiffers =
    suggestedPersona !== null && suggestedPersona !== lane.personaId;
  checks.push({
    rule: "persona_alignment",
    passed: true,
    ...(personaDiffers
      ? { detail: "suggested persona differs from the lane persona" }
      : {}),
  });

  const eligible = checks
    .filter((check) => check.rule !== "persona_alignment")
    .every((check) => check.passed);
  return {
    laneId: lane.laneId,
    laneRevisionId: lane.laneRevisionId,
    eligible,
    checks,
  };
}

/**
 * Evaluate every lane revision of the package's pinned plan revision against
 * a sufficient assessment and persist one decision row per lane revision.
 * Returns the evaluations (idempotent: conflicts on the unique key are
 * skipped — the decision already recorded is authoritative).
 */
export function persistLaneEligibility(
  tx: DbExecutor,
  pkg: ContentPackageRow,
  assessment: SufficiencyAssessmentRow,
  now: number,
): LaneEvaluation[] {
  const lanes: LaneUnderEvaluation[] = tx
    .select({
      laneId: campaignLanes.id,
      laneRevisionId: campaignLaneRevisions.id,
      laneStatus: campaignLanes.status,
      revisionStatus: campaignLaneRevisions.status,
      channel: campaignLaneRevisions.channel,
      format: campaignLaneRevisions.format,
      personaId: campaignLaneRevisions.personaId,
    })
    .from(campaignLaneRevisions)
    .innerJoin(campaignLanes, eq(campaignLaneRevisions.laneId, campaignLanes.id))
    .where(eq(campaignLaneRevisions.planRevisionId, pkg.planRevisionId))
    .all();
  if (lanes.length === 0) return [];

  // §9.5 rule 5: has any *other* package in this campaign already earned an
  // eligible decision for this angle on one of these lane threads?
  const usedLaneIds = new Set(
    tx
      .select({ laneId: laneEligibilityDecisions.laneId })
      .from(laneEligibilityDecisions)
      .innerJoin(
        contentPackages,
        eq(laneEligibilityDecisions.packageId, contentPackages.id),
      )
      .where(
        and(
          eq(contentPackages.campaignId, pkg.campaignId),
          eq(contentPackages.angleHash, pkg.angleHash),
          ne(contentPackages.id, pkg.id),
          eq(laneEligibilityDecisions.eligible, true),
          inArray(
            laneEligibilityDecisions.laneId,
            lanes.map((lane) => lane.laneId),
          ),
        ),
      )
      .all()
      .map((row) => row.laneId),
  );

  const suggestedPersonaId = pkg.opportunityId
    ? (tx
        .select({ value: campaignOpportunities.suggestedPersonaId })
        .from(campaignOpportunities)
        .where(eq(campaignOpportunities.id, pkg.opportunityId))
        .get()?.value ?? null)
    : null;

  const assessmentView = {
    eligibleFormats: JSON.parse(assessment.eligibleFormatsJson) as string[],
    ineligibleFormats: JSON.parse(assessment.ineligibleFormatsJson) as {
      format: string;
    }[],
  };

  const evaluations = lanes.map((lane) =>
    evaluateLane(
      lane,
      assessmentView,
      usedLaneIds.has(lane.laneId),
      suggestedPersonaId,
    ),
  );
  for (const evaluation of evaluations) {
    tx.insert(laneEligibilityDecisions)
      .values({
        id: randomUUID(),
        workspaceId: pkg.workspaceId,
        packageId: pkg.id,
        assessmentId: assessment.id,
        laneId: evaluation.laneId,
        laneRevisionId: evaluation.laneRevisionId,
        eligible: evaluation.eligible,
        checksJson: JSON.stringify(evaluation.checks),
        evaluatorVersion: LANE_ELIGIBILITY_EVALUATOR_VERSION,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
  return evaluations;
}
