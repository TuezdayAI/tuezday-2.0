"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge } from "@/src/components/ui/badge";
import { Input, Select } from "@/src/components/ui/input";

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
  engagement_reply: "Reply",
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

  if (!workspace || !stats) return <EmptyState description="Loading…" />;

  const proposed = syntheses.filter((s) => s.status === "proposed");

  return (
    <>
      <PageHeader title="Learning" subtitle={<>What Tuezday learns from your decisions, edits, and results — proposed as brain
            updates that you approve or dismiss.</>} actions={<>
            <Button variant="primary" disabled={synthesizing} onClick={synthesize}>
            {synthesizing ? "Synthesizing…" : "✨ Synthesize learnings"}
          </Button>
          </>} />

      <Card>
        <CardHeader title="Signal so far" />
        <p className="bundle-summary">
          Ratings: {stats.ratings.accepted ?? 0} accepted · {stats.ratings.needs_edit ?? 0} needs
          edit · {stats.ratings.rejected ?? 0} rejected — Drafts: {stats.decisions.approved}{" "}
          approved · {stats.decisions.rejected} rejected · {stats.editedCount} edited before
          decision — {stats.metricsCount} metric record(s)
        </p>
      </Card>

      <Card>
        <CardHeader
          title={
            <>
              Proposed now updates{" "}
              {proposed.length > 0 && <Badge tone="edited">{proposed.length} awaiting review</Badge>}
            </>
          }
        />
        {syntheses.length === 0 ? (
          <EmptyState description={<>No syntheses yet. Approve/reject some work, then synthesize — or let the worker propose
            one weekly.</>} />
        ) : (
          <ul className="section-list">
            {syntheses.map((s) => (
              <li key={s.id} className="section-card">
                <div className="section-head">
                  <Badge
                    tone={
                      s.status === "accepted"
                        ? "approved"
                        : s.status === "dismissed"
                          ? "rejected"
                          : "edited"
                    }
                  >
                    {s.status}
                  </Badge>
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
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => decide(s.id, "accept")}
                    >
                      ✓ Accept into now
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => decide(s.id, "dismiss")}
                    >
                      ✗ Dismiss
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error">{error}</p>}
      </Card>

      <Card>
        <CardHeader title="Record engagement metrics" />
        <form className="persona-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }} onSubmit={addMetric}>
          <div className="resolve-controls">
            <label style={{ flex: 1 }}>
              Approved draft (optional)
              <Select value={metricDraftId} onChange={(e) => setMetricDraftId(e.target.value)}>
                <option value="">(not linked to a draft)</option>
                {approvedDrafts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {TASK_LABELS[d.taskType]} · {d.channel} · {d.content.slice(0, 40)}…
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Channel
              <Select
                value={metricChannel}
                onChange={(e) => setMetricChannel(e.target.value as Channel)}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div className="resolve-controls">
            <label style={{ flex: 1 }}>
              Description
              <Input
                value={metricDescription}
                onChange={(e) => setMetricDescription(e.target.value)}
                placeholder="e.g. June launch post"
              />
            </label>
            <label>
              Impressions
              <Input type="number" min={0} value={impressions} onChange={(e) => setImpressions(e.target.value)} />
            </label>
            <label>
              Engagements
              <Input type="number" min={0} value={engagements} onChange={(e) => setEngagements(e.target.value)} />
            </label>
            <label>
              Clicks
              <Input type="number" min={0} value={clicks} onChange={(e) => setClicks(e.target.value)} />
            </label>
          </div>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional — e.g. best performer this month)"
            maxLength={1000}
          />
          <div className="editor-actions">
            <Button variant="primary" type="submit" disabled={busy}>
              Record metrics
            </Button>
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
      </Card>

      <Card>
        <CardHeader title={`Training examples (${examples.length})`} />
        {examples.length === 0 ? (
          <EmptyState description={<>Nothing yet — rate outputs in the Playground and decide drafts in Review.</>} />
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
      </Card>
    </>
  );
}
