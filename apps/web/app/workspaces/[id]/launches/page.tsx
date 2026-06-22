"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  LAUNCH_CHANNELS,
  type Audience,
  type Campaign,
  type Launch,
  type LaunchChannel,
  type LaunchDetail,
  type LaunchMessage,
  type Persona,
  type Workspace,
} from "@tuezday/contracts";
import { API_URL, apiDownload, apiFetch } from "@/lib/api";

const CHANNEL_LABELS: Record<LaunchChannel, string> = {
  email: "Email (CSV)",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  x: "X (DMs)",
};

// Channel → connector provider key. email has no connector.
const CHANNEL_PROVIDER: Record<LaunchChannel, string | null> = {
  email: null,
  linkedin: "linkedin",
  instagram: "instagram",
  x: "twitter",
};

interface ConnectorsView {
  connections: { id: string; providerKey: string; status: string }[];
}

export default function LaunchesPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<{
    name: string;
    audienceId: string;
    campaignId: string;
    personaId: string;
    channels: LaunchChannel[];
  }>({ name: "", audienceId: "", campaignId: "", personaId: "", channels: ["email"] });
  const [saving, setSaving] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LaunchDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [igMedia, setIgMedia] = useState("");
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [wsRes, lRes, aRes, cRes, pRes, conRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/launches`),
        apiFetch(`/workspaces/${id}/audiences`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/connectors`),
      ]);
      if (!wsRes.ok || !lRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setLaunches(await lRes.json());
      setAudiences(aRes.ok ? await aRes.json() : []);
      setCampaigns(cRes.ok ? ((await cRes.json()) as Campaign[]).filter((c) => c.status === "active") : []);
      setPersonas(pRes.ok ? await pRes.json() : []);
      if (conRes.ok) {
        const view = (await conRes.json()) as ConnectorsView;
        setConnected(
          new Set(view.connections.filter((c) => c.status === "connected").map((c) => c.providerKey)),
        );
      }
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function channelConnected(channel: LaunchChannel): boolean {
    const provider = CHANNEL_PROVIDER[channel];
    return provider === null || connected.has(provider);
  }

  async function openDetail(launchId: string) {
    if (openId === launchId) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(launchId);
    setDetail(null);
    setDispatchNote(null);
    const res = await apiFetch(`/workspaces/${id}/launches/${launchId}`);
    if (res.ok) setDetail(await res.json());
  }

  async function refreshDetail(launchId: string) {
    const res = await apiFetch(`/workspaces/${id}/launches/${launchId}`);
    if (res.ok) setDetail(await res.json());
    await load();
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/launches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          audienceId: form.audienceId,
          campaignId: form.campaignId || undefined,
          personaId: form.personaId || undefined,
          channels: form.channels,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setShowForm(false);
      setForm({ name: "", audienceId: "", campaignId: "", personaId: "", channels: ["email"] });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create launch");
    } finally {
      setSaving(false);
    }
  }

  async function generate(launchId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/launches/${launchId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `API returned ${res.status}`);
      }
      await refreshDetail(launchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  async function approve(draftId: string, launchId: string) {
    await apiFetch(`/workspaces/${id}/drafts/${draftId}/approve`, { method: "POST" });
    await refreshDetail(launchId);
  }

  async function remove(launch: Launch) {
    if (!confirm(`Delete launch "${launch.name}"?`)) return;
    await apiFetch(`/workspaces/${id}/launches/${launch.id}`, { method: "DELETE" });
    if (openId === launch.id) {
      setOpenId(null);
      setDetail(null);
    }
    await load();
  }

  async function dispatch(launchId: string, channel: LaunchChannel) {
    setBusy(true);
    setDispatchNote(null);
    setError(null);
    try {
      const payload: { media?: { url: string; type: "image" | "video" }[] } = {};
      if (channel === "instagram") {
        const urls = igMedia
          .split(/[\n,]/)
          .map((u) => u.trim())
          .filter(Boolean);
        payload.media = urls.map((url) => ({
          url,
          type: /\.(mp4|mov|webm)(\?|$)/i.test(url) ? "video" : "image",
        }));
      }
      const res = await apiFetch(
        `/workspaces/${id}/launches/${launchId}/channels/${channel}/dispatch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      const sent = (body.results ?? []).filter((r: { status: string }) => r.status === "sent").length;
      const failed = (body.results ?? []).filter((r: { status: string }) => r.status === "failed").length;
      setDispatchNote(`${CHANNEL_LABELS[channel]}: ${sent} sent${failed ? `, ${failed} failed` : ""}.`);
      await refreshDetail(launchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dispatch failed");
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
  if (!workspace) return <p className="empty">Loading…</p>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Launches</h1>
          <p className="subtitle">
            Launch a personalized first-touch at a segment: per-recipient email + X DMs, and one
            broadcast post each for LinkedIn and Instagram. Every message clears Review first.
          </p>
        </div>
        <div className="page-actions">
          <button className="button-secondary" onClick={() => setShowForm(!showForm)}>
            + New launch
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {showForm && (
        <section className="panel">
          <h2>New launch</h2>
          <form className="persona-form" onSubmit={create}>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Launch name — e.g. Spring outreach"
            />
            <div className="resolve-controls">
              <label>
                Audience
                <select
                  value={form.audienceId}
                  onChange={(e) => setForm({ ...form, audienceId: e.target.value })}
                >
                  <option value="">(pick a segment / list)</option>
                  {audiences.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.memberCount})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Campaign
                <select
                  value={form.campaignId}
                  onChange={(e) => setForm({ ...form, campaignId: e.target.value })}
                >
                  <option value="">(no campaign)</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Persona
                <select
                  value={form.personaId}
                  onChange={(e) => setForm({ ...form, personaId: e.target.value })}
                >
                  <option value="">(org voice)</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="checkbox-row" style={{ flexWrap: "wrap", gap: 12 }}>
              <span className="meta">Channels</span>
              {LAUNCH_CHANNELS.map((channel) => {
                const usable = channelConnected(channel);
                return (
                  <label key={channel} className="checkbox-label" title={usable ? "" : "Connect this account on Integrations first"}>
                    <input
                      type="checkbox"
                      disabled={!usable}
                      checked={form.channels.includes(channel)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          channels: e.target.checked
                            ? [...form.channels, channel]
                            : form.channels.filter((c) => c !== channel),
                        })
                      }
                    />
                    {CHANNEL_LABELS[channel]}
                    {!usable && <span className="meta"> (not connected)</span>}
                  </label>
                );
              })}
            </div>
            <div className="editor-actions">
              <button type="submit" disabled={saving || !form.name || !form.audienceId || form.channels.length === 0}>
                {saving ? "Creating…" : "Create launch"}
              </button>
              <button type="button" className="button-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="panel">
        <h2>Launches ({launches.length})</h2>
        {launches.length === 0 ? (
          <p className="empty">No launches yet. Create one to target a segment.</p>
        ) : (
          <ul className="section-list">
            {launches.map((launch) => (
              <li key={launch.id} className="section-card">
                <div className="section-head">
                  <button className="link-button" onClick={() => openDetail(launch.id)}>
                    <span className="section-title">{launch.name}</span>
                  </button>
                  <span className={`layer-badge state-${launch.status}`}>{launch.status}</span>
                  <span className="meta">
                    {launch.channels.map((c) => CHANNEL_LABELS[c]).join(" · ")} · {launch.messageCount} messages
                  </span>
                  {launch.status === "draft" && (
                    <button disabled={busy} onClick={() => generate(launch.id)}>
                      Generate
                    </button>
                  )}
                  <button className="link-button" onClick={() => remove(launch)}>
                    delete
                  </button>
                </div>

                {openId === launch.id && detail && (
                  <LaunchDetailView
                    detail={detail}
                    workspaceId={id}
                    busy={busy}
                    igMedia={igMedia}
                    setIgMedia={setIgMedia}
                    dispatchNote={dispatchNote}
                    channelConnected={channelConnected}
                    onApprove={(draftId) => approve(draftId, launch.id)}
                    onDispatch={(channel) => dispatch(launch.id, channel)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function LaunchDetailView({
  detail,
  workspaceId,
  busy,
  igMedia,
  setIgMedia,
  dispatchNote,
  channelConnected,
  onApprove,
  onDispatch,
}: {
  detail: LaunchDetail;
  workspaceId: string;
  busy: boolean;
  igMedia: string;
  setIgMedia: (v: string) => void;
  dispatchNote: string | null;
  channelConnected: (c: LaunchChannel) => boolean;
  onApprove: (draftId: string) => void;
  onDispatch: (channel: LaunchChannel) => void;
}) {
  const { launch, messages, recipientCount } = detail;
  const byChannel = (channel: LaunchChannel) => messages.filter((m) => m.channel === channel);
  const approvedCount = (channel: LaunchChannel) =>
    byChannel(channel).filter((m) => m.draftState === "approved").length;

  return (
    <div style={{ marginTop: 10 }}>
      <p className="meta">
        {recipientCount} recipient(s) · status {launch.status}
      </p>
      {dispatchNote && <p className="bundle-summary">{dispatchNote}</p>}

      {launch.channels.map((channel) => {
        const rows = byChannel(channel);
        if (rows.length === 0) return null;
        return (
          <div key={channel} className="panel" style={{ marginTop: 10 }}>
            <div className="panel-title-row">
              <h3 style={{ margin: 0 }}>{CHANNEL_LABELS[channel]}</h3>
              {channel === "email" ? (
                <button
                  className="button-secondary"
                  disabled={approvedCount("email") === 0}
                  onClick={() =>
                    void apiDownload(
                      `/workspaces/${workspaceId}/launches/${launch.id}/export.csv`,
                      "tuezday-launch-email.csv",
                    )
                  }
                >
                  ↓ Download CSV ({approvedCount("email")})
                </button>
              ) : (
                <button
                  disabled={busy || approvedCount(channel) === 0 || !channelConnected(channel)}
                  onClick={() => onDispatch(channel)}
                >
                  {channel === "x" ? "Send DMs" : "Publish"} ({approvedCount(channel)})
                </button>
              )}
            </div>

            {channel === "instagram" && (
              <textarea
                value={igMedia}
                onChange={(e) => setIgMedia(e.target.value)}
                placeholder="Image/video URL(s) — one per line. 2+ images = carousel, a .mp4 = reel."
                rows={2}
                style={{ width: "100%", marginBottom: 8 }}
              />
            )}

            <ul className="section-list">
              {rows.map((m) => (
                <MessageRow key={m.id} message={m} onApprove={onApprove} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function MessageRow({
  message,
  onApprove,
}: {
  message: LaunchMessage;
  onApprove: (draftId: string) => void;
}) {
  const recipient = message.kind === "broadcast" ? "Broadcast post" : message.recipientName;
  return (
    <li className="section-card">
      <div className="section-head">
        <span className="section-title">{recipient}</span>
        {message.status === "skipped" ? (
          <span className="meta">skipped — {message.skipReason}</span>
        ) : (
          <>
            {message.draftState && (
              <span className={`layer-badge state-${message.draftState}`}>{message.draftState}</span>
            )}
            <span className={`layer-badge state-${message.status}`}>{message.status}</span>
            {message.draftId && message.draftState !== "approved" && message.status !== "sent" && (
              <button className="link-button" onClick={() => onApprove(message.draftId!)}>
                approve
              </button>
            )}
            {message.externalUrl && (
              <a className="link-button" href={message.externalUrl} target="_blank" rel="noreferrer">
                view
              </a>
            )}
          </>
        )}
      </div>
      {message.draftContent && <p className="section-reason">{message.draftContent.slice(0, 200)}</p>}
      {message.lastError && <p className="error">{message.lastError}</p>}
    </li>
  );
}
