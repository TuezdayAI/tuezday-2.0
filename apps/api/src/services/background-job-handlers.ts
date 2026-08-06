import {
  BACKGROUND_JOB_KINDS,
  type BackgroundJobKind,
  type BackgroundJobPayload,
} from "@tuezday/contracts";
import type { BackgroundJobClaim } from "./background-jobs";

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
