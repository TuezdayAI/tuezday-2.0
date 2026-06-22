"use client";

import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  type Channel,
  type Draft,
  type EngagementMetric,
  type NowSynthesis,
  type TaskType,
  type Workspace,
} from "@tuezday/contracts";

const TASK_LABELS: Record<TaskType, string> = {
  linkedin_post: "LinkedIn post",
  cold_email_opener: "Cold email opener",
  ad_copy_variant: "Ad copy variant",
  landing_page_hero: "Landing page hero",
  signal_response: "Signal response",
  outbound_email: "Outbound email",
  meta_ad_creative: "Meta ad creative",
  google_rsa: "Google RSA",
  pr_pitch: "Media pitch",
  press_boilerplate: "Press boilerplate",
  x_dm: "X DM",
  instagram_post: "Instagram post",
};

interface TrainingExample {
  kind: "rating" | "decision";
  id: string;
  taskType: TaskType;
  channel: Channel;
  content: string;
  originalContent: string | null;
  wasEdited: boolean;
  rating: string | null;
  decision: string | null;
  createdAt: number;
}

interface Stats {
  ratings: Record<string, number>;
  decisions: { approved: number; rejected: number };
  editedCount: number;
  metricsCount: number;
}

export default function LearningPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [examples, setExamples] = useState<TrainingExample[]>([]);
  const [syntheses, setSyntheses] = useState<NowSynthesis[]>([]);
  const [metrics, setMetrics] = useState<EngagementMetric[]>([]);
  const [approvedDrafts, setApprovedDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [synthesizing, setSynthesizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // metric form
  const [metricDraftId, setMetricDraftId] = useState("");
  const [metricChannel, setMetricChannel] = useState<Channel>("linkedin");
  const [metricDescription, setMetricDescription] = useState("");
  const [impressions, setImpressions] = useState("");
  const [engagements, setEngagements] = useState("");
  const [clicks, setClicks] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    try {
      const [wsRes, sRes, eRes, synRes, mRes, dRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/learning/stats`),
        apiFetch(`/workspaces/${id}/learning/examples`),
        apiFetch(`/workspaces/${id}/learning/syntheses`),
        apiFetch(`/workspaces/${id}/metrics`),
        apiFetch(`/workspaces/${id}/drafts?state=approved`),
      ]);
      if (!wsRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setStats(await sRes.json());
      setExamples(await eRes.json());
      setSyntheses(await synRes.json());
      setMetrics(await mRes.json());
      setApprovedDrafts(await dRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function synthesize() {
    setSynthesizing(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/learning/synthesize`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Synthesis failed");
    } finally {
      setSynthesizing(false);
    }
  }

  async function decide(synthesisId: string, action: "accept" | "dismiss") {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/learning/syntheses/${synthesisId}/${action}`,
        { method: "POST" },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setBusy(false);
    }
  }

  async function addMetric(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/metrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftId: metricDraftId || undefined,
          channel: metricChannel,
          description: metricDescription,
          impressions: impressions ? Number(impressions) : undefined,
          engagements: engagements ? Number(engagements) : undefined,
          clicks: clicks ? Number(clicks) : undefined,
          notes,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setMetricDescription("");
      setImpressions("");
      setEngagements("");
      setClicks("");
      setNotes("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record metric");
    } finally {
      setBusy(false);
    }
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace || !stats) return <p className="empty">Loading…</p>;

  const proposed = syntheses.filter((s) => s.status === "proposed");

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Learning</h1>
          <p className="subtitle">
            What Tuezday learns from your decisions, edits, and results — proposed as brain
            updates that you approve or dismiss.
          </p>
        </div>
        <div className="page-actions">
          <button disabled={synthesizing} onClick={synthesize}>
            {synthesizing ? "Synthesizing…" : "✨ Synthesize learnings"}
          </button>
        </div>
      </div>

      <section className="panel">
        <h2>Signal so far</h2>
        <p className="bundle-summary">
          Ratings: {stats.ratings.accepted ?? 0} accepted · {stats.ratings.needs_edit ?? 0} needs
          edit · {stats.ratings.rejected ?? 0} rejected — Drafts: {stats.decisions.approved}{" "}
          approved · {stats.decisions.rejected} rejected · {stats.editedCount} edited before
          decision — {stats.metricsCount} metric record(s)
        </p>
      </section>

      <section className="panel">
        <h2>
          Proposed now updates{" "}
          {proposed.length > 0 && <span className="layer-badge state-edited">{proposed.length} awaiting review</span>}
        </h2>
        {syntheses.length === 0 ? (
          <p className="empty">
            No syntheses yet. Approve/reject some work, then synthesize — or let the worker propose
            one weekly.
          </p>
        ) : (
          <ul className="section-list">
            {syntheses.map((s) => (
              <li key={s.id} className="section-card">
                <div className="section-head">
                  <span
                    className={`layer-badge ${
                      s.status === "accepted"
                        ? "state-approved"
                        : s.status === "dismissed"
                          ? "state-rejected"
                          : "state-edited"
                    }`}
                  >
                    {s.status}
                  </span>
                  <span className="section-title">
                    Synthesis · {new Date(s.createdAt).toLocaleString()}
                  </span>
                  {s.status === "accepted" && (
                    <Link className="link-button" href={`/workspaces/${id}/brain`}>
                      view in brain →
                    </Link>
                  )}
                </div>
                <pre className="output-text">{s.proposal}</pre>
                {s.rationale && <p className="section-reason">Why: {s.rationale}</p>}
                {s.status === "proposed" && (
                  <div className="rating-row">
                    <button
                      className="button-secondary rating-accepted"
                      disabled={busy}
                      onClick={() => decide(s.id, "accept")}
                    >
                      ✓ Accept into now
                    </button>
                    <button
                      className="button-secondary rating-rejected"
                      disabled={busy}
                      onClick={() => decide(s.id, "dismiss")}
                    >
                      ✗ Dismiss
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <h2>Record engagement metrics</h2>
        <form className="persona-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }} onSubmit={addMetric}>
          <div className="resolve-controls">
            <label style={{ flex: 1 }}>
              Approved draft (optional)
              <select value={metricDraftId} onChange={(e) => setMetricDraftId(e.target.value)}>
                <option value="">(not linked to a draft)</option>
                {approvedDrafts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {TASK_LABELS[d.taskType]} · {d.channel} · {d.content.slice(0, 40)}…
                  </option>
                ))}
              </select>
            </label>
            <label>
              Channel
              <select
                value={metricChannel}
                onChange={(e) => setMetricChannel(e.target.value as Channel)}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="resolve-controls">
            <label style={{ flex: 1 }}>
              Description
              <input
                value={metricDescription}
                onChange={(e) => setMetricDescription(e.target.value)}
                placeholder="e.g. June launch post"
              />
            </label>
            <label>
              Impressions
              <input type="number" min={0} value={impressions} onChange={(e) => setImpressions(e.target.value)} />
            </label>
            <label>
              Engagements
              <input type="number" min={0} value={engagements} onChange={(e) => setEngagements(e.target.value)} />
            </label>
            <label>
              Clicks
              <input type="number" min={0} value={clicks} onChange={(e) => setClicks(e.target.value)} />
            </label>
          </div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional — e.g. best performer this month)"
            maxLength={1000}
          />
          <div className="editor-actions">
            <button type="submit" disabled={busy}>
              Record metrics
            </button>
          </div>
        </form>

        {metrics.length > 0 && (
          <ul className="draft-chain" style={{ marginTop: 12 }}>
            {metrics.map((m) => (
              <li key={m.id}>
                <span className="layer-badge">{m.channel}</span>{" "}
                <span className="meta">
                  {m.description || "untitled"} — {m.impressions ?? "?"} impressions ·{" "}
                  {m.engagements ?? "?"} engagements · {m.clicks ?? "?"} clicks
                  {m.notes ? ` · ${m.notes}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Training examples ({examples.length})</h2>
        {examples.length === 0 ? (
          <p className="empty">
            Nothing yet — rate outputs in the Playground and decide drafts in Review.
          </p>
        ) : (
          <ul className="section-list">
            {examples.map((e) => (
              <li key={`${e.kind}-${e.id}`} className="section-card">
                <div
                  className="section-head"
                  onClick={() => setExpanded((x) => ({ ...x, [e.id]: !x[e.id] }))}
                >
                  <span
                    className={`layer-badge ${
                      (e.rating ?? e.decision) === "accepted" || e.decision === "approved"
                        ? "state-approved"
                        : (e.rating ?? e.decision) === "rejected"
                          ? "state-rejected"
                          : "state-edited"
                    }`}
                  >
                    {e.kind === "rating" ? `rated ${e.rating}` : e.decision}
                    {e.wasEdited ? " (edited)" : ""}
                  </span>
                  <span className="section-title">
                    {TASK_LABELS[e.taskType]} · {e.channel}
                  </span>
                  <span className="section-tokens">
                    {new Date(e.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="section-reason">
                  {e.content.slice(0, 140)}
                  {e.content.length > 140 ? "…" : ""}
                </p>
                {expanded[e.id] && (
                  <>
                    {e.wasEdited && e.originalContent && (
                      <details className="original-content" open>
                        <summary>Original (before founder edit)</summary>
                        <pre className="section-content">{e.originalContent}</pre>
                      </details>
                    )}
                    <pre className="output-text">{e.content}</pre>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
