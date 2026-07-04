"use client";

import { use, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export default function BillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
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
        setError(String(err));
      }
    }
    void fetchBilling();
  }, [id]);

  const handleUpgrade = async () => {
    try {
      setUpgrading(true);
      const res = await apiFetch(`/workspaces/${id}/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      });
      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.message || resData.error || "Checkout failed");
      }
      if (resData.url) {
        window.location.href = resData.url;
      }
    } catch (err) {
      alert(String(err));
      setUpgrading(false);
    }
  };

  return (
    <div className="ws-content">
      <header className="page-header">
        <h1>Billing & Plans</h1>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "800px" }}>
        {error && <div className="error">{error}</div>}
        
        {!data && !error && <div className="empty">Loading...</div>}

        {data && (
          <>
            <div className="billing-card">
              <div className="billing-kicker">Current Plan</div>
              <div className="billing-plan-row">
                <div>
                  <h2 className="billing-plan-name">{data.plan} Plan</h2>
                  {data.plan === "free" && (
                    <p className="billing-plan-hint">Upgrade to Pro for more generations and features.</p>
                  )}
                </div>
                {data.plan === "free" && (
                  <button
                    onClick={handleUpgrade}
                    disabled={upgrading}
                    className="billing-button"
                  >
                    {upgrading ? "Redirecting..." : "Upgrade to Pro"}
                  </button>
                )}
              </div>
            </div>

            <div className="billing-card">
              <div className="billing-kicker">Usage</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                <UsageRow
                  title="Monthly Generations"
                  used={data.usage.monthlyGenerations}
                  limit={data.entitlements.monthlyGenerations}
                />
                <UsageRow
                  title="Connectors"
                  used={data.usage.connectors}
                  limit={data.entitlements.connectors}
                />
                <UsageRow
                  title="Seats"
                  used={data.usage.seats}
                  limit={data.entitlements.seats}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function UsageRow({ title, used, limit }: { title: string; used: number; limit: number }) {
  const isUnlimited = limit === -1;
  const percent = isUnlimited ? 0 : Math.min(100, Math.round((used / limit) * 100)) || 0;
  const overLimit = !isUnlimited && used >= limit;
  
  return (
    <div className="billing-usage-row">
      <div className="billing-usage-header">
        <span className="billing-usage-label">{title}</span>
        {isUnlimited ? (
          <span className="billing-usage-unlimited">Unlimited</span>
        ) : (
          <span className="billing-usage-count">
            {used} / {limit}
          </span>
        )}
      </div>
      
      {!isUnlimited && (
        <>
          <div className="billing-usage-bar-track">
            <div 
              className={`billing-usage-bar-fill ${overLimit ? 'over-limit' : ''}`} 
              style={{ width: `${percent}%` }}
            ></div>
          </div>
          {overLimit && (
            <div className="billing-upgrade-flash">
              Upgrade for more usages.
            </div>
          )}
        </>
      )}
    </div>
  );
}
