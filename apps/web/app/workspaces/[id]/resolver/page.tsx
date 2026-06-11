"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  DEFAULT_TOKEN_BUDGET,
  TASK_TYPES,
  type Campaign,
  type Channel,
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
};

export default function ResolverPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);

  // resolve controls
  const [taskType, setTaskType] = useState<TaskType>("linkedin_post");
  const [channel, setChannel] = useState<Channel>("linkedin");
  const [personaId, setPersonaId] = useState<string>("");
  const [campaignId, setCampaignId] = useState<string>("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [tokenBudget, setTokenBudget] = useState(DEFAULT_TOKEN_BUDGET);
  const [bundle, setBundle] = useState<ResolvedContext | null>(null);
  const [resolving, setResolving] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // persona form
  const [showPersonaForm, setShowPersonaForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pName, setPName] = useState("");
  const [pDescription, setPDescription] = useState("");
  const [pOverlay, setPOverlay] = useState("");

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, cRes] = await Promise.all([
        fetch(`${API_URL}/workspaces/${id}`),
        fetch(`${API_URL}/workspaces/${id}/personas`),
        fetch(`${API_URL}/workspaces/${id}/campaigns`),
      ]);
      if (!wsRes.ok || !pRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setCampaigns(((await cRes.json()) as Campaign[]).filter((c) => c.status === "active"));
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve() {
    setResolving(true);
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
          tokenBudget,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setBundle(await res.json());
      setExpanded({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve");
    } finally {
      setResolving(false);
    }
  }

  function startEdit(p?: Persona) {
    setShowPersonaForm(true);
    setEditingId(p?.id ?? null);
    setPName(p?.name ?? "");
    setPDescription(p?.description ?? "");
    setPOverlay(p?.overlay ?? "");
  }

  async function savePersona(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const url = editingId
        ? `${API_URL}/workspaces/${id}/personas/${editingId}`
        : `${API_URL}/workspaces/${id}/personas`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pName, description: pDescription, overlay: pOverlay }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setShowPersonaForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save persona");
    }
  }

  async function removePersona(persona: Persona) {
    if (!confirm(`Delete persona "${persona.name}"?`)) return;
    await fetch(`${API_URL}/workspaces/${id}/personas/${persona.id}`, { method: "DELETE" });
    if (personaId === persona.id) setPersonaId("");
    await load();
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
            <Link href="/">Workspaces</Link> / <Link href={`/workspaces/${id}`}>{workspace.name}</Link>{" "}
            / Resolver
          </p>
          <h1>Context Resolver</h1>
          <p className="subtitle">
            Resolve the brain into the exact context bundle a task would receive — before any AI
            sees it.
          </p>
        </div>
        <Link className="button-secondary" href={`/workspaces/${id}`}>
          ← Brain editor
        </Link>
      </div>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Personas</h2>
          <button className="button-secondary" onClick={() => startEdit()}>
            + New persona
          </button>
        </div>
        {personas.length === 0 ? (
          <p className="empty">
            No personas yet. Create one (e.g. “CEO voice”, “Company page”) to see the same brain
            resolve differently.
          </p>
        ) : (
          <ul className="persona-list">
            {personas.map((p) => (
              <li key={p.id} className="persona-card">
                <div>
                  <span className="name">{p.name}</span>
                  {p.description && <span className="meta"> — {p.description}</span>}
                </div>
                <div className="persona-actions">
                  <button className="button-secondary" onClick={() => startEdit(p)}>
                    Edit
                  </button>
                  <button className="button-secondary danger" onClick={() => removePersona(p)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {showPersonaForm && (
          <form className="persona-form" onSubmit={savePersona}>
            <input
              value={pName}
              onChange={(e) => setPName(e.target.value)}
              placeholder="Persona name (e.g. CEO)"
              maxLength={100}
            />
            <input
              value={pDescription}
              onChange={(e) => setPDescription(e.target.value)}
              placeholder="Who is speaking? (e.g. Founder, first person)"
              maxLength={500}
            />
            <textarea
              value={pOverlay}
              onChange={(e) => setPOverlay(e.target.value)}
              placeholder="Overlay — voice and point-of-view adjustments layered on the org brain…"
              rows={5}
            />
            <div className="editor-actions">
              <button type="submit" disabled={pName.trim().length === 0}>
                {editingId ? "Update persona" : "Create persona"}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setShowPersonaForm(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Resolve</h2>
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
          <button onClick={resolve} disabled={resolving}>
            {resolving ? "Resolving…" : "Resolve context"}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {bundle && (
          <div className="bundle">
            <p className="bundle-summary">
              {bundle.sections.filter((s) => s.included).length} of {bundle.sections.length}{" "}
              sections included · ~{bundle.includedTokens} tokens of {bundle.tokenBudget} budget
              {bundle.overBudget && (
                <span className="error"> — over budget: trim your docs or raise the budget</span>
              )}
            </p>
            <ol className="section-list">
              {bundle.sections.map((s: ContextSection) => (
                <li key={s.key} className={`section-card ${s.included ? "" : "excluded"}`}>
                  <div
                    className="section-head"
                    onClick={() => setExpanded((e) => ({ ...e, [s.key]: !e[s.key] }))}
                  >
                    <span className={`layer-badge layer-${s.layer}`}>{s.layer}</span>
                    <span className="section-title">{s.title}</span>
                    <span className="section-tokens">
                      {s.included ? `~${s.tokens} tok` : "excluded"}
                    </span>
                  </div>
                  <p className="section-reason">{s.reason}</p>
                  {expanded[s.key] && s.content && (
                    <pre className="section-content">{s.content}</pre>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>
    </>
  );
}
