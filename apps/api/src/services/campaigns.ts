import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type {
  ApprovalState,
  AutomationMode,
  Campaign,
  CampaignAudience,
  CampaignOrigin,
  CampaignStatus,
  Channel,
  UpdateCampaignAutomationInput,
  UpsertCampaignInput,
} from "@tuezday/contracts";
import { composeCampaignPlanSection } from "@tuezday/brain";
import type { ResolveCampaign, ResolveCampaignPlan } from "@tuezday/brain";
import type { Db, DbExecutor } from "../db";
import {
  campaigns,
  drafts,
  externalActionPolicyRules,
  type CampaignRow,
} from "../db/schema";
import { getCampaignAdMetrics, type CampaignAdMetrics } from "./ads";
import { listCampaignAudiences } from "./audiences";
import { ensureCampaignActionPolicies } from "./external-action-backfill";
import { deleteGuidanceForScope } from "./guidance";
import {
  invalidateMatching,
  itemIdsForCampaignChange,
} from "./matching-invalidation";
import {
  getCampaignControlPlaneSummary,
  type ControlPlaneSummary,
} from "./orchestration-backfill";

function rowToCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    origin: row.origin as Campaign["origin"],
    purpose: row.purpose as Campaign["purpose"],
    objective: row.objective,
    kpi: row.kpi,
    timeframe: row.timeframe,
    audience: row.audience,
    pillars: JSON.parse(row.pillarsJson) as string[],
    channels: JSON.parse(row.channelsJson) as Channel[],
    personaIds: JSON.parse(row.personaIdsJson) as string[],
    overlay: row.overlay,
    status: row.status as CampaignStatus,
    automationMode: row.automationMode as AutomationMode,
    autoDailyCap: row.autoDailyCap,
    currentPlanRevisionId: row.currentPlanRevisionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Backward-compatible route error for campaign-scoped execution. */
export function campaignExecutionError(
  campaign: Pick<Campaign, "status">,
): "campaign_archived" | "campaign_inactive" | null {
  if (campaign.status === "active") return null;
  return campaign.status === "archived" ? "campaign_archived" : "campaign_inactive";
}

function inputToColumns(input: UpsertCampaignInput) {
  return {
    name: input.name,
    purpose: input.purpose,
    objective: input.objective,
    kpi: input.kpi,
    timeframe: input.timeframe,
    audience: input.audience,
    pillarsJson: JSON.stringify(input.pillars),
    channelsJson: JSON.stringify(input.channels),
    personaIdsJson: JSON.stringify(input.personaIds),
    overlay: input.overlay,
    status: input.status,
  };
}

export function createCampaign(
  db: Db,
  workspaceId: string,
  input: UpsertCampaignInput,
  /** Sprint 77: `propose_campaign` creates campaigns as `system` so the
   * campaign list can tell a founder which ones an agent drew up (D-77.7).
   * Every existing caller is a person on a route, and keeps `user`. */
  options: { origin?: CampaignOrigin } = {},
): Campaign {
  return db.transaction((tx) => {
    const now = Date.now();
    const row: CampaignRow = {
      id: randomUUID(),
      workspaceId,
      origin: options.origin ?? "user",
      ...inputToColumns(input),
      // Automation is set only via the dedicated toggle, never reset by a general
      // campaign edit; a new campaign starts from the input defaults (manual / null).
      automationMode: input.automationMode,
      autoDailyCap: input.autoDailyCap,
      // Sprint 61 routing policy starts from the schema defaults (D-61.1).
      routingBand: "review",
      routingMinFit: 70,
      routingMinConfidence: 60,
      routingMinTrust: 0,
      routingExclusionsJson: "[]",
      currentPlanRevisionId: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(campaigns).values(row).run();
    ensureCampaignActionPolicies(
      tx,
      workspaceId,
      row.id,
      input.automationMode,
    );
    if (input.status === "active") {
      invalidateMatching(tx, workspaceId, {
        directItemIds: [],
        includeReadyNoMatch: true,
      });
    }
    return rowToCampaign(row);
  });
}

export function listCampaigns(db: DbExecutor, workspaceId: string): Campaign[] {
  return db
    .select()
    .from(campaigns)
    .where(eq(campaigns.workspaceId, workspaceId))
    .orderBy(desc(campaigns.createdAt))
    .all()
    .map(rowToCampaign)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));
}

export function getCampaign(
  db: DbExecutor,
  workspaceId: string,
  campaignId: string,
): Campaign | undefined {
  const row = db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, campaignId)))
    .get();
  return row ? rowToCampaign(row) : undefined;
}

export function updateCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
  input: UpsertCampaignInput,
): Campaign | undefined {
  return db.transaction((tx) => {
    const existing = getCampaign(tx, workspaceId, campaignId);
    if (!existing) return undefined;
    const previousPersonaIds = [...existing.personaIds].sort();
    const currentPersonaIds = [...input.personaIds].sort();
    const matchingChanged =
      existing.name !== input.name ||
      existing.objective !== input.objective ||
      existing.status !== input.status ||
      JSON.stringify(previousPersonaIds) !==
        JSON.stringify(currentPersonaIds);
    const shouldInvalidate =
      matchingChanged &&
      (existing.status === "active" || input.status === "active");
    const blastRadiusPersonaIds = [
      ...new Set([...existing.personaIds, ...input.personaIds]),
    ];
    const directItemIds = shouldInvalidate
      ? itemIdsForCampaignChange(
          tx,
          workspaceId,
          campaignId,
          blastRadiusPersonaIds,
        )
      : [];

    tx.update(campaigns)
      .set({ ...inputToColumns(input), updatedAt: Date.now() })
      .where(eq(campaigns.id, campaignId))
      .run();
    if (shouldInvalidate) {
      invalidateMatching(tx, workspaceId, {
        directItemIds,
        includeReadyNoMatch: input.status === "active",
      });
    }
    return getCampaign(tx, workspaceId, campaignId);
  });
}

export function deleteCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
): boolean {
  return db.transaction((tx) => {
    const existing = getCampaign(tx, workspaceId, campaignId);
    if (!existing) return false;
    const directItemIds = itemIdsForCampaignChange(
      tx,
      workspaceId,
      campaignId,
      existing.personaIds,
    );
    invalidateMatching(tx, workspaceId, {
      directItemIds,
      includeReadyNoMatch: false,
    });
    deleteGuidanceForScope(tx, workspaceId, { campaignId });
    tx.delete(externalActionPolicyRules)
      .where(
        and(
          eq(externalActionPolicyRules.workspaceId, workspaceId),
          eq(externalActionPolicyRules.scope, "campaign"),
          eq(externalActionPolicyRules.scopeId, campaignId),
        ),
      )
      .run();
    tx.delete(campaigns).where(eq(campaigns.id, campaignId)).run();
    return true;
  });
}

/** Set a campaign's automation mode + per-campaign daily cap (Sprint 28). */
export function setCampaignAutomation(
  db: Db,
  workspaceId: string,
  campaignId: string,
  input: UpdateCampaignAutomationInput,
): Campaign | undefined {
  const existing = getCampaign(db, workspaceId, campaignId);
  if (!existing) return undefined;
  db.update(campaigns)
    .set({
      automationMode: input.automationMode,
      autoDailyCap: input.autoDailyCap,
      updatedAt: Date.now(),
    })
    .where(eq(campaigns.id, campaignId))
    .run();
  return getCampaign(db, workspaceId, campaignId);
}

/** Active campaigns whose automation is on (human_in_the_loop or scheduled_auto). */
export function listAutomatedCampaigns(db: Db, workspaceId: string): Campaign[] {
  return listCampaigns(db, workspaceId).filter(
    (c) => c.status === "active" && c.automationMode !== "manual",
  );
}

/**
 * The campaign's resolver overlay: **the free text alone** (Sprint 53, D3a).
 *
 * This used to concatenate the campaign row's structured columns (`Objective:`,
 * `KPI:`, `Timeframe:`, `Audience:`, `Messaging pillars:`) and *then* append the
 * free text, which made the row a third home for campaign strategy alongside
 * `campaign_plan_revisions` and the plan form. The plan wins; the overlay is now
 * "additional instruction" and nothing else.
 *
 * Deliberately plan-blind — the fallback for a plan-less campaign lives in
 * `composeResolveCampaign`, where the plan is in scope.
 */
export function composeCampaignOverlay(campaign: Campaign): string {
  return campaign.overlay.trim();
}

/**
 * The campaign row's legacy structured strategy block, composed exactly as
 * `composeCampaignOverlay` used to compose it (minus the free text).
 *
 * **Fallback only.** Sprint 53 moved campaign strategy to the active plan
 * revision, but a campaign can genuinely have no active revision: nothing in
 * campaign *creation* mints a plan, and `backfillMissingCampaignPlans` runs at
 * boot, so every campaign created since the last boot is plan-less — as is any
 * campaign whose activation failed validation (a lane pointing at a
 * disconnected connection) and kept a draft-only plan.
 *
 * Dropping the block unconditionally would silently strip objective/KPI/
 * timeframe/audience/pillars from those campaigns' prompts. A second
 * composition path that exists only while a plan is missing, and that announces
 * itself in the trace, is the cheaper failure.
 */
export function composeLegacyCampaignStrategy(campaign: Campaign): string {
  const parts: string[] = [];
  if (campaign.objective) parts.push(`Objective: ${campaign.objective}`);
  if (campaign.kpi) parts.push(`KPI: ${campaign.kpi}`);
  if (campaign.timeframe) parts.push(`Timeframe: ${campaign.timeframe}`);
  if (campaign.audience) parts.push(`Audience: ${campaign.audience}`);
  if (campaign.pillars.length > 0)
    parts.push(`Messaging pillars:\n${campaign.pillars.map((p) => `- ${p}`).join("\n")}`);
  return parts.join("\n\n");
}

/**
 * The campaign as the resolver takes it.
 *
 * `overlay` is the free-text instruction (Sprint 53); `objective`/`pillars`
 * still ride along because `composeZoomQuery` (`packages/brain/src/zoom.ts`)
 * is a separate consumer of them and must not regress.
 *
 * Pass the campaign's **active** plan — the same value the call site hands to
 * `resolveContext` as `campaignPlan`, from `campaignPlanInput`. When the plan
 * would compose to an empty section (absent, or activated with no content), the
 * legacy structured block is prepended and `legacyStrategyFallback` is set so
 * the resolver can name the degradation in the trace. Emptiness is measured
 * with the resolver's own composer, so the two can never disagree about whether
 * a plan carries strategy.
 */
export function composeResolveCampaign(
  campaign: Campaign,
  plan?: ResolveCampaignPlan,
): ResolveCampaign {
  const instruction = composeCampaignOverlay(campaign);
  const planCarriesStrategy = composeCampaignPlanSection(plan).content.length > 0;
  const legacy = planCarriesStrategy ? "" : composeLegacyCampaignStrategy(campaign);
  return {
    name: campaign.name,
    overlay: legacy ? [legacy, instruction].filter(Boolean).join("\n\n") : instruction,
    legacyStrategyFallback: legacy.length > 0,
    objective: campaign.objective || undefined,
    pillars: campaign.pillars.length > 0 ? campaign.pillars : undefined,
  };
}

export interface CampaignDetail {
  campaign: Campaign;
  draftCounts: Record<ApprovalState, number>;
  drafts: Array<{
    id: string;
    state: ApprovalState;
    taskType: string;
    channel: string;
    createdAt: number;
  }>;
  /** Paid totals from linked ad campaigns (Sprint 14); null when none. */
  adMetrics: CampaignAdMetrics | null;
  /** Audiences attached as this campaign's targets (Sprint 24). */
  audiences: CampaignAudience[];
  /** Shadow read model while legacy campaign execution remains active. */
  controlPlane: ControlPlaneSummary;
}

export function getCampaignDetail(db: Db, campaign: Campaign): CampaignDetail {
  const rows = db
    .select({
      id: drafts.id,
      state: drafts.state,
      taskType: drafts.taskType,
      channel: drafts.channel,
      createdAt: drafts.createdAt,
    })
    .from(drafts)
    .where(and(eq(drafts.workspaceId, campaign.workspaceId), eq(drafts.campaignId, campaign.id)))
    .orderBy(desc(drafts.createdAt))
    .all();

  const draftCounts = {
    draft: 0,
    pending_review: 0,
    edited: 0,
    approved: 0,
    rejected: 0,
  } as Record<ApprovalState, number>;
  for (const row of rows) draftCounts[row.state as ApprovalState] += 1;

  return {
    campaign,
    draftCounts,
    drafts: rows.map((r) => ({ ...r, state: r.state as ApprovalState })),
    adMetrics: getCampaignAdMetrics(db, campaign),
    audiences: listCampaignAudiences(db, campaign.workspaceId, campaign.id),
    controlPlane: getCampaignControlPlaneSummary(db, campaign.workspaceId, campaign.id),
  };
}
