"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Textarea } from "@/src/components/ui/input";


import { API_URL, apiDownload, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  BrainDocType,
  BrainDocVersion,
  BrainDocument,
  Campaign,
  DocOutline,
  GuidanceOverride,
  Persona,
  Workspace,
} from "@tuezday/contracts";
import {
  BRAIN_DOC_TOKEN_WARNING,
  CHANNELS,
  CHANNEL_LABELS,
  GUIDANCE_CONTENT_MAX_CHARS,
  MATRIX_DOC_TYPES,
  type Channel,
  type ChannelGuidance,
} from "@tuezday/contracts";
import {
  BRAIN_DOC_META,
  PREAMBLE_ID,
  buildFallbackOutline,
  estimateTokens,
  type BrainScore,
} from "@tuezday/brain";

interface BrainView {
  docs: BrainDocument[];
  completeness: BrainScore;
}

const STATUS_LABEL: Record<string, string> = {
  empty: "empty",
  draft: "draft",
  complete: "complete",
};

export default function WorkspaceBrainPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [brain, setBrain] = useState<BrainView | null>(null);
  const [selected, setSelected] = useState<BrainDocType>("soul");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<BrainDocVersion[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<BrainDocVersion | null>(null);

  // Channel guidance (Sprint 21) — editable per channel, overrides the built-in default.
  const [guidance, setGuidance] = useState<ChannelGuidance[] | null>(null);
  const [guidanceDrafts, setGuidanceDrafts] = useState<Record<string, string>>({});
  const [guidanceSaving, setGuidanceSaving] = useState<string | null>(null);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);

  // Scoped guidance (Sprint 44) — persona/campaign-scoped overrides, most-specific-wins.
  const [scoped, setScoped] = useState<GuidanceOverride[] | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [scopedChannel, setScopedChannel] = useState<Channel>("linkedin");
  const [scopedPersonaId, setScopedPersonaId] = useState("");
  const [scopedCampaignId, setScopedCampaignId] = useState("");
  const [scopedContent, setScopedContent] = useState("");
  const [scopedBusy, setScopedBusy] = useState(false);
  const [scopedError, setScopedError] = useState<string | null>(null);

  const selectedDoc = useMemo(
    () => brain?.docs.find((d) => d.docType === selected) ?? null,
    [brain, selected],
  );
  const selectedMeta = BRAIN_DOC_META.find((m) => m.docType === selected)!;
  const dirty = selectedDoc !== null && draft !== selectedDoc.content;

  // Sprint 43: soul/voice/now are constitutional — they ride every prompt in
  // full, so size matters there. ICP/History are outlined + zoomed per task.
  const isMatrixDoc = (MATRIX_DOC_TYPES as readonly string[]).includes(selected);
  const draftTokens = estimateTokens(draft);
  const outline = useMemo<DocOutline | null>(() => {
    if (!selectedDoc || selectedDoc.content.trim() === "") return null;
    return selectedDoc.outline ?? buildFallbackOutline(selectedDoc.content, selectedDoc.updatedAt);
  }, [selectedDoc]);

  const load = useCallback(async () => {
    try {
      const [wsRes, brainRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/brain`),
      ]);
      if (!wsRes.ok || !brainRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setBrain(await brainRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}.`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // When the loaded doc or selection changes, reset the editor to saved content.
  useEffect(() => {
    if (selectedDoc) setDraft(selectedDoc.content);
    setShowHistory(false);
    setPreviewVersion(null);
    setVersions(null);
  }, [selectedDoc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(content: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/brain/${selected}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      await load();
      setDraft(content);
      if (showHistory) await loadVersions();
    } catch (err) {
      // A TypeError from fetch means the request never reached the API
      // (server down, wrong port, or a blocked CORS preflight).
      if (err instanceof TypeError) {
        setError(
          `Could not reach the API at ${API_URL}. Check that "npm run dev" is running and the browser console for CORS errors.`,
        );
      } else {
        setError(err instanceof Error ? err.message : "Failed to save");
      }
    } finally {
      setSaving(false);
    }
  }

  async function loadVersions() {
    const res = await apiFetch(`/workspaces/${id}/brain/${selected}/versions`);
    if (res.ok) setVersions(await res.json());
  }

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    setPreviewVersion(null);
    if (next && versions === null) await loadVersions();
  }

  const loadGuidance = useCallback(async () => {
    const res = await apiFetch(`/workspaces/${id}/guidance`);
    if (res.ok) {
      const rows: ChannelGuidance[] = await res.json();
      setGuidance(rows);
      setGuidanceDrafts(Object.fromEntries(rows.map((r) => [r.channel, r.content])));
    }
  }, [id]);

  const loadScoped = useCallback(async () => {
    const [oRes, pRes, cRes] = await Promise.all([
      apiFetch(`/workspaces/${id}/guidance/overrides`),
      apiFetch(`/workspaces/${id}/personas`),
      apiFetch(`/workspaces/${id}/campaigns`),
    ]);
    if (oRes.ok) setScoped(await oRes.json());
    if (pRes.ok) setPersonas(await pRes.json());
    if (cRes.ok) setCampaigns(((await cRes.json()) as Campaign[]).filter((c) => c.status === "active"));
  }, [id]);

  useEffect(() => {
    void loadGuidance();
    void loadScoped();
  }, [loadGuidance, loadScoped]);

  async function saveGuidance(channel: Channel) {
    setGuidanceSaving(channel);
    setGuidanceError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/guidance/${channel}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: guidanceDrafts[channel] ?? "" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      await loadGuidance();
    } catch (err) {
      setGuidanceError(err instanceof Error ? err.message : "Failed to save guidance");
    } finally {
      setGuidanceSaving(null);
    }
  }

  async function resetGuidance(channel: Channel) {
    setGuidanceSaving(channel);
    setGuidanceError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/guidance/${channel}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      await loadGuidance();
    } catch (err) {
      setGuidanceError(err instanceof Error ? err.message : "Failed to reset guidance");
    } finally {
      setGuidanceSaving(null);
    }
  }

  async function saveScoped(e: React.FormEvent) {
    e.preventDefault();
    setScopedBusy(true);
    setScopedError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/guidance/${scopedChannel}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: scopedContent,
          ...(scopedPersonaId ? { personaId: scopedPersonaId } : {}),
          ...(scopedCampaignId ? { campaignId: scopedCampaignId } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      }
      setScopedContent("");
      await loadScoped();
    } catch (err) {
      setScopedError(err instanceof Error ? err.message : "Failed to save scoped guidance");
    } finally {
      setScopedBusy(false);
    }
  }

  async function deleteScoped(row: GuidanceOverride) {
    setScopedBusy(true);
    setScopedError(null);
    try {
      const params = new URLSearchParams();
      if (row.personaId) params.set("personaId", row.personaId);
      if (row.campaignId) params.set("campaignId", row.campaignId);
      const res = await apiFetch(`/workspaces/${id}/guidance/${row.channel}?${params}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      await loadScoped();
    } catch (err) {
      setScopedError(err instanceof Error ? err.message : "Failed to delete scoped guidance");
    } finally {
      setScopedBusy(false);
    }
  }

  function editScoped(row: GuidanceOverride) {
    setScopedChannel(row.channel);
    setScopedPersonaId(row.personaId ?? "");
    setScopedCampaignId(row.campaignId ?? "");
    setScopedContent(row.content);
  }

  if (error && !brain) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!brain || !workspace) return <EmptyState description="Loading…" />;

  return (
    <>
      <PageHeader title="Brain" subtitle={<>Everything Tuezday knows about your company — edit it anytime. Completeness:{" "}
            <strong>{brain.completeness.percent}%</strong></>} actions={<>
            <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void apiDownload(`/workspaces/${id}/brain/export`, "gtm-brain.md")}
          >
            Export brain (.md)
          </Button>
          </>} />

      <div className="brain-layout">
        <nav className="doc-nav">
          {BRAIN_DOC_META.map((meta) => {
            const score = brain.completeness.docs.find((d) => d.docType === meta.docType);
            return (
              <button
                key={meta.docType}
                className={`doc-nav-item ${selected === meta.docType ? "active" : ""}`}
                onClick={() => setSelected(meta.docType)}
              >
                <span className="doc-title">{meta.title}</span>
                <span className={`doc-status status-${score?.status}`}>
                  {STATUS_LABEL[score?.status ?? "empty"]}
                </span>
              </button>
            );
          })}
        </nav>

        <section className="doc-editor">
          <p className="doc-description">{selectedMeta.description}</p>

          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Write the ${selectedMeta.title} doc in markdown…`}
            rows={18}
          />

          {error && <p className="error">{error}</p>}
          
          <p className="meta">
            ~{draftTokens} tokens
            {isMatrixDoc &&
              " — large is fine: tasks see this doc as an outline and zoom into matching sections."}
          </p>
          {!isMatrixDoc && draftTokens >= BRAIN_DOC_TOKEN_WARNING && (
            <p className="token-warning">
              {selectedMeta.title} is constitutional — it rides every prompt in full, so ~
              {draftTokens} tokens counts against every generation. Consider trimming; reference
              detail belongs in ICP or History, which are outlined per task.
            </p>
          )}

          <div className="editor-actions">
            <button onClick={() => save(draft)} disabled={saving || !dirty}>
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
            <Button variant="secondary" size="sm" onClick={toggleHistory}>
              {showHistory ? "Hide history" : "History"}
            </Button>
            {dirty && <span className="unsaved">Unsaved changes</span>}
          </div>

          {outline && (
            <details className="outline-preview">
              <summary className="link-button" style={{ cursor: "pointer", listStyle: "none" }}>
                Outline — the map outline-mode tasks see ({outline.sections.length}{" "}
                {outline.sections.length === 1 ? "section" : "sections"})
                {dirty ? " · from last save" : ""}
              </summary>
              <ul className="outline-list">
                {outline.sections.map((s) => (
                  <li key={s.id} className={s.level === 3 ? "outline-h3" : ""}>
                    <span className="outline-heading">
                      {s.heading === PREAMBLE_ID ? "(intro)" : s.heading}
                    </span>
                    {s.summary && <span className="meta"> — {s.summary}</span>}
                    <span className="section-tokens" style={{ marginLeft: 6 }}>
                      ~{s.tokens} tok
                    </span>
                    {s.summarySource === "llm" && (
                      <span className="outline-llm-badge">AI summary</span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="meta">
                Regenerated on every save. The resolver zooms into whole sections from this map when
                a task&apos;s query matches them.
              </p>
            </details>
          )}

          {showHistory && (
            <div className="history">
              {versions === null ? (
                <EmptyState description={<>Loading versions…</>} />
              ) : versions.length === 0 ? (
                <EmptyState description={<>No saved versions yet. Versions appear after the first save.</>} />
              ) : (
                <ul className="version-list">
                  {versions.map((v) => (
                    <li key={v.id} className={previewVersion?.id === v.id ? "active" : ""}>
                      <button onClick={() => setPreviewVersion(v)}>
                        v{v.version} — {new Date(v.createdAt).toLocaleString()}
                        {v.actor ? ` · ${v.actor}` : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {previewVersion && (
                <div className="version-preview">
                  <pre>{previewVersion.content || "(empty)"}</pre>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saving}
                    onClick={() => save(previewVersion.content)}
                  >
                    Restore v{previewVersion.version}
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <section className="guidance-section">
        <h2>Channel guidance</h2>
        <p className="subtitle">
          Per-channel writing guidance the resolver injects into every generation. Override any
          channel here — no redeploy. Reset restores the built-in default.
        </p>

        {guidanceError && <p className="error">{guidanceError}</p>}

        {guidance === null ? (
          <EmptyState description={<>Loading guidance…</>} />
        ) : (
          <div className="guidance-list">
            {guidance.map((g) => {
              const value = guidanceDrafts[g.channel] ?? "";
              const dirty = value !== g.content;
              const busy = guidanceSaving === g.channel;
              return (
                <div key={g.channel} className="guidance-item">
                  <div className="guidance-head">
                    <span className="doc-title">{CHANNEL_LABELS[g.channel]}</span>
                    <span className={`guidance-source source-${g.source}`}>
                      {g.source === "workspace" ? "Workspace override" : "Default"}
                    </span>
                  </div>
                  <Textarea
                    value={value}
                    onChange={(e) =>
                      setGuidanceDrafts((d) => ({ ...d, [g.channel]: e.target.value }))
                    }
                    rows={4}
                  />
                  <div className="editor-actions">
                    <button onClick={() => void saveGuidance(g.channel)} disabled={busy || !dirty}>
                      {busy ? "Saving…" : dirty ? "Save" : "Saved"}
                    </button>
                    {g.source === "workspace" && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void resetGuidance(g.channel)}
                        disabled={busy}
                      >
                        Reset to default
                      </Button>
                    )}
                    {dirty && <span className="unsaved">Unsaved changes</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="guidance-section">
        <h2>Scoped guidance</h2>
        <p className="subtitle">
          Channel guidance for one persona and/or campaign. The most specific scope wins and
          replaces the workspace text: persona + campaign, then persona, then campaign, then the
          workspace override above.
        </p>

        {scopedError && <p className="error">{scopedError}</p>}

        {scoped === null ? (
          <EmptyState description={<>Loading scoped guidance…</>} />
        ) : scoped.length === 0 ? (
          <EmptyState description={<>No scoped overrides yet. Add one below — e.g. LinkedIn guidance that only applies when the “CEO” persona drafts.</>} />
        ) : (
          <ul className="section-list">
            {scoped.map((row) => (
              <li key={row.id} className="section-card">
                <div className="section-head">
                  <span className="layer-badge layer-channel">{CHANNEL_LABELS[row.channel]}</span>
                  {row.personaName && (
                    <span className="layer-badge layer-persona">persona · {row.personaName}</span>
                  )}
                  {row.campaignName && (
                    <span className="layer-badge layer-campaign">campaign · {row.campaignName}</span>
                  )}
                  <span className="section-tokens">
                    {new Date(row.updatedAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="section-reason">
                  {row.content.length > 180 ? `${row.content.slice(0, 180)}…` : row.content}
                </p>
                <div className="editor-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={scopedBusy}
                    onClick={() => editScoped(row)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={scopedBusy}
                    onClick={() => void deleteScoped(row)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form className="persona-form" onSubmit={saveScoped}>
          <div className="resolve-controls">
            <label>
              Channel
              <select
                value={scopedChannel}
                onChange={(e) => setScopedChannel(e.target.value as Channel)}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Persona
              <select value={scopedPersonaId} onChange={(e) => setScopedPersonaId(e.target.value)}>
                <option value="">(any persona)</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Campaign
              <select
                value={scopedCampaignId}
                onChange={(e) => setScopedCampaignId(e.target.value)}
              >
                <option value="">(any campaign)</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Textarea
            value={scopedContent}
            onChange={(e) => setScopedContent(e.target.value)}
            placeholder="Guidance that applies only at this scope — it replaces the workspace text above…"
            rows={4}
            maxLength={GUIDANCE_CONTENT_MAX_CHARS}
          />
          <div className="editor-actions">
            <button
              type="submit"
              disabled={
                scopedBusy ||
                scopedContent.trim().length === 0 ||
                (!scopedPersonaId && !scopedCampaignId)
              }
            >
              {scopedBusy ? "Saving…" : "Save scoped guidance"}
            </button>
            {!scopedPersonaId && !scopedCampaignId && (
              <span className="meta">Pick a persona and/or campaign — unscoped text lives above.</span>
            )}
          </div>
        </form>
      </section>
    </>
  );
}
