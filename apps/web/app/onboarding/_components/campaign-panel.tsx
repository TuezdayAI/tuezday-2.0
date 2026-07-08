"use client";

import { useState } from "react";
import {
  CHANNELS,
  CHANNEL_LABELS,
  ONBOARDING_FREQUENCIES,
  ONBOARDING_FREQUENCY_LABELS,
  onboardingQuickCampaign,
  type Channel,
  type OnboardingFrequency,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import type { WizardPanelProps } from "./types";
import "./campaign-panel.css";

/**
 * Onboarding Step 6 (Sprint 36.6): the lightweight 3-field campaign quick
 * form — goal, channels, posting frequency — mapped by the pure contracts
 * helper onto the existing campaign input and POSTed to the existing
 * campaigns endpoint. Explicitly NOT a campaign wizard: everything else
 * takes the schema's defaults, and the full editor lives at /campaigns.
 */
export function CampaignPanel({
  workspaceId,
  userName,
  onContinue,
  onError,
  campaignId,
  onCampaignCreated,
  workspaceName,
}: WizardPanelProps) {
  const [goal, setGoal] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [frequency, setFrequency] = useState<OnboardingFrequency>("3x_week");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const heading = `One campaign to start${userName ? `, ${userName}` : ""}`;
  const safeWorkspaceName = workspaceName?.trim() || "My workspace";
  const derivedName = `${safeWorkspaceName} launch`;

  function toggleChannel(channel: Channel) {
    setChannels((prev) =>
      prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel],
    );
  }

  async function reAdvance() {
    setBusy(true);
    onError(null);
    try {
      await onContinue();
    } finally {
      setBusy(false);
    }
  }

  async function createAndContinue() {
    setBusy(true);
    onError(null);
    try {
      const payload = onboardingQuickCampaign({
        workspaceName: safeWorkspaceName,
        goal,
        channels,
        frequency,
        name: name.trim() || undefined,
      });
      const res = await apiFetch(`/workspaces/${workspaceId}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        onError(body?.message ?? "Could not create the campaign");
        return;
      }
      onCampaignCreated?.(body.id);
      await onContinue();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // Came back to this step after creating: never create a duplicate — the
  // campaign already exists, so Continue just re-advances the cursor.
  if (campaignId) {
    return (
      <section className="panel ob-panel">
        <h1>{heading}</h1>
        <p className="cp-created" role="status">
          <span className="cp-created-dot" aria-hidden="true" />
          Campaign created — you can refine it any time in Campaigns.
        </p>
        <div className="ob-actions">
          <span />
          <button type="button" disabled={busy} onClick={reAdvance}>
            {busy ? "Continuing…" : "Continue"}
          </button>
        </div>
      </section>
    );
  }

  const canSubmit = goal.trim().length > 0 && channels.length > 0;

  return (
    <section className="panel ob-panel">
      <h1>{heading}</h1>
      <p className="subtitle">
        What&apos;s this push for? You can refine everything later in Campaigns.
      </p>

      <label className="cp-field">
        <span>Goal</span>
        <textarea
          className="ob-input cp-goal"
          value={goal}
          rows={3}
          maxLength={2000}
          placeholder="Launch our new feature to platform teams"
          onChange={(e) => setGoal(e.target.value)}
          autoFocus
        />
      </label>

      <fieldset className="cp-group">
        <legend>Channels</legend>
        <div className="cp-chips">
          {CHANNELS.map((channel) => {
            const selected = channels.includes(channel);
            return (
              <button
                key={channel}
                type="button"
                className={`cp-chip ${selected ? "selected" : ""}`}
                aria-pressed={selected}
                onClick={() => toggleChannel(channel)}
              >
                {CHANNEL_LABELS[channel]}
              </button>
            );
          })}
        </div>
        <span className="cp-hint">Pick at least one.</span>
      </fieldset>

      <fieldset className="cp-group">
        <legend>Posting frequency</legend>
        <div className="cp-segmented" role="radiogroup" aria-label="Posting frequency">
          {ONBOARDING_FREQUENCIES.map((freq) => (
            <button
              key={freq}
              type="button"
              role="radio"
              aria-checked={frequency === freq}
              className={`cp-segment ${frequency === freq ? "selected" : ""}`}
              onClick={() => setFrequency(freq)}
            >
              {ONBOARDING_FREQUENCY_LABELS[freq]}
            </button>
          ))}
        </div>
      </fieldset>

      <details className="cp-details">
        <summary>Campaign name</summary>
        <input
          className="ob-input"
          value={name}
          maxLength={200}
          placeholder={derivedName}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="cp-hint">
          Leave blank to call it &ldquo;{derivedName}&rdquo;.
        </span>
      </details>

      <div className="ob-actions">
        <span />
        <button type="button" disabled={busy || !canSubmit} onClick={createAndContinue}>
          {busy ? "Creating…" : "Create campaign & continue"}
        </button>
      </div>
    </section>
  );
}
