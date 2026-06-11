"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  SIGNAL_SOURCES,
  type ApprovalState,
  type Campaign,
  type Channel,
  type Persona,
  type SignalSource,
  type Workspace,
} from "@tuezday/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const SOURCE_LABELS: Record<SignalSource, string> = {
  reddit: "Reddit",
  x: "X",
  linkedin: "LinkedIn",
  rss: "RSS",
  news: "News",
  other: "Other",
};

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  edited: "Edited",
  approved: "Approved",
  rejected: "Rejected",
};

interface SignalView {
  id: string;
  content: string;
  source: SignalSource;
  sourceUrl: string | null;
  createdAt: number;
  drafts: { id: string; state: ApprovalState; channel: Channel; createdAt: number }[];
}

export default function ContentPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [signalsList, setSignalsList] = useState<SignalView[]>([]);
  const [error, setError] = useState<string | null>(null);

  // new signal form
  const [content, setContent] = useState("");
  const [source, setSource] = useState<SignalSource>("linkedin");
  const [sourceUrl, setSourceUrl] = useState("");
  const [saving, setSaving] = useState(false);

  // draft-response controls per signal
  const [draftingFor, setDraftingFor] = useState<string | null>(null);
  const [draftChannel, setDraftChannel] = useState<Channel>("linkedin");
  const [draftPersonaId, setDraftPersonaId] = useState("");
  const [draftCampaignId, setDraftCampaignId] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, sRes, cRes] = await Promise.all([
        fetch(`${API_URL}/workspaces/${id}`),
        fetch(`${API_URL}/workspaces/${id}/personas`),
        fetch(`${API_URL}/workspaces/${id}/signals`),
        fetch(`${API_URL}/workspaces/${id}/campaigns`),
      ]);
      if (!wsRes.ok || !pRes.ok || !sRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setSignalsList(await sRes.json());
      setCampaigns(((await cRes.json()) as Campaign[]).filter((c) => c.status === "active"));
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addSignal(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/workspaces/${id}/signals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          source,
          ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setContent("");
      setSourceUrl("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add signal");
    } finally {
      setSaving(false);
    }
  }

  async function draftResponse(signalId: string) {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/workspaces/${id}/signals/${signalId}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: draftChannel,
          personaId: draftPersonaId || undefined,
          campaignId: draftCampaignId || undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setDraftingFor(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to draft a response");
    } finally {
      setGenerating(false);
    }
  }

  async function fetchDraftContent(draftId: string): Promise<string | null> {
    const res = await fetch(`${API_URL}/workspaces/${id}/drafts/${draftId}`);
    if (!res.ok) return null;
    return (await res.json()).content;
  }

  async function copyDraft(draftId: string) {
    const text = await fetchDraftContent(draftId);
    if (text === null) return;
    await navigator.clipboard.writeText(text);
    setCopied(draftId);
    setTimeout(() => setCopied(null), 2000);
  }

  async function downloadDraft(draftId: string, channel: string) {
    const text = await fetchDraftContent(draftId);
    if (text === null) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    a.download = `tuezday-${channel}-${draftId.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
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
            <Link href={`/workspaces/${id}`}>{workspace.name}</Link> / Content
          </p>
          <h1>Content</h1>
          <p className="subtitle">
            Paste a market signal → Tuezday drafts your response through the brain → approve →
            ship it.
          </p>
        </div>
        <div className="persona-actions">
          <Link className="button-secondary" href={`/workspaces/${id}`}>
            ← Brain
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/discovery`}>
            Discovery
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/approvals`}>
            Approvals
          </Link>
        </div>
      </div>

      <section className="panel">
        <h2>New signal</h2>
        <form className="persona-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }} onSubmit={addSignal}>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste the post, thread, comment, or customer quote you want to respond to…"
            rows={5}
            maxLength={10000}
          />
          <div className="resolve-controls">
            <label>
              Source
              <select value={source} onChange={(e) => setSource(e.target.value as SignalSource)}>
                {SIGNAL_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              Source URL (optional)
              <input
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://…"
              />
            </label>
            <button type="submit" disabled={saving || content.trim().length === 0}>
              {saving ? "Adding…" : "Add signal"}
            </button>
          </div>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <h2>Signal inbox</h2>
        {signalsList.length === 0 ? (
          <p className="empty">No signals yet. Paste something the market said above.</p>
        ) : (
          <ul className="section-list">
            {signalsList.map((s) => (
              <li key={s.id} className="section-card">
                <div className="section-head">
                  <span className="layer-badge">{SOURCE_LABELS[s.source]}</span>
                  <span className="section-title">
                    {s.sourceUrl ? (
                      <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="signal-link">
                        {s.content.slice(0, 80)}
                        {s.content.length > 80 ? "…" : ""}
                      </a>
                    ) : (
                      <>
                        {s.content.slice(0, 80)}
                        {s.content.length > 80 ? "…" : ""}
                      </>
                    )}
                  </span>
                  <span className="section-tokens">{new Date(s.createdAt).toLocaleString()}</span>
                </div>
                <pre className="section-content signal-content">{s.content}</pre>

                {s.drafts.length > 0 && (
                  <ul className="draft-chain">
                    {s.drafts.map((d) => (
                      <li key={d.id}>
                        <span className={`layer-badge state-${d.state}`}>
                          {STATE_LABELS[d.state]}
                        </span>{" "}
                        <span className="meta">{d.channel} response</span>{" "}
                        <Link className="link-button" href={`/workspaces/${id}/approvals`}>
                          open in queue
                        </Link>
                        {d.state === "approved" && (
                          <>
                            {" "}
                            <button className="link-button" onClick={() => copyDraft(d.id)}>
                              {copied === d.id ? "copied!" : "copy"}
                            </button>{" "}
                            <button
                              className="link-button"
                              onClick={() => downloadDraft(d.id, d.channel)}
                            >
                              download .md
                            </button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {draftingFor === s.id ? (
                  <div className="resolve-controls" style={{ marginTop: 10 }}>
                    <label>
                      Channel
                      <select
                        value={draftChannel}
                        onChange={(e) => setDraftChannel(e.target.value as Channel)}
                      >
                        {CHANNELS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Persona
                      <select
                        value={draftPersonaId}
                        onChange={(e) => setDraftPersonaId(e.target.value)}
                      >
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
                        <select
                          value={draftCampaignId}
                          onChange={(e) => setDraftCampaignId(e.target.value)}
                        >
                          <option value="">(no campaign)</option>
                          {campaigns.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button disabled={generating} onClick={() => draftResponse(s.id)}>
                      {generating ? "Drafting…" : "Generate draft"}
                    </button>
                    <button
                      className="button-secondary"
                      onClick={() => setDraftingFor(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="rating-row" style={{ marginTop: 10 }}>
                    <button className="button-secondary" onClick={() => setDraftingFor(s.id)}>
                      Draft response
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
