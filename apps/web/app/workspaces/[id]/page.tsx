"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  Campaign,
  Draft,
  Generation,
  NowSynthesis,
  Persona,
  Workspace,
} from "@tuezday/contracts";
import type { BrainScore } from "@tuezday/brain";
import { API_URL, apiFetch } from "@/lib/api";
import { EmptyState } from "@/src/components/empty-state";
import { PageHeader } from "@/src/components/page-header";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Button } from "@/src/components/ui/button";
import buttonStyles from "@/src/components/ui/button.module.css";

interface BrainView {
  completeness: BrainScore;
}

interface HomeData {
  workspace: Workspace;
  brain: BrainView;
  personas: Persona[];
  generations: Generation[];
  drafts: Draft[];
  newSignals: number;
  syntheses: NowSynthesis[];
  campaigns: Campaign[];
}

const STATE_LABEL: Record<string, string> = {
  draft: "draft",
  pending_review: "waiting for review",
  approved: "approved",
  rejected: "rejected",
  edited: "edited",
};

export default function WorkspaceHomePage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ws, brain, personas, generations, drafts, signals, syntheses, campaigns] =
        await Promise.all([
          apiFetch(`/workspaces/${id}`),
          apiFetch(`/workspaces/${id}/brain`),
          apiFetch(`/workspaces/${id}/personas`),
          apiFetch(`/workspaces/${id}/generations`),
          apiFetch(`/workspaces/${id}/drafts`),
          apiFetch(`/workspaces/${id}/discovery/items?status=new`),
          apiFetch(`/workspaces/${id}/learning/syntheses`),
          apiFetch(`/workspaces/${id}/campaigns`),
        ]);
      if (!ws.ok || !brain.ok) throw new Error("not found");
      setData({
        workspace: await ws.json(),
        brain: await brain.json(),
        personas: personas.ok ? await personas.json() : [],
        generations: generations.ok ? await generations.json() : [],
        drafts: drafts.ok ? await drafts.json() : [],
        newSignals: signals.ok ? ((await signals.json()) as unknown[]).length : 0,
        syntheses: syntheses.ok ? await syntheses.json() : [],
        campaigns: campaigns.ok ? await campaigns.json() : [],
      });
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">{"<-"} Back to workspaces</Link>
      </>
    );
  }

  if (!data) return <EmptyState description="Loading..." />;

  const { workspace, drafts, newSignals, syntheses, campaigns } = data;
  const pendingReview = drafts.filter((d) => d.state === "pending_review").length;
  const proposedUpdates = syntheses.filter((s) => s.status === "proposed").length;
  const activeCampaigns = campaigns.filter((c) => c.status === "active").length;
  const recentDrafts = [...drafts].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);

  return (
    <>
      <PageHeader
        title="Command Center"
        subtitle={`The GTM loop for ${workspace.name}: review work, act on signals, update the Brain, and keep campaigns moving.`}
      />

      <div className="home-grid">
        <Link
          className={`stat-card ${pendingReview > 0 ? "attention" : ""}`}
          data-tone="icp"
          href={`/workspaces/${id}/approvals`}
        >
          <span className="stat-number">{pendingReview}</span>
          <span className="stat-label">Needs review</span>
          <span className="stat-hint">Drafts waiting for a human decision</span>
        </Link>
        <Link className="stat-card" data-tone="signal" href={`/workspaces/${id}/discovery`}>
          <span className="stat-number">{newSignals}</span>
          <span className="stat-label">Market signals</span>
          <span className="stat-hint">Things worth turning into action</span>
        </Link>
        <Link className="stat-card" data-tone="history" href={`/workspaces/${id}/learning`}>
          <span className="stat-number">{proposedUpdates}</span>
          <span className="stat-label">Brain updates</span>
          <span className="stat-hint">Learning ready for you to accept</span>
        </Link>
        <Link className="stat-card" data-tone="voice" href={`/workspaces/${id}/campaigns`}>
          <span className="stat-number">{activeCampaigns}</span>
          <span className="stat-label">Campaigns live</span>
          <span className="stat-hint">GTM pushes currently in play</span>
        </Link>
      </div>

      <Card>
        <CardHeader
          title="Recent drafts"
          actions={
            <Link
              className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.sm}`}
              href={`/workspaces/${id}/content`}
            >
              Create draft
            </Link>
          }
        />
        {recentDrafts.length === 0 ? (
          <EmptyState
            title="No drafts yet"
            description="Drafts appear here after you create from the Brain, turn a signal into a post, or generate campaign assets."
            primaryAction={
              <Link
                className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.sm}`}
                href={`/workspaces/${id}/content`}
              >
                Start in Create
              </Link>
            }
          />
        ) : (
          <ul className="section-list">
            {recentDrafts.map((draft) => (
              <li key={draft.id} className="section-card">
                <div className="section-head">
                  <span className="section-title">
                    {draft.taskType.replace(/_/g, " ")} / {draft.channel}
                  </span>
                  <span className={`layer-badge state-${draft.state}`}>
                    {STATE_LABEL[draft.state] ?? draft.state}
                  </span>
                  <span className="section-tokens">
                    {new Date(draft.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="section-reason">
                  {draft.content.length > 160
                    ? `${draft.content.slice(0, 160)}...`
                    : draft.content}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
