"use client";

import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  SIGNAL_SOURCES,
  SOCIAL_POST_CONSTRAINTS,
  type ApprovalState,
  type Campaign,
  type Channel,
  type Connection,
  type ConnectorProvider,
  type Persona,
  type Publication,
  type SignalSource,
  type Workspace,
} from "@tuezday/contracts";

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

interface PublicationView extends Publication {
  draft: { id: string; taskType: string; channel: string; content: string } | null;
}

const PUBLICATION_BADGES: Record<Publication["status"], string> = {
  scheduled: "state-edited",
  published: "state-approved",
  failed: "state-rejected",
};

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

  // publish controls per draft
  const [socialConnections, setSocialConnections] = useState<Connection[]>([]);
  const [publications, setPublications] = useState<PublicationView[]>([]);
  const [publishingFor, setPublishingFor] = useState<string | null>(null);
  const [pubConnectionId, setPubConnectionId] = useState("");
  const [pubTarget, setPubTarget] = useState("");
  const [pubTitle, setPubTitle] = useState("");
  const [pubSchedule, setPubSchedule] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, sRes, cRes, connRes, pubRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/signals`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/connectors`),
        apiFetch(`/workspaces/${id}/publications`),
      ]);
      if (!wsRes.ok || !pRes.ok || !sRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setSignalsList(await sRes.json());
      setCampaigns(((await cRes.json()) as Campaign[]).filter((c) => c.status === "active"));
      if (connRes.ok) {
        const view = (await connRes.json()) as {
          providers: ConnectorProvider[];
          connections: Connection[];
        };
        const socialKeys = new Set(
          view.providers.filter((p) => p.categories?.includes("social")).map((p) => p.key),
        );
        setSocialConnections(
          view.connections.filter((c) => socialKeys.has(c.providerKey) && c.status === "connected"),
        );
      }
      if (pubRes.ok) setPublications(await pubRes.json());
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
      const res = await apiFetch(`/workspaces/${id}/signals`, {
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
      const res = await apiFetch(`/workspaces/${id}/signals/${signalId}/draft`, {
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
    const res = await apiFetch(`/workspaces/${id}/drafts/${draftId}`);
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

  /** Open the publish form, prefilling the title from the draft's first line. */
  async function openPublish(draftId: string) {
    const text = await fetchDraftContent(draftId);
    const constraints = SOCIAL_POST_CONSTRAINTS.reddit;
    setPubTitle((text ?? "").split("\n")[0]!.trim().slice(0, constraints.titleMaxChars));
    setPubTarget("");
    setPubSchedule("");
    setPubConnectionId(socialConnections[0]?.id ?? "");
    setPublishError(null);
    setPublishingFor(draftId);
  }

  async function publishDraft(draftId: string) {
    setPublishing(true);
    setPublishError(null);
    try {
      const scheduledFor = pubSchedule ? new Date(pubSchedule).getTime() : undefined;
      const res = await apiFetch(`/workspaces/${id}/drafts/${draftId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: pubConnectionId,
          target: pubTarget.trim().replace(/^r\//, ""),
          title: pubTitle.trim(),
          ...(scheduledFor ? { scheduledFor } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      if (body.status === "failed") {
        throw new Error(body.lastError ?? "The platform refused the post.");
      }
      setPublishingFor(null);
      await load();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Publish failed");
      await load(); // a failed attempt still leaves a receipt to show
    } finally {
      setPublishing(false);
    }
  }

  async function retryPublication(publicationId: string) {
    setPublishing(true);
    try {
      await apiFetch(`/workspaces/${id}/publications/${publicationId}/retry`, {
        method: "POST",
      });
      await load();
    } finally {
      setPublishing(false);
    }
  }

  async function cancelPublication(publicationId: string) {
    if (!confirm("Cancel this scheduled post?")) return;
    await apiFetch(`/workspaces/${id}/publications/${publicationId}`, { method: "DELETE" });
    await load();
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
      <div className="page-header">
        <div>
          <h1>Create</h1>
          <p className="subtitle">
            Turn a market signal into a post, email, or ad in your voice. Every draft goes to
            Review before it ships.
          </p>
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
                            </button>{" "}
                            <button className="link-button" onClick={() => openPublish(d.id)}>
                              publish…
                            </button>
                            {publications
                              .filter((p) => p.draftId === d.id)
                              .map((p) => (
                                <span
                                  key={p.id}
                                  className={`layer-badge ${PUBLICATION_BADGES[p.status]}`}
                                  style={{ marginLeft: 6 }}
                                >
                                  {p.status === "published" && p.externalUrl ? (
                                    <a href={p.externalUrl} target="_blank" rel="noreferrer">
                                      live on r/{p.target}
                                    </a>
                                  ) : p.status === "scheduled" ? (
                                    `scheduled · r/${p.target}`
                                  ) : (
                                    `failed · r/${p.target}`
                                  )}
                                </span>
                              ))}
                          </>
                        )}
                        {publishingFor === d.id && (
                          <div className="resolve-controls" style={{ marginTop: 10 }}>
                            {socialConnections.length === 0 ? (
                              <p className="empty">
                                No social account connected.{" "}
                                <Link href={`/workspaces/${id}/connectors`}>
                                  Connect Reddit on the Integrations page
                                </Link>{" "}
                                first.
                              </p>
                            ) : (
                              <>
                                <label>
                                  Account
                                  <select
                                    value={pubConnectionId}
                                    onChange={(e) => setPubConnectionId(e.target.value)}
                                  >
                                    {socialConnections.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.providerKey}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label>
                                  Subreddit
                                  <input
                                    value={pubTarget}
                                    onChange={(e) => setPubTarget(e.target.value)}
                                    placeholder="r/test"
                                  />
                                </label>
                                <label style={{ flex: 1 }}>
                                  Title ({pubTitle.length}/
                                  {SOCIAL_POST_CONSTRAINTS.reddit.titleMaxChars})
                                  <input
                                    value={pubTitle}
                                    onChange={(e) => setPubTitle(e.target.value)}
                                  />
                                </label>
                                <label>
                                  Schedule (optional)
                                  <input
                                    type="datetime-local"
                                    value={pubSchedule}
                                    onChange={(e) => setPubSchedule(e.target.value)}
                                  />
                                </label>
                                <button
                                  disabled={
                                    publishing ||
                                    !pubConnectionId ||
                                    !pubTarget.trim() ||
                                    !pubTitle.trim() ||
                                    pubTitle.length > SOCIAL_POST_CONSTRAINTS.reddit.titleMaxChars
                                  }
                                  onClick={() => publishDraft(d.id)}
                                >
                                  {publishing
                                    ? "Publishing…"
                                    : pubSchedule
                                      ? "Schedule"
                                      : "Post now"}
                                </button>
                              </>
                            )}
                            <button
                              className="button-secondary"
                              onClick={() => setPublishingFor(null)}
                            >
                              Cancel
                            </button>
                            {publishError && <p className="error">{publishError}</p>}
                          </div>
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

      <section className="panel">
        <h2>Published</h2>
        {publications.length === 0 ? (
          <p className="empty">
            Nothing published yet. Approve a draft, then use publish… to post it to a connected
            social account.
          </p>
        ) : (
          <ul className="section-list">
            {publications.map((p) => (
              <li key={p.id} className="section-card">
                <div className="section-head">
                  <span className={`layer-badge ${PUBLICATION_BADGES[p.status]}`}>{p.status}</span>
                  <span className="section-title">{p.title}</span>
                  <span className="section-tokens">
                    {p.providerKey} · r/{p.target}
                  </span>
                </div>
                <p className="section-reason">
                  {p.status === "published" && p.externalUrl && (
                    <>
                      Live at{" "}
                      <a href={p.externalUrl} target="_blank" rel="noreferrer">
                        {p.externalUrl}
                      </a>{" "}
                      ({new Date(p.publishedAt ?? p.updatedAt).toLocaleString()})
                    </>
                  )}
                  {p.status === "scheduled" &&
                    `Posts at ${new Date(p.scheduledFor).toLocaleString()}`}
                  {p.status === "failed" && (p.lastError ?? "The platform refused the post.")}
                </p>
                <div className="rating-row" style={{ marginTop: 8 }}>
                  {p.status === "failed" && (
                    <button
                      className="button-secondary"
                      disabled={publishing}
                      onClick={() => retryPublication(p.id)}
                    >
                      Retry
                    </button>
                  )}
                  {p.status === "scheduled" && (
                    <button
                      className="button-secondary danger"
                      onClick={() => cancelPublication(p.id)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
