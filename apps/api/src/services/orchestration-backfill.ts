import {
  campaignPlanWorkspaceSchema,
  type Campaign,
  type CampaignLaneRevisionView,
  type CampaignPlanIssue,
  type CampaignPlanWorkspace,
  type Channel,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { getCampaign } from "./campaigns";
import { listCadenceRows } from "./cadences";
import { listCampaignAudiences } from "./audiences";
import { upsertLaneRevision } from "./campaign-lanes";
import {
  activatePlanRevision,
  createPlanRevision,
  getCurrentCampaignPlan,
  listCampaignPlanDetails,
} from "./campaign-plans";
import { CampaignPlanNotFoundError } from "./campaign-plan-errors";

export type BackfillStatus = "backfilled" | "needs_configuration" | "already_backfilled";

export interface BackfillResult {
  status: BackfillStatus;
  planRevisionId: string;
  issues: CampaignPlanIssue[];
}

export interface ControlPlaneSummary {
  planRevision: number | null;
  laneCount: number;
  configurationIssueCount: number;
}

const LEGACY_FORMAT_BY_CHANNEL: Partial<Record<Channel, string>> = {
  linkedin: "linkedin_post",
  instagram: "instagram_post",
  x: "x_post",
};

export function getCampaignConfigurationIssues(
  campaign: Campaign,
  lanes: readonly Pick<CampaignLaneRevisionView, "channel" | "status">[],
): CampaignPlanIssue[] {
  const activeChannels = new Set(
    lanes.filter((lane) => lane.status === "active").map((lane) => lane.channel),
  );
  return campaign.channels
    .filter((channel) => !activeChannels.has(channel))
    .map((channel) => ({
      path: `channels.${channel}`,
      code: "execution_mapping_missing",
      message: `Choose a persona, publishing account, format, and schedule for ${channel}.`,
    }));
}

export async function getCampaignPlanWorkspace(
  db: Db,
  workspaceId: string,
  campaignId: string,
): Promise<CampaignPlanWorkspace> {
  const campaign = await getCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new CampaignPlanNotFoundError();
  const revisions = await listCampaignPlanDetails(db, workspaceId, campaignId);
  const workingRevision =
    revisions.find(({ plan }) => plan.status === "draft") ??
    revisions.find(({ plan }) => plan.id === campaign.currentPlanRevisionId) ??
    null;
  return campaignPlanWorkspaceSchema.parse({
    currentPlanRevisionId: campaign.currentPlanRevisionId,
    revisions,
    issues: getCampaignConfigurationIssues(campaign, workingRevision?.lanes ?? []),
  });
}

export async function getCampaignControlPlaneSummary(
  db: Db,
  workspaceId: string,
  campaignId: string,
): Promise<ControlPlaneSummary> {
  const campaign = await getCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new CampaignPlanNotFoundError();
  const detail = await getCurrentCampaignPlan(db, workspaceId, campaignId);
  if (!detail) {
    return {
      planRevision: null,
      laneCount: 0,
      configurationIssueCount: campaign.channels.length,
    };
  }
  return {
    planRevision: detail.plan.revision,
    laneCount: detail.lanes.length,
    configurationIssueCount: getCampaignConfigurationIssues(campaign, detail.lanes).length,
  };
}

export async function backfillCampaignControlPlane(
  db: Db,
  workspaceId: string,
  campaignId: string,
): Promise<BackfillResult> {
  const campaign = await getCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new CampaignPlanNotFoundError();
  const existing = await getCurrentCampaignPlan(db, workspaceId, campaignId);
  if (existing) {
    return {
      status: "already_backfilled",
      planRevisionId: existing.plan.id,
      issues: getCampaignConfigurationIssues(campaign, existing.lanes),
    };
  }

  const campaignAudiences = await listCampaignAudiences(db, workspaceId, campaignId);
  const plan = await createPlanRevision(
    db,
    workspaceId,
    campaignId,
    {
      objective: campaign.objective,
      kpi: campaign.kpi,
      timeframe: campaign.timeframe,
      startAt: null,
      endAt: null,
      audienceIds: campaignAudiences.map((audience) => audience.id),
      pillars: campaign.pillars,
      offers: [],
      ctas: [],
      // Deliberately **not** `campaign.overlay` (Sprint 53 review, C1).
      //
      // The backfill exists to rehome the five *strategy* columns — objective,
      // KPI, timeframe, audience, pillars — which stopped reaching the prompt
      // when `composeCampaignOverlay` was re-scoped. The free-text overlay did
      // not move: it is still emitted verbatim as the `campaign` section's
      // "additional instruction". Copying it into `guidance` as well put the
      // same bytes in the prompt twice (once per section) the moment the boot
      // sweep ran, and left a second copy that drifts the first time either the
      // overlay or the plan is edited.
      guidance: "",
    },
    { userId: null },
  );

  const laneChannels = new Set<string>();
  const cadences = (await listCadenceRows(db, workspaceId)).filter(
    (cadence) => cadence.campaignId === campaignId && cadence.status === "active",
  );
  for (const cadence of cadences) {
    const format = LEGACY_FORMAT_BY_CHANNEL[cadence.channel];
    if (!cadence.personaId || !format) continue;
    const key = `legacy-${cadence.channel}-${cadence.personaId.slice(0, 8)}-${cadence.id.slice(0, 8)}`;
    await upsertLaneRevision(db, workspaceId, campaignId, plan.id, {
      key,
      name: cadence.name,
      personaId: cadence.personaId,
      // Several attached audiences cannot be assigned to one lane safely.
      audienceId: campaignAudiences.length === 1 ? campaignAudiences[0]!.id : null,
      channel: cadence.channel,
      format,
      publishingConnectionId: cadence.connectionId,
      providerTarget: cadence.target,
      deliveryMode: "planned",
      plannedQuantity: cadence.daysOfWeek.length,
      schedule: {
        daysOfWeek: cadence.daysOfWeek,
        timeOfDay: cadence.timeOfDay,
        timezone: cadence.timezone,
      },
      reactivePeriod: null,
      reactiveCap: null,
      status: "active",
    });
    laneChannels.add(cadence.channel);
  }

  const issues = getCampaignConfigurationIssues(
    campaign,
    Array.from(laneChannels).map((channel) => ({ channel: channel as Channel, status: "active" as const })),
  );
  await activatePlanRevision(db, workspaceId, campaignId, plan.id);
  return {
    status: issues.length > 0 ? "needs_configuration" : "backfilled",
    planRevisionId: plan.id,
    issues,
  };
}
