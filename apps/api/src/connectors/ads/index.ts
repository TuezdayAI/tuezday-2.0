import type { AdLaunchObjective, Connection, ConnectorProvider } from "@tuezday/contracts";
import type { ConnectorFabric } from "../fabric";
import { MetaAdsAdapter } from "./meta";

/**
 * Provider-agnostic ads boundary. Tuezday owns the metric model; every ad
 * platform call from services goes through this interface so Google Ads and
 * others slot in without touching the ads domain. Reporting (`AdsAdapter`,
 * Sprint 14) stays read-only; execution (`AdsExecutionAdapter`, Sprint 20) is
 * a separate capability the same provider adapter may implement.
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

/**
 * The write boundary money flows through. Object creation is step-by-step so
 * the service can persist each external id as it lands — a failed launch
 * resumes from where it stopped instead of duplicating platform objects.
 */
export interface AdsExecutionAdapter {
  /** Create the campaign shell PAUSED — a partial chain must never spend. */
  createCampaign(
    externalAccountId: string,
    input: { name: string; objective: AdLaunchObjective },
  ): Promise<{ externalId: string }>;
  createAdSet(
    externalAccountId: string,
    input: {
      campaignExternalId: string;
      name: string;
      objective: AdLaunchObjective;
      dailyBudgetCents: number;
      countries: string[];
      ageMin: number;
      ageMax: number;
      startAt?: number | null;
      endAt?: number | null;
    },
  ): Promise<{ externalId: string }>;
  createAdCreative(
    externalAccountId: string,
    input: {
      name: string;
      pageId: string;
      linkUrl: string;
      primaryText: string;
      headline: string;
      description: string;
    },
  ): Promise<{ externalId: string }>;
  createAd(
    externalAccountId: string,
    input: { name: string; adSetExternalId: string; creativeExternalId: string },
  ): Promise<{ externalId: string }>;
  setCampaignStatus(campaignExternalId: string, status: "ACTIVE" | "PAUSED"): Promise<void>;
  listCampaignStatuses(
    externalAccountId: string,
  ): Promise<Array<{ externalCampaignId: string; status: string }>>;
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

export function adsExecutionAdapterFor(
  fabric: ConnectorFabric,
  provider: ConnectorProvider,
  connection: Connection,
): AdsExecutionAdapter | undefined {
  if (!provider.categories?.includes("ads")) return undefined;
  if (provider.key === "meta_ads") {
    return new MetaAdsAdapter(fabric, {
      nangoConnectionId: connection.nangoConnectionId,
      integrationKey: `tuezday-${provider.key}`,
    });
  }
  return undefined;
}
