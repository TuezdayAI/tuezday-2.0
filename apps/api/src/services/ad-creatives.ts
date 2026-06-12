import {
  AD_CREATIVE_FORMATS,
  AD_CREATIVE_TASK_TYPES,
  formatAdCreative,
  parseAdCreative,
  validateAdCreative,
  type AdCreativeTaskType,
  type AdCreativeViolation,
  type ApprovalState,
  type Channel,
  type Draft,
  type TaskType,
} from "@tuezday/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { drafts, type DraftRow } from "../db/schema";
import { getCampaignAdMetrics, type CampaignAdMetrics } from "./ads";
import { listCampaigns } from "./campaigns";

/**
 * Split one LLM response into canonical variant contents. Formats with a
 * variant count separate variants with `---`; asset-set formats (google_rsa)
 * are one variant per response. Chunks that don't parse are dropped — an
 * empty result means the whole output was unusable (the route turns that
 * into 502 generation_unparseable).
 */
export function parseGeneratedVariants(taskType: AdCreativeTaskType, output: string): string[] {
  let text = output.trim();
  const fence = /^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (fence) text = fence[1]!.trim();

  const chunks = AD_CREATIVE_FORMATS[taskType].variantCount
    ? text.split(/\r?\n\s*-{3,}\s*(?:\r?\n|$)/)
    : [text];

  const variants: string[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const parsed = parseAdCreative(taskType, trimmed);
    // Re-serialize so stored drafts use the canonical labels/casing.
    if (parsed) variants.push(formatAdCreative(taskType, parsed.fields));
  }
  return variants;
}

export interface AdCreativeSetDraft extends Draft {
  violations: AdCreativeViolation[];
}

export interface AdCreativeSet {
  generationId: string;
  taskType: AdCreativeTaskType;
  campaignId: string | null;
  campaignName: string | null;
  personaId: string | null;
  createdAt: number;
  drafts: AdCreativeSetDraft[];
  adMetrics: CampaignAdMetrics | null;
}

function rowToDraft(row: DraftRow): Draft {
  return {
    ...row,
    taskType: row.taskType as TaskType,
    channel: row.channel as Channel,
    state: row.state as ApprovalState,
  };
}

export function withViolations(draft: Draft): AdCreativeSetDraft {
  return {
    ...draft,
    violations: validateAdCreative(draft.taskType as AdCreativeTaskType, draft.content).violations,
  };
}

/** Ad creative drafts grouped into variant sets (one set per generation). */
export function listAdCreativeSets(db: Db, workspaceId: string): AdCreativeSet[] {
  const rows = db
    .select()
    .from(drafts)
    .where(
      and(
        eq(drafts.workspaceId, workspaceId),
        inArray(drafts.taskType, [...AD_CREATIVE_TASK_TYPES]),
      ),
    )
    .orderBy(asc(drafts.createdAt))
    .all();

  const campaignById = new Map(listCampaigns(db, workspaceId).map((c) => [c.id, c]));
  const metricsByCampaign = new Map<string, CampaignAdMetrics | null>();
  const sets = new Map<string, AdCreativeSet>();

  for (const row of rows) {
    const draft = rowToDraft(row);
    const key = draft.sourceGenerationId ?? draft.id;
    let set = sets.get(key);
    if (!set) {
      const campaign = draft.campaignId ? campaignById.get(draft.campaignId) : undefined;
      let adMetrics: CampaignAdMetrics | null = null;
      if (campaign) {
        if (!metricsByCampaign.has(campaign.id)) {
          metricsByCampaign.set(campaign.id, getCampaignAdMetrics(db, campaign));
        }
        adMetrics = metricsByCampaign.get(campaign.id) ?? null;
      }
      set = {
        generationId: key,
        taskType: draft.taskType as AdCreativeTaskType,
        campaignId: draft.campaignId,
        campaignName: campaign?.name ?? null,
        personaId: draft.personaId,
        createdAt: draft.createdAt,
        drafts: [],
        adMetrics,
      };
      sets.set(key, set);
    }
    set.drafts.push(withViolations(draft));
  }

  return [...sets.values()].sort((a, b) => b.createdAt - a.createdAt);
}
