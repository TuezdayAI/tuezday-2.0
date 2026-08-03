import {
  AD_CREATIVE_TASK_TYPES,
  formatAdCreative,
  validateAdCreative,
  type AdCreativeTaskType,
  type AdCreativeViolation,
  type ApprovalState,
  type Channel,
  type Draft,
  type GenerationReview,
  type GoogleRsaResponse,
  type LaunchMedia,
  type MetaAdVariantsResponse,
  type TaskType,
} from "@tuezday/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { drafts, type DraftRow } from "../db/schema";
import { getCampaignAdMetrics, type CampaignAdMetrics } from "./ads";
import { listCampaigns } from "./campaigns";

/**
 * Serialize a structured generation response into canonical variant contents
 * (Sprint 58 — the model returns schema-constrained JSON, not labeled text).
 * Blank-only variants are dropped; an empty result means the whole output was
 * unusable (the route turns that into 502 generation_unparseable). Stored
 * drafts keep the exact same canonical labeled-text format as before —
 * `parseAdCreative`/`validateAdCreative` over stored drafts are untouched.
 */
export function metaAdVariantContents(response: MetaAdVariantsResponse): string[] {
  return response.variants
    .filter((v) => (v.primaryText + v.headline + v.description).trim().length > 0)
    .map((v) =>
      formatAdCreative("meta_ad_creative", [
        { key: "primary_text", index: 1, value: v.primaryText.trim() },
        { key: "headline", index: 1, value: v.headline.trim() },
        { key: "description", index: 1, value: v.description.trim() },
      ]),
    );
}

/** One asset set = one draft; empty when the model produced no usable lines. */
export function googleRsaContents(response: GoogleRsaResponse): string[] {
  const headlines = response.headlines.map((v) => v.trim()).filter(Boolean);
  const descriptions = response.descriptions.map((v) => v.trim()).filter(Boolean);
  if (headlines.length === 0 && descriptions.length === 0) return [];
  return [
    formatAdCreative("google_rsa", [
      ...headlines.map((value, i) => ({ key: "headline", index: i + 1, value })),
      ...descriptions.map((value, i) => ({ key: "description", index: i + 1, value })),
    ]),
  ];
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
  const {
    automationKey: _automationKey,
    reviewJson: _reviewJson,
    mediaJson: _mediaJson,
    ...publicRow
  } = row;
  return {
    ...publicRow,
    taskType: row.taskType as TaskType,
    channel: row.channel as Channel,
    state: row.state as ApprovalState,
    media: _mediaJson
      ? (JSON.parse(_mediaJson) as LaunchMedia[])
      : null,
    review: _reviewJson
      ? (JSON.parse(_reviewJson) as GenerationReview)
      : null,
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
