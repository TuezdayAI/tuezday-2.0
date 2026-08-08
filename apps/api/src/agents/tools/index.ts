import type { AnyTool } from "../registry";
import { askFounderTool } from "./ask";
import { delegateTool } from "./delegate";
import { findInstructiveRejectionsTool } from "./find-instructive-rejections";
import { findSimilarApprovedDraftsTool } from "./find-similar-approved-drafts";
import { getBrainSectionTool } from "./get-brain-section";
import { getCampaignInsightsTool } from "./get-campaign-insights";
import { getCampaignPlanTool } from "./get-campaign-plan";
import { getMetricSummaryTool } from "./get-metric-summary";
import { getPersonaTool } from "./get-persona";
import { getPriorPostsTool } from "./get-prior-posts";
import { getSequenceFunnelTool } from "./get-sequence-funnel";
import { getWorkspaceInsightsTool } from "./get-workspace-insights";
import { listCampaignsTool } from "./list-campaigns";
import { listDraftsTool } from "./list-drafts";
import { listChannelGuardrailsTool } from "./list-channel-guardrails";
import { listPersonasTool } from "./list-personas";
import { listRecentPublicationsTool } from "./list-recent-publications";
import {
  proposeAdMutationTool,
  proposeCampaignTool,
  proposeDraftTool,
  proposePublicationTool,
  proposeReplyTool,
  proposeSequenceStepTool,
} from "./propose";
import { safeFetchUrlTool } from "./safe-fetch-url";
import { searchDiscoveryItemsTool } from "./search-discovery-items";
import { searchEvidenceTool } from "./search-evidence";

// ---------------------------------------------------------------------------
// The registry whitelist: every tool the model can call. Kept in
// AGENT_TOOL_NAMES order (packages/contracts) — a test asserts the two stay in
// lockstep: read tools first (Sprint 57), propose tools next (Sprint 69), the
// ask tool last (Sprint 70).
//
// Everything reachable from this module must stay a leaf: TOOLS_BY_NAME is
// built at top level, so an import cycle back into here leaves the map
// half-initialized at load. That is why the propose tools take an injected
// service instead of importing the external-action coordinator.
// ---------------------------------------------------------------------------

export const READ_TOOLS: readonly AnyTool[] = [
  searchEvidenceTool,
  getBrainSectionTool,
  getCampaignPlanTool,
  listRecentPublicationsTool,
  findSimilarApprovedDraftsTool,
  findInstructiveRejectionsTool,
  getPersonaTool,
  listChannelGuardrailsTool,
  searchDiscoveryItemsTool,
  getPriorPostsTool,
  safeFetchUrlTool,
  // Sprint 76 — analytics and inventory reads.
  listCampaignsTool,
  listPersonasTool,
  getCampaignInsightsTool,
  getWorkspaceInsightsTool,
  getMetricSummaryTool,
  getSequenceFunnelTool,
  // Sprint 77 — the approval queue as data (D-77.8).
  listDraftsTool,
];

export const PROPOSE_TOOLS: readonly AnyTool[] = [
  proposeDraftTool,
  proposePublicationTool,
  proposeReplyTool,
  proposeSequenceStepTool,
  proposeAdMutationTool,
  // Sprint 77 — the sixth propose tool (D-77.7).
  proposeCampaignTool,
];

export const ASK_TOOLS: readonly AnyTool[] = [askFounderTool];

/** Sprint 79 — offered to a background orchestrator and to nothing else. */
export const DELEGATE_TOOLS: readonly AnyTool[] = [delegateTool];

export const ALL_TOOLS: readonly AnyTool[] = [
  ...READ_TOOLS,
  ...PROPOSE_TOOLS,
  ...ASK_TOOLS,
  ...DELEGATE_TOOLS,
];

const TOOLS_BY_NAME = new Map<string, AnyTool>(ALL_TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): AnyTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
