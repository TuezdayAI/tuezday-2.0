"use client";

import { use, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  PLANS,
  usageMeter,
  type EntitlementUsage,
  type Entitlements,
  type PlanId,
  type WorkspaceSpend,
} from "@tuezday/contracts";
import { formatCost, formatTokens } from "@/lib/agent-inspector";
import { EmptyState } from "@/src/components/empty-state";
import { TopBarActions } from "@/src/components/top-bar";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Icon } from "@/src/components/ui/icon";
import { Meter } from "@/src/components/ui/meter";
import styles from "./billing.module.css";

interface BillingView {
  plan: PlanId;
  entitlements: Entitlements;
  usage: EntitlementUsage;
  spend: WorkspaceSpend;
}

/** "$0.13" for cents values, "Unlimited" for -1. */
function dollars(cents: number): string {
  if (cents === -1) return "Unlimited";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Human labels for pipeline slugs, e.g. "signal_matching" -> "Signal matching". */
function pipelineLabel(pipeline: string): string {
  const label = pipeline.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Display-only price copy; the checkout price always comes from Stripe. */
const PLAN_PRICE_COPY: Record<PlanId, string> = { free: "$0", pro: "$29.99", scale: "Custom" };

export default function BillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<BillingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  useEffect(() => {
    async function fetchBilling() {
      try {
        const res = await apiFetch(`/workspaces/${id}/billing`);
        if (!res.ok) {
          setError(`Failed to load billing info: ${res.status}`);
          return;
        }
        setData(await res.json());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    void fetchBilling();
  }, [id]);

  async function handleUpgrade() {
    setUpgrading(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? "Checkout failed");
      if (body?.url) {
        window.location.href = body.url;
        return;
      }
      throw new Error("Checkout did not return a redirect URL.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUpgrading(false);
    }
  }

  return (
    <>
      {data?.plan === "free" && (
        <TopBarActions>
          <Button variant="primary" size="compact" onClick={handleUpgrade} disabled={upgrading}>
            {upgrading ? "Redirecting…" : "Upgrade to Pro"}
          </Button>
        </TopBarActions>
      )}

      <div className="page-header">
        <div>
          <h1>Billing &amp; subscription</h1>
          <p className="subtitle">Your plan, and how much of it this workspace is using.</p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <Card>
        <div className={styles.sectionHead}>
          <Icon name="doc-history" size="compact" className={styles.sectionIcon} />
          <h2>Current plan</h2>
        </div>
        {!data ? (
          <EmptyState description="Loading your plan and usage…" />
        ) : (
          <>
            <div className="plan-hero">
              <div>
                <div className="plan-hero-name">
                  {PLANS[data.plan].label} Plan
                  <Badge tone="approved">Active</Badge>
                </div>
                {data.plan === "free" && (
                  <p className="meta">Upgrade to Pro for more generations and features.</p>
                )}
              </div>
              <div className="plan-hero-price">
                <div className="plan-hero-amount">{PLAN_PRICE_COPY[data.plan]}</div>
                <p className="meta">Per month</p>
              </div>
            </div>

            <div className={styles.usageHead}>
              <Icon name="status-learning" size="compact" className={styles.sectionIcon} />
              <h3>Usage</h3>
            </div>
            <MeterRow
              title="AI usage (rolling 30 days)"
              used={data.spend.spentCents}
              limit={data.spend.budgetCents}
              format={dollars}
            />
            {data.spend.state === "near" && (
              <p className="usage-alert">
                You have used over 80% of this month&apos;s AI budget. Generation pauses at the cap.
              </p>
            )}
            <MeterRow title="Connectors" used={data.usage.connectors} limit={data.entitlements.connectors} />
            <MeterRow title="Seats" used={data.usage.seats} limit={data.entitlements.seats} />

            {data.plan === "free" && (
              <div className={styles.upgradeRow}>
                <Button variant="primary" onClick={handleUpgrade} disabled={upgrading}>
                  {upgrading ? "Redirecting…" : "Upgrade to Pro"}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {data && (
        <Card>
          <div className={styles.sectionHead}>
            <Icon name="status-learning" size="compact" className={styles.sectionIcon} />
            <h2>AI spend by pipeline</h2>
          </div>
          <p className="meta">
            {data.spend.cacheHitRate === null
              ? "No model calls in this window yet."
              : `Prompt cache hit rate: ${Math.round(data.spend.cacheHitRate * 100)}% of input tokens served from cache.`}
          </p>
          {data.spend.byPipeline.length === 0 ? (
            <EmptyState description="Spend appears here after the first model call." />
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Pipeline</th>
                  <th style={{ textAlign: "right" }}>Calls</th>
                  <th style={{ textAlign: "right" }}>Input tokens</th>
                  <th style={{ textAlign: "right" }}>Cached</th>
                  <th style={{ textAlign: "right" }}>Output tokens</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.spend.byPipeline.map((row) => (
                  <tr key={row.pipeline}>
                    <td>{pipelineLabel(row.pipeline)}</td>
                    <td style={{ textAlign: "right" }}>{row.calls}</td>
                    <td style={{ textAlign: "right" }}>{formatTokens(row.inputTokens)}</td>
                    <td style={{ textAlign: "right" }}>{formatTokens(row.cachedTokens)}</td>
                    <td style={{ textAlign: "right" }}>{formatTokens(row.outputTokens)}</td>
                    <td style={{ textAlign: "right" }}>{formatCost(row.costCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

function MeterRow({
  title,
  used,
  limit,
  format,
}: {
  title: string;
  used: number;
  limit: number;
  format?: (value: number) => string;
}) {
  const meter = usageMeter(used, limit);
  const fmt = format ?? String;
  const figure = meter.state === "unlimited" ? `${fmt(used)} / Unlimited` : `${fmt(used)} / ${fmt(limit)}`;
  return (
    <div className={styles.meterRow}>
      <Meter label={title} figure={figure} percent={meter.percent} state={meter.state} />
      {meter.state === "over" && <p className="usage-alert">Upgrade for more usage</p>}
    </div>
  );
}
