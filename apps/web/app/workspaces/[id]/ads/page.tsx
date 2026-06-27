"use client";

import { EmptyState } from "@/src/components/empty-state";


import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  AdAccount,
  AdCampaign,
  AdMetricSource,
  Campaign,
  Connection,
  ConnectorProvider,
  Workspace,
} from "@tuezday/contracts";

interface ConnectorsView {
  providers: ConnectorProvider[];
  connections: Connection[];
  fabric: { healthy: boolean; detail?: string };
}

interface AccountView extends AdAccount {
  provider: { key: string; label: string } | null;
  connectionStatus: string | null;
}

interface Totals {
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

interface ReportDay extends Totals {
  date: string;
  source: AdMetricSource;
}

interface ReportCampaign {
  adCampaign: AdCampaign & {
    account: { id: string; name: string; currency: string; connectionId: string | null };
    linkedCampaign: { id: string; name: string } | null;
  };
  totals: Totals;
  days: ReportDay[];
}

interface Report {
  since: string;
  until: string;
  campaigns: ReportCampaign[];
}

interface CsvRow {
  date: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultRange(): { since: string; until: string } {
  const now = new Date();
  return { since: ymd(new Date(now.getTime() - 27 * 24 * 60 * 60 * 1000)), until: ymd(now) };
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

const CSV_COLUMNS = ["date", "campaign", "spend", "impressions", "clicks", "conversions"] as const;

/** Parse `date,campaign,spend,impressions,clicks,conversions` (header required,
 * any column order). Returns rows or a message describing what is wrong. */
function parseCsv(text: string): { rows: CsvRow[] } | { error: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return { error: "Paste a header line plus at least one data row." };
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const indices: Record<string, number> = {};
  for (const column of CSV_COLUMNS) {
    const at = header.indexOf(column);
    if (at === -1) return { error: `Missing "${column}" column. Expected: ${CSV_COLUMNS.join(",")}` };
    indices[column] = at;
  }
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(",").map((c) => c.trim());
    const date = cells[indices.date!] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { error: `Row ${i}: date "${date}" is not YYYY-MM-DD.` };
    }
    const campaignName = cells[indices.campaign!] ?? "";
    if (!campaignName) return { error: `Row ${i}: campaign name is empty.` };
    const numbers: Record<string, number> = {};
    for (const column of ["spend", "impressions", "clicks", "conversions"] as const) {
      const value = Number(cells[indices[column]!] || 0);
      if (!Number.isFinite(value) || value < 0) {
        return { error: `Row ${i}: ${column} "${cells[indices[column]!]}" is not a number.` };
      }
      numbers[column] = value;
    }
    rows.push({
      date,
      campaignName,
      spend: numbers.spend!,
      impressions: Math.round(numbers.impressions!),
      clicks: Math.round(numbers.clicks!),
      conversions: Math.round(numbers.conversions!),
    });
  }
  return { rows };
}

export default function AdsPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [connectionId, setConnectionId] = useState("");
  const [range, setRange] = useState(defaultRange);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const [csvText, setCsvText] = useState("");
  const [csvName, setCsvName] = useState("");
  const [csvCurrency, setCsvCurrency] = useState("USD");
  const [csvNote, setCsvNote] = useState<string | null>(null);

  const loadReport = useCallback(
    async (since: string, until: string) => {
      const res = await apiFetch(`/workspaces/${id}/ads/report?since=${since}&until=${until}`,
      );
      if (res.ok) setReport(await res.json());
    },
    [id],
  );

  const load = useCallback(async () => {
    try {
      const [wsRes, cRes, aRes, cpRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/connectors`),
        apiFetch(`/workspaces/${id}/ads/accounts`),
        apiFetch(`/workspaces/${id}/campaigns`),
      ]);
      if (!wsRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setView(await cRes.json());
      setAccounts(await aRes.json());
      setCampaignsList(await cpRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadReport(range.since, range.until);
  }, [loadReport, range]);

  const adsConnections = useMemo(() => {
    if (!view) return [];
    const adsProviderKeys = new Set(
      view.providers.filter((p) => p.categories?.includes("ads")).map((p) => p.key),
    );
    return view.connections.filter(
      (c) => adsProviderKeys.has(c.providerKey) && c.status === "connected",
    );
  }, [view]);

  const activeConnectionId = connectionId || adsConnections[0]?.id || "";

  function providerLabel(providerKey: string): string {
    return view?.providers.find((p) => p.key === providerKey)?.label ?? providerKey;
  }

  async function post(path: string, payload?: Record<string, unknown>) {
    const res = await apiFetch(`/workspaces/${id}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
    return body;
  }

  async function importAccounts() {
    setBusy(true);
    setError(null);
    try {
      const result = await post("/ads/accounts/import", { connectionId: activeConnectionId });
      setSyncNote(`${result.created} account(s) imported.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function syncAccount(account: AccountView) {
    setBusy(true);
    setError(null);
    setSyncNote(null);
    try {
      const result = await post(`/ads/accounts/${account.id}/sync`, {
        since: range.since,
        until: range.until,
      });
      setSyncNote(
        `${account.name}: ${result.rows} daily rows across ${result.campaigns} campaigns (${result.created} new, ${result.updated} updated)` +
          (result.truncated ? " — capped; narrow the date range to get the rest" : ""),
      );
      await load();
      await loadReport(range.since, range.until);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function linkCampaign(reportRow: ReportCampaign, campaignId: string) {
    setBusy(true);
    setError(null);
    try {
      await post(`/ads/campaigns/${reportRow.adCampaign.id}/link`, {
        campaignId: campaignId || null,
      });
      await loadReport(range.since, range.until);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Link failed");
    } finally {
      setBusy(false);
    }
  }

  async function importCsv() {
    setCsvNote(null);
    setError(null);
    const parsed = parseCsv(csvText);
    if ("error" in parsed) {
      setCsvNote(parsed.error);
      return;
    }
    setBusy(true);
    try {
      const result = await post("/ads/import-csv", {
        rows: parsed.rows,
        ...(csvName.trim() ? { accountName: csvName.trim() } : {}),
        currency: csvCurrency.trim() || "USD",
      });
      setCsvNote(
        `Imported ${result.rows} rows across ${result.campaigns} campaigns (${result.created} new, ${result.updated} updated).`,
      );
      setCsvText("");
      await load();
      await loadReport(range.since, range.until);
    } catch (err) {
      setCsvNote(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace || !view) return <EmptyState description="Loading…" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Ads</h1>
          <p className="subtitle">
            What paid spend is doing, in Tuezday&apos;s own metric model. Read-only — campaigns are
            managed on the platform.
          </p>
        </div>
      </div>

      {!view.fabric.healthy && accounts.length === 0 && (
        <p className="error">
          Connector service offline: {view.fabric.detail ?? "Nango is not reachable."} CSV import
          below still works.
        </p>
      )}

      <section className="panel">
        <div className="panel-title-row">
          <h2>Ad accounts</h2>
        </div>
        {adsConnections.length === 0 ? (
          <EmptyState description={<>No ad platform connected yet.{" "}
            <Link href={`/workspaces/${id}/connectors`}>Connect Meta Ads on the integrations page</Link>{" "}
            — or use the CSV import below without connecting anything.</>} />
        ) : (
          <div className="resolve-controls">
            <label>
              Connection
              <select value={activeConnectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {adsConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {providerLabel(c.providerKey)}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy || !activeConnectionId} onClick={importAccounts}>
              {busy ? "Working…" : "Import ad accounts"}
            </button>
          </div>
        )}
        {syncNote && <p className="section-reason">{syncNote}</p>}
        {error && <p className="error">{error}</p>}
        {accounts.length > 0 && (
          <ul className="section-list">
            {accounts.map((account) => (
              <li key={account.id} className="section-card">
                <div className="section-head">
                  <span className="section-title">
                    {account.name} <span className="meta">({account.currency})</span>
                  </span>
                  <span className="layer-badge">
                    {account.connectionId ? (account.provider?.label ?? "connected") : "CSV import"}
                  </span>
                  {account.lastSyncedAt && (
                    <span className="section-tokens">
                      synced {new Date(account.lastSyncedAt).toLocaleString()}
                    </span>
                  )}
                  {account.connectionId && (
                    <button
                      className="button-secondary"
                      disabled={busy || account.connectionStatus !== "connected"}
                      onClick={() => syncAccount(account)}
                    >
                      Sync now
                    </button>
                  )}
                </div>
                {account.lastError && <p className="error">{account.lastError}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Campaign performance</h2>
        </div>
        <div className="resolve-controls">
          <label>
            From
            <input
              type="date"
              value={range.since}
              onChange={(e) => setRange((r) => ({ ...r, since: e.target.value }))}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={range.until}
              onChange={(e) => setRange((r) => ({ ...r, until: e.target.value }))}
            />
          </label>
        </div>
        {!report || report.campaigns.length === 0 ? (
          <EmptyState description={<>No metrics in this range yet. Sync an account above or import a CSV below.</>} />
        ) : (
          <ul className="section-list">
            {report.campaigns.map((row) => {
              const currency = row.adCampaign.account.currency;
              const { spendCents, impressions, clicks, conversions } = row.totals;
              const ctr = impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) + "%" : "—";
              const cpc = clicks > 0 ? money(Math.round(spendCents / clicks), currency) : "—";
              const costPerConversion =
                conversions > 0 ? money(Math.round(spendCents / conversions), currency) : "—";
              return (
                <li key={row.adCampaign.id} className="section-card">
                  <div className="section-head">
                    <span className="section-title">{row.adCampaign.name}</span>
                    <span className="meta">{row.adCampaign.account.name}</span>
                    {row.days.some((d) => d.source === "csv") && (
                      <span className="layer-badge">csv</span>
                    )}
                    <label className="meta" style={{ marginLeft: "auto" }}>
                      Campaign{" "}
                      <select
                        value={row.adCampaign.linkedCampaign?.id ?? ""}
                        disabled={busy}
                        onChange={(e) => linkCampaign(row, e.target.value)}
                      >
                        <option value="">— not linked —</option>
                        {campaignsList.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p className="section-reason">
                    {money(spendCents, currency)} spend · {impressions.toLocaleString()} impressions
                    · {clicks.toLocaleString()} clicks · CTR {ctr} · CPC {cpc} · {conversions}{" "}
                    conversions · cost/conv {costPerConversion}
                  </p>
                  <details>
                    <summary className="meta">Daily breakdown ({row.days.length} days)</summary>
                    <ul className="draft-chain">
                      {row.days.map((day) => (
                        <li key={day.date}>
                          <span className="meta">{day.date}</span> —{" "}
                          {money(day.spendCents, currency)} · {day.impressions.toLocaleString()}{" "}
                          imp · {day.clicks} clicks · {day.conversions} conv
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>CSV import</h2>
        <p className="meta">
          Header: <code>{CSV_COLUMNS.join(",")}</code> — one row per campaign per day; spend in
          currency units (12.34). Re-importing the same rows updates them in place.
        </p>
        <div className="resolve-controls">
          <label>
            Account label
            <input
              value={csvName}
              onChange={(e) => setCsvName(e.target.value)}
              placeholder="CSV import"
            />
          </label>
          <label>
            Currency
            <input
              value={csvCurrency}
              onChange={(e) => setCsvCurrency(e.target.value)}
              maxLength={3}
              style={{ width: 70 }}
            />
          </label>
        </div>
        <textarea
          rows={6}
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder={`date,campaign,spend,impressions,clicks,conversions\n2026-06-01,Launch,12.34,4000,85,6`}
        />
        <div className="editor-actions">
          <button disabled={busy || !csvText.trim()} onClick={importCsv}>
            Import rows
          </button>
        </div>
        {csvNote && <p className="section-reason">{csvNote}</p>}
      </section>
    </>
  );
}
