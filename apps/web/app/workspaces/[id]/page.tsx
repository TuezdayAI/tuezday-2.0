"use client";

import { API_URL, apiFetch } from "@/lib/api";

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
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!data) return <p className="empty">Loading…</p>;

  const { workspace, brain, personas, generations, drafts, newSignals, syntheses, campaigns } =
    data;

  const brainFilled =
    brain.completeness.percent >= 60 ||
    brain.completeness.docs.every((d) => d.status !== "empty");
  const hasVoice = personas.length > 0;
  const hasDraft = generations.length > 0;
  const hasDecision = drafts.some((d) => d.state !== "pending_review" && d.state !== "draft");

  const steps = [
    {
      done: brainFilled,
      title: "Teach Tuezday your company",
      hint: `Fill in the five brain docs — ${brain.completeness.percent}% complete`,
      href: `/workspaces/${id}/brain`,
    },
    {
      done: hasVoice,
      title: "Add a voice",
      hint: "Create a persona Tuezday can write as",
      href: `/workspaces/${id}/resolver`,
    },
    {
      done: hasDraft,
      title: "Generate your first draft",
      hint: "Try the Playground — see exactly what Tuezday used",
      href: `/workspaces/${id}/sandbox`,
    },
    {
      done: hasDecision,
      title: "Make your first decision",
      hint: "Approve, edit, or reject a draft in Review",
      href: `/workspaces/${id}/approvals`,
    },
  ];
  const setupDone = steps.every((s) => s.done);

  const pendingReview = drafts.filter((d) => d.state === "pending_review").length;
  const proposedUpdates = syntheses.filter((s) => s.status === "proposed").length;
  const activeCampaigns = campaigns.filter((c) => c.status === "active").length;

  const recentDrafts = [...drafts].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Home</h1>
          <p className="subtitle">What needs your attention in {workspace.name} today.</p>
        </div>
      </div>

      {!setupDone && (
        <section className="panel">
          <h2>Get set up</h2>
          <ul className="checklist">
            {steps.map((step) => (
              <li key={step.title}>
                <Link
                  className={`checklist-item ${step.done ? "done" : ""}`}
                  href={step.href}
                >
                  <span className="check-dot">{step.done ? "✓" : ""}</span>
                  <span>
                    <span className="step-title">{step.title}</span>
                    <br />
                    <span className="step-hint">{step.hint}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="home-grid">
        <Link
          className={`stat-card ${pendingReview > 0 ? "attention" : ""}`}
          href={`/workspaces/${id}/approvals`}
        >
          <span className="stat-number">{pendingReview}</span>
          <span className="stat-label">Waiting for review</span>
          <span className="stat-hint">Drafts that need a decision from you</span>
        </Link>
        <Link className="stat-card" href={`/workspaces/${id}/discovery`}>
          <span className="stat-number">{newSignals}</span>
          <span className="stat-label">New signals</span>
          <span className="stat-hint">Things happening in your market</span>
        </Link>
        <Link className="stat-card" href={`/workspaces/${id}/learning`}>
          <span className="stat-number">{proposedUpdates}</span>
          <span className="stat-label">Proposed brain updates</span>
          <span className="stat-hint">What Tuezday learned from your decisions</span>
        </Link>
        <Link className="stat-card" href={`/workspaces/${id}/campaigns`}>
          <span className="stat-number">{activeCampaigns}</span>
          <span className="stat-label">Active campaigns</span>
          <span className="stat-hint">GTM goals currently in play</span>
        </Link>
      </div>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Recent drafts</h2>
          <Link className="button-secondary" href={`/workspaces/${id}/content`}>
            Create something
          </Link>
        </div>
        {recentDrafts.length === 0 ? (
          <p className="empty">
            Nothing here yet. Drafts appear as soon as you create something — try the Playground
            or paste a signal in Create.
          </p>
        ) : (
          <ul className="section-list">
            {recentDrafts.map((draft) => (
              <li key={draft.id} className="section-card">
                <div className="section-head">
                  <span className="section-title">
                    {draft.taskType.replace(/_/g, " ")} · {draft.channel}
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
                    ? `${draft.content.slice(0, 160)}…`
                    : draft.content}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
