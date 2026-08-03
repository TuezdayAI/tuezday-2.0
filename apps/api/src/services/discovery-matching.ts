import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Db, DbExecutor } from "../db";
import {
  campaigns,
  discoveredItems,
  personas,
  type DiscoveredItemRow,
} from "../db/schema";
import { matchingResponseSchema, type MatchingResponseEntry } from "@tuezday/contracts";
import type { LlmGateway } from "../llm/gateway";
import { meteredLlm } from "../llm/metered";
import { generateStructured, StructuredOutputError } from "../llm/structured";
import { llmBudgetExhausted } from "./entitlements";
import {
  brainDigest,
  buildMatchingContext,
  buildMatchingPrompt,
  clampScore,
  replaceItemMatches,
  revalidateSignalMatches,
  sanitizeEntryMatches,
} from "./matching";
import { DATABASE_NOW_MS } from "./task-leases";
import { getWorkspace } from "./workspaces";

export interface MatchingClaim {
  itemId: string;
  workspaceId: string;
  owner: string;
  version: number;
  inputFingerprint: string;
  leaseExpiresAt: number;
}

export interface MatchingDependencies {
  db: Db;
  llm: LlmGateway;
  leaseMs: number;
  heartbeatMs: number;
}

interface FingerprintItem {
  title: string;
  summary: string;
  url: string;
  contentHash: string;
}

function fingerprintForItem(
  db: DbExecutor,
  workspaceId: string,
  item: FingerprintItem,
): string {
  const orderedPersonas = db
    .select({
      id: personas.id,
      name: personas.name,
      description: personas.description,
      topicsJson: personas.topicsJson,
    })
    .from(personas)
    .where(eq(personas.workspaceId, workspaceId))
    .orderBy(asc(personas.id))
    .all()
    .map((persona) => ({
      id: persona.id,
      name: persona.name,
      description: persona.description,
      topics: JSON.parse(persona.topicsJson) as string[],
    }));
  const orderedActiveCampaigns = db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      objective: campaigns.objective,
      personaIdsJson: campaigns.personaIdsJson,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        eq(campaigns.status, "active"),
      ),
    )
    .orderBy(asc(campaigns.id))
    .all()
    .map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      objective: campaign.objective,
      personaIds: [
        ...(JSON.parse(campaign.personaIdsJson) as string[]),
      ].sort(),
    }));
  const serialized = JSON.stringify({
    item: {
      title: item.title,
      summary: item.summary,
      url: item.url,
      contentHash: item.contentHash,
    },
    personas: orderedPersonas,
    campaigns: orderedActiveCampaigns,
  });
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function claimIsCurrent(
  claim: MatchingClaim,
  requireUnexpired = true,
) {
  return and(
    eq(discoveredItems.id, claim.itemId),
    eq(discoveredItems.workspaceId, claim.workspaceId),
    eq(discoveredItems.status, "new"),
    isNull(discoveredItems.duplicateOfId),
    eq(discoveredItems.matchingState, "running"),
    eq(discoveredItems.matchingLeaseOwner, claim.owner),
    eq(discoveredItems.matchingVersion, claim.version),
    eq(
      discoveredItems.matchingInputFingerprint,
      claim.inputFingerprint,
    ),
    requireUnexpired
      ? gt(discoveredItems.matchingLeaseExpiresAt, DATABASE_NOW_MS)
      : undefined,
  );
}

export function claimMatchingBatch(
  db: Db,
  input: {
    workspaceId?: string;
    owner: string;
    limit: number;
    leaseMs: number;
  },
): MatchingClaim[] {
  if (input.limit <= 0) return [];
  return db.transaction((tx) => {
    const candidates = tx
      .select()
      .from(discoveredItems)
      .where(
        and(
          input.workspaceId
            ? eq(discoveredItems.workspaceId, input.workspaceId)
            : undefined,
          eq(discoveredItems.status, "new"),
          isNull(discoveredItems.duplicateOfId),
          or(
            inArray(discoveredItems.matchingState, [
              "pending",
              "retryable_error",
            ]),
            and(
              eq(discoveredItems.matchingState, "running"),
              lte(
                discoveredItems.matchingLeaseExpiresAt,
                DATABASE_NOW_MS,
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(discoveredItems.createdAt), asc(discoveredItems.id))
      .all();
    const claims: MatchingClaim[] = [];
    for (const candidate of candidates) {
      if (claims.length >= input.limit) break;
      const fingerprint = fingerprintForItem(
        tx,
        candidate.workspaceId,
        candidate,
      );
      const claimed = tx
        .update(discoveredItems)
        .set({
          matchingState: "running",
          matchingVersion: sql`${discoveredItems.matchingVersion} + 1`,
          matchingInputFingerprint: fingerprint,
          matchingLeaseOwner: input.owner,
          matchingLeaseExpiresAt: sql`
            ${DATABASE_NOW_MS} + ${input.leaseMs}
          `,
          matchingHeartbeatAt: DATABASE_NOW_MS,
          matchingError: null,
        })
        .where(
          and(
            eq(discoveredItems.id, candidate.id),
            eq(
              discoveredItems.matchingVersion,
              candidate.matchingVersion,
            ),
            eq(discoveredItems.status, "new"),
            isNull(discoveredItems.duplicateOfId),
            or(
              inArray(discoveredItems.matchingState, [
                "pending",
                "retryable_error",
              ]),
              and(
                eq(discoveredItems.matchingState, "running"),
                lte(
                  discoveredItems.matchingLeaseExpiresAt,
                  DATABASE_NOW_MS,
                ),
              ),
            ),
          ),
        )
        .returning({
          itemId: discoveredItems.id,
          workspaceId: discoveredItems.workspaceId,
          version: discoveredItems.matchingVersion,
          leaseExpiresAt: discoveredItems.matchingLeaseExpiresAt,
        })
        .get();
      if (claimed?.leaseExpiresAt === null) continue;
      claims.push({
        ...claimed,
        owner: input.owner,
        inputFingerprint: fingerprint,
        leaseExpiresAt: claimed.leaseExpiresAt,
      });
    }
    return claims;
  });
}

export function heartbeatMatchingClaim(
  db: Db,
  claim: MatchingClaim,
  leaseMs: number,
): boolean {
  return (
    db
      .update(discoveredItems)
      .set({
        matchingLeaseExpiresAt: sql`
          ${DATABASE_NOW_MS} + ${leaseMs}
        `,
        matchingHeartbeatAt: DATABASE_NOW_MS,
      })
      .where(claimIsCurrent(claim))
      .run().changes === 1
  );
}

function markRetryable(
  db: Db,
  claim: MatchingClaim,
  code: string,
): boolean {
  return (
    db
      .update(discoveredItems)
      .set({
        matchingState: "retryable_error",
        matchingLeaseOwner: null,
        matchingLeaseExpiresAt: null,
        matchingHeartbeatAt: null,
        matchingError: code,
      })
      .where(claimIsCurrent(claim))
      .run().changes === 1
  );
}

class MatchingFenceError extends Error {}

function commitMatchingResult(
  db: Db,
  claim: MatchingClaim,
  entry: MatchingResponseEntry,
  context: ReturnType<typeof buildMatchingContext>,
): boolean {
  try {
    return db.transaction((tx) => {
      const item = tx
        .select()
        .from(discoveredItems)
        .where(claimIsCurrent(claim))
        .get();
      if (!item) throw new MatchingFenceError();
      const currentFingerprint = fingerprintForItem(
        tx,
        claim.workspaceId,
        item,
      );
      if (currentFingerprint !== claim.inputFingerprint) {
        const reset = tx
          .update(discoveredItems)
          .set({
            matchingState: "pending",
            matchingInputFingerprint: null,
            matchingLeaseOwner: null,
            matchingLeaseExpiresAt: null,
            matchingHeartbeatAt: null,
            matchingError: null,
          })
          .where(claimIsCurrent(claim))
          .run();
        if (reset.changes !== 1) throw new MatchingFenceError();
        return false;
      }

      const matches = revalidateSignalMatches(
        tx,
        claim.workspaceId,
        sanitizeEntryMatches(entry, context),
      );
      const best = matches[0];
      replaceItemMatches(tx, claim.workspaceId, claim.itemId, matches);
      const updated = tx
        .update(discoveredItems)
        .set({
          score: clampScore(entry.score),
          // Sprint 53 (D3b): the item's suggested persona/campaign are no longer
          // stored. They are projected from the top-scoring row written by
          // replaceItemMatches above (see projectSuggestedRouting in
          // services/matching.ts). scoreReason stays a real stored column.
          scoreReason: best ? best.reason : entry.reason?.slice(0, 500) ?? null,
          scoredAt: Date.now(),
          matchingState: "ready",
          matchingLeaseOwner: null,
          matchingLeaseExpiresAt: null,
          matchingHeartbeatAt: null,
          matchingError: null,
        })
        .where(claimIsCurrent(claim))
        .run();
      if (updated.changes !== 1) throw new MatchingFenceError();
      return true;
    });
  } catch (error) {
    if (error instanceof MatchingFenceError) return false;
    throw error;
  }
}

function currentClaimedItems(
  db: Db,
  claims: MatchingClaim[],
): Array<{ claim: MatchingClaim; item: DiscoveredItemRow }> {
  return claims.flatMap((claim) => {
    const item = db
      .select()
      .from(discoveredItems)
      .where(claimIsCurrent(claim))
      .get();
    return item ? [{ claim, item }] : [];
  });
}

function errorCode(signal: AbortSignal): string {
  const reason = signal.reason as { code?: unknown } | undefined;
  return typeof reason?.code === "string"
    ? reason.code
    : "matching_timeout";
}

export async function runMatchingBatch(
  deps: MatchingDependencies,
  claims: MatchingClaim[],
  signal: AbortSignal,
): Promise<{ ready: number; retryableErrors: number }> {
  let ready = 0;
  let retryableErrors = 0;
  const workspaceIds = [
    ...new Set(claims.map((claim) => claim.workspaceId)),
  ];
  for (const workspaceId of workspaceIds) {
    const workspaceClaims = currentClaimedItems(
      deps.db,
      claims.filter((claim) => claim.workspaceId === workspaceId),
    );
    if (workspaceClaims.length === 0) continue;
    const workspace = getWorkspace(deps.db, workspaceId);
    if (!workspace) continue;
    // Budget degradation (Sprint 59): over-budget workspaces skip scoring;
    // items go back to retryable and a later tick picks them up once spend
    // rolls out of the window or the plan changes. Never a mid-run failure.
    if (llmBudgetExhausted(deps.db, workspaceId)) {
      for (const { claim } of workspaceClaims) {
        if (markRetryable(deps.db, claim, "llm_budget_exhausted")) retryableErrors += 1;
      }
      continue;
    }
    const context = buildMatchingContext(deps.db, workspaceId);
    const itemsBlock = workspaceClaims
      .map(
        ({ item }, index) =>
          `ITEM ${index}: ${item.title}\n${
            item.summary
              ? item.summary.slice(0, 300)
              : "(no summary)"
          }`,
      )
      .join("\n\n");
    const prompt = buildMatchingPrompt({
      workspaceName: workspace.name,
      digest: brainDigest(deps.db, workspaceId),
      ctx: context,
      itemsBlock,
    });
    const leaseLost = new AbortController();
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const scheduleHeartbeat = () => {
      heartbeat = setTimeout(() => {
        if (stopped) return;
        const live = workspaceClaims.every(({ claim }) =>
          heartbeatMatchingClaim(deps.db, claim, deps.leaseMs),
        );
        if (!live) {
          leaseLost.abort(
            Object.assign(new Error("matching_lease_lost"), {
              code: "matching_lease_lost",
            }),
          );
          return;
        }
        scheduleHeartbeat();
      }, deps.heartbeatMs);
      heartbeat.unref();
    };
    scheduleHeartbeat();
    const effectiveSignal = AbortSignal.any([
      signal,
      leaseLost.signal,
    ]);

    let entries: MatchingResponseEntry[];
    try {
      const metered = meteredLlm(deps.llm, deps.db, {
        workspaceId,
        pipeline: "discovery_matching",
      });
      const response = await generateStructured(metered, matchingResponseSchema, {
        prompt,
        signal: effectiveSignal,
        tier: "cheap",
      });
      entries = response.value;
    } catch (error) {
      // A response that failed schema validation even after the repair retry
      // is retryable data trouble; aborts and gateway trouble keep their codes.
      const code =
        error instanceof StructuredOutputError
          ? "matching_malformed_response"
          : effectiveSignal.aborted
            ? errorCode(effectiveSignal)
            : "matching_gateway_failed";
      for (const { claim } of workspaceClaims) {
        if (markRetryable(deps.db, claim, code)) {
          retryableErrors += 1;
        }
      }
      continue;
    } finally {
      stopped = true;
      if (heartbeat) clearTimeout(heartbeat);
    }

    for (const [index, { claim }] of workspaceClaims.entries()) {
      const entry = entries.find((candidate) => candidate.index === index);
      if (!entry) {
        if (markRetryable(deps.db, claim, "matching_missing_result")) {
          retryableErrors += 1;
        }
        continue;
      }
      if (commitMatchingResult(deps.db, claim, entry, context)) {
        ready += 1;
      }
    }
  }
  return { ready, retryableErrors };
}
