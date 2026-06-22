"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  WEEKDAY_LABELS,
  type Campaign,
  type Channel,
  type Connection,
  type ConnectorProvider,
  type Persona,
  type PostingCadence,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";

interface CadenceSummary extends PostingCadence {
  queuedCount: number;
  nextSlotAt: number | null;
}

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

function scheduleSummary(c: PostingCadence): string {
  const days = c.daysOfWeek.map((d) => WEEKDAY_LABELS[d]).join("/");
  return `${days} at ${c.timeOfDay} ${c.timezone}`;
}

export default function CadencePage() {
  const { id } = useParams<{ id: string }>();
  const [cadences, setCadences] = useState<CadenceSummary[] | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [social, setSocial] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    name: "",
    campaignId: "",
    personaId: "",
    channel: "linkedin" as Channel,
    connectionId: "",
    target: "",
    daysOfWeek: [1, 3, 5] as number[],
    timeOfDay: "09:00",
    timezone: browserTimeZone(),
  });

  const load = useCallback(async () => {
    try {
      const [cadRes, campRes, persRes, connRes] = await Promise.all([
        apiFetch(`/workspaces/${id}/cadences`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/connectors`),
      ]);
      if (cadRes.ok) setCadences(await cadRes.json());
      if (campRes.ok)
        setCampaigns(((await campRes.json()) as Campaign[]).filter((c) => c.status === "active"));
      if (persRes.ok) setPersonas(await persRes.json());
      if (connRes.ok) {
        const view = (await connRes.json()) as {
          providers: ConnectorProvider[];
          connections: Connection[];
        };
        const socialKeys = new Set(
          view.providers.filter((p) => p.categories?.includes("social")).map((p) => p.key),
        );
        setSocial(
          view.connections.filter((c) => socialKeys.has(c.providerKey) && c.status === "connected"),
        );
      }
      setError(null);
    } catch {
      setError("Could not load cadences. Is the API running?");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleDay(day: number) {
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(day)
        ? f.daysOfWeek.filter((d) => d !== day)
        : [...f.daysOfWeek, day].sort((a, b) => a - b),
    }));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    const res = await apiFetch(`/workspaces/${id}/cadences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        campaignId: form.campaignId,
        personaId: form.personaId || undefined,
        channel: form.channel,
        connectionId: form.connectionId,
        target: form.target,
        daysOfWeek: form.daysOfWeek,
        timeOfDay: form.timeOfDay,
        timezone: form.timezone,
      }),
    });
    const body = await res.json().catch(() => null);
    setSubmitting(false);
    if (!res.ok) {
      setError(body?.message ?? `Could not create the cadence (${body?.error ?? res.status}).`);
      return;
    }
    setForm((f) => ({ ...f, name: "", target: "" }));
    setNotice(`Cadence "${body.name}" created.`);
    await load();
  }

  async function fill(c: CadenceSummary) {
    setNotice(null);
    const res = await apiFetch(`/workspaces/${id}/cadences/${c.id}/fill`, { method: "POST" });
    const body = await res.json().catch(() => null);
    if (res.ok) setNotice(`Slotted ${body.filled} draft(s) into "${c.name}".`);
    await load();
  }

  async function toggleStatus(c: CadenceSummary) {
    await apiFetch(`/workspaces/${id}/cadences/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: c.status === "active" ? "paused" : "active" }),
    });
    await load();
  }

  async function remove(c: CadenceSummary) {
    if (!window.confirm(`Delete "${c.name}"? Its still-scheduled posts will be canceled.`)) return;
    await apiFetch(`/workspaces/${id}/cadences/${c.id}`, { method: "DELETE" });
    await load();
  }

  const canCreate =
    form.name && form.campaignId && form.connectionId && form.target && form.daysOfWeek.length > 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Posting cadence</h1>
          <p className="subtitle">
            Recurring posting slots. Approved drafts in the matching campaign + channel auto-fill the
            next open slots and publish on schedule. See them on the{" "}
            <Link href={`/workspaces/${id}/calendar`}>calendar</Link>.
          </p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="empty">{notice}</p>}

      <section className="panel">
        <h2>New cadence</h2>
        {social.length === 0 ? (
          <p className="empty">
            No connected social account.{" "}
            <Link href={`/workspaces/${id}/connectors`}>Connect one</Link> first — a cadence posts
            through it.
          </p>
        ) : (
          <form onSubmit={create}>
            <div className="resolve-controls">
              <label>
                Name
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Weekly thought leadership"
                />
              </label>
              <label>
                Campaign
                <select
                  value={form.campaignId}
                  onChange={(e) => setForm((f) => ({ ...f, campaignId: e.target.value }))}
                >
                  <option value="">— pick a campaign —</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Persona (optional)
                <select
                  value={form.personaId}
                  onChange={(e) => setForm((f) => ({ ...f, personaId: e.target.value }))}
                >
                  <option value="">Any persona</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="resolve-controls">
              <label>
                Channel
                <select
                  value={form.channel}
                  onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value as Channel }))}
                >
                  {CHANNELS.map((ch) => (
                    <option key={ch} value={ch}>
                      {ch}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Post through
                <select
                  value={form.connectionId}
                  onChange={(e) => setForm((f) => ({ ...f, connectionId: e.target.value }))}
                >
                  <option value="">— pick an account —</option>
                  {social.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.providerKey}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Target
                <input
                  value={form.target}
                  onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
                  placeholder="subreddit, or 'feed'"
                />
              </label>
            </div>
            <div className="resolve-controls">
              <label>
                Time
                <input
                  type="time"
                  value={form.timeOfDay}
                  onChange={(e) => setForm((f) => ({ ...f, timeOfDay: e.target.value }))}
                />
              </label>
              <label>
                Time zone
                <input
                  value={form.timezone}
                  onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                  placeholder="America/New_York"
                />
              </label>
            </div>
            <div className="cadence-days">
              {WEEKDAY_LABELS.map((label, day) => (
                <label key={day} className="cadence-day">
                  <input
                    type="checkbox"
                    checked={form.daysOfWeek.includes(day)}
                    onChange={() => toggleDay(day)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <button type="submit" disabled={submitting || !canCreate}>
              {submitting ? "Creating…" : "Create cadence"}
            </button>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Your cadences</h2>
        {cadences === null ? (
          <p className="empty">Loading…</p>
        ) : cadences.length === 0 ? (
          <p className="empty">No cadences yet.</p>
        ) : (
          <ul className="checklist">
            {cadences.map((c) => (
              <li key={c.id} className="checklist-item">
                <span>
                  <strong>{c.name}</strong>{" "}
                  <span className="doc-status">
                    {c.channel} · {c.status}
                    {" · "}
                    {scheduleSummary(c)}
                    {" · "}
                    {c.queuedCount} approved draft(s) queued
                    {c.nextSlotAt
                      ? ` · next slot ${new Date(c.nextSlotAt).toLocaleString()}`
                      : ""}
                  </span>
                </span>
                <span className="page-actions">
                  <button type="button" className="button-secondary" onClick={() => fill(c)}>
                    Fill now
                  </button>
                  <button type="button" className="button-secondary" onClick={() => toggleStatus(c)}>
                    {c.status === "active" ? "Pause" : "Resume"}
                  </button>
                  <button type="button" className="button-secondary" onClick={() => remove(c)}>
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
