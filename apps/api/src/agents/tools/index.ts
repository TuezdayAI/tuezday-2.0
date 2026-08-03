import type { AnyTool } from "../registry";
import { findInstructiveRejectionsTool } from "./find-instructive-rejections";
import { findSimilarApprovedDraftsTool } from "./find-similar-approved-drafts";
import { getBrainSectionTool } from "./get-brain-section";
import { getCampaignPlanTool } from "./get-campaign-plan";
import { getPersonaTool } from "./get-persona";
import { getPriorPostsTool } from "./get-prior-posts";
import { listChannelGuardrailsTool } from "./list-channel-guardrails";
import { listRecentPublicationsTool } from "./list-recent-publications";
import { safeFetchUrlTool } from "./safe-fetch-url";
import { searchDiscoveryItemsTool } from "./search-discovery-items";
import { searchEvidenceTool } from "./search-evidence";

// ---------------------------------------------------------------------------
// The registry whitelist (Sprint 57): every read tool the model can call.
// Kept in AGENT_TOOL_NAMES order (packages/contracts) — a test asserts the
// two stay in lockstep.
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

const TOOLS_BY_NAME = new Map<string, AnyTool>(READ_TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): AnyTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
