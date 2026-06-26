// apps/api/src/analytics/posthog.ts
import type { AnalyticsEventInput, AnalyticsSink } from "./sink";

const DEFAULT_HOST = "https://us.i.posthog.com";

/**
 * PostHog via the public /capture/ REST endpoint. No SDK — one endpoint, one
 * body shape (matches GeminiGateway). Fire-and-forget; swallows every error so
 * a dead analytics endpoint can never break a request.
 */
export class PostHogSink implements AnalyticsSink {
  private readonly host: string;
  constructor(
    private readonly apiKey: string,
    host: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.host = (host ?? DEFAULT_HOST).replace(/\/$/, "");
  }

  capture(input: AnalyticsEventInput): void {
    const properties: Record<string, unknown> = { ...input.properties };
    if (input.workspaceId) properties.$groups = { workspace: input.workspaceId };
    const body = JSON.stringify({
      api_key: this.apiKey,
      event: input.event,
      distinct_id: input.distinctId,
      properties,
      timestamp: new Date().toISOString(),
    });
    void this.fetcher(`${this.host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      /* analytics must never affect the request path */
    });
  }
}
