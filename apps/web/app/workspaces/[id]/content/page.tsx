"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { PreviewCard } from "@/src/components/ui/preview-card";
import type { BrandName } from "@/src/components/ui/brand-icons";
import { Input, Textarea, Select } from "@/src/components/ui/input";
import styles from "./content.module.css";

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
  type PublicationMetric,
  type SignalSource,
  type Workspace,
} from "@tuezday/contracts";

const SOURCE_LABELS: Record<SignalSource, string> = {
  reddit: "Reddit",
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  rss: "RSS",
  news: "News",
  hacker_news: "Hacker News",
  youtube: "YouTube",
  podcast: "Podcast",
  google_trends: "Google Trends",
  funding: "Funding",
  g2: "G2",
  capterra: "Capterra",
  intent: "Intent",
  other: "Other",
};

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  edited: "Edited",
  approved: "Approved",
  rejected: "Rejected",
};

const STATE_BADGE_TONES: Record<
  ApprovalState,
  "draft" | "pending" | "edited" | "approved" | "rejected"
> = {
  draft: "draft",
  pending_review: "pending",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
};

interface SignalView {
  id: string;
  content: string;
  source: SignalSource;
  sourceUrl: string | null;
  suggestedPersonaId: string | null;
  suggestedCampaignId: string | null;
  createdAt: number;
  drafts: { id: string; state: ApprovalState; channel: Channel; createdAt: number }[];
}

interface PublicationView extends Publication {
  draft: { id: string; taskType: string; channel: string; content: string } | null;
  metrics: PublicationMetric[];
}

/** Compact "12 likes · 3 comments" style line for one engagement snapshot. */
function metricSummary(m: PublicationMetric): string {
  const parts: string[] = [];
  if (m.likes != null) parts.push(`${m.likes} likes`);
  if (m.comments != null) parts.push(`${m.comments} comments`);
  if (m.shares != null) parts.push(`${m.shares} shares`);
  if (m.impressions != null) parts.push(`${m.impressions} impressions`);
  if (m.clicks != null) parts.push(`${m.clicks} clicks`);
  return parts.length > 0 ? parts.join(" · ") : "no counts available";
}

const PUBLICATION_BADGE_TONES: Record<Publication["status"], "edited" | "approved" | "rejected"> = {
  scheduled: "edited",
  published: "approved",
  failed: "rejected",
};

const BRAND_KEYS = ["linkedin", "x", "reddit", "instagram", "meta", "google"] as const;

function brandOf(providerKey: string): BrandName | undefined {
  return (BRAND_KEYS as readonly string[]).includes(providerKey)
    ? (providerKey as BrandName)
    : undefined;
}

// Sample signals for the preview-value empty state (spec §6.5) — blurred
// behind the CTA, never shown as real data.
const SAMPLE_SIGNALS = [
  {
    source: "LinkedIn",
    title: "“Every AI content tool sounds the same — where's the one that knows my company?”",
    meta: "VP Marketing thread · 214 reactions",
  },
  {
    source: "Reddit",
    title: "r/SaaS: what's your GTM stack in 2026? Ours is 9 tools and none of them talk.",
    meta: "68 comments · trending",
  },
  {
    source: "News",
    title: "Gartner: 40% of GTM teams will consolidate content ops onto one platform by 2028",
    meta: "press release",
  },
];

const SAMPLE_PUBLICATIONS = [
  {
    title: "Why your AI posts sound like everyone else's",
    body: "The problem isn't the model — it's that the model knows nothing about you. We rebuilt our GTM around one editable brain…",
    status: "published",
  },
  {
    title: "The 9-tool GTM stack is dead",
    body: "We asked 50 founders what they'd keep if they could only keep one tool. The answers surprised us…",
    status: "scheduled",
  },
];

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

  if (!workspace) return <EmptyState description="Loading…" />;

  return (
    <>
      <PageHeader
        title="Create"
        subtitle="Turn a market signal into a post, email, or ad in your voice. Every draft goes to Review before it ships."
      />

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="add" size="sm" />
              New signal
            </span>
          }
        />
        <form className="persona-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }} onSubmit={addSignal}>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste the post, thread, comment, or customer quote you want to respond to…"
            rows={5}
            maxLength={10000}
          />
          <div className="resolve-controls">
            <label>
              Source
              <Select value={source} onChange={(e) => setSource(e.target.value as SignalSource)}>
                {SIGNAL_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </Select>
            </label>
            <label style={{ flex: 1 }}>
              Source URL (optional)
              <Input
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://…"
              />
            </label>
            <Button variant="primary" type="submit" disabled={saving || content.trim().length === 0}>
              {saving ? "Adding…" : "Add signal"}
            </Button>
          </div>
        </form>
        {error && <p className="error">{error}</p>}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="discover" size="sm" />
              Signal inbox{" "}
              {signalsList.length > 0 && (
                <CountBadge count={signalsList.length} label="signals in the inbox" />
              )}
            </span>
          }
        />
        {signalsList.length === 0 ? (
          <EmptyState
            title="No signals yet"
            description="Paste something the market said above — a thread, a comment, a customer quote — and draft your response in your voice."
            preview={
              <ul className="section-list">
                {SAMPLE_SIGNALS.map((s) => (
                  <li key={s.title} className="section-card">
                    <div className="section-head">
                      <span className="layer-badge">{s.source}</span>
                      <span className="section-title">{s.title}</span>
                      <span className="meta">{s.meta}</span>
                    </div>
                  </li>
                ))}
              </ul>
            }
          />
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
                        <Badge tone={STATE_BADGE_TONES[d.state]}>
                          {STATE_LABELS[d.state]}
                        </Badge>{" "}
                        <span className="meta">{d.channel} response</span>{" "}
                        <Link className="link-button" href={`/workspaces/${id}/review`}>
                          open in queue
                        </Link>
                        {d.state === "approved" && (
                          <>
                            {" "}
                            <Button variant="ghost" size="sm" onClick={() => copyDraft(d.id)}>
                              {copied === d.id ? "copied!" : "copy"}
                            </Button>{" "}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => downloadDraft(d.id, d.channel)}
                            >
                              download .md
                            </Button>{" "}
                            <Button variant="ghost" size="sm" onClick={() => openPublish(d.id)}>
                              publish…
                            </Button>
                            {publications
                              .filter((p) => p.draftId === d.id)
                              .map((p) => (
                                <Badge
                                  key={p.id}
                                  tone={PUBLICATION_BADGE_TONES[p.status]}
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
                                </Badge>
                              ))}
                          </>
                        )}
                        {publishingFor === d.id && (
                          <div className="resolve-controls" style={{ marginTop: 10 }}>
                            {socialConnections.length === 0 ? (
                              <EmptyState description={<>No social account connected.{" "}
                                <Link href={`/workspaces/${id}/connectors`}>
                                  Connect Reddit on the Integrations page
                                </Link>{" "}
                                first.</>} />
                            ) : (
                              <>
                                <label>
                                  Account
                                  <Select
                                    value={pubConnectionId}
                                    onChange={(e) => setPubConnectionId(e.target.value)}
                                  >
                                    {socialConnections.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.providerKey}
                                      </option>
                                    ))}
                                  </Select>
                                </label>
                                <label>
                                  Subreddit
                                  <Input
                                    value={pubTarget}
                                    onChange={(e) => setPubTarget(e.target.value)}
                                    placeholder="r/test"
                                  />
                                </label>
                                <label style={{ flex: 1 }}>
                                  Title ({pubTitle.length}/
                                  {SOCIAL_POST_CONSTRAINTS.reddit.titleMaxChars})
                                  <Input
                                    value={pubTitle}
                                    onChange={(e) => setPubTitle(e.target.value)}
                                  />
                                </label>
                                <label>
                                  Schedule (optional)
                                  <Input
                                    type="datetime-local"
                                    value={pubSchedule}
                                    onChange={(e) => setPubSchedule(e.target.value)}
                                  />
                                </label>
                                <Button
                                  variant="primary"
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
                                </Button>
                              </>
                            )}
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setPublishingFor(null)}
                            >
                              Cancel
                            </Button>
                            {publishError && <p className="error-inline">{publishError}</p>}
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
                      <Select
                        value={draftChannel}
                        onChange={(e) => setDraftChannel(e.target.value as Channel)}
                      >
                        {CHANNELS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label>
                      Persona
                      <Select
                        value={draftPersonaId}
                        onChange={(e) => setDraftPersonaId(e.target.value)}
                      >
                        <option value="">(none — org voice)</option>
                        {personas.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                    {campaigns.length > 0 && (
                      <label>
                        Campaign
                        <Select
                          value={draftCampaignId}
                          onChange={(e) => setDraftCampaignId(e.target.value)}
                        >
                          <option value="">(no campaign)</option>
                          {campaigns.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                      </label>
                    )}
                    <Button variant="primary" disabled={generating} onClick={() => draftResponse(s.id)}>
                      {generating ? "Drafting…" : "Generate draft"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setDraftingFor(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="rating-row" style={{ marginTop: 10 }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setDraftingFor(s.id);
                        setDraftPersonaId(s.suggestedPersonaId ?? "");
                        setDraftCampaignId(s.suggestedCampaignId ?? "");
                      }}
                    >
                      Draft response
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-live" size="sm" />
              Published{" "}
              {publications.length > 0 && (
                <CountBadge count={publications.length} label="publication receipts" />
              )}
            </span>
          }
        />
        {publications.length === 0 ? (
          <EmptyState
            title="Nothing published yet"
            description="Approve a draft, then use publish… to post it to a connected social account. Receipts and engagement land here."
            preview={
              <div className={styles.previewGrid}>
                {SAMPLE_PUBLICATIONS.map((p) => (
                  <PreviewCard
                    key={p.title}
                    kind="social"
                    platform="reddit"
                    title={p.title}
                    body={p.body}
                    status={p.status}
                    statusTone={p.status === "published" ? "approved" : "edited"}
                  />
                ))}
              </div>
            }
          />
        ) : (
          <div className={styles.previewGrid}>
            {publications.map((p) => (
              <div key={p.id} className={styles.pubCell}>
                <PreviewCard
                  kind="social"
                  platform={brandOf(p.providerKey)}
                  title={p.title}
                  body={p.draft?.content ?? ""}
                  status={p.status}
                  statusTone={PUBLICATION_BADGE_TONES[p.status]}
                  scheduledAt={
                    p.status === "scheduled"
                      ? new Date(p.scheduledFor).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : undefined
                  }
                  actions={
                    <>
                      {p.status === "failed" && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={publishing}
                          onClick={() => retryPublication(p.id)}
                        >
                          Retry
                        </Button>
                      )}
                      {p.status === "scheduled" && (
                        <Button variant="danger" size="sm" onClick={() => cancelPublication(p.id)}>
                          Cancel
                        </Button>
                      )}
                    </>
                  }
                />
                <div className={styles.pubMeta}>
                  {p.status === "published" && p.externalUrl && (
                    <>
                      Live at{" "}
                      <a href={p.externalUrl} target="_blank" rel="noreferrer">
                        r/{p.target}
                      </a>{" "}
                      ({new Date(p.publishedAt ?? p.updatedAt).toLocaleString()})
                    </>
                  )}
                  {p.status === "scheduled" && `${p.providerKey} · r/${p.target}`}
                  {p.status === "failed" && (p.lastError ?? "The platform refused the post.")}
                </div>
                {p.status === "published" && p.metrics.length > 0 && (
                  <div className={styles.pubMetrics}>
                    {p.metrics
                      .slice()
                      .sort((a, b) => a.window.localeCompare(b.window))
                      .map((m) => (
                        <span key={m.id}>
                          <span className="layer-badge">{m.window}</span> {metricSummary(m)}
                        </span>
                      ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
