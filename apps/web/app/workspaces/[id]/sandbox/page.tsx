"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  DEFAULT_TOKEN_BUDGET,
  OUTPUT_RATINGS,
  TASK_TYPES,
  type Campaign,
  type Channel,
  type OutputRating,
  type Persona,
  type TaskType,
  type Workspace,
} from "@tuezday/contracts";
import type { ContextSection, ResolvedContext } from "@tuezday/brain";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const TASK_LABELS: Record<TaskType, string> = {
  linkedin_post: "LinkedIn post",
  cold_email_opener: "Cold email opener",
  ad_copy_variant: "Ad copy variant",
  landing_page_hero: "Landing page hero",
  signal_response: "Signal response",
  outbound_email: "Outbound email",
};

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
}

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
  const [showTrace, setShowTrace] = useState(false);
  const [expandedLog, setExpandedLog] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, gRes, dRes, cRes] = await Promise.all([
        fetch(`${API_URL}/workspaces/${id}`),
        fetch(`${API_URL}/workspaces/${id}/personas`),
        fetch(`${API_URL}/workspaces/${id}/generations`),
        fetch(`${API_URL}/workspaces/${id}/drafts`),
        fetch(`${API_URL}/workspaces/${id}/campaigns`),
      ]);
      if (!wsRes.ok || !pRes.ok || !gRes.ok || !dRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setLog(await gRes.json());
      setCampaigns(((await cRes.json()) as Campaign[]).filter((c) => c.status === "active"));
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

  // Any control change invalidates the preview gate.
  useEffect(() => {
    setPreviewStale(true);
  }, [taskType, channel, personaId, campaignId, useEvidence, tokenBudget]);

  async function previewContext() {
    setError(null);
    try {
      const res = await fetch(`${API_URL}/workspaces/${id}/resolve`, {
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

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/workspaces/${id}/generate`, {
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
      if (!res.ok) {
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setLatest(body);
      setShowTrace(false);
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

  async function rate(generationId: string, rating: OutputRating) {
    setError(null);
    const res = await fetch(`${API_URL}/workspaces/${id}/generations/${generationId}/rating`, {
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
    const res = await fetch(`${API_URL}/workspaces/${id}/generations/${generationId}/submit`, {
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
        in approval queue →
      </Link>
    ) : (
      <button className="button-secondary" onClick={() => sendToQueue(generationId)}>
        Send to approval queue
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

  if (!workspace) return <p className="empty">Loading…</p>;

  return (
    <>
      <div className="brain-header">
        <div>
          <p className="breadcrumb">
            <Link href="/">Workspaces</Link> /{" "}
            <Link href={`/workspaces/${id}`}>{workspace.name}</Link> / Sandbox
          </p>
          <h1>Generation Sandbox</h1>
          <p className="subtitle">
            Preview the context, generate with the brain, rate the output. Ratings are stored as
            training signals.
          </p>
        </div>
        <div className="persona-actions">
          <Link className="button-secondary" href={`/workspaces/${id}`}>
            ← Brain
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/resolver`}>
            Resolver
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/approvals`}>
            Approvals →
          </Link>
        </div>
      </div>

      <section className="panel">
        <h2>1 · Choose the task</h2>
        <div className="resolve-controls">
          <label>
            Task
            <select value={taskType} onChange={(e) => setTaskType(e.target.value as TaskType)}>
              {TASK_TYPES.map((t) => (
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
        <button onClick={generate} disabled={generating || !preview || previewStale}>
          {generating ? "Generating…" : "Generate with brain"}
        </button>

        {error && <p className="error">{error}</p>}

        {latest && (
          <div className="generation-output">
            <p className="bundle-summary">
              {TASK_LABELS[latest.taskType]} · {latest.channel} · {personaName(latest.personaId)} ·{" "}
              {latest.model} · {(latest.durationMs / 1000).toFixed(1)}s{" "}
              <button className="link-button" onClick={() => setShowTrace(!showTrace)}>
                {showTrace ? "hide" : "show"} prompt trace
              </button>
            </p>
            {showTrace && <pre className="section-content">{latest.prompt}</pre>}
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
          <p className="empty">No generations yet.</p>
        ) : (
          <ul className="section-list">
            {log.map((g) => (
              <li key={g.id} className="section-card">
                <div
                  className="section-head"
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
                    <pre className="output-text">{g.output}</pre>
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
