// apps/api/src/analytics/track.ts
import type { Db } from "../db";
import { getAnalyticsOptOut } from "../services/workspaces";
import type { AnalyticsEventInput, AnalyticsSink } from "./sink";

/**
 * The single entry point routes use to record a product event. Honors the
 * workspace opt-out (workspace-scoped events only), then hands to the
 * fire-and-forget sink. Wrapped so neither the lookup nor the sink can break a
 * request.
 */
export function track(db: Db, sink: AnalyticsSink, input: AnalyticsEventInput): void {
  try {
    if (input.workspaceId && getAnalyticsOptOut(db, input.workspaceId)) return;
    sink.capture(input);
  } catch {
    /* analytics is best-effort */
  }
}
