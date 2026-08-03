import type { ResolveCampaignPlan } from "@tuezday/brain";
import type { BrainDocType, DocOutline, ResolvedTaskDocMatrix } from "@tuezday/contracts";
import type { Db } from "../db";
import { getBrainOutlines } from "./brain";
import { getCurrentCampaignPlan } from "./campaign-plans";
import { resolveTaskDocMatrix } from "./context-matrix";

export interface SelectiveContextInputs {
  matrix: ResolvedTaskDocMatrix;
  outlines: Partial<Record<BrainDocType, DocOutline>>;
}

/**
 * The Sprint 43 resolver inputs every resolveContext call site passes: the
 * workspace's merged task matrix and the per-doc outlines. One helper so no
 * call site can drift to a different selection policy.
 */
export function selectiveContextInputs(db: Db, workspaceId: string): SelectiveContextInputs {
  return {
    matrix: resolveTaskDocMatrix(db, workspaceId),
    outlines: getBrainOutlines(db, workspaceId),
  };
}

/**
 * The Sprint 53 `campaignPlan` resolver input: the campaign's **active** plan
 * revision, or `undefined` when there is no campaign in scope or the campaign
 * has never activated a plan. The resolver stays DB-free — it composes and
 * excludes, it never loads — so every campaign-scoped call site loads the plan
 * here and passes it in.
 *
 * Deliberately not folded into `selectiveContextInputs`: that one is
 * workspace-scoped and a plan is campaign-scoped, so a single helper would
 * either need a campaign it usually does not have or would silently return
 * nothing for the sites that do.
 *
 * `CampaignPlanRevision` is a structural superset of `ResolveCampaignPlan`,
 * so the revision passes straight through with no mapping layer.
 */
export function campaignPlanInput(
  db: Db,
  workspaceId: string,
  campaignId: string | null | undefined,
): ResolveCampaignPlan | undefined {
  if (!campaignId) return undefined;
  return getCurrentCampaignPlan(db, workspaceId, campaignId)?.plan;
}
