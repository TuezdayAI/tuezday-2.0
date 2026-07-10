"use client";

import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Icon } from "@/src/components/ui/icon";
import { TopBarActions } from "@/src/components/top-bar";
import { AutomationGuardrails } from "./guardrails";
import styles from "./automation.module.css";

import { useState } from "react";
import { useParams } from "next/navigation";
import type { AutomationCampaignResult } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";

export default function AutomationPage() {
  const { id } = useParams<{ id: string }>();
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<AutomationCampaignResult[] | null>(null);

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

  return (
    <>
      <TopBarActions>
        <Button variant="primary" size="sm" onClick={runNow} disabled={running}>
          <Icon name="status-generating" size="sm" /> {running ? "Running…" : "Run automation now"}
        </Button>
      </TopBarActions>

      <div className="page-header">
        <div>
          <h1>Automation</h1>
          <p className="subtitle">
            Guardrails for campaigns set to <strong>scheduled-auto</strong>. New discovery signals
            draft to each campaign channel; human-in-the-loop waits at Review, scheduled-auto
            auto-approves and posts on the campaign cadence — within these limits.
          </p>
        </div>
      </div>

      <AutomationGuardrails workspaceId={id} framed />

      {lastRun && (
        <Card>
          <h2 className={styles.head}>
            <Icon name="info" size="sm" /> Last run
          </h2>
          {lastRun.length === 0 ? (
            <EmptyState
              icon={<Icon name="status-generating" size="lg" />}
              title="No automated campaigns yet"
              description={
                <>
                  Switch a campaign to <strong>human-in-the-loop</strong> or{" "}
                  <strong>scheduled-auto</strong> on its card, and the next run will draft for it.
                </>
              }
            />
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
        </Card>
      )}
    </>
  );
}
