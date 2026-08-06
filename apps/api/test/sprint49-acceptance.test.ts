import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Response as LightMyRequestResponse } from "light-my-request";
import { describe, expect, it } from "vitest";
import { buildApp, type TuezdayApp } from "../src/app";
import type {
  ConnectorFabric,
  ProxyJsonResult,
} from "../src/connectors/fabric";
import { createDb, type Db } from "../src/db";
import {
  approvalDecisions,
  campaigns,
  connections,
  discoveredItemMatches,
  discoveredItems,
  discoveryJobs,
  discoverySources,
  drafts,
  signalMatches,
  signals,
  taskLeases,
} from "../src/db/schema";
import {
  DbEvidenceStore,
  EVIDENCE_EMBEDDING_DIMENSIONS,
} from "../src/evidence/db-store";
import type { LlmGateway } from "../src/llm/gateway";
import type { DiscoveryOperatorPolicy } from "../src/runtime/operator-policy";
import { asUser, registerUser } from "./helpers";

const WORKER_TOKEN = "sprint-49-acceptance-worker-token";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const acceptancePolicy: DiscoveryOperatorPolicy = {
  maxJobsPerTick: 1,
  tickTimeoutMs: 120_000,
  sourceTimeoutMs: 120_000,
  maxItemsPerSource: 100,
  maxPagesPerSource: 10,
  maxCallsPerSource: 30,
  maxResponseBytes: 2 * 1024 * 1024,
  maxBytesPerSource: 10 * 1024 * 1024,
  maxMatchingItemsPerTick: 20,
  matchingTimeoutMs: 120_000,
  leaseMs: 300_000,
  heartbeatMs: 60_000,
  maxRoutingStoriesPerTick: 10,
  routingTimeoutMs: 120_000,
  maxPackagesPerTick: 10,
  packageTimeoutMs: 120_000,
  maxDeliverablesPerTick: 10,
  variantTimeoutMs: 60_000,
};

interface ProviderStats {
  tweetPages: Array<{ instance: string; handle: string; page: number }>;
}

function fixtureFabric(input: {
  instance: string;
  stats: ProviderStats;
  stallTweetCall: number;
  stalled: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<void>>;
}): ConnectorFabric {
  let localTweetCalls = 0;
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession() {
      return { token: "unused" };
    },
    async importConnection() {},
    async connectionExists() {
      return true;
    },
    async deleteConnection() {},
    async proxyGet() {
      return { status: 200, bodySnippet: "{}" };
    },
    async proxyJson(
      _method,
      providerPath,
    ): Promise<ProxyJsonResult> {
      const userMatch = providerPath.match(
        /^\/2\/users\/by\/username\/([^?]+)/,
      );
      if (userMatch) {
        const handle = decodeURIComponent(userMatch[1]!);
        return {
          status: 200,
          json: {
            data: { id: `user-${handle}`, username: handle },
          },
          decodedBytes: 32,
        };
      }

      const timelineMatch = providerPath.match(
        /^\/2\/users\/user-(alpha|beta)\/tweets\?/,
      );
      if (!timelineMatch) {
        throw new Error(`Unexpected fixture provider path: ${providerPath}`);
      }
      const handle = timelineMatch[1]!;
      const url = new URL(providerPath, "https://fixture.invalid");
      const token = url.searchParams.get("pagination_token");
      const pageNumber = token ? Number.parseInt(token, 10) : 1;
      localTweetCalls += 1;
      input.stats.tweetPages.push({
        instance: input.instance,
        handle,
        page: pageNumber,
      });
      if (localTweetCalls === input.stallTweetCall) {
        input.stalled.resolve(undefined);
        await input.release.promise;
      }

      return {
        status: 200,
        json: {
          data: [
            {
              id: `${handle}-${pageNumber}`,
              text: `${handle} restart-safe signal page ${pageNumber}`,
              created_at: `2026-07-0${4 - pageNumber}T10:00:00Z`,
              author_id: `user-${handle}`,
            },
          ],
          includes: {
            users: [
              { id: `user-${handle}`, username: handle },
            ],
          },
          meta: pageNumber < 3
            ? { next_token: String(pageNumber + 1) }
            : {},
        },
        decodedBytes: 128,
      };
    },
  };
}

function closeDb(db: Db | undefined): void {
  if (!db) return;
  (db as Db & { $client: { close(): void } }).$client.close();
}

describe("Sprint 49 founder acceptance", () => {
  it(
    "survives restart and overlapping discovery, matching, and automation",
    async () => {
      const tempDir = mkdtempSync(
        path.join(tmpdir(), "tuezday-s49-acceptance-"),
      );
      const databaseFile = path.join(tempDir, "shared.sqlite");
      const firstProviderStalled = deferred<void>();
      const releaseFirstProvider = deferred<void>();
      const restartedProviderStalled = deferred<void>();
      const releaseRestartedProvider = deferred<void>();
      const matchingStarted = deferred<void>();
      const releaseMatching = deferred<void>();
      const automationStarted = deferred<void>();
      const releaseAutomation = deferred<void>();
      const stats: ProviderStats = { tweetPages: [] };
      let appA: TuezdayApp | undefined;
      let appB: TuezdayApp | undefined;
      let dbA: Db | undefined;
      let dbB: Db | undefined;
      let firstTick: Promise<LightMyRequestResponse> | undefined;
      let restartedTick: Promise<LightMyRequestResponse> | undefined;
      let automationTick: Promise<LightMyRequestResponse> | undefined;

      const llm: LlmGateway = {
        async embed({ texts }) {
          return {
            embeddings: texts.map(() =>
              Array.from(
                { length: EVIDENCE_EMBEDDING_DIMENSIONS },
                (_, index) => (index === 0 ? 1 : 0),
              ),
            ),
            model: "fixture-embedding",
            provider: "fixture",
            dimensions: EVIDENCE_EMBEDDING_DIMENSIONS,
          };
        },
        async generate({ prompt }) {
          // Sprint 61 shadow routing runs inside the discovery tick; this
          // acceptance choreography is about jobs/matching/automation, so the
          // matcher finds no relevant campaign and stays out of the way.
          if (prompt.includes("CANDIDATE CAMPAIGNS:")) {
            return { text: "[]", model: "fixture", provider: "fixture", durationMs: 1 };
          }
          if (prompt.includes("DISCOVERED ITEMS:")) {
            matchingStarted.resolve(undefined);
            await releaseMatching.promise;
            const itemCount = prompt.match(/ITEM \d+:/g)?.length ?? 0;
            return {
              text: JSON.stringify(
                Array.from({ length: itemCount }, (_, index) => ({
                  index,
                  score: 92,
                  matches: [
                    {
                      personaId,
                      campaignId,
                      score: 91,
                      reason: "Exact Sprint 49 acceptance route.",
                    },
                  ],
                })),
              ),
              model: "fixture",
              provider: "fixture",
              durationMs: 1,
            };
          }
          automationStarted.resolve(undefined);
          await releaseAutomation.promise;
          return {
            text: "Restart-safe headline\nOne automatic founder-ready draft.",
            model: "fixture",
            provider: "fixture",
            durationMs: 1,
          };
        },
      };

      let personaId = "";
      let campaignId = "";

      try {
        dbA = createDb(databaseFile);
        appA = await buildApp({
          db: dbA,
          llm,
          evidence: new DbEvidenceStore(dbA, llm),
          connectors: fixtureFabric({
            instance: "api-a",
            stats,
            stallTweetCall: 2,
            stalled: firstProviderStalled,
            release: releaseFirstProvider,
          }),
          workerToken: WORKER_TOKEN,
          operatorPolicy: acceptancePolicy,
          instanceId: "api-a",
        });
        const user = await registerUser(
          appA,
          "sprint49-acceptance@test.dev",
        );
        const userA = asUser(appA, user.token);
        const workspaceResponse = await userA.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Sprint 49 acceptance" },
        });
        expect(workspaceResponse.statusCode, workspaceResponse.body).toBe(201);
        const workspaceId = workspaceResponse.json().id as string;

        const evidenceUpload = await userA.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/evidence`,
          payload: {
            title: "Restart-safe operations",
            content:
              "Tuezday uses fenced leases and durable checkpoints for reliable GTM automation.",
          },
        });
        expect(evidenceUpload.statusCode, evidenceUpload.body).toBe(201);
        expect(evidenceUpload.json()).toMatchObject({ status: "ready" });

        const resolved = await userA.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/resolve`,
          payload: {
            taskType: "linkedin_post",
            channel: "linkedin",
            useEvidence: true,
          },
        });
        expect(resolved.statusCode, resolved.body).toBe(200);
        expect(
          resolved.json().sections.find(
            (section: { key: string }) => section.key === "evidence",
          ),
        ).toMatchObject({ included: true });

        const personaResponse = await userA.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/personas`,
          payload: {
            name: "Founder",
            description: "Explains restart-safe GTM operations.",
            topics: ["reliable automation"],
          },
        });
        expect(personaResponse.statusCode, personaResponse.body).toBe(201);
        personaId = personaResponse.json().id as string;

        const campaignResponse = await userA.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns`,
          payload: {
            name: "Reliability launch",
            objective: "Explain bounded restart-safe execution.",
            channels: ["linkedin"],
            personaIds: [personaId],
          },
        });
        expect(campaignResponse.statusCode, campaignResponse.body).toBe(201);
        campaignId = campaignResponse.json().id as string;
        const automationMode = await userA.inject({
          method: "PATCH",
          url:
            `/workspaces/${workspaceId}/campaigns/${campaignId}` +
            "/automation",
          payload: { automationMode: "scheduled_auto" },
        });
        expect(automationMode.statusCode, automationMode.body).toBe(200);

        const connectionId = randomUUID();
        const now = Date.now();
        dbA.insert(connections)
          .values({
            id: connectionId,
            workspaceId,
            providerKey: "twitter",
            nangoConnectionId: "nango-sprint49-fixture",
            configJson: "{}",
            displayName: "X fixture",
            externalAccountId: null,
            externalAccountName: null,
            externalAccountHandle: null,
            externalAccountUrl: null,
            status: "connected",
            lastCheckedAt: now,
            lastError: null,
            contentProfileJson: "{}",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        const sourceResponse = await userA.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/discovery/sources`,
          payload: {
            type: "x",
            name: "Six-page restart fixture",
            config: {
              mode: "account_timeline",
              handles: ["alpha", "beta"],
            },
            connectionId,
          },
        });
        expect(sourceResponse.statusCode, sourceResponse.body).toBe(201);
        const sourceId = sourceResponse.json().id as string;

        firstTick = appA.inject({
          method: "POST",
          url: "/internal/discovery/tick",
          payload: {},
          headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });
        await firstProviderStalled.promise;

        expect(
          dbA
            .select({ externalId: discoveredItems.externalId })
            .from(discoveredItems)
            .all(),
        ).toEqual([{ externalId: "x:alpha-1" }]);
        const firstClaim = dbA
          .select()
          .from(discoveryJobs)
          .where(eq(discoveryJobs.sourceId, sourceId))
          .get()!;
        expect(firstClaim).toMatchObject({
          status: "running",
          attempt: 1,
          fetchedCount: 1,
          newCount: 1,
        });

        // Simulate process death after the durable page checkpoint. The old
        // request remains suspended so its eventual write also proves fencing.
        dbA.update(discoveryJobs)
          .set({ leaseExpiresAt: 0 })
          .where(eq(discoveryJobs.id, firstClaim.id))
          .run();
        dbA.update(taskLeases)
          .set({ expiresAt: 0 })
          .where(eq(taskLeases.key, "discovery:scheduler"))
          .run();

        dbB = createDb(databaseFile);
        appB = await buildApp({
          db: dbB,
          llm,
          evidence: new DbEvidenceStore(dbB, llm),
          connectors: fixtureFabric({
            instance: "api-b",
            stats,
            stallTweetCall: 1,
            stalled: restartedProviderStalled,
            release: releaseRestartedProvider,
          }),
          workerToken: WORKER_TOKEN,
          operatorPolicy: acceptancePolicy,
          instanceId: "api-b",
        });
        const userB = asUser(appB, user.token);
        restartedTick = appB.inject({
          method: "POST",
          url: "/internal/discovery/tick",
          payload: {},
          headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });
        await restartedProviderStalled.promise;

        expect(
          dbB
            .select({ attempt: discoveryJobs.attempt })
            .from(discoveryJobs)
            .where(eq(discoveryJobs.id, firstClaim.id))
            .get(),
        ).toEqual({ attempt: 2 });
        const providerCallsAtOverlap = stats.tweetPages.length;
        const overlappingTick = await appB.inject({
          method: "POST",
          url: "/internal/discovery/tick",
          payload: {},
          headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });
        expect(overlappingTick.statusCode, overlappingTick.body).toBe(200);
        expect(overlappingTick.json()).toMatchObject({
          busy: true,
          processed: 0,
        });
        expect(stats.tweetPages).toHaveLength(providerCallsAtOverlap);
        releaseRestartedProvider.resolve(undefined);

        await matchingStarted.promise;
        const matchingItem = dbB
          .select()
          .from(discoveredItems)
          .where(eq(discoveredItems.matchingState, "running"))
          .get()!;
        const blockedAcceptance = await userB.inject({
          method: "POST",
          url:
            `/workspaces/${workspaceId}/discovery/items/` +
            `${matchingItem.id}/accept`,
        });
        expect(blockedAcceptance.statusCode, blockedAcceptance.body).toBe(409);
        expect(blockedAcceptance.json()).toMatchObject({
          error: "matching_not_ready",
        });
        expect(dbB.select().from(signals).all()).toHaveLength(0);

        releaseMatching.resolve(undefined);
        const restartedResponse = await restartedTick;
        expect(restartedResponse.statusCode, restartedResponse.body).toBe(200);
        expect(restartedResponse.json()).toMatchObject({
          busy: false,
          processed: 1,
          scored: 6,
        });

        releaseFirstProvider.resolve(undefined);
        const staleResponse = await firstTick;
        expect(staleResponse.statusCode, staleResponse.body).toBe(200);
        expect(staleResponse.json().sources[0]).toMatchObject({
          sourceId,
          error: "lease_lost",
        });

        const occurrences = dbB
          .select({ externalId: discoveredItems.externalId })
          .from(discoveredItems)
          .where(eq(discoveredItems.sourceId, sourceId))
          .all()
          .map((row) => row.externalId)
          .sort();
        expect(occurrences).toEqual([
          "x:alpha-1",
          "x:alpha-2",
          "x:alpha-3",
          "x:beta-1",
          "x:beta-2",
          "x:beta-3",
        ]);
        expect(new Set(occurrences)).toHaveLength(6);
        const source = dbB
          .select({ cursorJson: discoverySources.cursorJson })
          .from(discoverySources)
          .where(eq(discoverySources.id, sourceId))
          .get()!;
        const cursor = JSON.parse(source.cursorJson) as {
          targets: Record<
            string,
            {
              highWatermark: {
                externalId: string;
                publishedAt: number | null;
              } | null;
              continuation: unknown;
            }
          >;
        };
        expect(
          Object.values(cursor.targets)
            .map((target) => target.highWatermark?.externalId)
            .sort(),
        ).toEqual(["x:alpha-1", "x:beta-1"]);
        expect(
          Object.values(cursor.targets).every(
            (target) => target.continuation === null,
          ),
        ).toBe(true);

        const itemMatchesBeforeAccept = dbB
          .select({
            personaId: discoveredItemMatches.personaId,
            campaignId: discoveredItemMatches.campaignId,
            score: discoveredItemMatches.score,
            reason: discoveredItemMatches.reason,
          })
          .from(discoveredItemMatches)
          .where(eq(discoveredItemMatches.itemId, matchingItem.id))
          .all();
        expect(itemMatchesBeforeAccept).toEqual([
          {
            personaId,
            campaignId,
            score: 91,
            reason: "Exact Sprint 49 acceptance route.",
          },
        ]);
        const accepted = await userB.inject({
          method: "POST",
          url:
            `/workspaces/${workspaceId}/discovery/items/` +
            `${matchingItem.id}/accept`,
        });
        expect(accepted.statusCode, accepted.body).toBe(200);
        const signalId = accepted.json().signal.id as string;
        const copiedMatches = dbB
          .select({
            personaId: signalMatches.personaId,
            campaignId: signalMatches.campaignId,
            score: signalMatches.score,
            reason: signalMatches.reason,
          })
          .from(signalMatches)
          .where(eq(signalMatches.signalId, signalId))
          .all();
        expect(copiedMatches).toEqual(itemMatchesBeforeAccept);

        automationTick = appB.inject({
          method: "POST",
          url: "/internal/automation/tick",
          payload: {},
          headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });
        await automationStarted.promise;
        const manualRace = await userB.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/automation/run`,
          payload: {},
        });
        expect(manualRace.statusCode, manualRace.body).toBe(200);
        expect(manualRace.json()).toMatchObject({ busy: true });
        releaseAutomation.resolve(undefined);
        const automationResponse = await automationTick;
        expect(automationResponse.statusCode, automationResponse.body).toBe(
          200,
        );
        expect(automationResponse.json()).toMatchObject({
          busy: false,
          processed: 1,
        });

        const automaticDrafts = dbB
          .select()
          .from(drafts)
          .where(
            and(
              eq(drafts.sourceSignalId, signalId),
              eq(drafts.campaignId, campaignId),
            ),
          )
          .all();
        expect(automaticDrafts).toHaveLength(1);
        expect(automaticDrafts[0]).toMatchObject({
          state: "approved",
          channel: "linkedin",
          personaId,
        });
        expect(automaticDrafts[0]!.automationKey).not.toBeNull();
        const decisions = dbB
          .select({ action: approvalDecisions.action })
          .from(approvalDecisions)
          .where(
            eq(approvalDecisions.draftId, automaticDrafts[0]!.id),
          )
          .all();
        expect(decisions.map((decision) => decision.action)).toEqual([
          "submit",
          "approve",
        ]);
        expect(
          decisions.filter((decision) => decision.action === "approve"),
        ).toHaveLength(1);
        expect(
          dbB
            .select({ automationMode: campaigns.automationMode })
            .from(campaigns)
            .where(eq(campaigns.id, campaignId))
            .get(),
        ).toEqual({ automationMode: "scheduled_auto" });
      } finally {
        releaseFirstProvider.resolve(undefined);
        releaseRestartedProvider.resolve(undefined);
        releaseMatching.resolve(undefined);
        releaseAutomation.resolve(undefined);
        await Promise.allSettled(
          [firstTick, restartedTick, automationTick].filter(
            (pending): pending is NonNullable<typeof pending> =>
              pending !== undefined,
          ),
        );
        await appB?.close();
        await appA?.close();
        closeDb(dbB);
        closeDb(dbA);
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
