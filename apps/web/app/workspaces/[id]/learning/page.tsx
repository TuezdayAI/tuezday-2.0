"use client";

import { TopBarActions } from "@/src/components/top-bar";
import { EmptyState } from "@/src/components/empty-state";
import { Button, ButtonLink } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { LoopGlyph } from "@/src/components/ui/diagram-kit";
import { Input, Select } from "@/src/components/ui/input";
import styles from "./learning.module.css";

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
  instagram_carousel: "Instagram carousel",
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

/** Registry icon per training-example outcome (spec §4 status vocabulary). */
function exampleIcon(e: TrainingExample): IconName {
  const outcome = e.rating ?? e.decision;
  if (outcome === "accepted" || outcome === "approved") return "status-approved";
  if (outcome === "rejected") return "status-rejected";
  return "status-learning";
}

/** What a training example changed, phrased as the LoopGlyph "change" side. */
function exampleChange(e: TrainingExample): string {
  const outcome = e.kind === "rating" ? `rated ${e.rating}` : (e.decision ?? "decided");
  return e.wasEdited ? `${outcome} · edited first` : outcome;
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
      <TopBarActions>
        <Button variant="primary" size="compact" disabled={synthesizing} onClick={synthesize}>
          <Icon name="status-generating" size="compact" />
          {synthesizing ? "Synthesizing…" : "Synthesize learnings"}
        </Button>
      </TopBarActions>

      <p className="subtitle">
        What Tuezday learns from your decisions, edits, and results — proposed as brain updates
        that you approve or dismiss.
      </p>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-learning" size="compact" className={styles.headIcon} />
              Signal so far
            </span>
          }
        />
        <div className={styles.statRow}>
          <Badge tone="approved">{stats.ratings.accepted ?? 0} rated accepted</Badge>
          <Badge tone="edited">{stats.ratings.needs_edit ?? 0} needs edit</Badge>
          <Badge tone="rejected">{stats.ratings.rejected ?? 0} rated rejected</Badge>
          <Badge tone="approved">{stats.decisions.approved} drafts approved</Badge>
          <Badge tone="rejected">{stats.decisions.rejected} drafts rejected</Badge>
          <Badge tone="edited">{stats.editedCount} edited before decision</Badge>
          <Badge tone="neutral">{stats.metricsCount} metric record(s)</Badge>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="doc-now" size="compact" className={styles.headIconNow} />
              Proposed now updates{" "}
              {proposed.length > 0 && <CountBadge count={proposed.length} label="proposed now updates awaiting review" />}
            </span>
          }
        />
        {syntheses.length === 0 ? (
          <EmptyState
            description={<>No syntheses yet. Approve/reject some work, then synthesize — or let the worker propose
            one weekly.</>}
            primaryAction={
              <Button variant="secondary" size="compact" disabled={synthesizing} onClick={synthesize}>
                <Icon name="status-generating" size="compact" />
                Synthesize now
              </Button>
            }
            preview={
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <LoopGlyph signal="12 approvals this week" change="voice: shorter openers" />
                </div>
                <div className={styles.previewCard}>
                  <LoopGlyph signal="3 rejected drafts mentioned pricing" change="now: avoid discount framing" />
                </div>
                <div className={styles.previewCard}>
                  <LoopGlyph signal="launch post outperformed 4×" change="now: lead with customer numbers" />
                </div>
              </div>
            }
          />
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
                    <ButtonLink variant="tertiary" size="compact" href={`/workspaces/${id}/brain`}>
                      view in brain →
                    </ButtonLink>
                  )}
                </div>
                <pre className="output-text">{s.proposal}</pre>
                {s.rationale && <p className="section-reason">Why: {s.rationale}</p>}
                {s.status === "proposed" && (
                  <div className="rating-row">
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={busy}
                      onClick={() => decide(s.id, "accept")}
                    >
                      <Icon name="status-approved" size="compact" />
                      Accept into now
                    </Button>
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={busy}
                      onClick={() => decide(s.id, "dismiss")}
                    >
                      <Icon name="status-rejected" size="compact" />
                      Dismiss
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
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-live" size="compact" className={styles.headIconLive} />
              Record engagement metrics
            </span>
          }
        />
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
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-learning" size="compact" className={styles.headIcon} />
              Training examples <CountBadge count={examples.length} label="training examples" />
            </span>
          }
        />
        {examples.length === 0 ? (
          <EmptyState
            description={<>Nothing yet — rate outputs in the Playground and decide drafts in Review. Every decision
            becomes a training example like these.</>}
            preview={
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <LoopGlyph icon="status-approved" signal="LinkedIn post · linkedin" change="rated accepted" />
                </div>
                <div className={styles.previewCard}>
                  <LoopGlyph icon="status-learning" signal="Cold email opener · email" change="approved · edited first" />
                </div>
                <div className={styles.previewCard}>
                  <LoopGlyph icon="status-rejected" signal="Ad copy variant · meta" change="rated rejected" />
                </div>
              </div>
            }
          />
        ) : (
          <ul className="section-list">
            {examples.map((e) => (
              <li key={`${e.kind}-${e.id}`} className="section-card">
                <div
                  className="section-head"
                  onClick={() => setExpanded((x) => ({ ...x, [e.id]: !x[e.id] }))}
                >
                  <LoopGlyph
                    icon={exampleIcon(e)}
                    signal={`${TASK_LABELS[e.taskType]} · ${e.channel}`}
                    change={exampleChange(e)}
                  />
                  <span className={`section-tokens ${styles.entryDate}`}>
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
