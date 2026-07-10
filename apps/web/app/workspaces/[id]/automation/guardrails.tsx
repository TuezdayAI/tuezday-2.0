"use client";
// Shared automation guardrail settings (spec §3.2). Rendered framed (Cards) on
// the /automation route and plain (hairline sections) inside the Campaigns
// settings modal. Every field hits the real /automation/settings endpoint and
// applies immediately — there is no separate pending state to save.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SocialAutomationSettings } from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";
import { EmptyState } from "@/src/components/empty-state";
import { Card } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { Icon, type IconName } from "@/src/components/ui/icon";
import styles from "./automation.module.css";

interface AutomationGuardrailsProps {
  workspaceId: string;
  /** Card framing on the /automation route; plain sections inside the modal. */
  framed?: boolean;
}

export function AutomationGuardrails({ workspaceId, framed = false }: AutomationGuardrailsProps) {
  const [settings, setSettings] = useState<SocialAutomationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/automation/settings`);
      if (!res.ok) throw new Error("not found");
      setSettings(await res.json());
      setError(null);
    } catch {
      setError(`Could not load automation settings from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Partial<SocialAutomationSettings>) {
    const res = await apiFetch(`/workspaces/${workspaceId}/automation/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) setSettings(await res.json());
  }

  if (error) return <p className="error">{error}</p>;
  if (!settings) return <EmptyState description="Loading…" />;
  const loaded = settings;

  function section(icon: IconName, title: string, children: ReactNode) {
    const head = (
      <h2 className={styles.head}>
        <Icon name={icon} size="sm" /> {title}
      </h2>
    );
    return framed ? (
      <Card>
        {head}
        {children}
      </Card>
    ) : (
      <section className={styles.plain}>
        {head}
        {children}
      </section>
    );
  }

  return (
    <>
      {section(
        "warning",
        "Kill switch",
        <>
          <p className="subtitle">
            The hard stop. When on, no campaign auto-posts and pending auto-slots are cleared on
            the next cadence run. Manual publishing and human-approved cadences keep working.
          </p>
          <label className="checkbox-label" style={{ fontSize: "1rem" }}>
            <input
              type="checkbox"
              checked={loaded.killSwitch}
              onChange={(e) => patch({ killSwitch: e.target.checked })}
            />
            {loaded.killSwitch ? "Auto-posting is STOPPED" : "Auto-posting is allowed"}
          </label>
        </>,
      )}

      {section(
        "email",
        "Auto-reply",
        <>
          <p className="subtitle">
            When on, inbox replies on <strong>scheduled-auto</strong> campaigns are auto-approved
            and posted automatically — within the kill switch and per-connection cap. When off
            (the default), every reply waits for your approval on Review, whatever the campaign's
            mode.
          </p>
          <label className="checkbox-label" style={{ fontSize: "1rem" }}>
            <input
              type="checkbox"
              checked={loaded.autoReplyEnabled}
              onChange={(e) => patch({ autoReplyEnabled: e.target.checked })}
            />
            {loaded.autoReplyEnabled
              ? "Replies on auto campaigns post automatically"
              : "All replies wait for approval"}
          </label>
        </>,
      )}

      {section(
        "calendar",
        "Daily caps",
        <>
          <p className="subtitle">
            Maximum auto-posts per UTC day. The per-connection cap protects an account's posting
            limit; the per-campaign cap is the default a campaign can override on its card.
          </p>
          <div className="resolve-controls">
            <label style={{ flex: 1 }}>
              Per connection / day
              <Input
                type="number"
                min={1}
                max={1000}
                defaultValue={loaded.perConnectionDailyCap}
                onBlur={(e) => {
                  const v = Math.max(1, Math.min(1000, Number(e.target.value)));
                  if (v !== loaded.perConnectionDailyCap) void patch({ perConnectionDailyCap: v });
                }}
              />
            </label>
            <label style={{ flex: 1 }}>
              Per campaign / day (default)
              <Input
                type="number"
                min={1}
                max={1000}
                defaultValue={loaded.perCampaignDailyCap}
                onBlur={(e) => {
                  const v = Math.max(1, Math.min(1000, Number(e.target.value)));
                  if (v !== loaded.perCampaignDailyCap) void patch({ perCampaignDailyCap: v });
                }}
              />
            </label>
          </div>
        </>,
      )}

      {section(
        "doc-icp",
        "Match threshold",
        <>
          <p className="subtitle">
            Minimum persona×campaign match score (0–100) a signal needs before automation drafts
            for that campaign. Lower it to let weaker matches through; raise it so only strong
            fits generate.
          </p>
          <div className="resolve-controls">
            <label style={{ flex: 1 }}>
              Match threshold (0–100)
              <Input
                type="number"
                min={0}
                max={100}
                defaultValue={loaded.matchThreshold}
                onBlur={(e) => {
                  const v = Math.max(0, Math.min(100, Number(e.target.value)));
                  if (v !== loaded.matchThreshold) void patch({ matchThreshold: v });
                }}
              />
            </label>
          </div>
        </>,
      )}
    </>
  );
}
