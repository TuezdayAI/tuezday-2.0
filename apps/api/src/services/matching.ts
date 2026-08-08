// Sprint 45 shared matching module: the persona×campaign prompt context,
// defensive match parsing, and signal/item match persistence used by both
// discovery scoring and one-off signal scoring. Factored out so a
// manually-created signal gets the exact same judgment a discovered item does.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  DISCOVERY_MAX_MATCHES_PER_ITEM,
  matchingResponseSchema,
  type DiscoveredItemMatch,
  type MatchingResponseEntry,
  type MatchingResponseMatch,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import {
  campaigns,
  discoveredItemMatches,
  personas,
  signalMatches,
  signals,
  type SignalMatchRow,
} from "../db/schema";
import type { LlmGateway } from "../llm/gateway";
import { meteredLlm } from "../llm/metered";
import { generateStructured } from "../llm/structured";
import { getBrain } from "./brain";
import { listCampaigns } from "./campaigns";
import { listPersonas } from "./personas";
import { getWorkspace } from "./workspaces";

const DIGEST_CHARS_PER_DOC = 600;
const MATCH_REASON_MAX_CHARS = 500;
const SIGNAL_CONTENT_PROMPT_CHARS = 600;

/** Compact brain summary that fronts every judgment prompt. */
export async function brainDigest(db: Db, workspaceId: string): Promise<string> {
  const { docs } = await getBrain(db, workspaceId);
  return docs
    .filter((d) => ["soul", "icp", "voice", "now"].includes(d.docType) && d.content.trim())
    .map((d) => `${d.docType.toUpperCase()}: ${d.content.trim().slice(0, DIGEST_CHARS_PER_DOC)}`)
    .join("\n\n");
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Sprint 53: `suggestedPersonaId` / `suggestedCampaignId` are no longer stored
 * on signals or discovered items — they are a read-only projection of the
 * top-scoring match. Callers pass the already-loaded, already-ordered match
 * list (score desc, createdAt asc), so the projection costs no extra query.
 */
export function projectSuggestedRouting(
  matches: ReadonlyArray<Pick<DiscoveredItemMatch, "personaId" | "campaignId">>,
): { suggestedPersonaId: string | null; suggestedCampaignId: string | null } {
  const best = matches[0];
  return {
    suggestedPersonaId: best?.personaId ?? null,
    suggestedCampaignId: best?.campaignId ?? null,
  };
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
export async function buildMatchingContext(db: Db, workspaceId: string): Promise<MatchingContext> {
  const workspacePersonas = (await listPersonas(db, workspaceId)).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const personaById = new Map(workspacePersonas.map((p) => [p.id, p]));
  const personaBlock =
    workspacePersonas
      .map((p) =>
        p.topics.length > 0
          ? `- ${p.id}: ${p.name} — topics: ${p.topics.join(", ")}`
          : `- ${p.id}: ${p.name}${p.description ? ` (${p.description})` : ""}`,
      )
      .join("\n") || "(no personas yet)";
  const activeCampaigns = (await listCampaigns(db, workspaceId))
    .filter((campaign) => campaign.status === "active")
    .map((campaign) => ({
      ...campaign,
      personaIds: [...campaign.personaIds].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
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
// Response sanitization. Shape is guaranteed upstream by generateStructured +
// matchingResponseSchema (Sprint 58); what remains here is domain judgment —
// the model may still cite ids that don't exist or pairings the campaign
// doesn't allow.
// ---------------------------------------------------------------------------

export interface ParsedMatch {
  personaId: string | null;
  campaignId: string | null;
  score: number;
  reason: string;
}

function toParsedMatch(raw: MatchingResponseMatch, ctx: MatchingContext): ParsedMatch | null {
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
    score: clampScore(raw.score),
    reason: (raw.reason ?? "").slice(0, MATCH_REASON_MAX_CHARS),
  };
}

/**
 * Sanitize one scoring entry's candidates. Unknown ids → null (never
 * rejected); a persona outside the campaign's `personaIds` is dropped to null
 * while the campaign match survives; more than
 * `DISCOVERY_MAX_MATCHES_PER_ITEM` entries keep the top-scoring five.
 * Best-scoring first, ties by the model's array order (stable sort).
 */
export function sanitizeEntryMatches(
  entry: MatchingResponseEntry,
  ctx: MatchingContext,
): ParsedMatch[] {
  const candidates: ParsedMatch[] = [];
  for (const raw of entry.matches) {
    const match = toParsedMatch(raw, ctx);
    if (match) candidates.push(match);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, DISCOVERY_MAX_MATCHES_PER_ITEM);
}

// ---------------------------------------------------------------------------
// Persistence + read models
// ---------------------------------------------------------------------------

/** Replace an item's candidate rows (delete-then-insert on every scoring). */
export async function replaceItemMatches(
  db: DbExecutor,
  workspaceId: string,
  itemId: string,
  matches: ParsedMatch[],
): Promise<void> {
  await db
    .delete(discoveredItemMatches)
    .where(
      and(
        eq(discoveredItemMatches.workspaceId, workspaceId),
        eq(discoveredItemMatches.itemId, itemId),
      ),
    );
  const now = Date.now();
  for (const match of matches) {
    await db.insert(discoveredItemMatches)
      .values({ id: randomUUID(), workspaceId, itemId, ...match, createdAt: now });
  }
}

export async function insertSignalMatch(
  db: DbExecutor,
  workspaceId: string,
  signalId: string,
  match: { personaId: string | null; campaignId: string | null; score: number; reason: string },
): Promise<void> {
  await db.insert(signalMatches)
    .values({
      id: randomUUID(),
      workspaceId,
      signalId,
      personaId: match.personaId,
      campaignId: match.campaignId,
      score: match.score,
      reason: match.reason,
      createdAt: Date.now(),
    });
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
export async function listItemMatchesForItems(
  db: DbExecutor,
  workspaceId: string,
  itemIds: string[],
): Promise<Map<string, DiscoveredItemMatch[]>> {
  const map = new Map<string, DiscoveredItemMatch[]>();
  if (itemIds.length === 0) return map;
  const rows = await db
    .select({
      itemId: discoveredItemMatches.itemId,
      rawPersonaId: discoveredItemMatches.personaId,
      personaId: personas.id,
      personaName: personas.name,
      rawCampaignId: discoveredItemMatches.campaignId,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      score: discoveredItemMatches.score,
      reason: discoveredItemMatches.reason,
    })
    .from(discoveredItemMatches)
    .leftJoin(
      personas,
      and(
        eq(discoveredItemMatches.personaId, personas.id),
        eq(personas.workspaceId, workspaceId),
      ),
    )
    .leftJoin(
      campaigns,
      and(
        eq(discoveredItemMatches.campaignId, campaigns.id),
        eq(campaigns.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(discoveredItemMatches.workspaceId, workspaceId),
        inArray(discoveredItemMatches.itemId, itemIds),
      ),
    )
    .orderBy(desc(discoveredItemMatches.score), asc(discoveredItemMatches.createdAt));
  for (const {
    itemId,
    rawPersonaId,
    rawCampaignId,
    ...match
  } of rows) {
    if (
      (rawPersonaId !== null && match.personaId === null) ||
      (rawCampaignId !== null && match.campaignId === null)
    ) {
      continue;
    }
    const list = map.get(itemId) ?? [];
    list.push(toContractMatch(match));
    map.set(itemId, list);
  }
  return map;
}

export async function listItemMatches(
  db: DbExecutor,
  workspaceId: string,
  itemId: string,
): Promise<DiscoveredItemMatch[]> {
  return (await listItemMatchesForItems(db, workspaceId, [itemId])).get(itemId) ?? [];
}

/** Contract-shaped matches for many signals at once (one joined query). */
export async function listSignalMatchesForSignals(
  db: DbExecutor,
  workspaceId: string,
  signalIds: string[],
): Promise<Map<string, DiscoveredItemMatch[]>> {
  const map = new Map<string, DiscoveredItemMatch[]>();
  if (signalIds.length === 0) return map;
  const rows = await db
    .select({
      signalId: signalMatches.signalId,
      rawPersonaId: signalMatches.personaId,
      personaId: personas.id,
      personaName: personas.name,
      rawCampaignId: signalMatches.campaignId,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      score: signalMatches.score,
      reason: signalMatches.reason,
    })
    .from(signalMatches)
    .leftJoin(
      personas,
      and(
        eq(signalMatches.personaId, personas.id),
        eq(personas.workspaceId, workspaceId),
      ),
    )
    .leftJoin(
      campaigns,
      and(
        eq(signalMatches.campaignId, campaigns.id),
        eq(campaigns.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(signalMatches.workspaceId, workspaceId),
        inArray(signalMatches.signalId, signalIds),
      ),
    )
    .orderBy(desc(signalMatches.score), asc(signalMatches.createdAt));
  for (const {
    signalId,
    rawPersonaId,
    rawCampaignId,
    ...match
  } of rows) {
    if (
      (rawPersonaId !== null && match.personaId === null) ||
      (rawCampaignId !== null && match.campaignId === null)
    ) {
      continue;
    }
    const list = map.get(signalId) ?? [];
    list.push(toContractMatch(match));
    map.set(signalId, list);
  }
  return map;
}

export async function listSignalMatches(
  db: DbExecutor,
  workspaceId: string,
  signalId: string,
): Promise<DiscoveredItemMatch[]> {
  return (await listSignalMatchesForSignals(db, workspaceId, [signalId])).get(signalId) ?? [];
}

/**
 * Re-check an LLM judgment against the workspace state that exists at write
 * time. The gateway call is awaited outside the transaction, so personas,
 * active campaigns, or campaign assignments may have changed meanwhile.
 */
export async function revalidateSignalMatches(
  db: DbExecutor,
  workspaceId: string,
  matches: ParsedMatch[],
): Promise<ParsedMatch[]> {
  if (matches.length === 0) return [];
  const currentPersonaIds = new Set(
    (await db
      .select({ id: personas.id })
      .from(personas)
      .where(eq(personas.workspaceId, workspaceId)))
      .map((row) => row.id),
  );
  const currentCampaignPersonaIds = new Map(
    (await db
      .select({
        id: campaigns.id,
        personaIdsJson: campaigns.personaIdsJson,
      })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.workspaceId, workspaceId),
          eq(campaigns.status, "active"),
        ),
      ))
      .map((row) => [
        row.id,
        new Set(JSON.parse(row.personaIdsJson) as string[]),
      ]),
  );

  return matches.flatMap((match) => {
    const campaignId =
      match.campaignId && currentCampaignPersonaIds.has(match.campaignId)
        ? match.campaignId
        : null;
    let personaId =
      match.personaId && currentPersonaIds.has(match.personaId)
        ? match.personaId
        : null;
    if (
      campaignId &&
      personaId &&
      !currentCampaignPersonaIds.get(campaignId)?.has(personaId)
    ) {
      personaId = null;
    }
    return campaignId || personaId
      ? [{ ...match, personaId, campaignId }]
      : [];
  });
}

/**
 * The highest-scoring candidate linking a signal to one specific campaign, or
 * undefined when the signal never matched it. This is what `runAutomation`
 * routes on (a signal can carry two candidate personas for the same campaign —
 * only the best one drives generation).
 */
export async function getBestSignalMatchForCampaign(
  db: Db,
  workspaceId: string,
  signalId: string,
  campaignId: string,
): Promise<SignalMatchRow | undefined> {
  const signalExists = (await db
    .select({ id: signals.id })
    .from(signals)
    .where(and(eq(signals.workspaceId, workspaceId), eq(signals.id, signalId))))[0];
  const campaignExists = (await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        eq(campaigns.id, campaignId),
      ),
    ))[0];
  if (!signalExists || !campaignExists) return undefined;

  const matches = await db
    .select()
    .from(signalMatches)
    .where(
      and(
        eq(signalMatches.workspaceId, workspaceId),
        eq(signalMatches.signalId, signalId),
        eq(signalMatches.campaignId, campaignId),
      ),
    )
    .orderBy(desc(signalMatches.score));
  if (matches.length === 0) return undefined;
  const personaIds = [
    ...new Set(
      matches.flatMap((match) => (match.personaId ? [match.personaId] : [])),
    ),
  ];
  const validPersonaIds = new Set(
    personaIds.length
      ? (await db
          .select({ id: personas.id })
          .from(personas)
          .where(
            and(
              eq(personas.workspaceId, workspaceId),
              inArray(personas.id, personaIds),
            ),
          ))
          .map((row) => row.id)
      : [],
  );
  return matches.find(
    (match) =>
      match.personaId === null || validPersonaIds.has(match.personaId),
  );
}

// ---------------------------------------------------------------------------
// One-off signal scoring
// ---------------------------------------------------------------------------

/**
 * Judge a single signal against the workspace's personas and campaigns using
 * the exact prompt/schema discovery items get. This phase performs no writes,
 * so callers can finish the complete persistence step in one transaction.
 * Gateway and StructuredOutputError failures propagate; callers convert them
 * to an empty best-effort result before opening that transaction.
 */
export async function judgeSignalMatches(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  content: string,
): Promise<ParsedMatch[]> {
  const ctx = await buildMatchingContext(db, workspaceId);
  const prompt = buildMatchingPrompt({
    workspaceName: (await getWorkspace(db, workspaceId))?.name ?? "this workspace",
    digest: await brainDigest(db, workspaceId),
    ctx,
    itemsBlock: `ITEM 0: ${content.slice(0, SIGNAL_CONTENT_PROMPT_CHARS)}`,
  });
  const metered = meteredLlm(llm, db, { workspaceId, pipeline: "signal_matching" });
  const result = await generateStructured(metered, matchingResponseSchema, { prompt, tier: "cheap" });
  const entry = result.value[0];
  if (!entry) return [];
  return sanitizeEntryMatches(entry, ctx);
}
