"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { BrainDocType, BrainDocVersion, BrainDocument, Workspace } from "@tuezday/contracts";
import { BRAIN_DOC_META, type BrainScore } from "@tuezday/brain";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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

  const selectedDoc = useMemo(
    () => brain?.docs.find((d) => d.docType === selected) ?? null,
    [brain, selected],
  );
  const selectedMeta = BRAIN_DOC_META.find((m) => m.docType === selected)!;
  const dirty = selectedDoc !== null && draft !== selectedDoc.content;

  const load = useCallback(async () => {
    try {
      const [wsRes, brainRes] = await Promise.all([
        fetch(`${API_URL}/workspaces/${id}`),
        fetch(`${API_URL}/workspaces/${id}/brain`),
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
      const res = await fetch(`${API_URL}/workspaces/${id}/brain/${selected}`, {
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
    const res = await fetch(`${API_URL}/workspaces/${id}/brain/${selected}/versions`);
    if (res.ok) setVersions(await res.json());
  }

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    setPreviewVersion(null);
    if (next && versions === null) await loadVersions();
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
      <div className="brain-header">
        <div>
          <p className="breadcrumb">
            <Link href="/">Workspaces</Link> / {workspace.name}
          </p>
          <h1>{workspace.name} — Brain</h1>
          <p className="subtitle">
            Brain completeness: <strong>{brain.completeness.percent}%</strong>
          </p>
        </div>
        <div className="persona-actions">
          <Link className="button-secondary" href={`/workspaces/${id}/resolver`}>
            Resolver
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/sandbox`}>
            Sandbox
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/approvals`}>
            Approvals
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/content`}>
            Content
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/discovery`}>
            Discovery
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/campaigns`}>
            Campaigns
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/evidence`}>
            Evidence
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/learning`}>
            Learning
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/outbound`}>
            Outbound
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/connectors`}>
            Connectors →
          </Link>
          <a className="button-secondary" href={`${API_URL}/workspaces/${id}/brain/export`}>
            Export brain (.md)
          </a>
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
    </>
  );
}
