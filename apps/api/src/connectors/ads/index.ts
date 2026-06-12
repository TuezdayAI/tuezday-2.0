import type { Connection, ConnectorProvider } from "@tuezday/contracts";
import type { ConnectorFabric } from "../fabric";
import { MetaAdsAdapter } from "./meta";

/**
 * Provider-agnostic ads boundary. Tuezday owns the metric model; every ad
 * platform call from services goes through this interface so Google Ads and
 * others slot in without touching the ads domain. Read-only by design — this
 * slice reports, it never mutates campaigns.
 */
export interface AdAccountRecord {
  externalId: string;
  name: string;
  currency: string;
}

export interface AdDailyMetricRecord {
  externalCampaignId: string;
  campaignName: string;
  /** YYYY-MM-DD as the platform reports it. */
  date: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface AdsAdapter {
  listAdAccounts(): Promise<{ accounts: AdAccountRecord[] }>;
  listDailyMetrics(
    externalAccountId: string,
    since: string,
    until: string,
  ): Promise<{ metrics: AdDailyMetricRecord[]; truncated: boolean }>;
}

export function adsAdapterFor(
  fabric: ConnectorFabric,
  provider: ConnectorProvider,
  connection: Connection,
): AdsAdapter | undefined {
  if (!provider.categories?.includes("ads")) return undefined;
  if (provider.key === "meta_ads") {
    return new MetaAdsAdapter(fabric, {
      nangoConnectionId: connection.nangoConnectionId,
      integrationKey: `tuezday-${provider.key}`,
    });
  }
  // Google Ads and friends get adapters under integration expansion.
  return undefined;
}
