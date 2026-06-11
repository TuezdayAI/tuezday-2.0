"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { EvidenceDocument, Workspace } from "@tuezday/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface EvidenceView {
  documents: EvidenceDocument[];
  store: { healthy: boolean; detail?: string };
}

export default function EvidencePage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<EvidenceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, eRes] = await Promise.all([
        fetch(`${API_URL}/workspaces/${id}`),
        fetch(`${API_URL}/workspaces/${id}/evidence`),
      ]);
      if (!wsRes.ok || !eRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setView(await eRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    setUploading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/workspaces/${id}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setTitle("");
      setContent("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function remove(doc: EvidenceDocument) {
    if (!confirm(`Delete "${doc.title}" from the evidence corpus?`)) return;
    await fetch(`${API_URL}/workspaces/${id}/evidence/${doc.id}`, { method: "DELETE" });
    await load();
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace || !view) return <p className="empty">Loading…</p>;

  return (
    <>
      <div className="brain-header">
        <div>
          <p className="breadcrumb">
            <Link href="/">Workspaces</Link> /{" "}
            <Link href={`/workspaces/${id}`}>{workspace.name}</Link> / Evidence
          </p>
          <h1>Evidence Corpus</h1>
          <p className="subtitle">
            Long-tail proof the brain retrieves on demand — website copy, past posts, research,
            call notes. Cited in every bundle that uses it.
          </p>
        </div>
        <Link className="button-secondary" href={`/workspaces/${id}`}>
          ← Brain
        </Link>
      </div>

      {!view.store.healthy && (
        <p className="error">
          Evidence store offline: {view.store.detail ?? "R2R is not reachable."} Existing context
          resolution keeps working without evidence.
        </p>
      )}

      <section className="panel">
        <h2>Add evidence</h2>
        <form
          className="persona-form"
          style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}
          onSubmit={upload}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. Website copy, June launch post, Customer call notes)"
            maxLength={200}
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste the document text…"
            rows={8}
          />
          <div className="editor-actions">
            <button
              type="submit"
              disabled={
                uploading ||
                !view.store.healthy ||
                title.trim().length === 0 ||
                content.trim().length === 0
              }
            >
              {uploading ? "Ingesting…" : "Add to corpus"}
            </button>
            {!view.store.healthy && (
              <span className="meta">Start the store with `npm run r2r:up` first.</span>
            )}
          </div>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <h2>Corpus ({view.documents.length})</h2>
        {view.documents.length === 0 ? (
          <p className="empty">
            No evidence yet. Paste your website copy and a few past posts to give the brain
            something to cite.
          </p>
        ) : (
          <ul className="section-list">
            {view.documents.map((doc) => (
              <li key={doc.id} className="section-card">
                <div className="section-head">
                  <span
                    className={`layer-badge ${
                      doc.status === "ready"
                        ? "state-approved"
                        : doc.status === "failed"
                          ? "state-rejected"
                          : "state-edited"
                    }`}
                  >
                    {doc.status}
                  </span>
                  <span className="section-title">{doc.title}</span>
                  <span className="section-tokens">
                    {doc.chars.toLocaleString()} chars ·{" "}
                    {new Date(doc.createdAt).toLocaleDateString()}
                  </span>
                </div>
                {doc.error && <p className="error">{doc.error}</p>}
                <div className="rating-row" style={{ marginTop: 8 }}>
                  <button className="button-secondary danger" onClick={() => remove(doc)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
