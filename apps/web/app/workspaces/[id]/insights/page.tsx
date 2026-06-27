"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";


import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiFetch, apiDownload } from "@/lib/api";
import type { WorkspaceInsights } from "@tuezday/contracts";
import Link from "next/link";

function money(cents: number, currency: string = "USD"): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export default function WorkspaceInsightsPage() {
  const { id } = useParams<{ id: string }>();
  const [insights, setInsights] = useState<WorkspaceInsights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/workspaces/${id}/insights`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load insights");
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setInsights(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!insights) return <EmptyState description={<>Loading insights…</>} />;

  return (
    <>
      <PageHeader title="Workspace Insights" subtitle={<>Aggregate metrics and brain completeness across your workspace.</>} actions={<>
            <button onClick={() => apiDownload(`/workspaces/${id}/insights?format=csv`, `workspace-insights-${id}.csv`)}>
            Export CSV
          </button>
          </>} />

      <section className="panel">
        <h2>Brain Completeness</h2>
        <div className="automation-row" style={{ display: "flex", gap: "20px", flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
          <div style={{ flex: 1, minWidth: "200px" }}>
            <div style={{ fontSize: "2.5rem", fontWeight: "bold", color: "var(--brand)" }}>
              {Math.round(insights.brain.completenessPct)}%
            </div>
            <p className="meta">Overall completeness score</p>
          </div>
          <div style={{ flex: 2 }}>
            <ul className="draft-chain">
              <li>
                <span className="meta">Personas: {insights.brain.personaCount} defined</span>
              </li>
              <li>
                <span className="meta">Active Overlays: {insights.brain.overlayCount}</span>
              </li>
              <li>
                <span className="meta">Campaigns: {insights.brain.campaignCount} active</span>
              </li>
              <li>
                <span className="meta">Total Generations: {insights.brain.generationsTotal}</span>
              </li>
            </ul>
          </div>
          <div style={{ flex: 2 }}>
            <ul className="draft-chain">
              {insights.brain.docs.map((doc) => (
                <li key={doc.type}>
                  <span className={`layer-badge ${doc.filled ? "state-approved" : "state-draft"}`}>
                    {doc.filled ? "Filled" : "Missing"}
                  </span>
                  <span className="meta">{doc.type}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginTop: "24px" }}>
        <h2>Metrics by Channel</h2>
        {insights.byChannel.length === 0 ? (
          <EmptyState description={<>No channel metrics available.</>} />
        ) : (
          <table className="data-table" style={{ width: "100%", textAlign: "left" }}>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Published</th>
                <th>Sent</th>
                <th>Replied</th>
                <th>Impressions</th>
                <th>Ad Spend</th>
              </tr>
            </thead>
            <tbody>
              {insights.byChannel.map((ch) => (
                <tr key={ch.channel}>
                  <td style={{ textTransform: "capitalize" }}>{ch.channel.replace(/_/g, " ")}</td>
                  <td>{ch.published}</td>
                  <td>{ch.sent}</td>
                  <td>{ch.replied}</td>
                  <td>{ch.impressions.toLocaleString()}</td>
                  <td>{money(ch.spendCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" style={{ marginTop: "24px" }}>
        <h2>Campaigns Summary</h2>
        {insights.campaigns.length === 0 ? (
          <EmptyState description={<>No campaigns available.</>} />
        ) : (
          <table className="data-table" style={{ width: "100%", textAlign: "left" }}>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Published</th>
                <th>Sent</th>
                <th>Approval Rate</th>
                <th>Ad Spend</th>
              </tr>
            </thead>
            <tbody>
              {insights.campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/workspaces/${id}/campaigns`}>{c.name}</Link>
                  </td>
                  <td>
                    <span className={`layer-badge ${c.status === "active" ? "state-approved" : ""}`}>
                      {c.status}
                    </span>
                  </td>
                  <td>{c.publishedCount}</td>
                  <td>{c.sentCount}</td>
                  <td>{Math.round(c.approvalRate * 100)}%</td>
                  <td>{money(c.spendCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
