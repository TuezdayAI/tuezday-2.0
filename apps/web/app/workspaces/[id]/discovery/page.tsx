"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  DISCOVERY_SOURCE_TYPES,
  type DiscoveredItem,
  type DiscoverySource,
  type DiscoverySourceType,
  type Persona,
  type Workspace,
} from "@tuezday/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const TYPE_LABELS: Record<DiscoverySourceType, string> = {
  rss: "RSS feed",
  google_news: "Google News",
  reddit: "Reddit",
  x: "X (needs API key)",
  linkedin: "LinkedIn (needs API key)",
};

interface SourceProposal {
  type: DiscoverySourceType;
  name: string;
  config: { feedUrl?: string; query?: string; subreddit?: string };
  reason: string;
}

interface RunSummary {
  sources: { sourceId: string; name: string; fetched: number; new: number; error?: string }[];
  scored: number;
}

export default function DiscoveryPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [inbox, setInbox] = useState<DiscoveredItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // add-source form
  const [showForm, setShowForm] = useState(false);
  const [newType, setNewType] = useState<DiscoverySourceType>("google_news");
  const [feedUrl, setFeedUrl] = useState("");
  const [query, setQuery] = useState("");
  const [subreddit, setSubreddit] = useState("");

  const [running, setRunning] = useState(false);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [proposals, setProposals] = useState<SourceProposal[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, sRes, iRes] = await Promise.all([
        fetch(`${API_URL}/workspaces/${id}`),
        fetch(`${API_URL}/workspaces/${id}/personas`),
        fetch(`${API_URL}/workspaces/${id}/discovery/sources`),
        fetch(`${API_URL}/workspaces/${id}/discovery/items?status=new`),
      ]);
      if (!wsRes.ok || !pRes.ok || !sRes.ok || !iRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setSources(await sRes.json());
      setInbox(await iRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addSource(input: {
    type: DiscoverySourceType;
    name?: string;
    config: Record<string, string | undefined>;
  }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/workspaces/${id}/discovery/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setShowForm(false);
      setFeedUrl("");
      setQuery("");
      setSubreddit("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add source");
    } finally {
      setBusy(false);
    }
  }

  function submitForm(e: React.FormEvent) {
    e.preventDefault();
    const config: Record<string, string | undefined> = {};
    if (newType === "rss") config.feedUrl = feedUrl.trim();
    if (newType === "google_news" || newType === "x" || newType === "linkedin")
      config.query = query.trim();
    if (newType === "reddit") {
      if (subreddit.trim()) config.subreddit = subreddit.trim();
      if (query.trim()) config.query = query.trim();
    }
    void addSource({ type: newType, config });
  }

  async function toggleSource(source: DiscoverySource) {
    await fetch(`${API_URL}/workspaces/${id}/discovery/sources/${source.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !source.enabled }),
    });
    await load();
  }

  async function removeSource(source: DiscoverySource) {
    if (!confirm(`Delete source "${source.name}"? Its discovered items go with it.`)) return;
    await fetch(`${API_URL}/workspaces/${id}/discovery/sources/${source.id}`, {
      method: "DELETE",
    });
    await load();
  }

  async function runNow() {
    setRunning(true);
    setError(null);
    setRunSummary(null);
    try {
      const res = await fetch(`${API_URL}/workspaces/${id}/discovery/run`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setRunSummary(body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discovery run failed");
    } finally {
      setRunning(false);
    }
  }

  async function suggest() {
    setSuggesting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/workspaces/${id}/discovery/suggest`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setProposals(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get suggestions");
    } finally {
      setSuggesting(false);
    }
  }

  async function triage(itemId: string, action: "accept" | "skip") {
    setBusy(true);
    try {
      await fetch(`${API_URL}/workspaces/${id}/discovery/items/${itemId}/${action}`, {
        method: "POST",
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  function personaName(pid: string | null): string | null {
    if (!pid) return null;
    return personas.find((p) => p.id === pid)?.name ?? null;
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
      <div className="page-header">
        <div>
          <h1>Discover</h1>
          <p className="subtitle">
            What is happening in your market right now. Tuezday scans the sources you choose —
            you decide what becomes content.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Sources</h2>
          <div className="persona-actions">
            <button className="button-secondary" disabled={suggesting} onClick={suggest}>
              {suggesting ? "Asking the brain…" : "✨ Suggest sources"}
            </button>
            <button className="button-secondary" onClick={() => setShowForm(!showForm)}>
              + Add source
            </button>
            <button disabled={running || sources.length === 0} onClick={runNow}>
              {running ? "Running…" : "▶ Run discovery now"}
            </button>
          </div>
        </div>

        {showForm && (
          <form className="persona-form" onSubmit={submitForm}>
            <div className="resolve-controls">
              <label>
                Type
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as DiscoverySourceType)}
                >
                  {DISCOVERY_SOURCE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              {newType === "rss" && (
                <label style={{ flex: 1 }}>
                  Feed URL
                  <input
                    value={feedUrl}
                    onChange={(e) => setFeedUrl(e.target.value)}
                    placeholder="https://example.com/feed.xml"
                  />
                </label>
              )}
              {newType !== "rss" && (
                <label style={{ flex: 1 }}>
                  {newType === "reddit" ? "Query (optional with subreddit)" : "Query"}
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder='e.g. "AI GTM tools"'
                  />
                </label>
              )}
              {newType === "reddit" && (
                <label>
                  Subreddit
                  <input
                    value={subreddit}
                    onChange={(e) => setSubreddit(e.target.value)}
                    placeholder="SaaS"
                  />
                </label>
              )}
              <button type="submit" disabled={busy}>
                Add
              </button>
            </div>
          </form>
        )}

        {proposals && (
          <div className="proposals">
            <p className="subtitle">Brain-proposed sources (derived from your docs + personas):</p>
            <ul className="section-list">
              {proposals.map((p, i) => (
                <li key={i} className="section-card">
                  <div className="section-head">
                    <span className="layer-badge">{TYPE_LABELS[p.type]}</span>
                    <span className="section-title">{p.name}</span>
                    <button
                      className="button-secondary"
                      disabled={busy}
                      onClick={() => addSource({ type: p.type, name: p.name, config: p.config })}
                    >
                      + Add
                    </button>
                  </div>
                  <p className="section-reason">
                    {JSON.stringify(p.config)} — {p.reason}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {sources.length === 0 ? (
          <p className="empty">No sources yet. Add one or let the brain suggest some.</p>
        ) : (
          <ul className="section-list">
            {sources.map((s) => (
              <li key={s.id} className={`section-card ${s.enabled ? "" : "excluded"}`}>
                <div className="section-head">
                  <span
                    className={`layer-badge ${
                      s.status === "active"
                        ? "state-approved"
                        : s.status === "needs_api_key"
                          ? "state-edited"
                          : "state-rejected"
                    }`}
                  >
                    {s.status === "needs_api_key" ? "needs API key" : s.status}
                  </span>
                  <span className="section-title">{s.name}</span>
                  <span className="section-tokens">
                    {s.lastFetchedAt
                      ? `last run ${new Date(s.lastFetchedAt).toLocaleString()}`
                      : "never run"}
                  </span>
                </div>
                {s.lastError && <p className="error">{s.lastError}</p>}
                <div className="rating-row" style={{ marginTop: 8 }}>
                  <button className="button-secondary" onClick={() => toggleSource(s)}>
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="button-secondary danger" onClick={() => removeSource(s)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {runSummary && (
          <p className="bundle-summary" style={{ marginTop: 12 }}>
            Run finished:{" "}
            {runSummary.sources
              .map((s) => `${s.name}: ${s.error ? `error` : `${s.new} new of ${s.fetched}`}`)
              .join(" · ")}{" "}
            · {runSummary.scored} scored by the brain
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <h2>Triage inbox ({inbox.length})</h2>
        {inbox.length === 0 ? (
          <p className="empty">
            Nothing to triage. Run discovery, or wait for the worker's next poll.
          </p>
        ) : (
          <ul className="section-list">
            {inbox.map((item) => {
              const persona = personaName(item.suggestedPersonaId);
              return (
                <li key={item.id} className="section-card">
                  <div className="section-head">
                    <span
                      className={`layer-badge ${
                        (item.score ?? 0) >= 70
                          ? "state-approved"
                          : (item.score ?? 0) >= 40
                            ? "state-edited"
                            : ""
                      }`}
                    >
                      {item.score === null ? "unscored" : `${item.score}/100`}
                    </span>
                    <span className="section-title">
                      <a href={item.url} target="_blank" rel="noreferrer" className="signal-link">
                        {item.title}
                      </a>
                    </span>
                    <span className="section-tokens">
                      {item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : ""}
                    </span>
                  </div>
                  {item.summary && <p className="section-reason">{item.summary.slice(0, 280)}</p>}
                  <p className="section-reason">
                    {persona && (
                      <span className="layer-badge layer-persona" style={{ marginRight: 6 }}>
                        → {persona}
                      </span>
                    )}
                    {item.scoreReason ?? ""}
                  </p>
                  <div className="rating-row" style={{ marginTop: 8 }}>
                    <button
                      className="button-secondary rating-accepted"
                      disabled={busy}
                      onClick={() => triage(item.id, "accept")}
                    >
                      ✓ Accept as signal
                    </button>
                    <button
                      className="button-secondary"
                      disabled={busy}
                      onClick={() => triage(item.id, "skip")}
                    >
                      Skip
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
