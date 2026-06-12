import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type { AdAccountRecord, AdDailyMetricRecord, AdsAdapter } from "./index";

/**
 * Meta Ads (Graph API Insights) over the Nango proxy, read-only. Every call
 * pins the Graph base URL so nothing depends on the facebook template's proxy
 * config, and the version is pinned here in one place.
 */

const GRAPH_BASE = "https://graph.facebook.com";
const GRAPH_VERSION = "v23.0";
const ACCOUNT_PAGE_CAP = 4;
const INSIGHTS_PAGE_CAP = 25;

/**
 * action_types counted as conversions. These are Meta's cross-channel
 * aggregates — adding pixel/onsite sub-types (offsite_conversion.fb_pixel_*,
 * onsite_conversion.*) as well would double-count.
 */
export const DEFAULT_CONVERSION_ACTIONS = ["lead", "purchase", "complete_registration"] as const;

interface MetaAdsOpts {
  nangoConnectionId: string;
  integrationKey: string;
}

interface GraphPage<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

interface RawAccount {
  id: string;
  name?: string;
  currency?: string;
}

interface RawInsightRow {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
}

function int(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function spendToCents(spend: string | undefined): number {
  const n = Number(spend ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function conversionsFrom(actions: RawInsightRow["actions"]): number {
  let total = 0;
  for (const action of actions ?? []) {
    if ((DEFAULT_CONVERSION_ACTIONS as readonly string[]).includes(action.action_type ?? "")) {
      total += int(action.value);
    }
  }
  return total;
}

export class MetaAdsAdapter implements AdsAdapter {
  constructor(
    private readonly fabric: ConnectorFabric,
    private readonly opts: MetaAdsOpts,
  ) {}

  private async request<T>(path: string): Promise<GraphPage<T>> {
    const result = await this.fabric.proxyJson(
      "GET",
      path,
      this.opts.nangoConnectionId,
      this.opts.integrationKey,
      { baseUrlOverride: GRAPH_BASE },
    );
    if (result.status < 200 || result.status >= 300) {
      const detail = result.json !== undefined ? JSON.stringify(result.json).slice(0, 200) : "";
      throw new ConnectorFabricError(
        `Meta Ads returned ${result.status} for GET ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (result.json ?? {}) as GraphPage<T>;
  }

  /** Walks Graph cursor pagination; returns whether the cap truncated it. */
  private async pages<T>(basePath: string, cap: number): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < cap; page++) {
      const path = after ? `${basePath}&after=${encodeURIComponent(after)}` : basePath;
      const body = await this.request<T>(path);
      items.push(...(body.data ?? []));
      if (!body.paging?.next) return { items, truncated: false };
      after = body.paging.cursors?.after;
      if (!after) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  async listAdAccounts(): Promise<{ accounts: AdAccountRecord[] }> {
    const { items } = await this.pages<RawAccount>(
      `/${GRAPH_VERSION}/me/adaccounts?fields=name,currency&limit=50`,
      ACCOUNT_PAGE_CAP,
    );
    return {
      accounts: items.map((raw) => ({
        externalId: raw.id,
        name: raw.name ?? raw.id,
        currency: raw.currency ?? "USD",
      })),
    };
  }

  async listDailyMetrics(
    externalAccountId: string,
    since: string,
    until: string,
  ): Promise<{ metrics: AdDailyMetricRecord[]; truncated: boolean }> {
    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    const { items, truncated } = await this.pages<RawInsightRow>(
      `/${GRAPH_VERSION}/${externalAccountId}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions&time_increment=1&time_range=${timeRange}&limit=500`,
      INSIGHTS_PAGE_CAP,
    );
    const metrics: AdDailyMetricRecord[] = [];
    for (const raw of items) {
      if (!raw.campaign_id || !raw.date_start) continue;
      metrics.push({
        externalCampaignId: raw.campaign_id,
        campaignName: raw.campaign_name ?? raw.campaign_id,
        date: raw.date_start,
        spendCents: spendToCents(raw.spend),
        impressions: int(raw.impressions),
        clicks: int(raw.clicks),
        conversions: conversionsFrom(raw.actions),
      });
    }
    return { metrics, truncated };
  }
}
