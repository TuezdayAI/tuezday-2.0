"use client";

import { API_URL, apiDownload, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { BrainDocType, BrainDocVersion, BrainDocument, Workspace } from "@tuezday/contracts";
import { CHANNEL_LABELS, type Channel, type ChannelGuidance } from "@tuezday/contracts";
import { BRAIN_DOC_META, type BrainScore } from "@tuezday/brain";
import { BrainTemplates } from "./_components/brain-templates";

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

  const selectedDoc = useMemo(
    () => brain?.docs.find((d) => d.docType === selected) ?? null,
    [brain, selected],
  );
  const selectedMeta = BRAIN_DOC_META.find((m) => m.docType === selected)!;
  const dirty = selectedDoc !== null && draft !== selectedDoc.content;

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

  useEffect(() => {
    void loadGuidance();
  }, [loadGuidance]);

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

  if (error && !brain) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!brain || !workspace) return <p className="empty">Loading…</p>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Brain</h1>
          <p className="subtitle">
            Everything Tuezday knows about your company — edit it anytime. Completeness:{" "}
            <strong>{brain.completeness.percent}%</strong>
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={() => void apiDownload(`/workspaces/${id}/brain/export`, "gtm-brain.md")}
          >
            Export brain (.md)
          </button>
        </div>
      </div>

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

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Write the ${selectedMeta.title} doc in markdown…`}
            rows={18}
          />

          {error && <p className="error">{error}</p>}
          
          {selectedDoc?.content.trim() === "" && (
            <BrainTemplates onApply={save} />
          )}

          <div className="editor-actions">
            <button onClick={() => save(draft)} disabled={saving || !dirty}>
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
            <button className="button-secondary" onClick={toggleHistory}>
              {showHistory ? "Hide history" : "History"}
            </button>
            {dirty && <span className="unsaved">Unsaved changes</span>}
          </div>

          {showHistory && (
            <div className="history">
              {versions === null ? (
                <p className="empty">Loading versions…</p>
              ) : versions.length === 0 ? (
                <p className="empty">No saved versions yet. Versions appear after the first save.</p>
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
                  <button
                    className="button-secondary"
                    disabled={saving}
                    onClick={() => save(previewVersion.content)}
                  >
                    Restore v{previewVersion.version}
                  </button>
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
          <p className="empty">Loading guidance…</p>
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
                  <textarea
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
                      <button
                        className="button-secondary"
                        onClick={() => void resetGuidance(g.channel)}
                        disabled={busy}
                      >
                        Reset to default
                      </button>
                    )}
                    {dirty && <span className="unsaved">Unsaved changes</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
