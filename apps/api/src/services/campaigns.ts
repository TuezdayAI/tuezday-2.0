import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type {
  ApprovalState,
  AutomationMode,
  Campaign,
  CampaignAudience,
  CampaignStatus,
  Channel,
  UpdateCampaignAutomationInput,
  UpsertCampaignInput,
} from "@tuezday/contracts";
import type { ResolveCampaign } from "@tuezday/brain";
import type { Db } from "../db";
import { campaigns, drafts, type CampaignRow } from "../db/schema";
import { getCampaignAdMetrics, type CampaignAdMetrics } from "./ads";
import { listCampaignAudiences } from "./audiences";

function rowToCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function inputToColumns(input: UpsertCampaignInput) {
  return {
    name: input.name,
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

export function createCampaign(db: Db, workspaceId: string, input: UpsertCampaignInput): Campaign {
  const now = Date.now();
  const row: CampaignRow = {
    id: randomUUID(),
    workspaceId,
    ...inputToColumns(input),
    // Automation is set only via the dedicated toggle, never reset by a general
    // campaign edit; a new campaign starts from the input defaults (manual / null).
    automationMode: input.automationMode,
    autoDailyCap: input.autoDailyCap,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(campaigns).values(row).run();
  return rowToCampaign(row);
}

export function listCampaigns(db: Db, workspaceId: string): Campaign[] {
  return db
    .select()
    .from(campaigns)
    .where(eq(campaigns.workspaceId, workspaceId))
    .orderBy(desc(campaigns.createdAt))
    .all()
    .map(rowToCampaign)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));
}

export function getCampaign(db: Db, workspaceId: string, campaignId: string): Campaign | undefined {
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
  const existing = getCampaign(db, workspaceId, campaignId);
  if (!existing) return undefined;
  db.update(campaigns)
    .set({ ...inputToColumns(input), updatedAt: Date.now() })
    .where(eq(campaigns.id, campaignId))
    .run();
  return getCampaign(db, workspaceId, campaignId);
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
 * Compose the campaign's resolver overlay from its structured fields plus the
 * free-form overlay. Deterministic; empty fields are omitted so the context
 * stays clean while the campaign is still being filled in.
 */
export function composeCampaignOverlay(campaign: Campaign): string {
  const parts: string[] = [];
  if (campaign.objective) parts.push(`Objective: ${campaign.objective}`);
  if (campaign.kpi) parts.push(`KPI: ${campaign.kpi}`);
  if (campaign.timeframe) parts.push(`Timeframe: ${campaign.timeframe}`);
  if (campaign.audience) parts.push(`Audience: ${campaign.audience}`);
  if (campaign.pillars.length > 0)
    parts.push(`Messaging pillars:\n${campaign.pillars.map((p) => `- ${p}`).join("\n")}`);
  if (campaign.overlay.trim()) parts.push(campaign.overlay.trim());
  return parts.join("\n\n");
}

/**
 * The campaign as the resolver takes it (Sprint 43): the composed overlay plus
 * the structured objective/pillars, which feed the Tier-3 zoom query.
 */
export function composeResolveCampaign(campaign: Campaign): ResolveCampaign {
  return {
    name: campaign.name,
    overlay: composeCampaignOverlay(campaign),
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
  };
}
