import { randomUUID } from "node:crypto";
import { desc, eq, inArray, and } from "drizzle-orm";
import type {
  ApprovalState,
  Channel,
  CreateSignalInput,
  DiscoveredItemMatch,
  Signal,
  SignalSource,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { drafts, signals, type SignalRow } from "../db/schema";
import type { LlmGateway } from "../llm/gateway";
import {
  insertSignalMatch,
  listSignalMatches,
  listSignalMatchesForSignals,
  scoreSignalMatches,
} from "./matching";

function rowToSignal(row: SignalRow, matches: DiscoveredItemMatch[]): Signal {
  return { ...row, source: row.source as SignalSource, matches };
}

export function createSignal(db: Db, workspaceId: string, input: CreateSignalInput): Signal {
  const row: SignalRow = {
    id: randomUUID(),
    workspaceId,
    content: input.content,
    source: input.source,
    sourceUrl: input.sourceUrl ?? null,
    suggestedPersonaId: input.suggestedPersonaId ?? null,
    suggestedCampaignId: input.suggestedCampaignId ?? null,
    createdAt: Date.now(),
  };
  db.insert(signals).values(row).run();
  return rowToSignal(row, []); // a brand-new signal has no matches yet
}

/**
 * Sprint 45: create a signal and route it. Explicit human intent (a supplied
 * persona and/or campaign) is trusted outright as a single high-confidence
 * match — the LLM is never called. Otherwise the signal gets the same
 * persona×campaign judgment a discovered item does, best-effort: an LLM
 * failure never blocks creation (the signal simply lands with zero matches).
 */
export async function createSignalWithMatching(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  input: CreateSignalInput,
): Promise<Signal> {
  const signal = createSignal(db, workspaceId, input);
  if (input.suggestedPersonaId || input.suggestedCampaignId) {
    // Explicit human intent wins outright — one high-confidence match, no LLM call.
    insertSignalMatch(db, workspaceId, signal.id, {
      personaId: input.suggestedPersonaId ?? null,
      campaignId: input.suggestedCampaignId ?? null,
      score: 100,
      reason: "Set explicitly at signal creation.",
    });
  } else {
    try {
      await scoreSignalMatches(db, llm, workspaceId, signal);
    } catch {
      // Matching is best-effort — the signal is already created; it carries
      // no candidates until a later re-score.
    }
  }
  // Re-read so the response carries the matches (and any patched suggested
  // fields) that landed above.
  return getSignal(db, workspaceId, signal.id) ?? signal;
}

export function getSignal(db: Db, workspaceId: string, signalId: string): Signal | undefined {
  const row = db
    .select()
    .from(signals)
    .where(and(eq(signals.workspaceId, workspaceId), eq(signals.id, signalId)))
    .get();
  return row ? rowToSignal(row, listSignalMatches(db, row.id)) : undefined;
}

export interface SignalDraftSummary {
  id: string;
  state: ApprovalState;
  channel: Channel;
  createdAt: number;
}

export interface SignalWithDrafts extends Signal {
  drafts: SignalDraftSummary[];
}

export function listSignals(db: Db, workspaceId: string): SignalWithDrafts[] {
  const signalRows = db
    .select()
    .from(signals)
    .where(eq(signals.workspaceId, workspaceId))
    .orderBy(desc(signals.createdAt))
    .all();
  if (signalRows.length === 0) return [];

  const draftRows = db
    .select({
      id: drafts.id,
      state: drafts.state,
      channel: drafts.channel,
      createdAt: drafts.createdAt,
      sourceSignalId: drafts.sourceSignalId,
    })
    .from(drafts)
    .where(
      inArray(
        drafts.sourceSignalId,
        signalRows.map((s) => s.id),
      ),
    )
    .all();

  const matchesBySignal = listSignalMatchesForSignals(
    db,
    signalRows.map((s) => s.id),
  );

  return signalRows.map((row) => ({
    ...rowToSignal(row, matchesBySignal.get(row.id) ?? []),
    drafts: draftRows
      .filter((d) => d.sourceSignalId === row.id)
      .map((d) => ({
        id: d.id,
        state: d.state as ApprovalState,
        channel: d.channel as Channel,
        createdAt: d.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
  }));
}
