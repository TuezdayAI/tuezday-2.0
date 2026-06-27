"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";


import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type {
  AutomationCampaignResult,
  SocialAutomationSettings,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";

export default function AutomationPage() {
  const { id } = useParams<{ id: string }>();
  const [settings, setSettings] = useState<SocialAutomationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<AutomationCampaignResult[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${id}/automation/settings`);
      if (!res.ok) throw new Error("not found");
      setSettings(await res.json());
      setError(null);
    } catch {
      setError(`Could not load automation settings from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Partial<SocialAutomationSettings>) {
    const res = await apiFetch(`/workspaces/${id}/automation/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) setSettings(await res.json());
  }

  async function runNow() {
    setRunning(true);
    try {
      const res = await apiFetch(`/workspaces/${id}/automation/run`, { method: "POST" });
      const body = await res.json();
      setLastRun(body.results ?? []);
    } finally {
      setRunning(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!settings) return <EmptyState description="Loading…" />;

  return (
    <>
      <PageHeader title="Automation" subtitle={<>Guardrails for campaigns set to <strong>scheduled-auto</strong>. New discovery signals
            draft to each campaign channel; human-in-the-loop waits at Review, scheduled-auto
            auto-approves and posts on the campaign cadence — within these limits.</>} actions={<>
            <button onClick={runNow} disabled={running}>
            {running ? "Running…" : "Run automation now"}
          </button>
          </>} />

      <section className="panel">
        <h2>Kill switch</h2>
        <p className="subtitle">
          The hard stop. When on, no campaign auto-posts and pending auto-slots are cleared on the
          next cadence run. Manual publishing and human-approved cadences keep working.
        </p>
        <label className="checkbox-label" style={{ fontSize: "1rem" }}>
          <input
            type="checkbox"
            checked={settings.killSwitch}
            onChange={(e) => patch({ killSwitch: e.target.checked })}
          />
          {settings.killSwitch ? "Auto-posting is STOPPED" : "Auto-posting is allowed"}
        </label>
      </section>

      <section className="panel">
        <h2>Auto-reply</h2>
        <p className="subtitle">
          When on, inbox replies on <strong>scheduled-auto</strong> campaigns are auto-approved and
          posted automatically — within the kill switch and per-connection cap. When off (the
          default), every reply waits for your approval on Review, whatever the campaign's mode.
        </p>
        <label className="checkbox-label" style={{ fontSize: "1rem" }}>
          <input
            type="checkbox"
            checked={settings.autoReplyEnabled}
            onChange={(e) => patch({ autoReplyEnabled: e.target.checked })}
          />
          {settings.autoReplyEnabled ? "Replies on auto campaigns post automatically" : "All replies wait for approval"}
        </label>
      </section>

      <section className="panel">
        <h2>Daily caps</h2>
        <p className="subtitle">
          Maximum auto-posts per UTC day. The per-connection cap protects an account's posting
          limit; the per-campaign cap is the default a campaign can override on its card.
        </p>
        <div className="resolve-controls">
          <label style={{ flex: 1 }}>
            Per connection / day
            <input
              type="number"
              min={1}
              max={1000}
              defaultValue={settings.perConnectionDailyCap}
              onBlur={(e) => {
                const v = Math.max(1, Math.min(1000, Number(e.target.value)));
                if (v !== settings.perConnectionDailyCap) void patch({ perConnectionDailyCap: v });
              }}
            />
          </label>
          <label style={{ flex: 1 }}>
            Per campaign / day (default)
            <input
              type="number"
              min={1}
              max={1000}
              defaultValue={settings.perCampaignDailyCap}
              onBlur={(e) => {
                const v = Math.max(1, Math.min(1000, Number(e.target.value)));
                if (v !== settings.perCampaignDailyCap) void patch({ perCampaignDailyCap: v });
              }}
            />
          </label>
        </div>
      </section>

      {lastRun && (
        <section className="panel">
          <h2>Last run</h2>
          {lastRun.length === 0 ? (
            <EmptyState description={<>No campaigns are in an automated mode yet.</>} />
          ) : (
            <ul className="draft-chain">
              {lastRun.map((r) => (
                <li key={r.campaignId}>
                  <span className="meta">
                    <strong>{r.campaignName}</strong> ({r.mode}) — {r.generated} generated,{" "}
                    {r.autoApproved} auto-approved
                    {r.skipped ? `, ${r.skipped} skipped` : ""}
                    {r.blocked ? ` — blocked: ${r.blocked}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
