import type { AnyTool } from "../registry";
import { findInstructiveRejectionsTool } from "./find-instructive-rejections";
import { findSimilarApprovedDraftsTool } from "./find-similar-approved-drafts";
import { getBrainSectionTool } from "./get-brain-section";
import { getCampaignPlanTool } from "./get-campaign-plan";
import { getPersonaTool } from "./get-persona";
import { getPriorPostsTool } from "./get-prior-posts";
import { listChannelGuardrailsTool } from "./list-channel-guardrails";
import { listRecentPublicationsTool } from "./list-recent-publications";
import {
  proposeAdMutationTool,
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
// lockstep, read tools first (Sprint 57), propose tools after (Sprint 69).
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
];

export const PROPOSE_TOOLS: readonly AnyTool[] = [
  proposeDraftTool,
  proposePublicationTool,
  proposeReplyTool,
  proposeSequenceStepTool,
  proposeAdMutationTool,
];

export const ALL_TOOLS: readonly AnyTool[] = [...READ_TOOLS, ...PROPOSE_TOOLS];

const TOOLS_BY_NAME = new Map<string, AnyTool>(ALL_TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): AnyTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
