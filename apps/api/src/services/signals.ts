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
import type { Db, DbExecutor } from "../db";
import { drafts, signals, type SignalRow } from "../db/schema";
import type { LlmGateway } from "../llm/gateway";
import {
  insertSignalMatch,
  judgeSignalMatches,
  listSignalMatches,
  listSignalMatchesForSignals,
  revalidateSignalMatches,
  type ParsedMatch,
} from "./matching";
import { getCampaign } from "./campaigns";
import { getPersona } from "./personas";

function rowToSignal(row: SignalRow, matches: DiscoveredItemMatch[]): Signal {
  return { ...row, source: row.source as SignalSource, matches };
}

export class SignalReferenceNotFoundError extends Error {
  constructor() {
    super("A related signal object was not found.");
    this.name = "SignalReferenceNotFoundError";
  }
}

export function resolveSignalReferences(
  db: Db,
  workspaceId: string,
  input: Pick<CreateSignalInput, "suggestedPersonaId" | "suggestedCampaignId">,
): void {
  if (
    input.suggestedPersonaId &&
    !getPersona(db, workspaceId, input.suggestedPersonaId)
  ) {
    throw new SignalReferenceNotFoundError();
  }
  if (
    input.suggestedCampaignId &&
    !getCampaign(db, workspaceId, input.suggestedCampaignId)
  ) {
    throw new SignalReferenceNotFoundError();
  }
}

export function insertSignalRow(
  db: DbExecutor,
  workspaceId: string,
  input: CreateSignalInput,
): SignalRow {
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
  return row;
}

export function createSignal(db: Db, workspaceId: string, input: CreateSignalInput): Signal {
  resolveSignalReferences(db, workspaceId, input);
  return rowToSignal(insertSignalRow(db, workspaceId, input), []);
}

export interface SignalCreationHooks {
  afterSignalInsert?(): void;
  afterMatchInsert?(index: number): void;
  afterProjectionUpdate?(): void;
  beforeReturn?(): void;
}

export function readSignal(
  db: DbExecutor,
  workspaceId: string,
  signalId: string,
): Signal | undefined {
  const row = db
    .select()
    .from(signals)
    .where(and(eq(signals.workspaceId, workspaceId), eq(signals.id, signalId)))
    .get();
  return row ? rowToSignal(row, listSignalMatches(db, row.id)) : undefined;
}

export function persistSignalCreation(
  db: Db,
  workspaceId: string,
  input: CreateSignalInput,
  matches: ParsedMatch[],
  hooks?: SignalCreationHooks,
): Signal {
  return db.transaction((tx) => {
    const matchesToPersist =
      input.suggestedPersonaId || input.suggestedCampaignId
        ? matches
        : revalidateSignalMatches(tx, workspaceId, matches);
    const row = insertSignalRow(tx, workspaceId, input);
    hooks?.afterSignalInsert?.();

    matchesToPersist.forEach((match, index) => {
      insertSignalMatch(tx, workspaceId, row.id, match);
      hooks?.afterMatchInsert?.(index);
    });

    const best = matchesToPersist[0];
    if (best) {
      tx.update(signals)
        .set({
          suggestedPersonaId: best.personaId,
          suggestedCampaignId: best.campaignId,
        })
        .where(and(eq(signals.workspaceId, workspaceId), eq(signals.id, row.id)))
        .run();
      hooks?.afterProjectionUpdate?.();
    }

    const created = readSignal(tx, workspaceId, row.id);
    if (!created) throw new Error("Signal creation did not produce a readable row.");
    hooks?.beforeReturn?.();
    return created;
  });
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
  hooks?: SignalCreationHooks,
): Promise<Signal> {
  resolveSignalReferences(db, workspaceId, input);
  let matches: ParsedMatch[];
  if (input.suggestedPersonaId || input.suggestedCampaignId) {
    // Explicit human intent wins outright — one high-confidence match, no LLM call.
    matches = [{
      personaId: input.suggestedPersonaId ?? null,
      campaignId: input.suggestedCampaignId ?? null,
      score: 100,
      reason: "Set explicitly at signal creation.",
    }];
  } else {
    try {
      matches = await judgeSignalMatches(db, llm, workspaceId, input.content);
    } catch {
      // Matching is best-effort. An LLM outage becomes an empty judgment
      // before persistence begins, so creation can still commit atomically.
      matches = [];
    }
  }
  return persistSignalCreation(db, workspaceId, input, matches, hooks);
}

export function getSignal(db: Db, workspaceId: string, signalId: string): Signal | undefined {
  return readSignal(db, workspaceId, signalId);
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
