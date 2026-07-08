"use client";

import { use, useEffect, useState } from "react";
import Script from "next/script";
import { apiFetch } from "@/lib/api";
import {
  buildRazorpayCheckoutOptions,
  buildRazorpayOrderRequest,
  formatRazorpayFailure,
  type RazorpayCheckoutOptions,
  type RazorpayFailureEvent,
  type RazorpayOrderResponse,
} from "@/lib/razorpay-checkout";
import { PLANS, usageMeter, type EntitlementUsage, type Entitlements, type PlanId } from "@tuezday/contracts";

interface BillingView {
  plan: PlanId;
  entitlements: Entitlements;
  usage: EntitlementUsage;
}

/** Display-only price copy; the provider checkout amount is configured separately. */
const PLAN_PRICE_COPY: Record<PlanId, string> = { free: "$0", pro: "$29.99", scale: "Custom" };
const RAZORPAY_KEY_ID = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? "";

interface RazorpayCheckoutInstance {
  open: () => void;
  on: (event: "payment.failed", handler: (response: RazorpayFailureEvent) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayCheckoutInstance;
  }
}

export default function BillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<BillingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    setNotice(null);
    try {
      if (!RAZORPAY_KEY_ID) throw new Error("Razorpay key id is not configured.");
      if (!window.Razorpay) throw new Error("Razorpay checkout is still loading. Please try again.");

      const res = await apiFetch("/api/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRazorpayOrderRequest(id, "pro")),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? "Could not create payment order.");

      const order = body as RazorpayOrderResponse;
      if (!order?.order_id || !order.amount || !order.currency) {
        throw new Error("Payment order response was incomplete.");
      }

      const checkout = new window.Razorpay(
        buildRazorpayCheckoutOptions({
          keyId: RAZORPAY_KEY_ID,
          order,
          onSuccess: async (payment) => {
            try {
              const verifyRes = await apiFetch("/api/verify-payment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payment),
              });
              const verifyBody = await verifyRes.json().catch(() => null);
              if (!verifyRes.ok) {
                throw new Error(verifyBody?.message ?? verifyBody?.error ?? "Payment verification failed.");
              }
              setNotice("Payment verified.");
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setUpgrading(false);
            }
          },
          onDismiss: () => {
            setError("Payment cancelled.");
            setUpgrading(false);
          },
        }),
      );
      checkout.on("payment.failed", (response) => {
        setError(formatRazorpayFailure(response));
        setUpgrading(false);
      });
      checkout.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUpgrading(false);
    }
  }

  return (
    <>
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        strategy="afterInteractive"
        onError={() => setError("Razorpay checkout script failed to load.")}
      />
      <div className="page-header">
        <div>
          <h1>Billing &amp; subscription</h1>
          <p className="subtitle">Your plan, and how much of it this workspace is using.</p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="meta">{notice}</p>}

      <section className="panel">
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
            <div className="usage-meters">
              <MeterRow
                title="Monthly generations"
                used={data.usage.monthlyGenerations}
                limit={data.entitlements.monthlyGenerations}
              />
              <MeterRow title="Connectors" used={data.usage.connectors} limit={data.entitlements.connectors} />
              <MeterRow title="Seats" used={data.usage.seats} limit={data.entitlements.seats} />
            </div>

            {data.plan === "free" && (
              <div className="editor-actions" style={{ marginTop: 20 }}>
                <button onClick={handleUpgrade} disabled={upgrading}>
                  {upgrading ? "Processing..." : "Pay with Razorpay"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

function MeterRow({ title, used, limit }: { title: string; used: number; limit: number }) {
  const meter = usageMeter(used, limit);
  return (
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span className="usage-meter-title">{title}</span>
        <span className="usage-meter-figure">
          {meter.state === "unlimited" ? `${used} / Unlimited` : `${used} / ${limit}`}
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${meter.state}`} style={{ width: `${meter.percent}%` }} />
      </div>
      {meter.state === "over" && <p className="usage-alert">Upgrade for more usage</p>}
    </div>
  );
}
