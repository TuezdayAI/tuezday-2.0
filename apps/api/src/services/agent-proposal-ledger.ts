import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import type {
  AgentProposal,
  AgentProposalTargetKind,
  ProposeToolName,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { agentProposals, type AgentProposalRow } from "../db/schema";

// ---------------------------------------------------------------------------
// The proposal ledger (Sprint 69) — reads and one write, nothing else.
//
// Split out of agent-proposals.ts, which imports the external-action adapters
// and everything they reach, so the inspector route can read what a run
// proposed without pulling the whole write path in behind it.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export function rowToAgentProposal(row: AgentProposalRow): AgentProposal {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentRunId: row.agentRunId,
    tool: row.tool as ProposeToolName,
    targetKind: row.targetKind as AgentProposalTargetKind,
    draftId: row.draftId,
    externalActionId: row.externalActionId,
    summary: row.summary,
    rationale: row.rationale,
    createdAt: row.createdAt,
  };
}

export function listAgentProposalsForRun(db: Db, agentRunId: string): AgentProposal[] {
  return db
    .select()
    .from(agentProposals)
    .where(eq(agentProposals.agentRunId, agentRunId))
    .orderBy(desc(agentProposals.createdAt))
    .all()
    .map(rowToAgentProposal);
}

/**
 * How many proposals this workspace has made in the trailing 24 hours, across
 * every run and every kind — including drafts, which have no external action to
 * carry an origin column and are exactly why this ledger exists (D-69.4).
 */
export function countProposalsToday(db: Db, workspaceId: string, now = Date.now()): number {
  return db
    .select({ id: agentProposals.id })
    .from(agentProposals)
    .where(
      and(
        eq(agentProposals.workspaceId, workspaceId),
        gte(agentProposals.createdAt, now - DAY_MS),
      ),
    )
    .all().length;
}

export interface RecordProposalInput {
  workspaceId: string;
  agentRunId: string;
  tool: ProposeToolName;
  targetKind: AgentProposalTargetKind;
  draftId?: string | null;
  externalActionId?: string | null;
  summary: string;
  rationale: string;
}

export function recordAgentProposal(db: Db, input: RecordProposalInput): AgentProposal {
  const row: AgentProposalRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    agentRunId: input.agentRunId,
    tool: input.tool,
    targetKind: input.targetKind,
    draftId: input.draftId ?? null,
    externalActionId: input.externalActionId ?? null,
    summary: input.summary,
    rationale: input.rationale,
    createdAt: Date.now(),
  };
  db.insert(agentProposals).values(row).run();
  return rowToAgentProposal(row);
}
