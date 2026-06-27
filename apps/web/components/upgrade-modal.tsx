"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

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
        
        <p className="mb-6 text-gray-600">
          {details?.limit 
            ? `You have reached your limit of ${details.limit} for ${details.key}. Please upgrade to a higher plan to continue.`
            : "This action requires an upgrade to a higher plan."}
        </p>

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
