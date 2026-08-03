import { PLAN_SECTION_TOKEN_CAP } from "@tuezday/contracts";
import { estimateTokens } from "./tokens";

// ---------------------------------------------------------------------------
// Campaign plan section (Sprint 53)
//
// The curated `campaign_plan_revisions` row — the thing the founder actually
// edits — composed into the text of a resolver context section. Pure: no DB, no
// I/O, deterministic. The API loads the active revision and hands it in.
//
// The plan is tier 1 (campaign strategy is constitutional), so it is never cut
// by the first three rungs of the sacrifice ladder. That makes a hard compose
// cap load-bearing: a maximal plan is ~4,000 tokens against an 8,000 budget.
// Composition therefore walks the fields in priority order and stops at
// PLAN_SECTION_TOKEN_CAP, reporting exactly what it dropped so the trace never
// overstates what the model saw.
// ---------------------------------------------------------------------------

/**
 * The campaign plan as the resolver sees it. Structurally a subset of the
 * contracts' `CampaignPlanRevision`, so the API can pass an already-loaded
 * revision straight through without mapping.
 */
export interface ResolveCampaignPlan {
  /** Revision number of the active plan — named in the section title. */
  revision?: number;
  objective?: string;
  kpi?: string;
  timeframe?: string;
  pillars?: string[];
  offers?: string[];
  ctas?: string[];
  guidance?: string;
}

export interface ComposedPlanSection {
  /** The section body. Empty when the plan is absent or has no content. */
  content: string;
  /** `estimateTokens(content)` — never above the cap. */
  tokens: number;
  /** True when the cap cut content that the plan actually contains. */
  truncated: boolean;
  /**
   * Field labels the cap dropped or shortened, in priority order — folded into
   * the section's `reason` so the trace names what the model did not see.
   */
  omitted: string[];
}

const EMPTY: ComposedPlanSection = { content: "", tokens: 0, truncated: false, omitted: [] };

/** Marker left behind when a field had to be cut mid-way to fit the cap. */
const TRUNCATION_MARKER = "…";

interface PlanBlock {
  /** Field label used in `omitted` — matches the plan field name. */
  field: string;
  text: string;
}

function textBlock(field: string, label: string, value: string | undefined): PlanBlock | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? { field, text: `${label}: ${trimmed}` } : null;
}

function listBlock(field: string, label: string, values: string[] | undefined): PlanBlock | null {
  const items = (values ?? []).map((v) => v.trim()).filter(Boolean);
  if (!items.length) return null;
  return { field, text: `${label}:\n${items.map((i) => `- ${i}`).join("\n")}` };
}

/** Priority order — the earlier a block, the more likely it survives the cap. */
function planBlocks(plan: ResolveCampaignPlan): PlanBlock[] {
  return [
    textBlock("objective", "Objective", plan.objective),
    textBlock("kpi", "KPI", plan.kpi),
    textBlock("timeframe", "Timeframe", plan.timeframe),
    listBlock("pillars", "Messaging pillars", plan.pillars),
    listBlock("offers", "Offers", plan.offers),
    listBlock("ctas", "Calls to action", plan.ctas),
    textBlock("guidance", "Plan guidance", plan.guidance),
  ].filter((b): b is PlanBlock => b !== null);
}

/**
 * Join blocks in order, stopping at `tokenCap`. Whole blocks are kept while
 * they fit; the first block that does not fit is cut to the remaining room (and
 * marked), and everything after it is dropped. Both the cut block and the
 * dropped ones are named in `omitted`.
 */
function assemble(blocks: PlanBlock[], tokenCap: number): ComposedPlanSection {
  const charCap = tokenCap * 4;
  const parts: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  let truncated = false;

  for (const block of blocks) {
    if (truncated) {
      omitted.push(block.field);
      continue;
    }
    const separator = parts.length ? 2 : 0; // "\n\n"
    const room = charCap - used - separator;
    if (block.text.length <= room) {
      parts.push(block.text);
      used += separator + block.text.length;
      continue;
    }
    truncated = true;
    omitted.push(block.field);
    const keep = room - TRUNCATION_MARKER.length;
    if (keep > 0) {
      parts.push(`${block.text.slice(0, keep)}${TRUNCATION_MARKER}`);
      used += separator + keep + TRUNCATION_MARKER.length;
    }
    // Remaining blocks are handled by the `truncated` branch above.
  }

  const content = parts.join("\n\n");
  return { content, tokens: estimateTokens(content), truncated, omitted };
}

/**
 * Compose the full plan section: objective, KPI, timeframe, pillars, offers,
 * CTAs, guidance — in that priority order, capped at `PLAN_SECTION_TOKEN_CAP`.
 * An absent or wholly empty plan composes to empty.
 */
export function composeCampaignPlanSection(
  plan: ResolveCampaignPlan | undefined,
  options: { tokenCap?: number } = {},
): ComposedPlanSection {
  if (!plan) return { ...EMPTY, omitted: [] };
  const blocks = planBlocks(plan);
  if (!blocks.length) return { ...EMPTY, omitted: [] };
  return assemble(blocks, options.tokenCap ?? PLAN_SECTION_TOKEN_CAP);
}

/**
 * The compact form used by the resolver's fourth sacrifice-ladder rung:
 * objective + KPI + pillars only — the strategy the prompt cannot do without.
 */
export function composeCompactCampaignPlanSection(
  plan: ResolveCampaignPlan | undefined,
  options: { tokenCap?: number } = {},
): ComposedPlanSection {
  if (!plan) return { ...EMPTY, omitted: [] };
  const keep = new Set(["objective", "kpi", "pillars"]);
  const all = planBlocks(plan);
  const blocks = all.filter((b) => keep.has(b.field));
  if (!blocks.length) return { ...EMPTY, omitted: all.map((b) => b.field) };
  const composed = assemble(blocks, options.tokenCap ?? PLAN_SECTION_TOKEN_CAP);
  const dropped = all.filter((b) => !keep.has(b.field)).map((b) => b.field);
  return { ...composed, omitted: [...composed.omitted, ...dropped] };
}
