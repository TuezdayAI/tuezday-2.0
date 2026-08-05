import type { ResolveCampaign, ResolveCampaignPlan, ResolveExamples } from "@tuezday/brain";
import type {
  BrainDocType,
  Campaign,
  Channel,
  CreateCampaignPlanRevisionInput,
  DocOutline,
  ResolvedTaskDocMatrix,
  TaskType,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { getBrainOutlines } from "./brain";
import { getCurrentCampaignPlan } from "./campaign-plans";
import { composeResolveCampaign } from "./campaigns";
import { resolveTaskDocMatrix } from "./context-matrix";
import { retrievePriorExamples } from "./prior-examples";

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

/**
 * The plan input for the inspector's preview (Sprint 53 Task 5): the unsaved
 * draft the founder is typing in the plan form when one is supplied, otherwise
 * the stored active plan. Preview only — nothing here writes.
 *
 * The draft's fields are copied out **one by one** rather than passed through.
 * `CreateCampaignPlanRevisionInput` is already validated by the same schema a
 * stored revision is created through, so no value can exceed a stored
 * revision's cap; the explicit projection additionally guarantees the request
 * body cannot smuggle a field the composer would read but the schema does not
 * govern — notably `revision`, which titles the section. A previewed draft has
 * no revision number, so it renders as "Campaign plan" rather than claiming to
 * be an activated revision N.
 */
export function campaignPlanPreviewInput(
  db: Db,
  workspaceId: string,
  campaignId: string | null | undefined,
  draft: CreateCampaignPlanRevisionInput | undefined,
): ResolveCampaignPlan | undefined {
  if (!campaignId) return undefined;
  if (!draft) return campaignPlanInput(db, workspaceId, campaignId);
  return {
    objective: draft.objective,
    kpi: draft.kpi,
    timeframe: draft.timeframe,
    pillars: draft.pillars,
    offers: draft.offers,
    ctas: draft.ctas,
    guidance: draft.guidance,
  };
}

/**
 * The two campaign-shaped `resolveContext` inputs, produced together.
 *
 * `composeResolveCampaign(campaign, plan)` and `campaignPlan: plan` must be
 * given **the same plan**: the former decides whether to fold the legacy
 * structured block into the overlay and sets `legacyStrategyFallback`, the
 * latter is what the resolver composes the `campaign_plan` section from. Pass
 * different values and the trace contradicts itself — a fallback flag beside a
 * populated plan section, or strategy in neither.
 *
 * Sprint 53 review (I4): fifteen call sites held that invariant by convention
 * and nothing enforced it. Returning both from one function makes them
 * impossible to diverge — spread it straight into the `resolveContext`
 * argument (`...campaignResolveInputs(db, workspaceId, campaign)`).
 */
export interface CampaignResolveInputs {
  campaign: ResolveCampaign | undefined;
  campaignPlan: ResolveCampaignPlan | undefined;
}

export function campaignResolveInputs(
  db: Db,
  workspaceId: string,
  campaign: Campaign | null | undefined,
): CampaignResolveInputs {
  const campaignPlan = campaignPlanInput(db, workspaceId, campaign?.id);
  return {
    campaign: campaign ? composeResolveCampaign(campaign, campaignPlan) : undefined,
    campaignPlan,
  };
}

/**
 * `campaignResolveInputs` for the plan form's preview, where the plan being
 * composed is the unsaved draft rather than the stored active revision. Same
 * pairing guarantee: one plan value feeds both outputs.
 */
/**
 * The Sprint 66 few-shot resolver inputs: prior approved/rejected examples
 * retrieved from approval history, or an exclusion reason when the workspace
 * has no usable history yet. Always returns one or the other, so every
 * participating call site's trace states honestly why examples are(n't) there.
 * Spread it straight into the `resolveContext` argument.
 */
export interface PriorExampleInputs {
  examples: ResolveExamples | undefined;
  examplesExclusionReason: string | undefined;
}

export function priorExampleInputs(
  db: Db,
  workspaceId: string,
  input: { query: string; channel?: Channel; taskType?: TaskType },
): PriorExampleInputs {
  const examples = retrievePriorExamples(db, workspaceId, input) ?? undefined;
  return {
    examples,
    examplesExclusionReason: examples
      ? undefined
      : "no approved or rejected prior outputs match this task yet.",
  };
}

export function campaignResolvePreviewInputs(
  db: Db,
  workspaceId: string,
  campaign: Campaign | null | undefined,
  draft: CreateCampaignPlanRevisionInput | undefined,
): CampaignResolveInputs {
  const campaignPlan = campaignPlanPreviewInput(db, workspaceId, campaign?.id, draft);
  return {
    campaign: campaign ? composeResolveCampaign(campaign, campaignPlan) : undefined,
    campaignPlan,
  };
}
