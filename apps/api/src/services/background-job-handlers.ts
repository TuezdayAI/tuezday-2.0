import {
  BACKGROUND_JOB_KINDS,
  BACKGROUND_RECURRING_JOB_KINDS,
  type BackgroundJobKind,
  type BackgroundJobPayload,
  type BackgroundRecurringJobKind,
} from "@tuezday/contracts";
import type { AgentProposalService } from "../agents/proposals";
import type { AgentQuestionService } from "../agents/questions";
import {
  adsAdapterFor,
  adsExecutionAdapterFor,
} from "../connectors/ads";
import {
  ConnectorFabricError,
  type ConnectorFabric,
} from "../connectors/fabric";
import type { Db } from "../db";
import type { IntentProvider } from "../discovery/intent";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import type { Mailer } from "../mail/mailer";
import type { GmailMailboxProvider } from "../outbound-email/gmail";
import type { BackgroundJobPolicy } from "../runtime/background-job-policy";
import type { DiscoveryOperatorPolicy } from "../runtime/operator-policy";
import type { SafeFetchService } from "../safe-fetch";
import { syncLaunchStatuses } from "./ad-launches";
import {
  defaultMetricRange,
  listAdAccounts,
  syncAdAccount,
} from "./ads";
import { runAutomationWithLease } from "./automation";
import type { BackgroundJobClaim } from "./background-jobs";
import { fillActiveCadences } from "./cadences";
import { getConnection, providerByKey } from "./connections";
import {
  runDiscoveryScheduler,
  type DiscoveryOperatorEvent,
} from "./discovery-scheduler";
import { llmBudgetExhausted } from "./entitlements";
import { emitEvent } from "./events";
import type { ExternalActionRuntime } from "./external-action-coordinator";
import { sweepEvidenceCandidates } from "./evidence";
import { runInbox } from "./inbox";
import { resumeLaunchGeneration } from "./launches";
import { runSequences } from "./launch-sequences";
import {
  NothingToLearnError,
  listSyntheses,
  synthesizeNow,
} from "./learning";
import { runMailboxInbox } from "./mailbox-inbox";
import { runOutreach } from "./outreach-engine";
import { runPipelinesTick } from "./pipeline-tick";
import { runPreferenceExtraction } from "./preference-extraction";
import { runDuePublications } from "./publications";
import { getWorkspace } from "./workspaces";

export type BackgroundJobOutcome =
  | { status: "complete"; result?: unknown }
  | { status: "retry"; error: string; availableAt?: number }
  | { status: "dead_letter"; error: string };

export interface BackgroundJobHandlerContext {
  claim: BackgroundJobClaim;
  signal: AbortSignal;
  heartbeat: () => boolean;
}

export type BackgroundJobHandler = (
  payload: BackgroundJobPayload,
  context: BackgroundJobHandlerContext,
) => Promise<BackgroundJobOutcome>;

export type BackgroundJobHandlers = Record<
  BackgroundJobKind,
  BackgroundJobHandler
>;

export type BackgroundJobOperation = (
  workspaceId: string,
  context: BackgroundJobHandlerContext,
) => Promise<unknown>;

export type BackgroundJobOperations = Record<
  BackgroundRecurringJobKind,
  BackgroundJobOperation
>;

export interface BackgroundJobHandlerDependencies {
  db: Db;
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
  proposals?: AgentProposalService;
  questions?: AgentQuestionService;
  intentProvider: IntentProvider;
  fabric: ConnectorFabric;
  gmail: GmailMailboxProvider;
  mailer: Mailer;
  fetcher: typeof fetch;
  runtime: ExternalActionRuntime;
  discoveryPolicy: DiscoveryOperatorPolicy;
  jobPolicy: BackgroundJobPolicy;
  instanceId: string;
  log: (event: DiscoveryOperatorEvent) => void;
}

/**
 * Validate the registry at the composition root so a newly added public job
 * kind can never be silently ignored by an older API process.
 */
export function defineBackgroundJobHandlers(
  handlers: BackgroundJobHandlers,
): BackgroundJobHandlers {
  const keys = Object.keys(handlers);
  for (const kind of BACKGROUND_JOB_KINDS) {
    if (typeof handlers[kind] !== "function") {
      throw new Error(`Missing background job handler: ${kind}`);
    }
  }
  for (const key of keys) {
    if (!BACKGROUND_JOB_KINDS.includes(key as BackgroundJobKind)) {
      throw new Error(`Unknown background job handler: ${key}`);
    }
  }
  return handlers;
}

/** Safe default used until the domain registry is injected by the app. */
export function unavailableBackgroundJobHandlers(): BackgroundJobHandlers {
  const handlers = {} as BackgroundJobHandlers;
  for (const kind of BACKGROUND_JOB_KINDS) {
    handlers[kind] = async () => ({
      status: "retry",
      error: `background_job_handler_unavailable:${kind}`,
    });
  }
  return defineBackgroundJobHandlers(handlers);
}

/**
 * Adapt tenant-scoped domain operations to the queue protocol. Keeping this
 * seam tiny makes the workspace boundary explicit and independently testable.
 */
export function createBackgroundJobHandlersFromOperations(
  operations: BackgroundJobOperations,
  launchGenerate: BackgroundJobHandler =
    unavailableBackgroundJobHandlers().launch_generate,
): BackgroundJobHandlers {
  const handlers = { launch_generate: launchGenerate } as BackgroundJobHandlers;
  for (const kind of BACKGROUND_RECURRING_JOB_KINDS) {
    handlers[kind] = async (payload, context) => ({
      status: "complete",
      result: await operations[kind](payload.workspaceId, context),
    });
  }
  return defineBackgroundJobHandlers(handlers);
}

async function syncWorkspaceAds(
  deps: BackgroundJobHandlerDependencies,
  workspaceId: string,
) {
  const range = defaultMetricRange();
  const results: Array<{
    accountId: string;
    name: string;
    ok: boolean;
    error?: string;
    rows?: number;
    created?: number;
    updated?: number;
    truncated?: boolean;
  }> = [];

  for (const account of listAdAccounts(deps.db, workspaceId)) {
    if (!account.connectionId) continue;
    const connection = getConnection(deps.db, workspaceId, account.connectionId);
    const provider = connection ? providerByKey(connection.providerKey) : undefined;
    const adapter =
      connection && provider
        ? adsAdapterFor(deps.fabric, provider, connection)
        : undefined;
    if (!connection || !provider || !adapter || connection.status !== "connected") {
      results.push({
        accountId: account.id,
        name: account.name,
        ok: false,
        error: "ads_connection_unavailable",
      });
      continue;
    }

    try {
      const result = await syncAdAccount(
        deps.db,
        adapter,
        workspaceId,
        account,
        range.since,
        range.until,
      );
      const execution = adsExecutionAdapterFor(deps.fabric, provider, connection);
      if (execution) {
        try {
          await syncLaunchStatuses(
            deps.db,
            execution,
            workspaceId,
            account.id,
            account.externalId,
          );
        } catch {
          // Metrics are authoritative for this job; status refresh is best effort.
        }
      }
      if (result.created + result.updated > 0) {
        await emitEvent(deps.db, deps.fetcher, workspaceId, "ads.synced", {
          adAccountId: account.id,
          externalId: account.externalId,
          since: range.since,
          until: range.until,
          ...result,
        });
      }
      results.push({
        accountId: account.id,
        name: account.name,
        ok: true,
        ...result,
      });
    } catch (error) {
      if (!(error instanceof ConnectorFabricError)) throw error;
      results.push({
        accountId: account.id,
        name: account.name,
        ok: false,
        error: error.message,
      });
    }
  }

  return { ...range, results };
}

async function synthesizeWorkspaceLearning(
  deps: BackgroundJobHandlerDependencies,
  workspaceId: string,
) {
  if (llmBudgetExhausted(deps.db, workspaceId)) {
    return { skipped: "llm_budget_exhausted" };
  }
  const syntheses = listSyntheses(deps.db, workspaceId);
  if (syntheses.some((synthesis) => synthesis.status === "proposed")) {
    return { skipped: "proposal_open" };
  }
  const newest = syntheses[0];
  if (
    newest &&
    Date.now() - newest.createdAt < deps.jobPolicy.intervals.learning
  ) {
    return { skipped: "not_due" };
  }
  const workspace = getWorkspace(deps.db, workspaceId);
  if (!workspace) return { skipped: "workspace_missing" };
  try {
    return await synthesizeNow(deps.db, deps.llm, workspaceId, workspace.name);
  } catch (error) {
    if (error instanceof NothingToLearnError) {
      return { skipped: "nothing_to_learn" };
    }
    throw error;
  }
}

/** Compose all thirteen production operations at the API boundary. */
export function createBackgroundJobHandlers(
  deps: BackgroundJobHandlerDependencies,
  launchGenerate?: BackgroundJobHandler,
): BackgroundJobHandlers {
  const operations: BackgroundJobOperations = {
    discovery: (workspaceId, context) =>
      runDiscoveryScheduler(
        {
          db: deps.db,
          llm: deps.llm,
          safeFetch: deps.safeFetch,
          intentProvider: deps.intentProvider,
          fabric: deps.fabric,
          policy: deps.discoveryPolicy,
          instanceId: deps.instanceId,
          shutdownSignal: context.signal,
          log: deps.log,
        },
        { workspaceId },
      ),
    automation: (workspaceId, context) =>
      runAutomationWithLease(
        {
          db: deps.db,
          llm: deps.llm,
          evidence: deps.evidence,
          leaseMs: deps.jobPolicy.leaseMs,
          heartbeatMs: deps.jobPolicy.heartbeatMs,
        },
        workspaceId,
        `${deps.instanceId}:background-automation:${context.claim.id}`,
      ),
    pipelines: (workspaceId) =>
      runPipelinesTick(
        deps.db,
        {
          llm: deps.llm,
          evidence: deps.evidence,
          safeFetch: deps.safeFetch,
          ...(deps.proposals ? { proposals: deps.proposals } : {}),
          ...(deps.questions ? { questions: deps.questions } : {}),
        },
        { workspaceId },
      ),
    preferences: (workspaceId) =>
      runPreferenceExtraction(deps.db, deps.llm, workspaceId),
    learning: (workspaceId) => synthesizeWorkspaceLearning(deps, workspaceId),
    ads: (workspaceId) => syncWorkspaceAds(deps, workspaceId),
    cadence: (workspaceId) =>
      fillActiveCadences(deps.db, deps.runtime, workspaceId, Date.now()),
    publish: async (workspaceId) => ({
      actions: await deps.runtime.run(workspaceId),
      results: await runDuePublications(
        deps.db,
        deps.fabric,
        deps.fetcher,
        workspaceId,
      ),
    }),
    inbox: (workspaceId) =>
      runInbox(
        deps.db,
        deps.llm,
        deps.evidence,
        deps.fabric,
        deps.runtime,
        workspaceId,
      ),
    mailbox_inbox: (workspaceId) =>
      runMailboxInbox(deps.db, deps.llm, deps.gmail, workspaceId),
    outreach: (workspaceId) =>
      runOutreach(
        deps.db,
        {
          llm: deps.llm,
          evidence: deps.evidence,
          runtime: deps.runtime,
          fabric: deps.fabric,
          mailer: deps.mailer,
          fetcher: deps.fetcher,
        },
        workspaceId,
      ),
    sequence: (workspaceId) =>
      runSequences(
        deps.db,
        deps.llm,
        deps.evidence,
        deps.runtime,
        workspaceId,
      ),
    evidence: async (workspaceId) =>
      sweepEvidenceCandidates(deps.db, workspaceId),
  };
  const launchGenerateHandler: BackgroundJobHandler = launchGenerate ?? (async (payload, context) => {
    if (payload.kind !== "launch_generate") {
      return { status: "dead_letter", error: "invalid_launch_generation_payload" };
    }
    const result = await resumeLaunchGeneration(
      deps.db,
      deps.llm,
      deps.evidence,
      payload.workspaceId,
      payload.launchId,
      payload.input,
      payload.actor,
      { signal: context.signal, heartbeat: context.heartbeat },
    );
    return result.ok
      ? {
          status: "complete",
          result: {
            launchId: result.detail.launch.id,
            status: result.detail.launch.status,
            messageCount: result.detail.launch.messageCount,
          },
        }
      : { status: "dead_letter", error: result.error };
  });
  return createBackgroundJobHandlersFromOperations(operations, launchGenerateHandler);
}
