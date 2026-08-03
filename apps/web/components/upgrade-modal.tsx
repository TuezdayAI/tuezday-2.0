"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

/** Human copy per entitlement key; the wire key is an internal identifier. */
const LIMIT_LABELS: Record<string, string> = {
  seats: "team seats",
  connectors: "connectors",
  monthlyLlmCents: "monthly AI budget",
};

function limitMessage(details: { key?: string; limit?: number } | null): string {
  if (!details?.limit) return "This action requires an upgrade to a higher plan.";
  const label = LIMIT_LABELS[details.key ?? ""] ?? details.key;
  const amount =
    details.key === "monthlyLlmCents" ? `$${(details.limit / 100).toFixed(2)}` : `${details.limit}`;
  return `You have reached your ${label} limit (${amount}). Please upgrade to a higher plan to continue.`;
}

export function UpgradeModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [details, setDetails] = useState<any>(null);
  const { id: workspaceId } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    const handleUpgradeRequired = (e: Event) => {
      const event = e as CustomEvent;
      setDetails(event.detail);
      setIsOpen(true);
    };

    window.addEventListener("upgrade_required", handleUpgradeRequired);
    return () => window.removeEventListener("upgrade_required", handleUpgradeRequired);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-xl font-bold mb-4">Upgrade Required</h2>
        
        <p className="mb-6 text-gray-600">{limitMessage(details)}</p>

        <div className="flex justify-end gap-3">
          <button 
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
            onClick={() => setIsOpen(false)}
          >
            Cancel
          </button>
          
          <button
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
            onClick={() => {
              setIsOpen(false);
              if (workspaceId) {
                router.push(`/workspaces/${workspaceId}/billing`);
              }
            }}
          >
            View Plans
          </button>
        </div>
      </div>
    </div>
  );
}
