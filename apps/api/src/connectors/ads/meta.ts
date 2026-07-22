import {
  metaAdSetStateSchema,
  type AdLaunchObjective,
  type MetaAdSetState,
  type TargetingChangeIntent,
} from "@tuezday/contracts";
import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type { AdAccountRecord, AdDailyMetricRecord, AdsAdapter, AdsExecutionAdapter } from "./index";

/**
 * Meta Ads (Graph API) over the Nango proxy — Insights reads (Sprint 14) and
 * campaign execution writes (Sprint 20). Every call pins the Graph base URL
 * so nothing depends on the facebook template's proxy config, and the version
 * is pinned here in one place.
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

interface RawAdSetState {
  id?: string;
  daily_budget?: string | number;
  targeting?: {
    geo_locations?: { countries?: unknown };
    age_min?: string | number;
    age_max?: string | number;
  };
  updated_time?: string;
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

/** optimization_goal per launch objective (billing is always impressions). */
const OPTIMIZATION_GOALS: Record<AdLaunchObjective, string> = {
  OUTCOME_TRAFFIC: "LINK_CLICKS",
  OUTCOME_AWARENESS: "REACH",
};

export class MetaAdsAdapter implements AdsAdapter, AdsExecutionAdapter {
  constructor(
    private readonly fabric: ConnectorFabric,
    private readonly opts: MetaAdsOpts,
    // Used only by uploadAdImage to download a hosted image before the
    // base64 adimages POST (the Graph API takes bytes, not URLs).
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
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
    return (result.json ?? {}) as T;
  }

  private async request<T>(path: string): Promise<GraphPage<T>> {
    return this.get<GraphPage<T>>(path);
  }

  private async post<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.fabric.proxyJson(
      "POST",
      path,
      this.opts.nangoConnectionId,
      this.opts.integrationKey,
      { body, baseUrlOverride: GRAPH_BASE },
    );
    if (result.status < 200 || result.status >= 300) {
      const detail = result.json !== undefined ? JSON.stringify(result.json).slice(0, 200) : "";
      throw new ConnectorFabricError(
        `Meta Ads returned ${result.status} for POST ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (result.json ?? {}) as T;
  }

  private async createObject(path: string, body: Record<string, unknown>): Promise<{ externalId: string }> {
    const json = await this.post<{ id?: string }>(path, body);
    if (!json.id) {
      throw new ConnectorFabricError(`Meta Ads did not return an id for POST ${path.split("?")[0]}.`);
    }
    return { externalId: String(json.id) };
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

  // --- Execution (Sprint 20) ---

  async getAdSetState(
    _externalAccountId: string,
    externalAdSetId: string,
  ): Promise<MetaAdSetState> {
    const raw = await this.get<RawAdSetState>(
      `/${GRAPH_VERSION}/${encodeURIComponent(externalAdSetId)}?fields=daily_budget,targeting,updated_time`,
    );
    const dailyBudgetCents = Number(raw.daily_budget);
    const countries = raw.targeting?.geo_locations?.countries;
    const ageMin = Number(raw.targeting?.age_min);
    const ageMax = Number(raw.targeting?.age_max);
    const parsedUpdatedAt = raw.updated_time ? Date.parse(raw.updated_time) : Number.NaN;
    const parsed = metaAdSetStateSchema.safeParse({
      externalAdSetId,
      dailyBudgetCents,
      countries,
      ageMin,
      ageMax,
      updatedAt: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : null,
    });
    if (!parsed.success) {
      throw new ConnectorFabricError(
        `Meta Ads returned malformed state for ad set ${externalAdSetId}: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }

  async updateDailyBudget(
    externalAccountId: string,
    externalAdSetId: string,
    dailyBudgetCents: number,
  ): Promise<MetaAdSetState> {
    await this.post(`/${GRAPH_VERSION}/${encodeURIComponent(externalAdSetId)}`, {
      daily_budget: dailyBudgetCents,
    });
    return this.getAdSetState(externalAccountId, externalAdSetId);
  }

  async updateTargeting(
    externalAccountId: string,
    externalAdSetId: string,
    targeting: TargetingChangeIntent["after"],
  ): Promise<MetaAdSetState> {
    await this.post(`/${GRAPH_VERSION}/${encodeURIComponent(externalAdSetId)}`, {
      targeting: {
        geo_locations: { countries: targeting.countries },
        age_min: targeting.ageMin,
        age_max: targeting.ageMax,
      },
    });
    return this.getAdSetState(externalAccountId, externalAdSetId);
  }

  async createCampaign(
    externalAccountId: string,
    input: { name: string; objective: AdLaunchObjective },
  ): Promise<{ externalId: string }> {
    return this.createObject(`/${GRAPH_VERSION}/${externalAccountId}/campaigns`, {
      name: input.name,
      objective: input.objective,
      // Born PAUSED — the chain activates the campaign only once it's whole.
      status: "PAUSED",
      special_ad_categories: [],
    });
  }

  async createAdSet(
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
  ): Promise<{ externalId: string }> {
    return this.createObject(`/${GRAPH_VERSION}/${externalAccountId}/adsets`, {
      name: input.name,
      campaign_id: input.campaignExternalId,
      // Meta's daily_budget is in the account currency's minor units — cents.
      daily_budget: input.dailyBudgetCents,
      billing_event: "IMPRESSIONS",
      optimization_goal: OPTIMIZATION_GOALS[input.objective],
      targeting: {
        geo_locations: { countries: input.countries },
        age_min: input.ageMin,
        age_max: input.ageMax,
      },
      status: "ACTIVE",
      ...(input.startAt ? { start_time: new Date(input.startAt).toISOString() } : {}),
      ...(input.endAt ? { end_time: new Date(input.endAt).toISOString() } : {}),
    });
  }

  /** Upload an image to the account's ad images library -> image_hash
   * (Sprint 41 Part 5). Accepts a hosted URL (fetched here) or raw bytes. */
  async uploadAdImage(
    externalAccountId: string,
    image: { url: string } | { bytes: Uint8Array },
  ): Promise<{ imageHash: string }> {
    let bytes: Uint8Array;
    if ("bytes" in image) {
      bytes = image.bytes;
    } else {
      let res: Response;
      try {
        res = await this.fetcher(image.url);
      } catch (err) {
        throw new ConnectorFabricError(
          `Could not download the ad image from ${image.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        throw new ConnectorFabricError(
          `Could not download the ad image from ${image.url}: HTTP ${res.status}`,
        );
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    }

    const json = await this.post<{ images?: Record<string, { hash?: string }> }>(`/${GRAPH_VERSION}/${externalAccountId}/adimages`, {
      bytes: Buffer.from(bytes).toString("base64"),
    });
    const hash = Object.values(json.images ?? {})[0]?.hash;
    if (!hash) {
      throw new ConnectorFabricError("Meta Ads did not return an image hash for the adimages upload.");
    }
    return { imageHash: hash };
  }

  async createAdCreative(
    externalAccountId: string,
    input: {
      name: string;
      pageId: string;
      linkUrl: string;
      primaryText: string;
      headline: string;
      description: string;
      imageHash?: string;
    },
  ): Promise<{ externalId: string }> {
    return this.createObject(`/${GRAPH_VERSION}/${externalAccountId}/adcreatives`, {
      name: input.name,
      // Link ad; image_hash (Sprint 41) attaches the generated static image —
      // without it Meta scrapes the link preview image, exactly as before.
      object_story_spec: {
        page_id: input.pageId,
        link_data: {
          link: input.linkUrl,
          message: input.primaryText,
          name: input.headline,
          description: input.description,
          ...(input.imageHash ? { image_hash: input.imageHash } : {}),
        },
      },
    });
  }

  async createAd(
    externalAccountId: string,
    input: { name: string; adSetExternalId: string; creativeExternalId: string },
  ): Promise<{ externalId: string }> {
    return this.createObject(`/${GRAPH_VERSION}/${externalAccountId}/ads`, {
      name: input.name,
      adset_id: input.adSetExternalId,
      creative: { creative_id: input.creativeExternalId },
      status: "ACTIVE",
    });
  }

  async setCampaignStatus(campaignExternalId: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
    await this.post(`/${GRAPH_VERSION}/${campaignExternalId}`, { status });
  }

  async listCampaignStatuses(
    externalAccountId: string,
  ): Promise<Array<{ externalCampaignId: string; status: string }>> {
    const { items } = await this.pages<{ id: string; effective_status?: string }>(
      `/${GRAPH_VERSION}/${externalAccountId}/campaigns?fields=effective_status&limit=200`,
      ACCOUNT_PAGE_CAP,
    );
    return items
      .filter((raw) => raw.id)
      .map((raw) => ({ externalCampaignId: raw.id, status: raw.effective_status ?? "UNKNOWN" }));
  }
}
