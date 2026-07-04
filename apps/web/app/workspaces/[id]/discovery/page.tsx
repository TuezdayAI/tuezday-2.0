"use client";

import { EmptyState } from "@/src/components/empty-state";
import { ShowMoreButton, useShowMore } from "@/src/components/show-more";


import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  DISCOVERY_SOURCE_TYPES,
  TRACKED_SOCIAL_PLATFORMS,
  type Campaign,
  type Connection,
  type DiscoveredItem,
  type DiscoverySource,
  type DiscoverySourceMode,
  type DiscoverySourceType,
  type Persona,
  type TrackedSocialAccount,
  type TrackedSocialPlatform,
  type Workspace,
} from "@tuezday/contracts";

// Connector provider key a connected source of each social type reads through
// (mirrors providerForDiscoverySourceType on the API).
const SOURCE_PROVIDERS: Partial<Record<DiscoverySourceType, string>> = {
  x: "twitter",
  linkedin: "linkedin",
  instagram: "instagram",
  reddit: "reddit",
};

const PLATFORM_LABELS: Record<TrackedSocialPlatform, string> = {
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  reddit: "Reddit",
};

/** Reddit "handles" are subreddits/users, not @-handles. */
function trackedHandleLabel(account: TrackedSocialAccount): string {
  return account.platform === "reddit" ? `u/${account.handle}` : `@${account.handle}`;
}

const TYPE_LABELS: Record<DiscoverySourceType, string> = {
  rss: "RSS feed",
  google_news: "Google News",
  reddit: "Reddit",
  hacker_news: "Hacker News",
  youtube: "YouTube channel",
  podcast: "Podcast",
  google_trends: "Google Trends",
  funding_news: "Funding news",
  x: "X (connected or API key)",
  linkedin: "LinkedIn (connected or API key)",
  instagram: "Instagram (connected account)",
  g2: "G2 reviews (needs API key)",
  capterra: "Capterra reviews (needs API key)",
  intent: "Intent signals (needs API key)",
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

// Shape of GET /workspaces/:id/discovery/items/:itemId/duplicates (Sprint 45).
interface DuplicateRef {
  id: string;
  sourceId: string;
  sourceName: string;
  createdAt: number;
}

export default function DiscoveryPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [tracked, setTracked] = useState<TrackedSocialAccount[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [inbox, setInbox] = useState<DiscoveredItem[]>([]);
  const inboxList = useShowMore(inbox, 50);
  const [error, setError] = useState<string | null>(null);

  // add-source form
  const [showForm, setShowForm] = useState(false);
  const [newType, setNewType] = useState<DiscoverySourceType>("google_news");
  const [feedUrl, setFeedUrl] = useState("");
  const [query, setQuery] = useState("");
  const [subreddit, setSubreddit] = useState("");
  const [channelId, setChannelId] = useState("");
  const [geo, setGeo] = useState("");
  const [sector, setSector] = useState("");
  // connected-source fields (Sprint 46)
  const [connectionId, setConnectionId] = useState("");
  const [mode, setMode] = useState<DiscoverySourceMode | "">("");
  const [handle, setHandle] = useState("");
  const [listId, setListId] = useState("");
  const [hashtag, setHashtag] = useState("");
  const [trackedAccountId, setTrackedAccountId] = useState("");

  // tracked-accounts form
  const [showTrackedForm, setShowTrackedForm] = useState(false);
  const [trackedPlatform, setTrackedPlatform] = useState<TrackedSocialPlatform>("x");
  const [trackedHandle, setTrackedHandle] = useState("");
  const [trackedDisplayName, setTrackedDisplayName] = useState("");
  const [trackedNotes, setTrackedNotes] = useState("");
  const [trackedError, setTrackedError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [proposals, setProposals] = useState<SourceProposal[] | null>(null);
  const [busy, setBusy] = useState(false);

  // "seen via N sources" expansion (Sprint 45 cross-source dedup)
  const [dupesOpen, setDupesOpen] = useState<Record<string, boolean>>({});
  const [dupes, setDupes] = useState<Record<string, DuplicateRef[]>>({});

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, cRes, sRes, tRes, iRes, connRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/discovery/sources`),
        apiFetch(`/workspaces/${id}/discovery/tracked-accounts`),
        apiFetch(`/workspaces/${id}/discovery/items?status=new`),
        apiFetch(`/workspaces/${id}/connectors`),
      ]);
      if (!wsRes.ok || !pRes.ok || !cRes.ok || !sRes.ok || !tRes.ok || !iRes.ok)
        throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setCampaigns(await cRes.json());
      setSources(await sRes.json());
      setTracked(await tRes.json());
      setInbox(await iRes.json());
      // Best-effort: the source form still works keyless if this fails.
      if (connRes.ok) {
        const view = (await connRes.json()) as { connections?: Connection[] };
        setConnections(view.connections ?? []);
      }
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
    connectionId?: string;
  }) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/discovery/sources`, {
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
      setChannelId("");
      setGeo("");
      setSector("");
      setConnectionId("");
      setMode("");
      setHandle("");
      setListId("");
      setHashtag("");
      setTrackedAccountId("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add source");
    } finally {
      setBusy(false);
    }
  }

  /** Connected accounts this source type can read through. */
  function connectionsForType(type: DiscoverySourceType): Connection[] {
    const provider = SOURCE_PROVIDERS[type];
    if (!provider) return [];
    return connections.filter((c) => c.providerKey === provider && c.status === "connected");
  }

  /** Tracked accounts on this source type's platform (source types map 1:1). */
  function trackedForType(type: DiscoverySourceType): TrackedSocialAccount[] {
    return tracked.filter((a) => a.platform === type && a.enabled);
  }

  // Effective listen mode while the form is open. X defaults to search; a
  // connected LinkedIn source only supports account timelines; Instagram
  // defaults to account posts.
  const xMode: DiscoverySourceMode = mode === "" ? "query" : mode;
  const igMode: DiscoverySourceMode = mode === "" ? "account_timeline" : mode;

  const matchingConnections = connectionsForType(newType);
  const showConnectionPicker = Boolean(SOURCE_PROVIDERS[newType]);
  const instagramUnconnectable = newType === "instagram" && matchingConnections.length === 0;
  const showQueryField =
    newType === "google_news" ||
    newType === "reddit" ||
    newType === "hacker_news" ||
    newType === "funding_news" ||
    newType === "g2" ||
    newType === "capterra" ||
    newType === "intent" ||
    (newType === "x" && (!connectionId || xMode === "query")) ||
    (newType === "linkedin" && !connectionId);
  const showAccountTarget =
    (newType === "x" && Boolean(connectionId) && xMode === "account_timeline") ||
    (newType === "linkedin" && Boolean(connectionId)) ||
    (newType === "instagram" && igMode === "account_timeline");

  function submitForm(e: React.FormEvent) {
    e.preventDefault();
    const config: Record<string, string | undefined> = {};
    const accountTarget: Record<string, string | undefined> = trackedAccountId
      ? { trackedAccountId }
      : { handle: handle.trim() || undefined };
    if (newType === "rss" || newType === "podcast") config.feedUrl = feedUrl.trim();
    if (
      newType === "google_news" ||
      newType === "hacker_news" ||
      newType === "funding_news" ||
      newType === "g2" ||
      newType === "capterra" ||
      newType === "intent"
    )
      config.query = query.trim();
    if (newType === "reddit") {
      if (subreddit.trim()) config.subreddit = subreddit.trim();
      if (query.trim()) config.query = query.trim();
    }
    if (newType === "x") {
      if (connectionId) {
        config.mode = xMode;
        if (xMode === "query") config.query = query.trim();
        if (xMode === "account_timeline") Object.assign(config, accountTarget);
        if (xMode === "list_timeline") config.listId = listId.trim();
      } else {
        config.query = query.trim();
      }
    }
    if (newType === "linkedin") {
      if (connectionId) {
        config.mode = "account_timeline";
        Object.assign(config, accountTarget);
      } else {
        config.query = query.trim();
      }
    }
    if (newType === "instagram") {
      config.mode = igMode;
      if (igMode === "account_timeline") Object.assign(config, accountTarget);
      if (igMode === "hashtag") config.hashtag = hashtag.trim();
    }
    if (newType === "youtube") config.channelId = channelId.trim();
    if (newType === "google_trends" && geo.trim()) config.geo = geo.trim();
    if (newType === "funding_news" && sector.trim()) config.sector = sector.trim();
    void addSource({
      type: newType,
      config,
      ...(connectionId ? { connectionId } : {}),
    });
  }

  async function toggleSource(source: DiscoverySource) {
    await apiFetch(`/workspaces/${id}/discovery/sources/${source.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !source.enabled }),
    });
    await load();
  }

  async function removeSource(source: DiscoverySource) {
    if (!confirm(`Delete source "${source.name}"? Its discovered items go with it.`)) return;
    await apiFetch(`/workspaces/${id}/discovery/sources/${source.id}`, {
      method: "DELETE",
    });
    await load();
  }

  async function addTrackedAccount(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setTrackedError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/discovery/tracked-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: trackedPlatform,
          handle: trackedHandle.trim(),
          ...(trackedDisplayName.trim() ? { displayName: trackedDisplayName.trim() } : {}),
          ...(trackedNotes.trim() ? { notes: trackedNotes.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setShowTrackedForm(false);
      setTrackedHandle("");
      setTrackedDisplayName("");
      setTrackedNotes("");
      await load();
    } catch (err) {
      setTrackedError(err instanceof Error ? err.message : "Failed to add tracked account");
    } finally {
      setBusy(false);
    }
  }

  async function toggleTrackedAccount(account: TrackedSocialAccount) {
    await apiFetch(`/workspaces/${id}/discovery/tracked-accounts/${account.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !account.enabled }),
    });
    await load();
  }

  async function removeTrackedAccount(account: TrackedSocialAccount) {
    if (
      !confirm(
        `Stop tracking ${PLATFORM_LABELS[account.platform]} ${trackedHandleLabel(account)}?`,
      )
    )
      return;
    await apiFetch(`/workspaces/${id}/discovery/tracked-accounts/${account.id}`, {
      method: "DELETE",
    });
    await load();
  }

  async function runNow() {
    setRunning(true);
    setError(null);
    setRunSummary(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/discovery/run`, { method: "POST" });
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
      const res = await apiFetch(`/workspaces/${id}/discovery/suggest`, { method: "POST" });
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
      await apiFetch(`/workspaces/${id}/discovery/items/${itemId}/${action}`, {
        method: "POST",
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleDuplicates(itemId: string) {
    if (dupesOpen[itemId]) {
      setDupesOpen((o) => ({ ...o, [itemId]: false }));
      return;
    }
    try {
      const res = await apiFetch(`/workspaces/${id}/discovery/items/${itemId}/duplicates`);
      if (res.ok) {
        const body = (await res.json()) as DuplicateRef[];
        setDupes((d) => ({ ...d, [itemId]: body }));
      }
    } catch {
      // best-effort: the expansion just shows nothing if the fetch fails
    }
    setDupesOpen((o) => ({ ...o, [itemId]: true }));
  }

  function personaName(pid: string | null): string | null {
    if (!pid) return null;
    return personas.find((p) => p.id === pid)?.name ?? null;
  }

  function campaignName(cid: string | null): string | null {
    if (!cid) return null;
    return campaigns.find((c) => c.id === cid)?.name ?? null;
  }

  function sourceName(sid: string): string {
    return sources.find((s) => s.id === sid)?.name ?? "unknown source";
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
                  onChange={(e) => {
                    setNewType(e.target.value as DiscoverySourceType);
                    setConnectionId("");
                    setMode("");
                    setTrackedAccountId("");
                  }}
                >
                  {DISCOVERY_SOURCE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              {showConnectionPicker && (
                <label>
                  Read through
                  <select
                    value={connectionId}
                    onChange={(e) => {
                      setConnectionId(e.target.value);
                      setMode("");
                      setTrackedAccountId("");
                    }}
                  >
                    <option value="">
                      {newType === "instagram"
                        ? "Choose an account…"
                        : newType === "reddit"
                          ? "No account (public RSS)"
                          : "No account (needs API key)"}
                    </option>
                    {matchingConnections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {newType === "x" && connectionId && (
                <label>
                  Listen for
                  <select
                    value={xMode}
                    onChange={(e) => {
                      setMode(e.target.value as DiscoverySourceMode);
                      setTrackedAccountId("");
                    }}
                  >
                    <option value="query">Recent post search</option>
                    <option value="account_timeline">Account timeline</option>
                    <option value="list_timeline">List timeline</option>
                  </select>
                </label>
              )}
              {newType === "instagram" && (
                <label>
                  Listen for
                  <select
                    value={igMode}
                    onChange={(e) => {
                      setMode(e.target.value as DiscoverySourceMode);
                      setTrackedAccountId("");
                    }}
                  >
                    <option value="account_timeline">Account posts</option>
                    <option value="hashtag">Hashtag</option>
                  </select>
                </label>
              )}
              {(newType === "rss" || newType === "podcast") && (
                <label style={{ flex: 1 }}>
                  Feed URL
                  <input
                    value={feedUrl}
                    onChange={(e) => setFeedUrl(e.target.value)}
                    placeholder="https://example.com/feed.xml"
                  />
                </label>
              )}
              {showQueryField && (
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
              {showAccountTarget && (
                <>
                  {trackedForType(newType).length > 0 && (
                    <label>
                      Tracked account
                      <select
                        value={trackedAccountId}
                        onChange={(e) => setTrackedAccountId(e.target.value)}
                      >
                        <option value="">Type a handle instead…</option>
                        {trackedForType(newType).map((a) => (
                          <option key={a.id} value={a.id}>
                            {trackedHandleLabel(a)}
                            {a.displayName ? ` — ${a.displayName}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {!trackedAccountId && (
                    <label>
                      Handle
                      <input
                        value={handle}
                        onChange={(e) => setHandle(e.target.value)}
                        placeholder="@competitor"
                      />
                    </label>
                  )}
                </>
              )}
              {newType === "x" && connectionId && xMode === "list_timeline" && (
                <label>
                  List ID
                  <input
                    value={listId}
                    onChange={(e) => setListId(e.target.value)}
                    placeholder="1234567890"
                  />
                </label>
              )}
              {newType === "instagram" && igMode === "hashtag" && (
                <label>
                  Hashtag
                  <input
                    value={hashtag}
                    onChange={(e) => setHashtag(e.target.value)}
                    placeholder="gtmstrategy"
                  />
                </label>
              )}
              {newType === "youtube" && (
                <label style={{ flex: 1 }}>
                  Channel ID
                  <input
                    value={channelId}
                    onChange={(e) => setChannelId(e.target.value)}
                    placeholder="UCxxxxxxxxxxxxxxxxxxxxxx"
                  />
                </label>
              )}
              {newType === "google_trends" && (
                <label>
                  Geo (optional)
                  <input value={geo} onChange={(e) => setGeo(e.target.value)} placeholder="US" />
                </label>
              )}
              {newType === "funding_news" && (
                <label>
                  Sector (optional)
                  <input
                    value={sector}
                    onChange={(e) => setSector(e.target.value)}
                    placeholder="fintech"
                  />
                </label>
              )}
              <button
                type="submit"
                disabled={busy || (newType === "instagram" && !connectionId)}
              >
                Add
              </button>
            </div>
            {instagramUnconnectable && (
              <p className="empty">
                Instagram discovery reads through a connected professional account — connect
                Instagram on the Integrations page first.
              </p>
            )}
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
          <EmptyState description={<>No sources yet. Add one or let the brain suggest some.</>} />
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
        <div className="panel-title-row">
          <h2>Tracked accounts</h2>
          <div className="persona-actions">
            <button
              className="button-secondary"
              onClick={() => setShowTrackedForm(!showTrackedForm)}
            >
              + Track account
            </button>
          </div>
        </div>
        <p className="subtitle">
          Competitor and source handles your connected sources can listen to — pick them in a
          source instead of retyping handles.
        </p>

        {showTrackedForm && (
          <form className="persona-form" onSubmit={addTrackedAccount}>
            <div className="resolve-controls">
              <label>
                Platform
                <select
                  value={trackedPlatform}
                  onChange={(e) => setTrackedPlatform(e.target.value as TrackedSocialPlatform)}
                >
                  {TRACKED_SOCIAL_PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {PLATFORM_LABELS[p]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Handle
                <input
                  value={trackedHandle}
                  onChange={(e) => setTrackedHandle(e.target.value)}
                  placeholder={trackedPlatform === "reddit" ? "u/competitor" : "@competitor"}
                />
              </label>
              <label>
                Display name (optional)
                <input
                  value={trackedDisplayName}
                  onChange={(e) => setTrackedDisplayName(e.target.value)}
                  placeholder="Competitor Inc"
                />
              </label>
              <label style={{ flex: 1 }}>
                Notes (optional)
                <input
                  value={trackedNotes}
                  onChange={(e) => setTrackedNotes(e.target.value)}
                  placeholder="why this account matters"
                />
              </label>
              <button type="submit" disabled={busy || !trackedHandle.trim()}>
                Add
              </button>
            </div>
          </form>
        )}
        {trackedError && <p className="error">{trackedError}</p>}

        {tracked.length === 0 ? (
          <EmptyState description={<>No tracked accounts yet. They are optional — add competitor handles here to reuse them across connected sources.</>} />
        ) : (
          <ul className="section-list">
            {tracked.map((a) => (
              <li key={a.id} className={`section-card ${a.enabled ? "" : "excluded"}`}>
                <div className="section-head">
                  <span className="layer-badge">{PLATFORM_LABELS[a.platform]}</span>
                  <span className="section-title">
                    {trackedHandleLabel(a)}
                    {a.displayName ? ` — ${a.displayName}` : ""}
                  </span>
                  <span className="section-tokens">
                    {a.enabled
                      ? a.lastResolvedAt
                        ? `resolved ${new Date(a.lastResolvedAt).toLocaleString()}`
                        : "not resolved yet"
                      : "disabled"}
                  </span>
                </div>
                {a.notes && <p className="section-reason">{a.notes}</p>}
                {a.lastError && <p className="error">{a.lastError}</p>}
                <div className="rating-row" style={{ marginTop: 8 }}>
                  <button className="button-secondary" onClick={() => toggleTrackedAccount(a)}>
                    {a.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    className="button-secondary danger"
                    onClick={() => removeTrackedAccount(a)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Triage inbox ({inbox.length})</h2>
        {inbox.length === 0 ? (
          <EmptyState description={<>Nothing to triage. Run discovery, or wait for the worker's next poll.</>} />
        ) : (
          <ul className="section-list">
            {inboxList.visible.map((item) => {
              const persona = personaName(item.suggestedPersonaId);
              const campaign = campaignName(item.suggestedCampaignId);
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
                    {item.duplicateCount > 0 && (
                      <span
                        className="layer-badge layer-zoom"
                        role="button"
                        style={{ cursor: "pointer" }}
                        title="The same story arrived from more than one source — click to see which"
                        onClick={() => void toggleDuplicates(item.id)}
                      >
                        seen via {item.duplicateCount + 1} sources{" "}
                        {dupesOpen[item.id] ? "▾" : "▸"}
                      </span>
                    )}
                    <span className="section-tokens">
                      {item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : ""}
                    </span>
                  </div>
                  {item.summary && <p className="section-reason">{item.summary.slice(0, 280)}</p>}
                  {item.matches.length > 0 ? (
                    <p className="section-reason">
                      {item.matches.map((m, i) => (
                        <span
                          key={i}
                          className={`layer-badge ${
                            m.score >= 70 ? "state-approved" : m.score >= 40 ? "state-edited" : ""
                          }`}
                          style={{ marginRight: 6, cursor: "help" }}
                          title={m.reason || "No reason given"}
                        >
                          {m.personaName ? `→ ${m.personaName} · ` : ""}
                          {m.campaignName ? `◆ ${m.campaignName} · ` : ""}
                          {m.score}/100
                        </span>
                      ))}
                      {item.scoreReason ?? ""}
                    </p>
                  ) : (
                    <p className="section-reason">
                      {persona && (
                        <span className="layer-badge layer-persona" style={{ marginRight: 6 }}>
                          → {persona}
                        </span>
                      )}
                      {campaign && (
                        <span className="layer-badge layer-campaign" style={{ marginRight: 6 }}>
                          ◆ {campaign}
                        </span>
                      )}
                      {item.scoreReason ?? ""}
                    </p>
                  )}
                  {dupesOpen[item.id] && (
                    <div style={{ marginTop: 6 }}>
                      <p className="section-reason" style={{ margin: "2px 0" }}>
                        ⧉ {sourceName(item.sourceId)} — fetched{" "}
                        {new Date(item.createdAt).toLocaleString()}
                      </p>
                      {(dupes[item.id] ?? []).map((d) => (
                        <p key={d.id} className="section-reason" style={{ margin: "2px 0" }}>
                          ⧉ {d.sourceName} — fetched {new Date(d.createdAt).toLocaleString()}
                        </p>
                      ))}
                    </div>
                  )}
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
        <ShowMoreButton
          hasMore={inboxList.hasMore}
          remaining={inboxList.remaining}
          onClick={inboxList.showMore}
        />
      </section>
    </>
  );
}
