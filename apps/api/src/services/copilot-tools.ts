import { z } from "zod";
import type { ChatCitation } from "@tuezday/contracts";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../agents/registry";
import { getBrainSectionTool } from "../agents/tools/get-brain-section";
import { searchEvidenceTool } from "../agents/tools/search-evidence";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { SafeFetchService } from "../safe-fetch/index";
import { getCampaign, listCampaigns } from "./campaigns";
import { getCampaignInsights, getWorkspaceInsights } from "./insights";
import { listOutreachSequences } from "./outreach-sequences";
import { getSequenceFunnel } from "./outreach-funnel";
import { listAudiences } from "./audiences";
import { listLeads } from "./leads";
import { getNextActionView } from "./next-action";
import { listWorkspacePriorities } from "./agent-inbox";

// ---------------------------------------------------------------------------
// Read-only tool registry (Sprint 42, Part 1).
//
// Every tool is a thin wrapper over a PURE-READ service. The registry is the
// whitelist: the copilot can only call a tool listed here, and no listed tool
// mutates state. Part 2 adds gated write tools through the approval gate —
// this file stays read-only.
// ---------------------------------------------------------------------------

export interface CopilotToolContext {
  db: Db;
  evidence: EvidenceStore;
  workspaceId: string;
}

export interface CopilotToolResult {
  /** Compact text handed back to the model as the tool's observation. */
  summary: string;
  /** Provenance chips surfaced under the assistant's grounded answer. */
  citations?: ChatCitation[];
}

export interface CopilotTool {
  name: string;
  description: string;
  argsSchema: z.ZodType<Record<string, unknown>>;
  run(ctx: CopilotToolContext, args: Record<string, unknown>): Promise<CopilotToolResult>;
}

const MAX_SUMMARY_CHARS = 2_000;

/** Deterministic, size-bounded rendering of a read result for the model. */
function compact(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    json = String(value);
  }
  if (json.length <= MAX_SUMMARY_CHARS) return json;
  return `${json.slice(0, MAX_SUMMARY_CHARS)}… (truncated)`;
}

const emptyArgs = z.object({}).passthrough();

// ---------------------------------------------------------------------------
// Brain + evidence — DELEGATED to the Sprint 57 internal tool registry
// (founder decision 2026-08-03: one registry, copilot as consumer). The
// registry tools own the retrieval logic; this file keeps only the
// copilot-specific presentation ({summary, citations}). The remaining eight
// tools below are logic-free one-line service wraps and stay put until the
// Phase O chat surface rebuilds the copilot on agent_runs.
// ---------------------------------------------------------------------------

/** The copilot never fetches external URLs; these two read tools never touch
 * safeFetch, so a context stub that fails closed is correct here. */
const unavailableSafeFetch: SafeFetchService = {
  validateUrl() {
    throw new Error("safe fetch is not available to the copilot");
  },
  async fetch() {
    throw new Error("safe fetch is not available to the copilot");
  },
};

function registryContext(ctx: CopilotToolContext): ToolContext {
  return {
    db: ctx.db,
    evidence: ctx.evidence,
    safeFetch: unavailableSafeFetch,
    workspaceId: ctx.workspaceId,
    actor: { userId: null, label: "copilot" },
    budget: DEFAULT_TOOL_BUDGET,
  };
}

const searchBrain: CopilotTool = {
  name: "search_brain",
  description:
    "Search the five workspace brain docs (soul, icp, voice, history, now) for sections relevant to a question. Returns matching section headings + text with citations. Use for identity, ICP, voice, strategy, and current-focus questions.",
  argsSchema: z.object({ query: z.string().min(1) }).passthrough(),
  async run(ctx, args) {
    const query = String(args.query ?? "").trim();
    const result = (await getBrainSectionTool.run(registryContext(ctx), { query })) as {
      sections?: Array<{ docType: string; sectionId: string; heading: string; text: string }>;
      note?: string;
    };
    if (!result.sections || result.sections.length === 0) {
      return { summary: result.note ?? "The brain has no written content yet." };
    }
    const citations: ChatCitation[] = result.sections.map((s) => ({
      kind: "brain" as const,
      ref: `${s.docType}#${s.sectionId}`,
      label: s.heading,
      detail: s.docType,
    }));
    const summary = compact(
      result.sections.map((s) => ({
        docType: s.docType,
        section: s.sectionId,
        heading: s.heading,
        text: s.text,
      })),
    );
    return { summary, citations };
  },
};

const searchEvidence: CopilotTool = {
  name: "search_evidence",
  description:
    "Search the workspace evidence corpus (uploaded docs, published content, captured signals) for passages relevant to a question. Returns source-cited chunks. Use for factual claims that should be backed by a source.",
  argsSchema: z.object({ query: z.string().min(1) }).passthrough(),
  async run(ctx, args) {
    const query = String(args.query ?? "").trim();
    const result = (await searchEvidenceTool.run(registryContext(ctx), { query })) as {
      results: Array<{ title: string; text: string; score: number; documentId: string }>;
      note?: string;
    };
    if (result.results.length === 0) {
      return { summary: `No matching evidence. ${result.note ?? "no results."}` };
    }
    const citations: ChatCitation[] = [];
    const seen = new Set<string>();
    for (const chunk of result.results) {
      if (seen.has(chunk.documentId)) continue;
      seen.add(chunk.documentId);
      citations.push({
        kind: "evidence",
        ref: chunk.documentId,
        label: chunk.title,
        detail: `score ${chunk.score.toFixed(2)}`,
      });
    }
    const summary = compact(result.results.map((c) => ({ title: c.title, text: c.text })));
    return { summary, citations };
  },
};

// ---------------------------------------------------------------------------
// Live data (campaigns, outreach, audiences, leads, workspace summary)
// ---------------------------------------------------------------------------

const dataCitation = (tool: string, label: string): ChatCitation => ({
  kind: "data",
  ref: tool,
  label,
});

const listCampaignsTool: CopilotTool = {
  name: "list_campaigns",
  description: "List all campaigns in the workspace (name, objective, status). Use to find a campaign before asking for its insights.",
  argsSchema: emptyArgs,
  async run(ctx) {
    const campaigns = listCampaigns(ctx.db, ctx.workspaceId);
    return {
      summary: compact(campaigns),
      citations: [dataCitation("list_campaigns", "Campaigns")],
    };
  },
};

const getCampaignInsightsTool: CopilotTool = {
  name: "get_campaign_insights",
  description: "Performance insights for one campaign (id required): outputs, approvals, publications, engagement. Use list_campaigns first to get the campaignId.",
  argsSchema: z.object({ campaignId: z.string().min(1) }).passthrough(),
  async run(ctx, args) {
    const campaignId = String(args.campaignId ?? "");
    const campaign = getCampaign(ctx.db, ctx.workspaceId, campaignId);
    if (!campaign) {
      return { summary: `No campaign with id ${campaignId} in this workspace.` };
    }
    const insights = getCampaignInsights(ctx.db, campaign);
    return {
      summary: compact({ campaign: { id: campaign.id, name: campaign.name }, insights }),
      citations: [dataCitation("get_campaign_insights", `Insights: ${campaign.name}`)],
    };
  },
};

const getWorkspaceInsightsTool: CopilotTool = {
  name: "get_workspace_insights",
  description: "Workspace-wide performance rollup across all campaigns and channels. Use for 'how are we doing overall' questions.",
  argsSchema: emptyArgs,
  async run(ctx) {
    const insights = getWorkspaceInsights(ctx.db, ctx.workspaceId);
    return {
      summary: compact(insights),
      citations: [dataCitation("get_workspace_insights", "Workspace insights")],
    };
  },
};

const listOutreachSequencesTool: CopilotTool = {
  name: "list_outreach_sequences",
  description: "List outreach email sequences (name, status, persona). Use to find a sequence before asking for its funnel.",
  argsSchema: emptyArgs,
  async run(ctx) {
    const sequences = listOutreachSequences(ctx.db, ctx.workspaceId);
    return {
      summary: compact(sequences),
      citations: [dataCitation("list_outreach_sequences", "Outreach sequences")],
    };
  },
};

const getSequenceFunnelTool: CopilotTool = {
  name: "get_sequence_funnel",
  description: "Funnel + reply metrics for one outreach sequence (id required): sent, opened, clicked, replied, positive, meetings, won/lost. Use list_outreach_sequences first for the sequenceId.",
  argsSchema: z.object({ sequenceId: z.string().min(1) }).passthrough(),
  async run(ctx, args) {
    const sequenceId = String(args.sequenceId ?? "");
    const funnel = getSequenceFunnel(ctx.db, ctx.workspaceId, sequenceId);
    if (!funnel) {
      return { summary: `No outreach sequence with id ${sequenceId} in this workspace.` };
    }
    return {
      summary: compact(funnel),
      citations: [dataCitation("get_sequence_funnel", "Sequence funnel")],
    };
  },
};

const listAudiencesTool: CopilotTool = {
  name: "list_audiences",
  description: "List audiences (name, kind, size) used for targeting outreach and campaigns.",
  argsSchema: emptyArgs,
  async run(ctx) {
    const audiences = listAudiences(ctx.db, ctx.workspaceId);
    return {
      summary: compact(audiences),
      citations: [dataCitation("list_audiences", "Audiences")],
    };
  },
};

const listLeadsTool: CopilotTool = {
  name: "list_leads",
  description: "List leads/contacts in the workspace (name, company, role, email). Use for 'who are our leads' questions.",
  argsSchema: emptyArgs,
  async run(ctx) {
    const leads = listLeads(ctx.db, ctx.workspaceId);
    return {
      summary: compact(leads),
      citations: [dataCitation("list_leads", "Leads")],
    };
  },
};

const getWorkspaceSummaryTool: CopilotTool = {
  name: "get_workspace_summary",
  description: "The 'what should I focus on' rollup: workspace insights + the recommended next action + the prioritized work queue. Use for open-ended 'where do we stand / what next' questions.",
  argsSchema: emptyArgs,
  async run(ctx) {
    const insights = getWorkspaceInsights(ctx.db, ctx.workspaceId);
    const nextAction = getNextActionView(ctx.db, ctx.workspaceId);
    const priorities = listWorkspacePriorities(ctx.db, ctx.workspaceId);
    return {
      summary: compact({ insights, nextAction, priorities }),
      citations: [dataCitation("get_workspace_summary", "Workspace summary")],
    };
  },
};

// ---------------------------------------------------------------------------
// Registry (the whitelist)
// ---------------------------------------------------------------------------

export const COPILOT_TOOLS: readonly CopilotTool[] = [
  searchBrain,
  searchEvidence,
  listCampaignsTool,
  getCampaignInsightsTool,
  getWorkspaceInsightsTool,
  listOutreachSequencesTool,
  getSequenceFunnelTool,
  listAudiencesTool,
  listLeadsTool,
  getWorkspaceSummaryTool,
];

const TOOLS_BY_NAME = new Map(COPILOT_TOOLS.map((t) => [t.name, t]));

export function getCopilotTool(name: string): CopilotTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
