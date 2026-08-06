import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  ROUTING_PROFILE_COMPILER_VERSION,
  campaignRoutingProfileSchema,
  routingProfilePayloadSchema,
  type CampaignRoutingProfile,
  type RoutingPolicyPatch,
  type RoutingProfilePayload,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import {
  audiences,
  campaignRoutingProfiles,
  campaigns,
  type CampaignRoutingProfileRow,
} from "../db/schema";
import { getCurrentCampaignPlan } from "./campaign-plans";

/** Guidance is prompt context, not authority — keep the projection bounded. */
const PROFILE_GUIDANCE_MAX_CHARS = 500;

export function rowToRoutingProfile(
  row: CampaignRoutingProfileRow,
): CampaignRoutingProfile {
  return campaignRoutingProfileSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    campaignId: row.campaignId,
    planRevisionId: row.planRevisionId,
    profileVersion: row.profileVersion,
    profileFingerprint: row.profileFingerprint,
    routingBand: row.routingBand,
    minFit: row.minFit,
    minConfidence: row.minConfidence,
    minTrust: row.minTrust,
    compilerVersion: row.compilerVersion,
    payload: routingProfilePayloadSchema.parse(JSON.parse(row.payloadJson)),
    createdAt: row.createdAt,
  });
}

function parseExclusions(json: string): string[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function distinct(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))].sort();
}

/**
 * Compile the current routing profile for one campaign (design §8.5): a
 * deterministic projection of the active plan revision + active lane
 * revisions + campaign routing policy. Append-only and idempotent — unchanged
 * inputs hash to the same fingerprint and return the existing row; any change
 * inserts a new row with the next per-campaign profileVersion.
 *
 * Returns undefined when the campaign is missing or has no active plan
 * revision (a campaign cannot be routed to before its plan exists).
 */
export function compileRoutingProfile(
  db: Db,
  workspaceId: string,
  campaignId: string,
): CampaignRoutingProfile | undefined {
  const campaign = db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)))
    .get();
  if (!campaign) return undefined;
  const detail = getCurrentCampaignPlan(db, workspaceId, campaignId);
  if (!detail) return undefined;

  const activeLanes = detail.lanes.filter((lane) => lane.status === "active");
  const audienceIds = distinct(detail.plan.audienceIds);
  const audienceNames =
    audienceIds.length > 0
      ? db
          .select({ name: audiences.name })
          .from(audiences)
          .where(
            and(
              eq(audiences.workspaceId, workspaceId),
              inArray(audiences.id, audienceIds),
            ),
          )
          .orderBy(asc(audiences.name))
          .all()
          .map((row) => row.name)
      : [];

  const payload: RoutingProfilePayload = routingProfilePayloadSchema.parse({
    campaignName: campaign.name,
    objective: detail.plan.objective,
    kpi: detail.plan.kpi,
    timeframe: detail.plan.timeframe,
    startAt: detail.plan.startAt,
    endAt: detail.plan.endAt,
    audiences: audienceNames,
    pillars: detail.plan.pillars,
    offers: detail.plan.offers,
    ctas: detail.plan.ctas,
    guidance: detail.plan.guidance.slice(0, PROFILE_GUIDANCE_MAX_CHARS),
    personaIds: distinct(activeLanes.map((lane) => lane.personaId)),
    channels: distinct(activeLanes.map((lane) => lane.channel)),
    formats: distinct(activeLanes.map((lane) => lane.format)),
    exclusions: parseExclusions(campaign.routingExclusionsJson),
  });

  const profileFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        compilerVersion: ROUTING_PROFILE_COMPILER_VERSION,
        planRevisionId: detail.plan.id,
        routingBand: campaign.routingBand,
        minFit: campaign.routingMinFit,
        minConfidence: campaign.routingMinConfidence,
        minTrust: campaign.routingMinTrust,
        payload,
      }),
      "utf8",
    )
    .digest("hex");

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(campaignRoutingProfiles)
      .where(
        and(
          eq(campaignRoutingProfiles.campaignId, campaignId),
          eq(campaignRoutingProfiles.planRevisionId, detail.plan.id),
          eq(campaignRoutingProfiles.profileFingerprint, profileFingerprint),
        ),
      )
      .get();
    if (existing) return rowToRoutingProfile(existing);
    const latest = tx
      .select({ profileVersion: campaignRoutingProfiles.profileVersion })
      .from(campaignRoutingProfiles)
      .where(eq(campaignRoutingProfiles.campaignId, campaignId))
      .orderBy(desc(campaignRoutingProfiles.profileVersion))
      .limit(1)
      .get();
    const inserted = tx
      .insert(campaignRoutingProfiles)
      .values({
        id: randomUUID(),
        workspaceId,
        campaignId,
        planRevisionId: detail.plan.id,
        profileVersion: (latest?.profileVersion ?? 0) + 1,
        profileFingerprint,
        routingBand: campaign.routingBand,
        minFit: campaign.routingMinFit,
        minConfidence: campaign.routingMinConfidence,
        minTrust: campaign.routingMinTrust,
        compilerVersion: ROUTING_PROFILE_COMPILER_VERSION,
        payloadJson: JSON.stringify(payload),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return rowToRoutingProfile(inserted);
  });
}

/**
 * Current profiles for every active campaign that participates in routing
 * (band != off). Compiles lazily; campaigns without an active plan are
 * skipped. Ordered by campaign creation for deterministic candidate ties.
 */
export function currentRoutingProfiles(
  db: Db,
  workspaceId: string,
): CampaignRoutingProfile[] {
  const rows = db
    .select({ id: campaigns.id, routingBand: campaigns.routingBand })
    .from(campaigns)
    .where(
      and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active")),
    )
    .orderBy(asc(campaigns.createdAt), asc(campaigns.id))
    .all();
  const profiles: CampaignRoutingProfile[] = [];
  for (const row of rows) {
    if (row.routingBand === "off") continue;
    const profile = compileRoutingProfile(db, workspaceId, row.id);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

/** Latest compiled profile fingerprints, cheap read for drift checks. */
export function latestProfileFingerprints(
  db: DbExecutor,
  workspaceId: string,
  campaignIds: string[],
): Map<string, string> {
  if (campaignIds.length === 0) return new Map();
  const rows = db
    .select({
      campaignId: campaignRoutingProfiles.campaignId,
      profileFingerprint: campaignRoutingProfiles.profileFingerprint,
      profileVersion: campaignRoutingProfiles.profileVersion,
    })
    .from(campaignRoutingProfiles)
    .where(
      and(
        eq(campaignRoutingProfiles.workspaceId, workspaceId),
        inArray(campaignRoutingProfiles.campaignId, campaignIds),
      ),
    )
    .all();
  const latest = new Map<string, { version: number; fingerprint: string }>();
  for (const row of rows) {
    const current = latest.get(row.campaignId);
    if (!current || row.profileVersion > current.version) {
      latest.set(row.campaignId, {
        version: row.profileVersion,
        fingerprint: row.profileFingerprint,
      });
    }
  }
  return new Map(
    [...latest.entries()].map(([campaignId, value]) => [
      campaignId,
      value.fingerprint,
    ]),
  );
}

/**
 * Update the campaign's routing policy and recompile. Returns the fresh
 * profile, or undefined when the campaign has no active plan yet (the policy
 * columns still update so they take effect once a plan activates).
 */
export function updateRoutingPolicy(
  db: Db,
  workspaceId: string,
  campaignId: string,
  patch: RoutingPolicyPatch,
): { updated: boolean; profile: CampaignRoutingProfile | undefined } {
  const changes: Partial<{
    routingBand: string;
    routingMinFit: number;
    routingMinConfidence: number;
    routingMinTrust: number;
    routingExclusionsJson: string;
    updatedAt: number;
  }> = {};
  if (patch.band !== undefined) changes.routingBand = patch.band;
  if (patch.minFit !== undefined) changes.routingMinFit = patch.minFit;
  if (patch.minConfidence !== undefined)
    changes.routingMinConfidence = patch.minConfidence;
  if (patch.minTrust !== undefined) changes.routingMinTrust = patch.minTrust;
  if (patch.exclusions !== undefined)
    changes.routingExclusionsJson = JSON.stringify(patch.exclusions);
  if (Object.keys(changes).length > 0) {
    changes.updatedAt = Date.now();
    const result = db
      .update(campaigns)
      .set(changes)
      .where(
        and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)),
      )
      .run();
    if (result.changes === 0) return { updated: false, profile: undefined };
  }
  return {
    updated: true,
    profile: compileRoutingProfile(db, workspaceId, campaignId),
  };
}
