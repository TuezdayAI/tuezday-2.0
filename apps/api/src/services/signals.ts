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
  projectSuggestedRouting,
  revalidateSignalMatches,
  type ParsedMatch,
} from "./matching";
import { getCampaign } from "./campaigns";
import { getPersona } from "./personas";

function rowToSignal(row: SignalRow, matches: DiscoveredItemMatch[]): Signal {
  // Sprint 53: the suggested* pair is derived from the top match, never read
  // off the row. The columns survive only until Task 7 nulls them.
  return {
    ...row,
    source: row.source as SignalSource,
    matches,
    ...projectSuggestedRouting(matches),
  };
}

export class SignalReferenceNotFoundError extends Error {
  constructor() {
    super("A related signal object was not found.");
    this.name = "SignalReferenceNotFoundError";
  }
}

export async function resolveSignalReferences(
  db: Db,
  workspaceId: string,
  input: Pick<CreateSignalInput, "suggestedPersonaId" | "suggestedCampaignId">,
): Promise<void> {
  if (
    input.suggestedPersonaId &&
    !await getPersona(db, workspaceId, input.suggestedPersonaId)
  ) {
    throw new SignalReferenceNotFoundError();
  }
  if (
    input.suggestedCampaignId &&
    !await getCampaign(db, workspaceId, input.suggestedCampaignId)
  ) {
    throw new SignalReferenceNotFoundError();
  }
}

export async function insertSignalRow(
  db: DbExecutor,
  workspaceId: string,
  input: CreateSignalInput,
): Promise<SignalRow> {
  const row: SignalRow = {
    id: randomUUID(),
    workspaceId,
    content: input.content,
    source: input.source,
    sourceUrl: input.sourceUrl ?? null,
    // Sprint 53: routing lives in signal_matches. Explicit intent on the input
    // becomes a score-100 match (see explicitIntentMatches); these columns are
    // never written again and reads project them from matches[0].
    suggestedPersonaId: null,
    suggestedCampaignId: null,
    createdAt: Date.now(),
  };
  await db.insert(signals).values(row).run();
  return row;
}

/** True when the caller named a persona and/or campaign: trusted human intent. */
function hasExplicitRouting(input: CreateSignalInput): boolean {
  return Boolean(input.suggestedPersonaId || input.suggestedCampaignId);
}

/**
 * Explicit routing, expressed the only way routing is stored: one score-100
 * match. References are validated by `resolveSignalReferences` beforehand, so
 * the match is trusted without a revalidation pass.
 */
function explicitIntentMatches(input: CreateSignalInput): ParsedMatch[] {
  if (!hasExplicitRouting(input)) return [];
  return [
    {
      personaId: input.suggestedPersonaId ?? null,
      campaignId: input.suggestedCampaignId ?? null,
      score: 100,
      reason: "Set explicitly at signal creation.",
    },
  ];
}

/**
 * Create a signal without LLM matching (the public API path). Explicit routing
 * still lands as a real score-100 match row rather than as standalone columns.
 */
export async function createSignal(db: Db, workspaceId: string, input: CreateSignalInput): Promise<Signal> {
  await resolveSignalReferences(db, workspaceId, input);
  return await persistSignalCreation(db, workspaceId, input, explicitIntentMatches(input));
}

export interface SignalCreationHooks {
  afterSignalInsert?(): void;
  afterMatchInsert?(index: number): void;
  beforeReturn?(): void;
}

export async function readSignal(
  db: DbExecutor,
  workspaceId: string,
  signalId: string,
): Promise<Signal | undefined> {
  const row = await db
    .select()
    .from(signals)
    .where(and(eq(signals.workspaceId, workspaceId), eq(signals.id, signalId)))
    .get();
  return row ? rowToSignal(row, await listSignalMatches(db, workspaceId, row.id)) : undefined;
}

export async function persistSignalCreation(
  db: Db,
  workspaceId: string,
  input: CreateSignalInput,
  matches: ParsedMatch[],
  hooks?: SignalCreationHooks,
): Promise<Signal> {
  return await db.transaction(async (tx) => {
    const matchesToPersist = hasExplicitRouting(input)
      ? matches
      : await revalidateSignalMatches(tx, workspaceId, matches);
    const row = await insertSignalRow(tx, workspaceId, input);
    hooks?.afterSignalInsert?.();

    // Sequential: the read below depends on every match row existing, and the
    // hook fires per index in order. `forEach(async …)` would not await.
    for (const [index, match] of matchesToPersist.entries()) {
      await insertSignalMatch(tx, workspaceId, row.id, match);
      hooks?.afterMatchInsert?.(index);
    }

    // No projection write: the suggested* pair is computed on read from the
    // rows just inserted.
    const created = await readSignal(tx, workspaceId, row.id);
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
  await resolveSignalReferences(db, workspaceId, input);
  let matches: ParsedMatch[];
  if (hasExplicitRouting(input)) {
    // Explicit human intent wins outright — one high-confidence match, no LLM call.
    matches = explicitIntentMatches(input);
  } else {
    try {
      matches = await judgeSignalMatches(db, llm, workspaceId, input.content);
    } catch {
      // Matching is best-effort. An LLM outage becomes an empty judgment
      // before persistence begins, so creation can still commit atomically.
      matches = [];
    }
  }
  return await persistSignalCreation(db, workspaceId, input, matches, hooks);
}

export async function getSignal(db: Db, workspaceId: string, signalId: string): Promise<Signal | undefined> {
  return await readSignal(db, workspaceId, signalId);
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

export async function listSignals(db: Db, workspaceId: string): Promise<SignalWithDrafts[]> {
  const signalRows = await db
    .select()
    .from(signals)
    .where(eq(signals.workspaceId, workspaceId))
    .orderBy(desc(signals.createdAt))
    .all();
  if (signalRows.length === 0) return [];

  const draftRows = await db
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

  const matchesBySignal = await listSignalMatchesForSignals(
    db,
    workspaceId,
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
