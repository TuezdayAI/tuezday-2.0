import type {
  ResolveCampaign,
  ResolveCampaignPlan,
  ResolveExamples,
  ResolvePreferences,
} from "@tuezday/brain";
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
import { retrievePreferenceRules } from "./preference-rules";
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
export async function selectiveContextInputs(db: Db, workspaceId: string): Promise<SelectiveContextInputs> {
  return {
    matrix: await resolveTaskDocMatrix(db, workspaceId),
    outlines: await getBrainOutlines(db, workspaceId),
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
export async function campaignPlanInput(
  db: Db,
  workspaceId: string,
  campaignId: string | null | undefined,
): Promise<ResolveCampaignPlan | undefined> {
  if (!campaignId) return undefined;
  return (await getCurrentCampaignPlan(db, workspaceId, campaignId))?.plan;
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
export async function campaignPlanPreviewInput(
  db: Db,
  workspaceId: string,
  campaignId: string | null | undefined,
  draft: CreateCampaignPlanRevisionInput | undefined,
): Promise<ResolveCampaignPlan | undefined> {
  if (!campaignId) return undefined;
  if (!draft) return await campaignPlanInput(db, workspaceId, campaignId);
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

export async function campaignResolveInputs(
  db: Db,
  workspaceId: string,
  campaign: Campaign | null | undefined,
): Promise<CampaignResolveInputs> {
  const campaignPlan = await campaignPlanInput(db, workspaceId, campaign?.id);
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

export async function priorExampleInputs(
  db: Db,
  workspaceId: string,
  input: { query: string; channel?: Channel; taskType?: TaskType },
): Promise<PriorExampleInputs> {
  const examples = await retrievePriorExamples(db, workspaceId, input) ?? undefined;
  return {
    examples,
    examplesExclusionReason: examples
      ? undefined
      : "no approved or rejected prior outputs match this task yet.",
  };
}

/**
 * The Sprint 68 preference-memory resolver inputs: the top-N active rules the
 * founder's own edits taught us, or an exclusion reason when none apply. Same
 * shape and same guarantee as `priorExampleInputs` — always one or the other,
 * so a participating trace states honestly why rules are(n't) there.
 *
 * Read-only (D-68.6). Recording that a rule was *applied* is a separate,
 * explicit call from the generation paths, so a preview or an eval replay
 * cannot inflate the hit count that promotion and retirement both read.
 */
export interface PreferenceRuleInputs {
  preferences: ResolvePreferences | undefined;
  preferencesExclusionReason: string | undefined;
}

export async function preferenceRuleInputs(
  db: Db,
  workspaceId: string,
  input: { channel?: Channel; taskType?: TaskType },
): Promise<PreferenceRuleInputs> {
  const preferences = await retrievePreferenceRules(db, workspaceId, input) ?? undefined;
  return {
    preferences,
    preferencesExclusionReason: preferences
      ? undefined
      : "no active learned rules apply to this task yet.",
  };
}

export async function campaignResolvePreviewInputs(
  db: Db,
  workspaceId: string,
  campaign: Campaign | null | undefined,
  draft: CreateCampaignPlanRevisionInput | undefined,
): Promise<CampaignResolveInputs> {
  const campaignPlan = await campaignPlanPreviewInput(db, workspaceId, campaign?.id, draft);
  return {
    campaign: campaign ? composeResolveCampaign(campaign, campaignPlan) : undefined,
    campaignPlan,
  };
}
