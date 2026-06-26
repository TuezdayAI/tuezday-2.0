"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { OnboardingStep } from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";

interface OnboardingState {
  steps: OnboardingStep[];
  dismissed: boolean;
}

export function OnboardingChecklist({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    apiFetch(`/workspaces/${workspaceId}/onboarding`)
      .then(async (res) => {
        if (!res.ok) throw new Error("failed to fetch");
        const data = await res.json();
        if (active) setState(data);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (error || !state) return null;
  if (state.dismissed) return null;

  const allDone = state.steps.every((s) => s.done);
  if (allDone) return null;

  const handleDismiss = async () => {
    setState({ ...state, dismissed: true });
    await apiFetch(`/workspaces/${workspaceId}/onboarding/dismiss`, { method: "PUT" });
  };

  return (
    <section className="panel onboarding-panel">
      <div className="panel-title-row">
        <h2>Get set up</h2>
        <button className="button-secondary" onClick={handleDismiss}>
          Dismiss
        </button>
      </div>
      <ul className="checklist">
        {state.steps.map((step) => (
          <li key={step.key}>
            <Link className={`checklist-item ${step.done ? "done" : ""}`} href={step.cta}>
              <span className="check-dot">{step.done ? "✓" : ""}</span>
              <span>
                <span className="step-title">{step.label}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
