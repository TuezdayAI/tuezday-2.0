"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { ConnectPrompt } from "@/src/components/connect-prompt";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Button } from "@/src/components/ui/button";
import { Badge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import styles from "./insights.module.css";
import { TrendChart, CompareChart } from "@/src/components/ui/chart";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
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

// Sample shapes for the preview-value empty state (spec §5.7.3 / §6.5) —
// blurred behind the connect prompt, never shown as real data.
const SAMPLE_CHANNEL_TREND = [
  { week: "W1", impressions: 1800, engagements: 120 },
  { week: "W2", impressions: 2600, engagements: 210 },
  { week: "W3", impressions: 2300, engagements: 180 },
  { week: "W4", impressions: 3400, engagements: 290 },
  { week: "W5", impressions: 4100, engagements: 360 },
  { week: "W6", impressions: 5200, engagements: 430 },
];

const SAMPLE_CHANNEL_TOTALS = [
  { channel: "LinkedIn", published: 14 },
  { channel: "X", published: 9 },
  { channel: "Reddit", published: 5 },
  { channel: "Email", published: 11 },
];

export default function WorkspaceInsightsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
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
            <Button variant="secondary" size="compact" onClick={() => apiDownload(`/workspaces/${id}/insights?format=csv`, `workspace-insights-${id}.csv`)}>
            Export CSV
          </Button>
          </>} />

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="brain" size="sm" />
              Brain Completeness
            </span>
          }
        />
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
                  <Badge tone={doc.filled ? "approved" : "draft"}>
                    {doc.filled ? "Filled" : "Missing"}
                  </Badge>
                  <span className="meta">{doc.type}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>

      <Card style={{ marginTop: "24px" }}>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-learning" size="sm" />
              Metrics by Channel
            </span>
          }
        />
        {insights.byChannel.length === 0 ? (
          <EmptyState
            preview={
              <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 16 }}>
                <TrendChart
                  data={SAMPLE_CHANNEL_TREND}
                  xKey="week"
                  series={[
                    { key: "impressions", label: "Impressions", tone: 5 },
                    { key: "engagements", label: "Engagements", tone: 2 },
                  ]}
                  height={230}
                />
                <CompareChart
                  data={SAMPLE_CHANNEL_TOTALS}
                  xKey="channel"
                  series={[{ key: "published", label: "Published", tone: 3 }]}
                  height={230}
                />
              </div>
            }
            description={
              <div style={{ display: "flex", justifyContent: "center" }}>
                <ConnectPrompt
                  provider="linkedin"
                  promise="See your numbers — published posts, impressions, and replies by channel."
                  onConnect={() => router.push(`/workspaces/${id}/connectors`)}
                />
              </div>
            }
          />
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
      </Card>

      <Card style={{ marginTop: "24px" }}>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="campaigns" size="sm" />
              Campaigns Summary
            </span>
          }
        />
        {insights.campaigns.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            description={
              <>
                Campaign-level generation and approval stats land here.{" "}
                <Link href={`/workspaces/${id}/campaigns`}>Create a campaign</Link> to segment your
                numbers.
              </>
            }
          />
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
      </Card>
    </>
  );
}
