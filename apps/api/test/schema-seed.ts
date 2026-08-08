/**
 * The campaign→story→opportunity→package→deliverable graph the schema tests
 * assert against.
 *
 * Before Sprint 74 each migration test carried its own positional-SQL copy of
 * this seed. The tables are typed, so the inserts go through drizzle here: it
 * is a third of the code and a column rename can no longer silently seed the
 * wrong field.
 */
import type { Db } from "../src/db";
import {
  campaignLaneRevisions,
  campaignLanes,
  campaignOpportunities,
  campaignPlanRevisions,
  campaignRoutingProfiles,
  campaigns,
  canonicalExternalStories,
  contentPackages,
  contextSnapshots,
  deliverables,
  personas,
  sufficiencyAssessments,
  variants,
  workspaces,
} from "../src/db/schema";

export const WS = "ws-1";
export const CAMPAIGN = "camp-1";
export const PLAN_REVISION = "rev-1";
export const STORY = "story-1";
export const ROUTING_PROFILE = "prof-1";
export const OPPORTUNITY = "opp-1";
export const PERSONA = "persona-1";
export const LANE = "lane-1";
export const LANE_REVISION = "lanerev-1";
/** The package id the assessment helper attaches to. */
export const PACKAGE_FIRST = "pkg-1";

/**
 * Seed everything a package or deliverable needs to exist. Ids are the
 * constants above so assertions can name rows without threading a result
 * object through every helper.
 */
export async function seedCampaignGraph(db: Db): Promise<void> {
  await db.insert(workspaces).values({ id: WS, name: "Workspace", createdAt: 1, updatedAt: 1 });
  await db
    .insert(campaigns)
    .values({ id: CAMPAIGN, workspaceId: WS, name: "Launch", createdAt: 1, updatedAt: 1 });
  await db.insert(campaignPlanRevisions).values({
    id: PLAN_REVISION,
    workspaceId: WS,
    campaignId: CAMPAIGN,
    revision: 1,
    status: "active",
    objective: "Grow",
    kpi: "Signups",
    timeframe: "Q3",
    createdAt: 1,
    activatedAt: 1,
  });
  await db.insert(canonicalExternalStories).values({
    id: STORY,
    workspaceId: WS,
    status: "active",
    canonicalUrl: "https://ex.com/a",
    title: "A",
    contentFingerprint: "fp-a",
    firstObservedAt: 1,
    lastObservedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  await db.insert(campaignRoutingProfiles).values({
    id: ROUTING_PROFILE,
    workspaceId: WS,
    campaignId: CAMPAIGN,
    planRevisionId: PLAN_REVISION,
    profileVersion: 1,
    profileFingerprint: "pfp-1",
    routingBand: "review",
    minFit: 70,
    minConfidence: 60,
    minTrust: 0,
    compilerVersion: 1,
    payloadJson: "{}",
    createdAt: 1,
  });
  await db.insert(campaignOpportunities).values({
    id: OPPORTUNITY,
    workspaceId: WS,
    canonicalStoryId: STORY,
    manualSignalId: null,
    campaignId: CAMPAIGN,
    planRevisionId: PLAN_REVISION,
    routingProfileId: ROUTING_PROFILE,
    status: "qualified",
    angle: "An angle",
    angleHash: "angle-1",
    workspaceRelevance: 80,
    campaignFit: 75,
    confidence: 65,
    actionability: 70,
    sourceTrust: 60,
    reason: "Fits the plan.",
    matcherVersion: 1,
    policyJson: "{}",
    createdAt: 1,
    updatedAt: 1,
  });
  await db.insert(personas).values({
    id: PERSONA,
    workspaceId: WS,
    name: "CTO",
    createdAt: 1,
    updatedAt: 1,
  });
  await db.insert(campaignLanes).values({
    id: LANE,
    workspaceId: WS,
    campaignId: CAMPAIGN,
    key: "li",
    name: "LinkedIn",
    createdAt: 1,
    updatedAt: 1,
  });
  await db.insert(campaignLaneRevisions).values({
    id: LANE_REVISION,
    workspaceId: WS,
    laneId: LANE,
    planRevisionId: PLAN_REVISION,
    personaId: PERSONA,
    channel: "linkedin",
    format: "linkedin_post",
    deliveryMode: "reactive",
    createdAt: 1,
  });
}

export async function insertPackage(
  db: Db,
  id: string,
  overrides: { opportunityId?: string | null } = {},
): Promise<void> {
  await db.insert(contentPackages).values({
    id,
    workspaceId: WS,
    campaignId: CAMPAIGN,
    planRevisionId: PLAN_REVISION,
    opportunityId: overrides.opportunityId === undefined ? OPPORTUNITY : overrides.opportunityId,
    canonicalStoryId: STORY,
    angle: "An angle",
    angleHash: "angle-1",
    novelty: 100,
    createdAt: 1,
    updatedAt: 1,
  });
}

export async function insertAssessment(db: Db, id: string, version: number): Promise<void> {
  await db.insert(sufficiencyAssessments).values({
    id,
    workspaceId: WS,
    packageId: PACKAGE_FIRST,
    assessmentVersion: version,
    verdict: "sufficient",
    confidence: 80,
    assessorVersion: 1,
    createdAt: 1,
  });
}

export async function insertDeliverable(
  db: Db,
  id: string,
  overrides: {
    kind?: string;
    originalScheduledFor?: number | null;
    packageId?: string | null;
  } = {},
): Promise<void> {
  await db.insert(deliverables).values({
    id,
    workspaceId: WS,
    campaignId: CAMPAIGN,
    planRevisionId: PLAN_REVISION,
    laneId: LANE,
    laneRevisionId: LANE_REVISION,
    kind: overrides.kind ?? "planned",
    originalScheduledFor:
      overrides.originalScheduledFor === undefined ? 1_000 : overrides.originalScheduledFor,
    packageId: overrides.packageId ?? null,
    createdAt: 1,
    updatedAt: 1,
  });
}

export async function insertSnapshot(
  db: Db,
  id: string,
  deliverableId: string,
  packageId: string | null,
): Promise<void> {
  await db.insert(contextSnapshots).values({
    id,
    workspaceId: WS,
    deliverableId,
    packageId,
    resolvedContextJson: "{}",
    inputsJson: "{}",
    model: "m",
    provider: "p",
    createdAt: 1,
  });
}

export async function insertVariant(
  db: Db,
  id: string,
  deliverableId: string,
  version: number,
  snapshotId: string,
): Promise<void> {
  await db.insert(variants).values({
    id,
    workspaceId: WS,
    deliverableId,
    variantVersion: version,
    contextSnapshotId: snapshotId,
    content: "Post body",
    model: "m",
    provider: "p",
    durationMs: 5,
    createdAt: 1,
  });
}
