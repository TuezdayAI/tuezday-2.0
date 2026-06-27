"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";


import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  DEFAULT_TOKEN_BUDGET,
  isAdCreativeTaskType,
  OUTPUT_RATINGS,
  TASK_TYPES,
  type Campaign,
  type Channel,
  type GenerationReview,
  type GenerationSettings,
  type OutputRating,
  type Persona,
  type TaskType,
  type Workspace,
} from "@tuezday/contracts";
import type { ContextSection, ResolvedContext } from "@tuezday/brain";
import { ReviewPanel } from "@/components/ReviewPanel";
import { WhyThisOutput, EvidenceRetrieval } from "@/components/why-this-output";

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

/** Ad creative variant sets are generated on the Ad creatives page; a media
 * pitch without a contact is meaningless (PR page). press_boilerplate stays —
 * it is a sandbox-shaped task. */
const SANDBOX_TASK_TYPES = TASK_TYPES.filter(
  // engagement_reply needs an inbound conversation — it's generated from the Inbox, not here.
  (t) => !isAdCreativeTaskType(t) && t !== "pr_pitch" && t !== "engagement_reply",
);

const RATING_LABELS: Record<OutputRating, string> = {
  accepted: "✓ Accept",
  needs_edit: "✎ Needs edit",
  rejected: "✗ Reject",
};

interface GenerationView {
  id: string;
  taskType: TaskType;
  channel: Channel;
  personaId: string | null;
  prompt: string;
  output: string;
  model: string;
  provider: string;
  durationMs: number;
  rating: OutputRating | null;
  createdAt: number;
  sections: ContextSection[];
  review?: GenerationReview | null;
  angles?: string[];
  chosenAngle?: string;
}

/** Retrieval-quality inspection: the composed query and every candidate chunk
 * with its similarity / recency / source / final scores and kept-vs-dropped
 * status. Renders only for the evidence section (which carries `evidence`). */


export default function SandboxPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [log, setLog] = useState<GenerationView[]>([]);
  const [submittedByGeneration, setSubmittedByGeneration] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const [taskType, setTaskType] = useState<TaskType>("linkedin_post");
  const [channel, setChannel] = useState<Channel>("linkedin");
  const [personaId, setPersonaId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [useEvidence, setUseEvidence] = useState(true);
  const [tokenBudget, setTokenBudget] = useState(DEFAULT_TOKEN_BUDGET);

  const [preview, setPreview] = useState<ResolvedContext | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [showPreviewDetail, setShowPreviewDetail] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [latest, setLatest] = useState<GenerationView | null>(null);
  const [expandedLog, setExpandedLog] = useState<Record<string, boolean>>({});

  const [settings, setSettings] = useState<GenerationSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [angles, setAngles] = useState<string[] | null>(null);
  const [chosenAngle, setChosenAngle] = useState<string>("");
  const [anglesLoading, setAnglesLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, gRes, dRes, cRes, sRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/generations`),
        apiFetch(`/workspaces/${id}/drafts`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/generation-settings`),
      ]);
      if (!wsRes.ok || !pRes.ok || !gRes.ok || !dRes.ok || !cRes.ok || !sRes.ok)
        throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setLog(await gRes.json());
      setCampaigns(((await cRes.json()) as Campaign[]).filter((c) => c.status === "active"));
      setSettings(await sRes.json());
      const drafts: { sourceGenerationId: string | null; id: string }[] = await dRes.json();
      setSubmittedByGeneration(
        Object.fromEntries(
          drafts.filter((d) => d.sourceGenerationId).map((d) => [d.sourceGenerationId!, d.id]),
        ),
      );
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any control change invalidates the preview gate and stale angle list.
  useEffect(() => {
    setPreviewStale(true);
    setAngles(null);
    setChosenAngle("");
  }, [taskType, channel, personaId, campaignId, useEvidence, tokenBudget]);

  async function previewContext() {
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType,
          channel,
          personaId: personaId || undefined,
          campaignId: campaignId || undefined,
          useEvidence,
          tokenBudget,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setPreview(await res.json());
      setPreviewStale(false);
      setShowPreviewDetail(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve context");
    }
  }

  async function generate(angle?: string) {
    setGenerating(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType,
          channel,
          personaId: personaId || undefined,
          campaignId: campaignId || undefined,
          useEvidence,
          tokenBudget,
          angle: angle || undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setLatest(body);
      await load();
    } catch (err) {
      if (err instanceof TypeError) {
        setError(`Could not reach the API at ${API_URL}. Is "npm run dev" running?`);
      } else {
        setError(err instanceof Error ? err.message : "Generation failed");
      }
    } finally {
      setGenerating(false);
    }
  }

  async function saveSettings(patch: Partial<GenerationSettings>) {
    setError(null);
    const res = await apiFetch(`/workspaces/${id}/generation-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      setSettings(await res.json());
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.message ?? `API returned ${res.status}`);
    }
  }

  async function suggestAngles() {
    setAnglesLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/angles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType,
          channel,
          personaId: personaId || undefined,
          campaignId: campaignId || undefined,
          useEvidence,
          tokenBudget,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setAngles(body.angles ?? []);
      setChosenAngle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not suggest angles");
    } finally {
      setAnglesLoading(false);
    }
  }

  async function rate(generationId: string, rating: OutputRating) {
    setError(null);
    const res = await apiFetch(`/workspaces/${id}/generations/${generationId}/rating`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating }),
    });
    if (res.ok) {
      const updated = await res.json();
      if (latest?.id === generationId) setLatest(updated);
      await load();
    }
  }

  function personaName(pid: string | null): string {
    if (!pid) return "org voice";
    return personas.find((p) => p.id === pid)?.name ?? "deleted persona";
  }

  async function sendToQueue(generationId: string) {
    setError(null);
    const res = await apiFetch(`/workspaces/${id}/generations/${generationId}/submit`, {
      method: "POST",
    });
    const body = await res.json().catch(() => null);
    if (!res.ok && res.status !== 409) {
      setError(body?.message ?? `API returned ${res.status}`);
      return;
    }
    await load();
  }

  function queueButton(generationId: string) {
    const draftId = submittedByGeneration[generationId];
    return draftId ? (
      <Link className="link-button" href={`/workspaces/${id}/approvals`}>
        in Review →
      </Link>
    ) : (
      <button className="button-secondary" onClick={() => sendToQueue(generationId)}>
        Send to Review
      </button>
    );
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace) return <EmptyState description="Loading…" />;

  return (
    <>
      <PageHeader title="Playground" subtitle={<>Try a one-off generation: see exactly what Tuezday will use, generate, then rate the
            result. Your ratings teach it what good looks like.</>} actions={<>
            <button className="button-secondary" onClick={() => setShowSettings((s) => !s)}>
            {showSettings ? "Hide quality settings" : "Quality settings"}
          </button>
          </>} />

      {showSettings && settings && (
        <section className="panel">
          <h2>Generation quality</h2>
          <p className="subtitle">
            Pre-review and the angle step run before you ever look at a draft. Both apply across
            every module in this workspace.
          </p>
          <div className="settings-grid">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.reviewEnabled}
                onChange={(e) => saveSettings({ reviewEnabled: e.target.checked })}
              />
              Automated pre-review (brand voice + channel fit)
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.angleEnabled}
                onChange={(e) => saveSettings({ angleEnabled: e.target.checked })}
              />
              Angle step (suggest angles before drafting)
            </label>
            <label>
              Angles to suggest
              <input
                type="number"
                min={2}
                max={5}
                value={settings.angleCount}
                onChange={(e) => saveSettings({ angleCount: Number(e.target.value) })}
              />
            </label>
            <label>
              Flag below score
              <input
                type="number"
                min={0}
                max={100}
                value={settings.flagThreshold}
                onChange={(e) => saveSettings({ flagThreshold: Number(e.target.value) })}
              />
            </label>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>1 · Choose the task</h2>
        <div className="resolve-controls">
          <label>
            Task
            <select value={taskType} onChange={(e) => setTaskType(e.target.value as TaskType)}>
              {SANDBOX_TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TASK_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Persona
            <select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
              <option value="">(none — org voice)</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {campaigns.length > 0 && (
            <label>
              Campaign
              <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">(no campaign)</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Token budget
            <input
              type="number"
              min={500}
              max={200000}
              value={tokenBudget}
              onChange={(e) => setTokenBudget(Number(e.target.value))}
            />
          </label>
          <label className="checkbox-label" style={{ alignSelf: "center" }}>
            <input
              type="checkbox"
              checked={useEvidence}
              onChange={(e) => setUseEvidence(e.target.checked)}
            />
            Use evidence
          </label>
          <button className="button-secondary" onClick={previewContext}>
            Preview context
          </button>
        </div>

        {preview && !previewStale && (
          <div className="bundle">
            <p className="bundle-summary">
              {preview.sections.filter((s) => s.included).length} of {preview.sections.length}{" "}
              sections · ~{preview.includedTokens} tokens of {preview.tokenBudget}
              {preview.overBudget && <span className="error"> — over budget</span>}{" "}
              <button
                className="link-button"
                onClick={() => setShowPreviewDetail(!showPreviewDetail)}
              >
                {showPreviewDetail ? "hide" : "show"} sections
              </button>
            </p>
            {showPreviewDetail && (
              <ol className="section-list">
                {preview.sections.map((s) => (
                  <li key={s.key} className={`section-card ${s.included ? "" : "excluded"}`}>
                    <div className="section-head">
                      <span className={`layer-badge layer-${s.layer}`}>{s.layer}</span>
                      <span className="section-title">{s.title}</span>
                      <span className="section-tokens">
                        {s.included ? `~${s.tokens} tok` : "excluded"}
                      </span>
                    </div>
                    <p className="section-reason">{s.reason}</p>
                    {s.evidence && <EvidenceRetrieval section={s} />}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>2 · Generate</h2>
        {(!preview || previewStale) && (
          <p className="subtitle">Preview the context first — always read what the model reads.</p>
        )}

        {settings?.angleEnabled && (
          <div style={{ marginBottom: 14 }}>
            <button
              className="button-secondary"
              onClick={suggestAngles}
              disabled={anglesLoading || !preview || previewStale}
            >
              {anglesLoading ? "Thinking…" : "Suggest angles"}
            </button>
            {angles && angles.length > 0 && (
              <ul className="angle-list">
                {angles.map((a, i) => (
                  <li key={i} className={`angle-card ${chosenAngle === a ? "chosen" : ""}`}>
                    <span>{a}</span>
                    <button
                      className="button-secondary"
                      disabled={generating}
                      onClick={() => {
                        setChosenAngle(a);
                        void generate(a);
                      }}
                    >
                      Draft from this
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {angles && angles.length === 0 && (
              <p className="subtitle">No angles came back — try again or draft without one.</p>
            )}
          </div>
        )}

        <button onClick={() => generate()} disabled={generating || !preview || previewStale}>
          {generating ? "Generating…" : "Generate with brain"}
        </button>

        {error && <p className="error">{error}</p>}

        {latest && (
          <div className="generation-output">
            <p className="bundle-summary">
              {TASK_LABELS[latest.taskType]} · {latest.channel} · {personaName(latest.personaId)} ·{" "}
              {latest.model} · {(latest.durationMs / 1000).toFixed(1)}s
            </p>
            {latest.chosenAngle && (
              <p className="meta">Angle: {latest.chosenAngle}</p>
            )}
            
            <WhyThisOutput sections={latest.sections} prompt={latest.prompt} review={latest.review} />

            <pre className="output-text">{latest.output}</pre>
            <div className="rating-row">
              {OUTPUT_RATINGS.map((r) => (
                <button
                  key={r}
                  className={`button-secondary rating-${r} ${latest.rating === r ? "active" : ""}`}
                  onClick={() => rate(latest.id, r)}
                >
                  {RATING_LABELS[r]}
                </button>
              ))}
              {latest.rating && <span className="meta">stored as training signal</span>}
              {queueButton(latest.id)}
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Training signal log</h2>
        {log.length === 0 ? (
          <EmptyState description={<>No generations yet.</>} />
        ) : (
          <ul className="section-list">
            {log.map((g) => (
              <li key={g.id} className="section-card">
                <div
                  className="section-head"
                  style={{ cursor: "pointer" }}
                  onClick={() => setExpandedLog((e) => ({ ...e, [g.id]: !e[g.id] }))}
                >
                  <span className={`layer-badge ${g.rating ? `rating-${g.rating}` : ""}`}>
                    {g.rating ?? "unrated"}
                  </span>
                  <span className="section-title">
                    {TASK_LABELS[g.taskType]} · {personaName(g.personaId)}
                  </span>
                  <span className="section-tokens">
                    {new Date(g.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="section-reason">
                  {g.output.slice(0, 140)}
                  {g.output.length > 140 ? "…" : ""}
                </p>
                {expandedLog[g.id] && (
                  <>
                    <details className="trace-details" style={{ marginTop: 12, marginBottom: 12 }}>
                      <summary className="link-button" style={{ cursor: 'pointer', listStyle: 'none' }}>
                        How did Tuezday write this?
                      </summary>
                      <div className="trace-content" style={{ marginTop: 8 }}>
                        {g.sections
                          ?.filter((s) => s.key === "evidence" && s.evidence)
                          .map((s) => (
                            <EvidenceRetrieval key={s.key} section={s} />
                          ))}
                        <pre className="section-content">{g.prompt}</pre>
                      </div>
                    </details>
                    <pre className="output-text">{g.output}</pre>
                    <ReviewPanel review={g.review} />
                    <div className="rating-row">
                      {OUTPUT_RATINGS.map((r) => (
                        <button
                          key={r}
                          className={`button-secondary rating-${r} ${g.rating === r ? "active" : ""}`}
                          onClick={() => rate(g.id, r)}
                        >
                          {RATING_LABELS[r]}
                        </button>
                      ))}
                      {queueButton(g.id)}
                    </div>
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
