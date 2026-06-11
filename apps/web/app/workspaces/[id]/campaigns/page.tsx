"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  type ApprovalState,
  type Campaign,
  type Channel,
  type Persona,
  type Workspace,
} from "@tuezday/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "draft",
  pending_review: "pending",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
};

interface CampaignDetail {
  campaign: Campaign;
  draftCounts: Record<ApprovalState, number>;
  drafts: { id: string; state: ApprovalState; taskType: string; channel: string; createdAt: number }[];
}

const EMPTY_FORM = {
  name: "",
  objective: "",
  kpi: "",
  timeframe: "",
  audience: "",
  pillarsText: "",
  channels: [] as Channel[],
  personaIds: [] as string[],
  overlay: "",
};

export default function CampaignsPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([]);
  const [details, setDetails] = useState<Record<string, CampaignDetail>>({});
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
      setCampaignsList(await cRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(c?: Campaign) {
    setShowForm(true);
    setEditingId(c?.id ?? null);
    setForm(
      c
        ? {
            name: c.name,
            objective: c.objective,
            kpi: c.kpi,
            timeframe: c.timeframe,
            audience: c.audience,
            pillarsText: c.pillars.join("\n"),
            channels: c.channels,
            personaIds: c.personaIds,
            overlay: c.overlay,
          }
        : EMPTY_FORM,
    );
  }

  function payloadFromForm(status: "active" | "archived" = "active") {
    return {
      name: form.name,
      objective: form.objective,
      kpi: form.kpi,
      timeframe: form.timeframe,
      audience: form.audience,
      pillars: form.pillarsText
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 10),
      channels: form.channels,
      personaIds: form.personaIds,
      overlay: form.overlay,
      status,
    };
  }

  async function saveCampaign(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const editing = editingId ? campaignsList.find((c) => c.id === editingId) : undefined;
      const url = editingId
        ? `${API_URL}/workspaces/${id}/campaigns/${editingId}`
        : `${API_URL}/workspaces/${id}/campaigns`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadFromForm(editing?.status ?? "active")),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setShowForm(false);
      setDetails({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save campaign");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(c: Campaign, status: "active" | "archived") {
    await fetch(`${API_URL}/workspaces/${id}/campaigns/${c.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: c.name,
        objective: c.objective,
        kpi: c.kpi,
        timeframe: c.timeframe,
        audience: c.audience,
        pillars: c.pillars,
        channels: c.channels,
        personaIds: c.personaIds,
        overlay: c.overlay,
        status,
      }),
    });
    await load();
  }

  async function toggleDetail(campaignId: string) {
    if (expandedId === campaignId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(campaignId);
    if (!details[campaignId]) {
      const res = await fetch(`${API_URL}/workspaces/${id}/campaigns/${campaignId}`);
      if (res.ok) {
        const detail = await res.json();
        setDetails((d) => ({ ...d, [campaignId]: detail }));
      }
    }
  }

  function toggleInList<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
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
            <Link href={`/workspaces/${id}`}>{workspace.name}</Link> / Campaigns
          </p>
          <h1>Campaigns</h1>
          <p className="subtitle">
            Goal-scoped GTM. A campaign layers its objective, pillars, and now-overlay into every
            context resolved under it.
          </p>
        </div>
        <div className="persona-actions">
          <Link className="button-secondary" href={`/workspaces/${id}`}>
            ← Brain
          </Link>
          <button onClick={() => startEdit()}>+ New campaign</button>
        </div>
      </div>

      {showForm && (
        <section className="panel">
          <h2>{editingId ? "Edit campaign" : "New campaign"}</h2>
          <form className="persona-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }} onSubmit={saveCampaign}>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Campaign name (e.g. Q3 GTM memory push)"
              maxLength={200}
            />
            <textarea
              value={form.objective}
              onChange={(e) => setForm({ ...form, objective: e.target.value })}
              placeholder="Objective — what is this campaign trying to achieve?"
              rows={2}
            />
            <div className="resolve-controls">
              <label style={{ flex: 1 }}>
                KPI
                <input
                  value={form.kpi}
                  onChange={(e) => setForm({ ...form, kpi: e.target.value })}
                  placeholder="e.g. 20 demo calls booked"
                />
              </label>
              <label style={{ flex: 1 }}>
                Timeframe
                <input
                  value={form.timeframe}
                  onChange={(e) => setForm({ ...form, timeframe: e.target.value })}
                  placeholder="e.g. Jul–Sep 2026"
                />
              </label>
            </div>
            <textarea
              value={form.audience}
              onChange={(e) => setForm({ ...form, audience: e.target.value })}
              placeholder="Audience slice — who exactly is this for?"
              rows={2}
            />
            <textarea
              value={form.pillarsText}
              onChange={(e) => setForm({ ...form, pillarsText: e.target.value })}
              placeholder={"Messaging pillars — one per line (max 10)"}
              rows={3}
            />
            <div className="checkbox-row">
              <span className="meta">Channels:</span>
              {CHANNELS.map((c) => (
                <label key={c} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={form.channels.includes(c)}
                    onChange={() => setForm({ ...form, channels: toggleInList(form.channels, c) })}
                  />
                  {c}
                </label>
              ))}
            </div>
            {personas.length > 0 && (
              <div className="checkbox-row">
                <span className="meta">Personas:</span>
                {personas.map((p) => (
                  <label key={p.id} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={form.personaIds.includes(p.id)}
                      onChange={() =>
                        setForm({ ...form, personaIds: toggleInList(form.personaIds, p.id) })
                      }
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            )}
            <textarea
              value={form.overlay}
              onChange={(e) => setForm({ ...form, overlay: e.target.value })}
              placeholder="Campaign now-overlay — what matters for this campaign right now (markdown)…"
              rows={4}
            />
            <div className="editor-actions">
              <button type="submit" disabled={saving || form.name.trim().length === 0}>
                {editingId ? "Update campaign" : "Create campaign"}
              </button>
              <button type="button" className="button-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      )}

      {campaignsList.length === 0 && !showForm ? (
        <p className="empty">No campaigns yet. Create the first one to make GTM goal-scoped.</p>
      ) : (
        <ul className="section-list">
          {campaignsList.map((c) => {
            const detail = details[c.id];
            return (
              <li key={c.id} className={`section-card ${c.status === "archived" ? "excluded" : ""}`}>
                <div className="section-head" onClick={() => toggleDetail(c.id)}>
                  <span
                    className={`layer-badge ${c.status === "active" ? "state-approved" : ""}`}
                  >
                    {c.status}
                  </span>
                  <span className="section-title">{c.name}</span>
                  <span className="section-tokens">{c.timeframe}</span>
                </div>
                {c.objective && <p className="section-reason">{c.objective}</p>}
                {c.pillars.length > 0 && (
                  <p className="section-reason">Pillars: {c.pillars.join(" · ")}</p>
                )}

                {expandedId === c.id && detail && (
                  <div className="campaign-detail">
                    <p className="bundle-summary">
                      Drafts:{" "}
                      {(Object.keys(detail.draftCounts) as ApprovalState[])
                        .filter((s) => detail.draftCounts[s] > 0)
                        .map((s) => `${detail.draftCounts[s]} ${STATE_LABELS[s]}`)
                        .join(" · ") || "none yet"}
                    </p>
                    {detail.drafts.length > 0 && (
                      <ul className="draft-chain">
                        {detail.drafts.slice(0, 8).map((d) => (
                          <li key={d.id}>
                            <span className={`layer-badge state-${d.state}`}>
                              {STATE_LABELS[d.state]}
                            </span>{" "}
                            <span className="meta">
                              {d.taskType} · {d.channel} ·{" "}
                              {new Date(d.createdAt).toLocaleDateString()}
                            </span>{" "}
                            <Link className="link-button" href={`/workspaces/${id}/approvals`}>
                              open queue
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <div className="rating-row" style={{ marginTop: 8 }}>
                  <button className="button-secondary" onClick={() => startEdit(c)}>
                    Edit
                  </button>
                  {c.status === "active" ? (
                    <button className="button-secondary" onClick={() => setStatus(c, "archived")}>
                      Archive
                    </button>
                  ) : (
                    <button className="button-secondary" onClick={() => setStatus(c, "active")}>
                      Unarchive
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
