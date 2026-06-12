import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type {
  AdAccount,
  AdCampaign,
  AdMetricSource,
  AdsCsvImportInput,
  Campaign,
  ConnectionStatus,
} from "@tuezday/contracts";
import { CONNECTOR_PROVIDERS } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  adAccounts,
  adCampaignMetrics,
  adCampaigns,
  campaigns,
  connections,
  type AdAccountRow,
  type AdCampaignRow,
} from "../db/schema";
import type { AdDailyMetricRecord, AdsAdapter } from "../connectors/ads";

const CSV_ACCOUNT_EXTERNAL_ID = "csv";

function rowToAdAccount(row: AdAccountRow): AdAccount {
  return { ...row };
}

function rowToAdCampaign(row: AdCampaignRow): AdCampaign {
  return { ...row };
}

/** YYYY-MM-DD (UTC) — window edges only; dates are stored as reported. */
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function defaultMetricRange(): { since: string; until: string } {
  const now = new Date();
  const since = new Date(now.getTime() - 27 * 24 * 60 * 60 * 1000);
  return { since: ymd(since), until: ymd(now) };
}

export interface AdAccountWithProvider extends AdAccount {
  provider: { key: string; label: string } | null;
  connectionStatus: ConnectionStatus | null;
}

export function listAdAccounts(db: Db, workspaceId: string): AdAccountWithProvider[] {
  const rows = db
    .select()
    .from(adAccounts)
    .where(eq(adAccounts.workspaceId, workspaceId))
    .orderBy(desc(adAccounts.createdAt))
    .all();
  const connectionRows = db
    .select()
    .from(connections)
    .where(eq(connections.workspaceId, workspaceId))
    .all();
  const connectionById = new Map(connectionRows.map((c) => [c.id, c]));
  return rows.map((row) => {
    const connection = row.connectionId ? connectionById.get(row.connectionId) : undefined;
    const provider = connection
      ? CONNECTOR_PROVIDERS.find((p) => p.key === connection.providerKey)
      : undefined;
    return {
      ...rowToAdAccount(row),
      provider: provider ? { key: provider.key, label: provider.label } : null,
      connectionStatus: connection ? (connection.status as ConnectionStatus) : null,
    };
  });
}

export function getAdAccount(db: Db, workspaceId: string, accountId: string): AdAccount | undefined {
  const row = db
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.workspaceId, workspaceId), eq(adAccounts.id, accountId)))
    .get();
  return row ? rowToAdAccount(row) : undefined;
}

export interface ImportAdAccountsResult {
  accounts: AdAccount[];
  created: number;
  updated: number;
}

/** Pull the platform's ad accounts and mirror them, upserting by externalId. */
export async function importAdAccounts(
  db: Db,
  adapter: AdsAdapter,
  workspaceId: string,
  connectionId: string,
): Promise<ImportAdAccountsResult> {
  const { accounts } = await adapter.listAdAccounts();
  const existing = db
    .select()
    .from(adAccounts)
    .where(eq(adAccounts.workspaceId, workspaceId))
    .all();
  const byExternalId = new Map(existing.map((row) => [row.externalId, row]));

  const now = Date.now();
  let created = 0;
  let updated = 0;
  const imported: AdAccount[] = [];
  for (const account of accounts) {
    const row = byExternalId.get(account.externalId);
    if (!row) {
      const fresh: AdAccountRow = {
        id: randomUUID(),
        workspaceId,
        connectionId,
        externalId: account.externalId,
        name: account.name,
        currency: account.currency,
        lastSyncedAt: null,
        lastError: null,
        createdAt: now,
      };
      db.insert(adAccounts).values(fresh).run();
      imported.push(rowToAdAccount(fresh));
      created++;
      continue;
    }
    const changed = row.name !== account.name || row.currency !== account.currency;
    db.update(adAccounts)
      .set({ name: account.name, currency: account.currency, connectionId })
      .where(eq(adAccounts.id, row.id))
      .run();
    if (changed) updated++;
    imported.push(rowToAdAccount({ ...row, name: account.name, currency: account.currency, connectionId }));
  }
  return { accounts: imported, created, updated };
}

export interface AdsSyncResult {
  campaigns: number;
  rows: number;
  created: number;
  updated: number;
  truncated: boolean;
}

/**
 * Upsert one batch of daily metric records under an account. Shared by the
 * platform sync and the CSV import — the metric model is source-agnostic.
 */
function upsertMetrics(
  db: Db,
  workspaceId: string,
  adAccountId: string,
  records: AdDailyMetricRecord[],
  source: AdMetricSource,
): { campaigns: number; rows: number; created: number; updated: number } {
  const now = Date.now();
  const campaignRows = db
    .select()
    .from(adCampaigns)
    .where(eq(adCampaigns.adAccountId, adAccountId))
    .all();
  const campaignByExternalId = new Map(campaignRows.map((row) => [row.externalId, row]));

  const seenCampaigns = new Map<string, string>();
  for (const record of records) {
    if (!seenCampaigns.has(record.externalCampaignId)) {
      seenCampaigns.set(record.externalCampaignId, record.campaignName);
    }
  }
  for (const [externalId, name] of seenCampaigns) {
    const row = campaignByExternalId.get(externalId);
    if (!row) {
      const fresh: AdCampaignRow = {
        id: randomUUID(),
        workspaceId,
        adAccountId,
        externalId,
        name,
        campaignId: null,
        lastSyncedAt: now,
        createdAt: now,
      };
      db.insert(adCampaigns).values(fresh).run();
      campaignByExternalId.set(externalId, fresh);
    } else {
      db.update(adCampaigns)
        .set({ name, lastSyncedAt: now })
        .where(eq(adCampaigns.id, row.id))
        .run();
      campaignByExternalId.set(externalId, { ...row, name });
    }
  }

  const campaignIds = [...campaignByExternalId.values()].map((row) => row.id);
  const metricRows = campaignIds.length
    ? db
        .select()
        .from(adCampaignMetrics)
        .where(inArray(adCampaignMetrics.adCampaignId, campaignIds))
        .all()
    : [];
  const metricByKey = new Map(metricRows.map((row) => [`${row.adCampaignId}|${row.date}`, row]));

  let created = 0;
  let updated = 0;
  for (const record of records) {
    const campaign = campaignByExternalId.get(record.externalCampaignId)!;
    const key = `${campaign.id}|${record.date}`;
    const row = metricByKey.get(key);
    if (!row) {
      db.insert(adCampaignMetrics)
        .values({
          id: randomUUID(),
          workspaceId,
          adCampaignId: campaign.id,
          date: record.date,
          spendCents: record.spendCents,
          impressions: record.impressions,
          clicks: record.clicks,
          conversions: record.conversions,
          source,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      created++;
      continue;
    }
    const changed =
      row.spendCents !== record.spendCents ||
      row.impressions !== record.impressions ||
      row.clicks !== record.clicks ||
      row.conversions !== record.conversions;
    if (changed) {
      db.update(adCampaignMetrics)
        .set({
          spendCents: record.spendCents,
          impressions: record.impressions,
          clicks: record.clicks,
          conversions: record.conversions,
          source,
          updatedAt: now,
        })
        .where(eq(adCampaignMetrics.id, row.id))
        .run();
      updated++;
    }
  }
  return { campaigns: seenCampaigns.size, rows: records.length, created, updated };
}

/**
 * Pull daily campaign metrics for the window. Re-pulling a window is the
 * point: Meta restates conversions retroactively, so rows update in place.
 * Adapter failures record lastError on the account and rethrow.
 */
export async function syncAdAccount(
  db: Db,
  adapter: AdsAdapter,
  workspaceId: string,
  account: AdAccount,
  since: string,
  until: string,
): Promise<AdsSyncResult> {
  let pulled;
  try {
    pulled = await adapter.listDailyMetrics(account.externalId, since, until);
  } catch (err) {
    db.update(adAccounts)
      .set({ lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500) })
      .where(eq(adAccounts.id, account.id))
      .run();
    throw err;
  }
  const counts = upsertMetrics(db, workspaceId, account.id, pulled.metrics, "sync");
  db.update(adAccounts)
    .set({ lastSyncedAt: Date.now(), lastError: null })
    .where(eq(adAccounts.id, account.id))
    .run();
  return { ...counts, truncated: pulled.truncated };
}

export interface CsvImportResult {
  accountId: string;
  campaigns: number;
  rows: number;
  created: number;
  updated: number;
}

/** CSV rows land in a lazily-created CSV-only account (no connection). */
export function importAdsCsv(db: Db, workspaceId: string, input: AdsCsvImportInput): CsvImportResult {
  let account = db
    .select()
    .from(adAccounts)
    .where(
      and(eq(adAccounts.workspaceId, workspaceId), eq(adAccounts.externalId, CSV_ACCOUNT_EXTERNAL_ID)),
    )
    .get();
  if (!account) {
    const fresh: AdAccountRow = {
      id: randomUUID(),
      workspaceId,
      connectionId: null,
      externalId: CSV_ACCOUNT_EXTERNAL_ID,
      name: input.accountName ?? "CSV import",
      currency: input.currency,
      lastSyncedAt: null,
      lastError: null,
      createdAt: Date.now(),
    };
    db.insert(adAccounts).values(fresh).run();
    account = fresh;
  } else if (input.accountName && input.accountName !== account.name) {
    db.update(adAccounts).set({ name: input.accountName }).where(eq(adAccounts.id, account.id)).run();
  }

  const records: AdDailyMetricRecord[] = input.rows.map((row) => ({
    // CSV campaign identity is the campaign name.
    externalCampaignId: row.campaignName,
    campaignName: row.campaignName,
    date: row.date,
    spendCents: Math.round(row.spend * 100),
    impressions: row.impressions,
    clicks: row.clicks,
    conversions: row.conversions,
  }));
  const counts = upsertMetrics(db, workspaceId, account.id, records, "csv");
  db.update(adAccounts).set({ lastSyncedAt: Date.now() }).where(eq(adAccounts.id, account.id)).run();
  return { accountId: account.id, ...counts };
}

export interface AdsReportTotals {
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface AdsReportDay extends AdsReportTotals {
  date: string;
  source: AdMetricSource;
}

export interface AdsReportCampaign {
  adCampaign: AdCampaign & {
    account: { id: string; name: string; currency: string; connectionId: string | null };
    linkedCampaign: { id: string; name: string } | null;
  };
  totals: AdsReportTotals;
  days: AdsReportDay[];
}

export interface AdsReport {
  since: string;
  until: string;
  campaigns: AdsReportCampaign[];
}

const ZERO_TOTALS: AdsReportTotals = { spendCents: 0, impressions: 0, clicks: 0, conversions: 0 };

function addTotals(totals: AdsReportTotals, day: AdsReportTotals): AdsReportTotals {
  return {
    spendCents: totals.spendCents + day.spendCents,
    impressions: totals.impressions + day.impressions,
    clicks: totals.clicks + day.clicks,
    conversions: totals.conversions + day.conversions,
  };
}

/** Per-ad-campaign totals + daily rows for the range, sorted by spend desc. */
export function getAdsReport(db: Db, workspaceId: string, since: string, until: string): AdsReport {
  const accountRows = db.select().from(adAccounts).where(eq(adAccounts.workspaceId, workspaceId)).all();
  const accountById = new Map(accountRows.map((row) => [row.id, row]));
  const campaignRows = db
    .select()
    .from(adCampaigns)
    .where(eq(adCampaigns.workspaceId, workspaceId))
    .all();
  const linkedIds = campaignRows.map((row) => row.campaignId).filter((id): id is string => id !== null);
  const linkedRows = linkedIds.length
    ? db.select().from(campaigns).where(inArray(campaigns.id, linkedIds)).all()
    : [];
  const linkedById = new Map(linkedRows.map((row) => [row.id, row]));
  const metricRows = db
    .select()
    .from(adCampaignMetrics)
    .where(
      and(
        eq(adCampaignMetrics.workspaceId, workspaceId),
        gte(adCampaignMetrics.date, since),
        lte(adCampaignMetrics.date, until),
      ),
    )
    .orderBy(asc(adCampaignMetrics.date))
    .all();
  const daysByCampaign = new Map<string, AdsReportDay[]>();
  for (const row of metricRows) {
    const day: AdsReportDay = {
      date: row.date,
      spendCents: row.spendCents,
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      source: row.source as AdMetricSource,
    };
    const list = daysByCampaign.get(row.adCampaignId);
    if (list) list.push(day);
    else daysByCampaign.set(row.adCampaignId, [day]);
  }

  const report = campaignRows.map((row) => {
    const account = accountById.get(row.adAccountId)!;
    const linked = row.campaignId ? linkedById.get(row.campaignId) : undefined;
    const days = daysByCampaign.get(row.id) ?? [];
    return {
      adCampaign: {
        ...rowToAdCampaign(row),
        account: {
          id: account.id,
          name: account.name,
          currency: account.currency,
          connectionId: account.connectionId,
        },
        linkedCampaign: linked ? { id: linked.id, name: linked.name } : null,
      },
      totals: days.reduce(addTotals, ZERO_TOTALS),
      days,
    };
  });
  report.sort((a, b) => b.totals.spendCents - a.totals.spendCents);
  return { since, until, campaigns: report };
}

export function getAdCampaign(db: Db, workspaceId: string, adCampaignId: string): AdCampaign | undefined {
  const row = db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.workspaceId, workspaceId), eq(adCampaigns.id, adCampaignId)))
    .get();
  return row ? rowToAdCampaign(row) : undefined;
}

export function linkAdCampaign(
  db: Db,
  workspaceId: string,
  adCampaignId: string,
  campaignId: string | null,
): AdCampaign | undefined {
  db.update(adCampaigns)
    .set({ campaignId })
    .where(and(eq(adCampaigns.workspaceId, workspaceId), eq(adCampaigns.id, adCampaignId)))
    .run();
  return getAdCampaign(db, workspaceId, adCampaignId);
}

export interface CampaignAdMetrics {
  totals: AdsReportTotals;
  adCampaigns: Array<{
    id: string;
    name: string;
    accountName: string;
    currency: string;
    totals: AdsReportTotals;
  }>;
}

/** All-time paid totals for a Tuezday campaign's linked ad campaigns. */
export function getCampaignAdMetrics(db: Db, campaign: Campaign): CampaignAdMetrics | null {
  const linked = db
    .select()
    .from(adCampaigns)
    .where(
      and(eq(adCampaigns.workspaceId, campaign.workspaceId), eq(adCampaigns.campaignId, campaign.id)),
    )
    .all();
  if (linked.length === 0) return null;

  const accountRows = db
    .select()
    .from(adAccounts)
    .where(eq(adAccounts.workspaceId, campaign.workspaceId))
    .all();
  const accountById = new Map(accountRows.map((row) => [row.id, row]));
  const metricRows = db
    .select()
    .from(adCampaignMetrics)
    .where(inArray(adCampaignMetrics.adCampaignId, linked.map((row) => row.id)))
    .all();

  const byCampaign = new Map<string, AdsReportTotals>();
  for (const row of metricRows) {
    byCampaign.set(row.adCampaignId, addTotals(byCampaign.get(row.adCampaignId) ?? ZERO_TOTALS, row));
  }
  const perCampaign = linked.map((row) => {
    const account = accountById.get(row.adAccountId);
    return {
      id: row.id,
      name: row.name,
      accountName: account?.name ?? "",
      currency: account?.currency ?? "USD",
      totals: byCampaign.get(row.id) ?? ZERO_TOTALS,
    };
  });
  return {
    totals: perCampaign.reduce((acc, c) => addTotals(acc, c.totals), ZERO_TOTALS),
    adCampaigns: perCampaign,
  };
}
