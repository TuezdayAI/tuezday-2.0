import { randomUUID } from "node:crypto";
import { backgroundJobPayloadSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import type { BackgroundJobPolicy } from "../runtime/background-job-policy";
import type {
  BackgroundJobHandlerContext,
  BackgroundJobHandlers,
  BackgroundJobOutcome,
} from "./background-job-handlers";
import {
  claimBackgroundJobs,
  completeBackgroundJob,
  deadLetterBackgroundJob,
  heartbeatBackgroundJob,
  retryBackgroundJob,
  type BackgroundJobClaim,
} from "./background-jobs";
import {
  admitDueBackgroundSchedules,
  reconcileBackgroundSchedules,
} from "./background-schedules";
import { withTaskLease } from "./task-leases";

export interface BackgroundJobRunnerDependencies {
  db: Db;
  handlers: BackgroundJobHandlers;
  policy: BackgroundJobPolicy;
  instanceId: string;
  shutdownSignal: AbortSignal;
}

export interface BackgroundJobTickResult {
  busy: boolean;
  reconciled: number;
  admitted: number;
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  lost: number;
}

type ExecutionResult = Pick<
  BackgroundJobTickResult,
  "succeeded" | "retried" | "deadLettered" | "lost"
>;

const EMPTY_EXECUTION_RESULT: ExecutionResult = {
  succeeded: 0,
  retried: 0,
  deadLettered: 0,
  lost: 0,
};

function mergeSignals(
  first: AbortSignal,
  second: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const onFirst = () => abort(first);
  const onSecond = () => abort(second);
  first.addEventListener("abort", onFirst, { once: true });
  second.addEventListener("abort", onSecond, { once: true });
  if (first.aborted) abort(first);
  if (second.aborted) abort(second);
  return {
    signal: controller.signal,
    cleanup: () => {
      first.removeEventListener("abort", onFirst);
      second.removeEventListener("abort", onSecond);
    },
  };
}

async function transitionOutcome(
  deps: BackgroundJobRunnerDependencies,
  claim: BackgroundJobClaim,
  outcome: BackgroundJobOutcome,
): Promise<ExecutionResult> {
  if (outcome.status === "complete") {
    return await completeBackgroundJob(deps.db, claim, outcome.result)
      ? { ...EMPTY_EXECUTION_RESULT, succeeded: 1 }
      : { ...EMPTY_EXECUTION_RESULT, lost: 1 };
  }
  if (outcome.status === "dead_letter") {
    return await deadLetterBackgroundJob(deps.db, claim, outcome.error)
      ? { ...EMPTY_EXECUTION_RESULT, deadLettered: 1 }
      : { ...EMPTY_EXECUTION_RESULT, lost: 1 };
  }
  const row = await retryBackgroundJob(deps.db, claim, outcome.error, {
    baseBackoffMs: deps.policy.baseBackoffMs,
    maxBackoffMs: deps.policy.maxBackoffMs,
    availableAt: outcome.availableAt,
  });
  if (!row) return { ...EMPTY_EXECUTION_RESULT, lost: 1 };
  return row.status === "dead_letter"
    ? { ...EMPTY_EXECUTION_RESULT, deadLettered: 1 }
    : { ...EMPTY_EXECUTION_RESULT, retried: 1 };
}

async function executeClaim(
  deps: BackgroundJobRunnerDependencies,
  initialClaim: BackgroundJobClaim,
): Promise<ExecutionResult> {
  let claim = initialClaim;
  let payload;
  try {
    payload = backgroundJobPayloadSchema.parse(JSON.parse(claim.payloadJson));
  } catch (error) {
    return await deadLetterBackgroundJob(deps.db, claim, error)
      ? { ...EMPTY_EXECUTION_RESULT, deadLettered: 1 }
      : { ...EMPTY_EXECUTION_RESULT, lost: 1 };
  }

  const leaseLost = new AbortController();
  const combined = mergeSignals(deps.shutdownSignal, leaseLost.signal);
  let stopped = false;
  const heartbeat = async (): Promise<boolean> => {
    if (stopped || combined.signal.aborted) return false;
    const renewed = await heartbeatBackgroundJob(deps.db, claim, deps.policy.leaseMs);
    if (!renewed) {
      leaseLost.abort(new Error("background_job_lease_lost"));
      return false;
    }
    claim = renewed;
    return true;
  };
  const heartbeatTimer = setInterval(heartbeat, deps.policy.heartbeatMs);

  try {
    if (combined.signal.aborted) {
      return { ...EMPTY_EXECUTION_RESULT, lost: 1 };
    }
    const context: BackgroundJobHandlerContext = {
      claim,
      signal: combined.signal,
      heartbeat,
    };
    const outcome = await deps.handlers[payload.kind](payload, context);
    if (combined.signal.aborted) {
      return { ...EMPTY_EXECUTION_RESULT, lost: 1 };
    }
    return await transitionOutcome(deps, claim, outcome);
  } catch (error) {
    if (combined.signal.aborted) {
      return { ...EMPTY_EXECUTION_RESULT, lost: 1 };
    }
    return await transitionOutcome(deps, claim, {
      status: "retry",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    stopped = true;
    clearInterval(heartbeatTimer);
    combined.cleanup();
  }
}

export async function runBackgroundJobTick(
  deps: BackgroundJobRunnerDependencies,
): Promise<BackgroundJobTickResult> {
  const dispatch = await withTaskLease(
    deps.db,
    {
      key: "background-jobs:dispatcher",
      owner: `${deps.instanceId}:background-dispatcher:${randomUUID()}`,
      leaseMs: deps.policy.leaseMs,
      heartbeatMs: deps.policy.heartbeatMs,
    },
    async () => {
      const reconciled = await reconcileBackgroundSchedules(deps.db, deps.policy);
      const admission = await admitDueBackgroundSchedules(
        deps.db,
        undefined,
        deps.policy.maxAttempts,
      );
      const claims = await claimBackgroundJobs(deps.db, {
        owner: `${deps.instanceId}:background-job:${randomUUID()}`,
        leaseMs: deps.policy.leaseMs,
        limit: deps.policy.batchSize,
        perWorkspaceLimit: deps.policy.perWorkspaceConcurrency,
      });
      return { reconciled, admitted: admission.admitted, claims };
    },
  );

  if (dispatch.busy) {
    return {
      busy: true,
      reconciled: 0,
      admitted: 0,
      claimed: 0,
      ...EMPTY_EXECUTION_RESULT,
    };
  }

  const executions = await Promise.all(
    dispatch.value.claims.map(async (claim) => executeClaim(deps, claim)),
  );
  const totals = executions.reduce<ExecutionResult>(
    (sum, result) => ({
      succeeded: sum.succeeded + result.succeeded,
      retried: sum.retried + result.retried,
      deadLettered: sum.deadLettered + result.deadLettered,
      lost: sum.lost + result.lost,
    }),
    { ...EMPTY_EXECUTION_RESULT },
  );
  return {
    busy: false,
    reconciled: dispatch.value.reconciled,
    admitted: dispatch.value.admitted,
    claimed: dispatch.value.claims.length,
    ...totals,
  };
}
