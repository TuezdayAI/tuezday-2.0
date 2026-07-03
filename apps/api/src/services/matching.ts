// Sprint 45 shared matching module: the persona×campaign prompt context,
// defensive match parsing, and signal/item match persistence used by both
// discovery scoring (scoreUnscoredItems) and one-off signal scoring
// (scoreSignalMatches). Factored out so a manually-created signal gets the
// exact same judgment a discovered item does.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  DISCOVERY_MAX_MATCHES_PER_ITEM,
  type DiscoveredItemMatch,
  type Signal,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  campaigns,
  discoveredItemMatches,
  personas,
  signalMatches,
  signals,
  type SignalMatchRow,
} from "../db/schema";
import type { LlmGateway } from "../llm/gateway";
import { getBrain } from "./brain";
import { listCampaigns } from "./campaigns";
import { listPersonas } from "./personas";
import { getWorkspace } from "./workspaces";

const DIGEST_CHARS_PER_DOC = 600;
const MATCH_REASON_MAX_CHARS = 500;
const SIGNAL_CONTENT_PROMPT_CHARS = 600;

/** Compact brain summary that fronts every judgment prompt. */
export function brainDigest(db: Db, workspaceId: string): string {
  const { docs } = getBrain(db, workspaceId);
  return docs
    .filter((d) => ["soul", "icp", "voice", "now"].includes(d.docType) && d.content.trim())
    .map((d) => `${d.docType.toUpperCase()}: ${d.content.trim().slice(0, DIGEST_CHARS_PER_DOC)}`)
    .join("\n\n");
}

/** Pull the first JSON array out of a model response; tolerate fences/noise. */
export function parseJsonArray(text: string): unknown[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------------
// Prompt context
// ---------------------------------------------------------------------------

export interface MatchingContext {
  personaIds: Set<string>;
  /** Active campaigns only — an inactive campaign is never a routing target. */
  campaignIds: Set<string>;
  /** campaignId -> the persona ids allowed to speak for that campaign. */
  campaignPersonaIds: Map<string, Set<string>>;
  /** Prompt block: one line per persona (Sprint 44 topics when present). */
  personaBlock: string;
  /** Prompt block: one line per active campaign incl. its assigned personas. */
  campaignBlock: string;
}

/**
 * Build the persona/campaign context both scoring paths share. Persona lines
 * include Sprint 44 topics (`- {id}: {name} — topics: a, b`), falling back to
 * the pre-44 `name (description)` line when a persona has no topics yet.
 * Campaign lines show which personas are assigned, so the model can only
 * suggest a persona actually allowed to speak for that campaign.
 */
export function buildMatchingContext(db: Db, workspaceId: string): MatchingContext {
  const workspacePersonas = listPersonas(db, workspaceId);
  const personaById = new Map(workspacePersonas.map((p) => [p.id, p]));
  const personaBlock =
    workspacePersonas
      .map((p) =>
        p.topics.length > 0
          ? `- ${p.id}: ${p.name} — topics: ${p.topics.join(", ")}`
          : `- ${p.id}: ${p.name}${p.description ? ` (${p.description})` : ""}`,
      )
      .join("\n") || "(no personas yet)";
  const activeCampaigns = listCampaigns(db, workspaceId).filter((c) => c.status === "active");
  const campaignBlock =
    activeCampaigns
      .map((c) => {
        const assigned = c.personaIds
          .map((id) => personaById.get(id))
          .filter((p): p is NonNullable<typeof p> => p !== undefined)
          .map((p) => `${p.id}: ${p.name}`)
          .join(", ");
        return `- ${c.id}: ${c.name}${c.objective ? ` — ${c.objective.slice(0, 120)}` : ""} — personas: [${assigned}]`;
      })
      .join("\n") || "(no campaigns yet)";
  return {
    personaIds: new Set(workspacePersonas.map((p) => p.id)),
    campaignIds: new Set(activeCampaigns.map((c) => c.id)),
    campaignPersonaIds: new Map(activeCampaigns.map((c) => [c.id, new Set(c.personaIds)])),
    personaBlock,
    campaignBlock,
  };
}

/** The judgment prompt shared by discovery batch scoring and signal scoring. */
export function buildMatchingPrompt(params: {
  workspaceName: string;
  digest: string;
  ctx: MatchingContext;
  itemsBlock: string;
}): string {
  return [
    `You are the judgment layer of ${params.workspaceName}'s GTM brain. Discovered items from the outside world need relevance scoring — the brain judges and routes signals, it does not invent them.`,
    `COMPANY BRAIN DIGEST:\n${params.digest || "(brain not filled yet)"}`,
    `PERSONAS (id: name):\n${params.ctx.personaBlock}`,
    `CAMPAIGNS (id: name — objective — personas):\n${params.ctx.campaignBlock}`,
    `DISCOVERED ITEMS:\n${params.itemsBlock}`,
    `For each item, judge how relevant it is overall as a GTM signal for this company (0 = noise, 100 = must act on this), and list in "matches" every persona×campaign pairing worth routing it to — each with its own 0-100 fit score and one short reason. Only suggest a persona that is assigned to that campaign. "matches" may be empty when nothing fits, and may have several entries when several pipelines fit.`,
    `Respond with ONLY a JSON array, one entry per item: [{"index": <item number>, "score": <0-100 overall relevance>, "matches": [{"personaId": <id or null>, "campaignId": <id or null>, "score": <0-100 fit>, "reason": "<one short sentence>"}]}]`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export interface ParsedMatch {
  personaId: string | null;
  campaignId: string | null;
  score: number;
  reason: string;
}

function toParsedMatch(raw: Record<string, unknown>, ctx: MatchingContext): ParsedMatch | null {
  const campaignId =
    typeof raw.campaignId === "string" && ctx.campaignIds.has(raw.campaignId)
      ? raw.campaignId
      : null;
  let personaId =
    typeof raw.personaId === "string" && ctx.personaIds.has(raw.personaId) ? raw.personaId : null;
  // A persona the campaign doesn't allow: drop the persona, keep the campaign.
  if (campaignId && personaId && !ctx.campaignPersonaIds.get(campaignId)?.has(personaId)) {
    personaId = null;
  }
  // A candidate routing nowhere is no candidate at all.
  if (!campaignId && !personaId) return null;
  return {
    personaId,
    campaignId,
    score: typeof raw.score === "number" ? clampScore(raw.score) : 0,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, MATCH_REASON_MAX_CHARS) : "",
  };
}

/**
 * Defensive parse of one scoring-response entry's candidates. Unknown ids →
 * null (never rejected); a persona outside the campaign's `personaIds` is
 * dropped to null while the campaign match survives; more than
 * `DISCOVERY_MAX_MATCHES_PER_ITEM` entries keep the top-scoring five; a
 * response with no `matches` key falls back to the legacy top-level
 * `personaId`/`campaignId` as a single candidate. Best-scoring first, ties by
 * the model's array order (stable sort).
 */
export function parseEntryMatches(
  entry: Record<string, unknown>,
  ctx: MatchingContext,
): ParsedMatch[] {
  const candidates: ParsedMatch[] = [];
  if (Array.isArray(entry.matches)) {
    for (const raw of entry.matches) {
      if (typeof raw !== "object" || raw === null) continue;
      const match = toParsedMatch(raw as Record<string, unknown>, ctx);
      if (match) candidates.push(match);
    }
  } else {
    // Legacy/partial shape: treat top-level personaId/campaignId as one match
    // scored by the entry's own (overall) score.
    const match = toParsedMatch(entry, ctx);
    if (match) candidates.push(match);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, DISCOVERY_MAX_MATCHES_PER_ITEM);
}

// ---------------------------------------------------------------------------
// Persistence + read models
// ---------------------------------------------------------------------------

/** Replace an item's candidate rows (delete-then-insert on every scoring). */
export function replaceItemMatches(
  db: Db,
  workspaceId: string,
  itemId: string,
  matches: ParsedMatch[],
): void {
  db.delete(discoveredItemMatches).where(eq(discoveredItemMatches.itemId, itemId)).run();
  const now = Date.now();
  for (const match of matches) {
    db.insert(discoveredItemMatches)
      .values({ id: randomUUID(), workspaceId, itemId, ...match, createdAt: now })
      .run();
  }
}

export function insertSignalMatch(
  db: Db,
  workspaceId: string,
  signalId: string,
  match: { personaId: string | null; campaignId: string | null; score: number; reason: string },
): void {
  db.insert(signalMatches)
    .values({
      id: randomUUID(),
      workspaceId,
      signalId,
      personaId: match.personaId,
      campaignId: match.campaignId,
      score: match.score,
      reason: match.reason,
      createdAt: Date.now(),
    })
    .run();
}

type ContractMatch = {
  personaId: string | null;
  personaName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  score: number;
  reason: string;
};

function toContractMatch(row: ContractMatch): DiscoveredItemMatch {
  return {
    personaId: row.personaId,
    personaName: row.personaName ?? null,
    campaignId: row.campaignId,
    campaignName: row.campaignName ?? null,
    score: row.score,
    reason: row.reason,
  };
}

/** Contract-shaped matches for many items at once (one joined query). */
export function listItemMatchesForItems(
  db: Db,
  itemIds: string[],
): Map<string, DiscoveredItemMatch[]> {
  const map = new Map<string, DiscoveredItemMatch[]>();
  if (itemIds.length === 0) return map;
  const rows = db
    .select({
      itemId: discoveredItemMatches.itemId,
      personaId: discoveredItemMatches.personaId,
      personaName: personas.name,
      campaignId: discoveredItemMatches.campaignId,
      campaignName: campaigns.name,
      score: discoveredItemMatches.score,
      reason: discoveredItemMatches.reason,
    })
    .from(discoveredItemMatches)
    .leftJoin(personas, eq(discoveredItemMatches.personaId, personas.id))
    .leftJoin(campaigns, eq(discoveredItemMatches.campaignId, campaigns.id))
    .where(inArray(discoveredItemMatches.itemId, itemIds))
    .orderBy(desc(discoveredItemMatches.score), asc(discoveredItemMatches.createdAt))
    .all();
  for (const { itemId, ...match } of rows) {
    const list = map.get(itemId) ?? [];
    list.push(toContractMatch(match));
    map.set(itemId, list);
  }
  return map;
}

export function listItemMatches(db: Db, itemId: string): DiscoveredItemMatch[] {
  return listItemMatchesForItems(db, [itemId]).get(itemId) ?? [];
}

/** Contract-shaped matches for many signals at once (one joined query). */
export function listSignalMatchesForSignals(
  db: Db,
  signalIds: string[],
): Map<string, DiscoveredItemMatch[]> {
  const map = new Map<string, DiscoveredItemMatch[]>();
  if (signalIds.length === 0) return map;
  const rows = db
    .select({
      signalId: signalMatches.signalId,
      personaId: signalMatches.personaId,
      personaName: personas.name,
      campaignId: signalMatches.campaignId,
      campaignName: campaigns.name,
      score: signalMatches.score,
      reason: signalMatches.reason,
    })
    .from(signalMatches)
    .leftJoin(personas, eq(signalMatches.personaId, personas.id))
    .leftJoin(campaigns, eq(signalMatches.campaignId, campaigns.id))
    .where(inArray(signalMatches.signalId, signalIds))
    .orderBy(desc(signalMatches.score), asc(signalMatches.createdAt))
    .all();
  for (const { signalId, ...match } of rows) {
    const list = map.get(signalId) ?? [];
    list.push(toContractMatch(match));
    map.set(signalId, list);
  }
  return map;
}

export function listSignalMatches(db: Db, signalId: string): DiscoveredItemMatch[] {
  return listSignalMatchesForSignals(db, [signalId]).get(signalId) ?? [];
}

/**
 * The highest-scoring candidate linking a signal to one specific campaign, or
 * undefined when the signal never matched it. This is what `runAutomation`
 * routes on (a signal can carry two candidate personas for the same campaign —
 * only the best one drives generation).
 */
export function getBestSignalMatchForCampaign(
  db: Db,
  signalId: string,
  campaignId: string,
): SignalMatchRow | undefined {
  return db
    .select()
    .from(signalMatches)
    .where(and(eq(signalMatches.signalId, signalId), eq(signalMatches.campaignId, campaignId)))
    .orderBy(desc(signalMatches.score))
    .limit(1)
    .get();
}

/**
 * Re-score watermark (Sprint 45): the newest persona/campaign `updatedAt` in
 * the workspace, 0 when both tables are empty. One MAX query; items whose
 * `scoredAt` predates this get re-judged on the next discovery run.
 */
export function getMatchingConfigVersion(db: Db, workspaceId: string): number {
  const row = db.get<{ v: number | null }>(sql`
    SELECT MAX(v) AS v FROM (
      SELECT MAX(${personas.updatedAt}) AS v FROM ${personas} WHERE ${personas.workspaceId} = ${workspaceId}
      UNION ALL
      SELECT MAX(${campaigns.updatedAt}) AS v FROM ${campaigns} WHERE ${campaigns.workspaceId} = ${workspaceId}
    )
  `);
  return row?.v ?? 0;
}

// ---------------------------------------------------------------------------
// One-off signal scoring
// ---------------------------------------------------------------------------

/**
 * Score a single signal against the workspace's personas and campaigns using
 * the exact prompt/parse discovery items get, writing `signal_matches` rows
 * and patching the signal's `suggestedPersonaId`/`suggestedCampaignId`
 * convenience fields from the best candidate. Gateway failures propagate —
 * callers treat matching as best-effort and try/catch around this so an LLM
 * outage never blocks signal creation.
 */
export async function scoreSignalMatches(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  signal: Signal,
): Promise<DiscoveredItemMatch[]> {
  const ctx = buildMatchingContext(db, workspaceId);
  const prompt = buildMatchingPrompt({
    workspaceName: getWorkspace(db, workspaceId)?.name ?? "this workspace",
    digest: brainDigest(db, workspaceId),
    ctx,
    itemsBlock: `ITEM 0: ${signal.content.slice(0, SIGNAL_CONTENT_PROMPT_CHARS)}`,
  });
  const result = await llm.generate({ prompt });
  const entries = parseJsonArray(result.text);
  if (!entries) return [];
  const entry = entries.find((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
  if (!entry) return [];
  const matches = parseEntryMatches(entry, ctx);

  // Same replace posture as item scoring: never accumulate stale candidates.
  db.delete(signalMatches).where(eq(signalMatches.signalId, signal.id)).run();
  for (const match of matches) insertSignalMatch(db, workspaceId, signal.id, match);
  const best = matches[0];
  if (best) {
    db.update(signals)
      .set({ suggestedPersonaId: best.personaId, suggestedCampaignId: best.campaignId })
      .where(eq(signals.id, signal.id))
      .run();
  }
  return listSignalMatches(db, signal.id);
}
