import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DiscoveryRunSummary } from "@tuezday/contracts";
import type { ConnectorFabric } from "../connectors/fabric";
import type { Db } from "../db";
import { discoveryJobs, workspaces } from "../db/schema";
import type { IntentProvider } from "../discovery/intent";
import type { DiscoveryPageReader } from "../discovery/paging";
import type { LlmGateway } from "../llm/gateway";
import type { DiscoveryOperatorPolicy } from "../runtime/operator-policy";
import type { SafeFetchService } from "../safe-fetch";
import {
  getDiscoverySourceMetrics,
  listDiscoverySources,
  runClaimedDiscoverySource,
  type SourceRunResult,
} from "./discovery";
import {
  claimMatchingBatch,
  runMatchingBatch,
} from "./discovery-matching";
import {
  claimNextDiscoveryJob,
  enqueueDueDiscoveryJobs,
  heartbeatDiscoveryJob,
  type DiscoveryJobClaim,
} from "./discovery-jobs";
import { runOpportunityRouting } from "./opportunity-matching";
import { runPackagePipeline } from "./sufficiency";
import { runDeliverablePipeline } from "./variant-generation";
import { withTaskLease } from "./task-leases";

export type DiscoverySchedulerResult = DiscoveryRunSummary;

export interface DiscoveryOperatorEvent {
  code: string;
  taskKey: string;
  jobId: string | null;
  workspaceId: string | null;
  sourceId: string | null;
  leaseVersion: number;
  attempt: number;
  elapsedMs: number;
  calls: number;
  pages: number;
  bytes: number;
  items: number;
  continuationPending: boolean;
  replay: boolean;
}

export interface DiscoverySchedulerDependencies {
  db: Db;
  llm: LlmGateway;
  safeFetch: SafeFetchService;
  intentProvider: IntentProvider;
  fabric: ConnectorFabric;
  policy: DiscoveryOperatorPolicy;
  instanceId: string;
  shutdownSignal: AbortSignal;
  log: (event: DiscoveryOperatorEvent) => void;
  /** Focused test seam; production uses the bounded adapter page readers. */
  pageReader?: DiscoveryPageReader;
}

class DiscoveryControlError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "DiscoveryControlError";
  }
}

function deadline(
  timeoutMs: number,
  code: string,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DiscoveryControlError(code)),
    timeoutMs,
  );
  timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

async function withDiscoveryJobHeartbeat<T>(
  deps: DiscoverySchedulerDependencies,
  claim: DiscoveryJobClaim,
  parentSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const leaseController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      const renewed = heartbeatDiscoveryJob(
        deps.db,
        claim,
        deps.policy.leaseMs,
      );
      if (!renewed) {
        leaseController.abort(new DiscoveryControlError("lease_lost"));
        return;
      }
      schedule();
    }, deps.policy.heartbeatMs);
    timer.unref();
  };
  schedule();

  try {
    return await work(
      AbortSignal.any([parentSignal, leaseController.signal]),
    );
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
}

function emptyResult(busy: boolean): DiscoverySchedulerResult {
  return {
    busy,
    budgetExhausted: false,
    queued: 0,
    processed: 0,
    sources: [],
    scored: 0,
    storiesRouted: 0,
    opportunitiesCreated: 0,
    packagesCreated: 0,
    packagesAssessed: 0,
    deliverablesCreated: 0,
    variantsGenerated: 0,
  };
}

function selectedWorkspaces(
  deps: DiscoverySchedulerDependencies,
  workspaceId: string | undefined,
): Array<{ id: string; name: string }> {
  if (workspaceId) {
    const workspace = deps.db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .get();
    return workspace ? [workspace] : [];
  }
  return deps.db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .all();
}

function hasQueuedWork(db: Db, workspaceId?: string): boolean {
  return Boolean(
    db
    .select({ id: discoveryJobs.id })
    .from(discoveryJobs)
    .where(
      and(
        workspaceId
          ? eq(discoveryJobs.workspaceId, workspaceId)
          : undefined,
        eq(discoveryJobs.status, "queued"),
      ),
    )
    .limit(1)
    .get(),
  );
}

export async function runDiscoveryScheduler(
  deps: DiscoverySchedulerDependencies,
  input: { workspaceId?: string },
): Promise<DiscoverySchedulerResult> {
  const schedulerOwner =
    `${deps.instanceId}:discovery-scheduler:${randomUUID()}`;
  const leased = await withTaskLease(
    deps.db,
    {
      key: "discovery:scheduler",
      owner: schedulerOwner,
      leaseMs: deps.policy.leaseMs,
      heartbeatMs: deps.policy.heartbeatMs,
    },
    async ({ signal: schedulerLeaseSignal }) => {
      const result = emptyResult(false);
      const tick = deadline(
        deps.policy.tickTimeoutMs,
        "tick_budget_exhausted",
      );
      const shutdownController = new AbortController();
      const onShutdown = () =>
        shutdownController.abort(new DiscoveryControlError("shutdown"));
      deps.shutdownSignal.addEventListener("abort", onShutdown, {
        once: true,
      });
      if (deps.shutdownSignal.aborted) onShutdown();
      const tickSignal = AbortSignal.any([
        schedulerLeaseSignal,
        tick.signal,
        shutdownController.signal,
      ]);
      const workspaceRows = selectedWorkspaces(deps, input.workspaceId);

      try {
        const now = Date.now();
        for (const workspace of workspaceRows) {
          const eligible = listDiscoverySources(
            deps.db,
            workspace.id,
          ).filter(
            (source) =>
              source.enabled &&
              source.status !== "reserved" &&
              source.status !== "needs_api_key",
          );
          result.queued += enqueueDueDiscoveryJobs(
            deps.db,
            workspace.id,
            eligible,
            now,
          );
        }

        const tickStartedAt = Date.now();
        while (result.processed < deps.policy.maxJobsPerTick) {
          const meaningfulSourceBudget = Math.min(
            5_000,
            deps.policy.sourceTimeoutMs,
          );
          const elapsed = Date.now() - tickStartedAt;
          if (
            tickSignal.aborted ||
            deps.policy.tickTimeoutMs - elapsed <
              meaningfulSourceBudget
          ) {
            result.budgetExhausted = hasQueuedWork(
              deps.db,
              input.workspaceId,
            );
            break;
          }

          const claim = claimNextDiscoveryJob(deps.db, {
            workspaceId: input.workspaceId,
            owner: `${deps.instanceId}:discovery-job:${randomUUID()}`,
            leaseMs: deps.policy.leaseMs,
          });
          if (!claim) break;

          const sourceStartedAt = Date.now();
          const tickRemainingMs = Math.max(
            1,
            deps.policy.tickTimeoutMs -
              (sourceStartedAt - tickStartedAt),
          );
          const sourceWindowMs = Math.min(
            deps.policy.sourceTimeoutMs,
            tickRemainingMs,
          );
          const sourceDeadline = deadline(
            sourceWindowMs,
            tickRemainingMs <= deps.policy.sourceTimeoutMs
              ? "tick_budget_exhausted"
              : "source_timeout",
          );
          let sourceResult: SourceRunResult;
          try {
            sourceResult = await withDiscoveryJobHeartbeat(
              deps,
              claim,
              AbortSignal.any([tickSignal, sourceDeadline.signal]),
              (signal) =>
                runClaimedDiscoverySource(
                  {
                    db: deps.db,
                    safeFetch: deps.safeFetch,
                    intentProvider: deps.intentProvider,
                    fabric: deps.fabric,
                    pageReader: deps.pageReader,
                  },
                  claim,
                  {
                    deadlineMs:
                      sourceStartedAt + deps.policy.sourceTimeoutMs,
                    maxItems: deps.policy.maxItemsPerSource,
                    maxPages: deps.policy.maxPagesPerSource,
                    maxCalls: deps.policy.maxCallsPerSource,
                    maxResponseBytes: deps.policy.maxResponseBytes,
                    maxBytes: deps.policy.maxBytesPerSource,
                  },
                  signal,
                ),
            );
          } finally {
            sourceDeadline.dispose();
          }

          result.processed += 1;
          result.sources.push(sourceResult);
          const metrics = getDiscoverySourceMetrics(sourceResult);
          if (
            metrics.code.endsWith("_budget_exhausted") ||
            metrics.code === "source_timeout" ||
            metrics.code === "response_limit"
          ) {
            result.budgetExhausted = true;
          }
          deps.log({
            code: metrics.code,
            taskKey: "discovery:scheduler",
            jobId: claim.id,
            workspaceId: claim.workspaceId,
            sourceId: claim.sourceId,
            leaseVersion: claim.leaseVersion,
            attempt: claim.attempt,
            elapsedMs: Math.max(0, Date.now() - sourceStartedAt),
            calls: metrics.calls,
            pages: metrics.pages,
            bytes: metrics.bytes,
            items: metrics.items,
            continuationPending: metrics.continuationPending,
            replay: metrics.replay,
          });
        }

        if (
          result.processed >= deps.policy.maxJobsPerTick &&
          hasQueuedWork(deps.db, input.workspaceId)
        ) {
          result.budgetExhausted = true;
        }

        let matchingRemaining = deps.policy.maxMatchingItemsPerTick;
        for (const workspace of workspaceRows) {
          if (matchingRemaining <= 0 || tickSignal.aborted) break;
          const claims = claimMatchingBatch(deps.db, {
            workspaceId: workspace.id,
            owner: `${deps.instanceId}:matching:${randomUUID()}`,
            limit: matchingRemaining,
            leaseMs: deps.policy.leaseMs,
          });
          if (claims.length === 0) continue;
          matchingRemaining -= claims.length;
          const matchingDeadline = deadline(
            deps.policy.matchingTimeoutMs,
            "matching_timeout",
          );
          try {
            const matching = await runMatchingBatch(
              {
                db: deps.db,
                llm: deps.llm,
                leaseMs: deps.policy.leaseMs,
                heartbeatMs: deps.policy.heartbeatMs,
              },
              claims,
              AbortSignal.any([
                tickSignal,
                matchingDeadline.signal,
              ]),
            );
            result.scored += matching.ready;
          } finally {
            matchingDeadline.dispose();
          }
        }

        // Sprint 61: story → campaign-opportunity routing (shadow). Runs
        // after item matching under the same scheduler lease; per-workspace
        // budget gating and lease/fingerprint fencing live in the service.
        let routingRemaining = deps.policy.maxRoutingStoriesPerTick;
        for (const workspace of workspaceRows) {
          if (routingRemaining <= 0 || tickSignal.aborted) break;
          const routing = await runOpportunityRouting(deps.db, deps.llm, {
            workspaceId: workspace.id,
            limit: routingRemaining,
            leaseMs: deps.policy.leaseMs,
            timeoutMs: deps.policy.routingTimeoutMs,
            signal: tickSignal,
          });
          routingRemaining -= routing.storiesConsidered;
          result.storiesRouted += routing.storiesRouted;
          result.opportunitiesCreated += routing.opportunitiesCreated;
        }

        // Sprint 62: package phase (shadow) — auto-package auto_qualified
        // opportunities of auto_package-band campaigns, then assess due
        // packages. Budget gating and lease fencing live in the service.
        let packagesRemaining = deps.policy.maxPackagesPerTick;
        for (const workspace of workspaceRows) {
          if (packagesRemaining <= 0 || tickSignal.aborted) break;
          const packages = await runPackagePipeline(deps.db, deps.llm, {
            workspaceId: workspace.id,
            limit: packagesRemaining,
            leaseMs: deps.policy.leaseMs,
            timeoutMs: deps.policy.packageTimeoutMs,
            signal: tickSignal,
          });
          packagesRemaining -=
            packages.packagesCreated + packages.packagesAssessed + packages.failures;
          result.packagesCreated += packages.packagesCreated;
          result.packagesAssessed += packages.packagesAssessed;
        }

        // Sprint 63: deliverable phase (shadow) — materialize planned slots,
        // fan out ready packages, generate due variants, sweep stale slots.
        // Deterministic parts always run; generation is budget-gated in the
        // service.
        let deliverablesRemaining = deps.policy.maxDeliverablesPerTick;
        for (const workspace of workspaceRows) {
          if (deliverablesRemaining <= 0 || tickSignal.aborted) break;
          const delivery = await runDeliverablePipeline(deps.db, deps.llm, {
            workspaceId: workspace.id,
            limit: deliverablesRemaining,
            leaseMs: deps.policy.leaseMs,
            timeoutMs: deps.policy.variantTimeoutMs,
            signal: tickSignal,
          });
          deliverablesRemaining -=
            delivery.packagesFannedOut +
            delivery.variantsGenerated +
            delivery.failures;
          result.deliverablesCreated += delivery.deliverablesCreated;
          result.variantsGenerated += delivery.variantsGenerated;
        }
        return result;
      } finally {
        tick.dispose();
        deps.shutdownSignal.removeEventListener("abort", onShutdown);
      }
    },
  );

  return leased.busy ? emptyResult(true) : leased.value;
}
