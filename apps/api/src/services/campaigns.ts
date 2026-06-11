import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type {
  ApprovalState,
  Campaign,
  CampaignStatus,
  Channel,
  UpsertCampaignInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { campaigns, drafts, type CampaignRow } from "../db/schema";

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
  };
}
