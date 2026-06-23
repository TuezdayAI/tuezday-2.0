"use client";

import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { EvidenceCandidate, EvidenceDocument, Workspace } from "@tuezday/contracts";

interface EvidenceView {
  documents: EvidenceDocument[];
  store: { healthy: boolean; detail?: string };
}

function originLabel(kind: EvidenceDocument["kind"]): string {
  return kind === "signal" ? "From signal" : kind === "published" ? "From published" : "Manual";
}

export default function EvidencePage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<EvidenceView | null>(null);
  const [candidates, setCandidates] = useState<EvidenceCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, eRes, cRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/evidence`),
        apiFetch(`/workspaces/${id}/evidence/candidates`),
      ]);
      if (!wsRes.ok || !eRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setView(await eRes.json());
      setCandidates(cRes.ok ? (await cRes.json()).candidates : []);
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
      const res = await apiFetch(`/workspaces/${id}/evidence`, {
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
    await apiFetch(`/workspaces/${id}/evidence/${doc.id}`, { method: "DELETE" });
    await load();
  }

  async function acceptCandidate(c: EvidenceCandidate) {
    setError(null);
    const res = await apiFetch(`/workspaces/${id}/evidence/candidates/${c.id}/accept`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.message ?? `Could not accept this candidate (${res.status}).`);
      return;
    }
    await load();
  }

  async function dismissCandidate(c: EvidenceCandidate) {
    await apiFetch(`/workspaces/${id}/evidence/candidates/${c.id}/dismiss`, { method: "POST" });
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
      <div className="page-header">
        <div>
          <h1>Evidence library</h1>
          <p className="subtitle">
            Supporting material Tuezday can pull in and cite — website copy, past posts,
            research, call notes.
          </p>
        </div>
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
        <h2>Ingest candidates ({candidates.length})</h2>
        <p className="subtitle" style={{ marginTop: 0 }}>
          Signals and published posts the worker proposes for the corpus. Accept the useful ones —
          nothing is ingested until you do.
        </p>
        {candidates.length === 0 ? (
          <p className="empty">
            No pending candidates. The worker proposes your signals and published posts here as they
            appear.
          </p>
        ) : (
          <ul className="section-list">
            {candidates.map((c) => (
              <li key={c.id} className="section-card">
                <div className="section-head">
                  <span className="layer-badge">
                    {c.kind === "signal" ? "From signal" : "From published"}
                  </span>
                  <span className="section-title">{c.title}</span>
                  <span className="section-tokens">
                    {new Date(c.sourceCreatedAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="meta" style={{ whiteSpace: "pre-wrap" }}>
                  {c.content.slice(0, 240)}
                  {c.content.length > 240 ? "…" : ""}
                </p>
                <div className="rating-row" style={{ marginTop: 8 }}>
                  <button onClick={() => acceptCandidate(c)} disabled={!view.store.healthy}>
                    Accept into corpus
                  </button>
                  <button className="button-secondary" onClick={() => dismissCandidate(c)}>
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
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
                  <span className="layer-badge">{originLabel(doc.kind)}</span>
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
