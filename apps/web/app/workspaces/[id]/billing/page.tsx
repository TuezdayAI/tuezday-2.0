"use client";

import { use, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { PLANS, usageMeter, type EntitlementUsage, type Entitlements, type PlanId } from "@tuezday/contracts";
import { Card } from "@/src/components/ui/card";
import { Meter } from "@/src/components/ui/meter";

interface BillingView {
  plan: PlanId;
  entitlements: Entitlements;
  usage: EntitlementUsage;
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
      <div className="page-header">
        <div>
          <h1>Billing &amp; subscription</h1>
          <p className="subtitle">Your plan, and how much of it this workspace is using.</p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <Card>
        <h2>Current plan</h2>
        {!data ? (
          <p className="meta">Loading...</p>
        ) : (
          <>
            <div className="plan-hero">
              <div>
                <div className="plan-hero-name">
                  {PLANS[data.plan].label} Plan
                  <span className="layer-badge state-approved">Active</span>
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

            <h3 className="usage-heading">Usage</h3>
            <MeterRow
              title="Monthly generations"
              used={data.usage.monthlyGenerations}
              limit={data.entitlements.monthlyGenerations}
            />
            <MeterRow title="Connectors" used={data.usage.connectors} limit={data.entitlements.connectors} />
            <MeterRow title="Seats" used={data.usage.seats} limit={data.entitlements.seats} />

            {data.plan === "free" && (
              <div className="editor-actions" style={{ marginTop: 20 }}>
                <button onClick={handleUpgrade} disabled={upgrading}>
                  {upgrading ? "Redirecting..." : "Upgrade to Pro"}
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function MeterRow({ title, used, limit }: { title: string; used: number; limit: number }) {
  const meter = usageMeter(used, limit);
  const figure = meter.state === "unlimited" ? `${used} / Unlimited` : `${used} / ${limit}`;
  return (
    <div style={{ marginBottom: 16 }}>
      <Meter label={title} figure={figure} percent={meter.percent} state={meter.state} />
      {meter.state === "over" && <p className="usage-alert">Upgrade for more usage</p>}
    </div>
  );
}
