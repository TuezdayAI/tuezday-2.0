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
    <div className="flex flex-col flex-1 h-full overflow-auto bg-gray-50">
      <header className="flex h-14 items-center gap-4 border-b bg-white px-6">
        <h1 className="text-lg font-semibold">Billing & Plans</h1>
      </header>

      <main className="flex-1 p-6 md:p-10">
        <div className="mx-auto max-w-4xl space-y-8">
          <div className="bg-white p-6 rounded-lg shadow-sm border">
            <h2 className="text-2xl font-bold mb-4">Current Plan</h2>
            {error && <div className="text-red-500 mb-4">{error}</div>}
            
            {!data && !error && <div>Loading...</div>}

            {data && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-lg font-medium text-gray-900 capitalize">{data.plan} Plan</p>
                    {data.plan === "free" && (
                      <p className="text-sm text-gray-500 mt-1">Upgrade to Pro for more generations and features.</p>
                    )}
                  </div>
                  {data.plan === "free" && (
                    <button
                      onClick={handleUpgrade}
                      disabled={upgrading}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-md font-medium disabled:opacity-50"
                    >
                      {upgrading ? "Redirecting..." : "Upgrade to Pro"}
                    </button>
                  )}
                </div>

                <div className="border-t pt-6 mt-6">
                  <h3 className="text-lg font-semibold mb-4">Usage</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <UsageCard
                      title="Monthly Generations"
                      used={data.usage.monthlyGenerations}
                      limit={data.entitlements.monthlyGenerations}
                    />
                    <UsageCard
                      title="Connectors"
                      used={data.usage.connectors}
                      limit={data.entitlements.connectors}
                    />
                    <UsageCard
                      title="Seats"
                      used={data.usage.seats}
                      limit={data.entitlements.seats}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function UsageCard({ title, used, limit }: { title: string; used: number; limit: number }) {
  const percent = Math.min(100, Math.round((used / limit) * 100)) || 0;
  
  return (
    <div className="bg-gray-50 p-4 rounded border">
      <div className="flex justify-between items-center mb-2">
        <h4 className="font-medium text-gray-700">{title}</h4>
        <span className="text-sm font-semibold text-gray-900">
          {used} / {limit}
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div 
          className={`h-2.5 rounded-full ${percent > 90 ? 'bg-red-600' : 'bg-blue-600'}`} 
          style={{ width: `${percent}%` }}
        ></div>
      </div>
    </div>
  );
}
