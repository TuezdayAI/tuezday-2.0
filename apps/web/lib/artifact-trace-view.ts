import type {
  ArtifactTrace,
  TraceContextSection,
  TraceCost,
  TraceKnob,
  TraceKnobState,
  TraceSubjectKind,
} from "@tuezday/contracts";

/**
 * How "why this" reads (Sprint 71). Presentation only — the API assembles the
 * trace and this file must never derive a new fact from it. The panel's entire
 * value is that it says what actually happened; a helper that infers is a
 * helper that can be wrong on the one screen that must not be.
 */

const SUBJECT_TITLE: Record<TraceSubjectKind, string> = {
  draft: "Why Tuezday wrote this",
  deliverable: "Why this deliverable says what it says",
  publication: "Why this went out",
  external_action: "Why this was proposed",
};

export function panelTitle(kind: TraceSubjectKind): string {
  return SUBJECT_TITLE[kind];
}

/** Section groups, in the order a founder asks about them. */
export const TRACE_BLOCKS = [
  "origin",
  "plan",
  "context",
  "examples",
  "preferences",
  "critic",
  "revisions",
  "cost",
  "knobs",
] as const;
export type TraceBlock = (typeof TRACE_BLOCKS)[number];

const BLOCK_TITLE: Record<TraceBlock, string> = {
  origin: "What triggered it",
  plan: "The campaign it serves",
  context: "What it read",
  examples: "What it learned from",
  preferences: "Rules you taught it",
  critic: "What the critic said",
  revisions: "What changed after you asked",
  cost: "What it cost",
  knobs: "Which settings shaped it",
};

export function blockTitle(block: TraceBlock): string {
  return BLOCK_TITLE[block];
}

/**
 * Whether a block has anything to show. A block with nothing in it is hidden
 * rather than rendered empty — except `context`, which carries its own written
 * reason for being empty and must stay visible to show it (D-71.3).
 */
export function blockHasContent(trace: ArtifactTrace, block: TraceBlock): boolean {
  switch (block) {
    case "origin":
      return trace.origin !== null;
    case "plan":
      return trace.plan !== null;
    case "context":
      return true;
    case "examples":
      return trace.examples.length > 0;
    case "preferences":
      return trace.preferences.length > 0;
    case "critic":
      return trace.critic !== null;
    case "revisions":
      return trace.revisions.length > 0;
    case "cost":
      return trace.cost !== null;
    case "knobs":
      return trace.knobs.length > 0;
  }
}

export function visibleBlocks(trace: ArtifactTrace): TraceBlock[] {
  return TRACE_BLOCKS.filter((block) => blockHasContent(trace, block));
}

/** What the model actually saw, and what it did not. Both are the answer. */
export function includedSections(trace: ArtifactTrace): TraceContextSection[] {
  return trace.context.filter((section) => section.included);
}

export function excludedSections(trace: ArtifactTrace): TraceContextSection[] {
  return trace.context.filter((section) => !section.included);
}

const LAYER_LABEL: Record<string, string> = {
  org: "Brain",
  channel: "Channel",
  campaign: "Campaign",
  plan: "Campaign plan",
  persona: "Persona",
  account: "Account",
  zoom: "Zoomed section",
  lead: "Lead",
  contact: "Media contact",
  signal: "Signal",
  conversation: "Conversation",
  evidence: "Evidence",
  examples: "Prior examples",
  preferences: "Learned rules",
  angle: "Angle",
  review: "Review subject",
  task: "Task",
};

export function layerLabel(layer: string): string {
  return LAYER_LABEL[layer] ?? layer;
}

/** The zoom badge, or null. Names the ranker so deferred #22 is visible. */
export function zoomBadge(section: TraceContextSection): string | null {
  if (section.zoomScore === null || section.zoomRank === null) return null;
  return `#${section.zoomRank} · BM25 ${section.zoomScore.toFixed(2)}`;
}

const KNOB_STATE_LABEL: Record<TraceKnobState, string> = {
  applied: "Shaped this",
  configured: "Set, but not here",
  absent: "Not in use",
};

export function knobStateLabel(state: TraceKnobState): string {
  return KNOB_STATE_LABEL[state];
}

/**
 * The knobs that did something, first. The board still lists all nine — seeing
 * six "not in use" rows is the point of atlas conflict #4.
 */
export function knobsByEffect(trace: ArtifactTrace): TraceKnob[] {
  const rank: Record<TraceKnobState, number> = { applied: 0, configured: 1, absent: 2 };
  return [...trace.knobs].sort((a, b) => rank[a.state] - rank[b.state]);
}

export function appliedKnobCount(trace: ArtifactTrace): number {
  return trace.knobs.filter((knob) => knob.state === "applied").length;
}

/**
 * Cost, in the smallest honest unit. An estimate is labelled as one: a number
 * presented as measured had better be measured.
 */
export function formatCost(cost: TraceCost): string {
  const cents = cost.costCents;
  const amount = cents < 1 ? `${(cents * 100).toFixed(0)}/100¢` : `${cents.toFixed(2)}¢`;
  return cost.estimated ? `~${amount} (priced, not metered)` : amount;
}

export function formatTokens(cost: TraceCost): string {
  return `${cost.inputTokens.toLocaleString()} in · ${cost.outputTokens.toLocaleString()} out`;
}

/** How much of the draft a revision turn rewrote, as a share. */
export function changedLabel(changedShare: number | null): string {
  if (changedShare === null) return "did not complete";
  return `${Math.round(changedShare * 100)}% rewritten`;
}

/**
 * The wording-match caveat, verbatim on the pillar row. The platform has never
 * recorded which pillar a draft was written to serve, and the panel must not
 * let a match read as a claim (D-71.4).
 */
export const PILLAR_CAVEAT = "closest by wording — the pillar was never recorded";

export function traceUrl(workspaceId: string, kind: TraceSubjectKind, id: string): string {
  return `/workspaces/${workspaceId}/trace/${kind}/${id}`;
}
