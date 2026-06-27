// apps/api/src/analytics/sink.ts
// Provider-agnostic product-analytics boundary. Routes depend only on this
// (via track.ts). Mirrors the LLM gateway seam.
import type { AnalyticsEvent } from "@tuezday/contracts";
import { PostHogSink } from "./posthog";

export interface AnalyticsEventInput {
  event: AnalyticsEvent;
  /** Real user id (actor.userId). Required — the system actor is never tracked. */
  distinctId: string;
  /** Workspace for opt-out + grouping; omit for user-lifecycle events. */
  workspaceId?: string;
  /** Non-PII properties only (ids, enums, counts). */
  properties?: Record<string, string | number | boolean | null>;
}

export interface AnalyticsSink {
  /** Fire-and-forget. MUST NOT throw and MUST NOT block the request. */
  capture(input: AnalyticsEventInput): void;
}

export class NoopSink implements AnalyticsSink {
  capture(): void {
    /* intentionally does nothing */
  }
}

/** PostHog when a key is present, else Noop. */
export function createAnalyticsSink(fetcher: typeof fetch = fetch): AnalyticsSink {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return new NoopSink();
  return new PostHogSink(apiKey, process.env.POSTHOG_HOST, fetcher);
}
