"use client";

import { TopBarActions } from "@/src/components/top-bar";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { Input, Textarea } from "@/src/components/ui/input";
import styles from "./evidence.module.css";

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

/** Registry icon per document origin (spec §4 vocabulary). */
function kindIcon(kind: EvidenceDocument["kind"]): IconName {
  return kind === "signal" ? "discover" : kind === "published" ? "post" : "blog";
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
  const [showAdd, setShowAdd] = useState(false);

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

  if (!workspace || !view) return <EmptyState description="Loading…" />;

  return (
    <>
      <TopBarActions>
        <Button variant="secondary" size="compact" onClick={() => setShowAdd((v) => !v)}>
          <Icon name="add" size="compact" />
          Add evidence
        </Button>
      </TopBarActions>

      <p className="subtitle">
        Supporting material Tuezday can pull in and cite — website copy, past posts, research,
        call notes.
      </p>

      {!view.store.healthy && (
        <p className="error">
          Evidence store offline: {view.store.detail ?? "the evidence store is unavailable."} Existing context
          resolution keeps working without evidence.
        </p>
      )}

      {showAdd && (
        <Card>
          <CardHeader
            title={
              <span className={styles.head}>
                <Icon name="add" size="compact" className={styles.headIcon} />
                Add evidence
              </span>
            }
          />
          <form
            className="persona-form"
            style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}
            onSubmit={upload}
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (e.g. Website copy, June launch post, Customer call notes)"
              maxLength={200}
            />
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste the document text…"
              rows={8}
            />
            <div className="editor-actions">
              <Button
                variant="primary"
                type="submit"
                disabled={
                  uploading ||
                  !view.store.healthy ||
                  title.trim().length === 0 ||
                  content.trim().length === 0
                }
              >
                {uploading ? "Ingesting…" : "Add to corpus"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {error && <p className="error">{error}</p>}

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-review" size="compact" className={styles.headIconReview} />
              Ingest candidates <CountBadge count={candidates.length} label="pending candidates" />
            </span>
          }
        />
        <p className="subtitle" style={{ marginTop: 0 }}>
          Signals and published posts the worker proposes for the corpus. Accept the useful ones —
          nothing is ingested until you do.
        </p>
        {candidates.length === 0 ? (
          <EmptyState description={<>No pending candidates — the worker proposes your signals and published posts here as they
            appear. Accepted candidates join the corpus below.</>} />
        ) : (
          <ul className="section-list">
            {candidates.map((c) => (
              <li key={c.id} className="section-card">
                <div className="section-head">
                  <span className={styles.kindMark} title={originLabel(c.kind)}>
                    <Icon name={kindIcon(c.kind)} size="compact" />
                  </span>
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
                  <Button variant="primary" onClick={() => acceptCandidate(c)} disabled={!view.store.healthy}>
                    Accept into corpus
                  </Button>
                  <Button variant="secondary" size="compact" onClick={() => dismissCandidate(c)}>
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="doc-history" size="compact" className={styles.headIcon} />
              Corpus <CountBadge count={view.documents.length} label="documents in the corpus" />
            </span>
          }
        />
        {view.documents.length === 0 ? (
          <EmptyState
            description={<>No evidence yet. Paste your website copy and a few past posts to give the brain
            something to cite.</>}
            primaryAction={
              <Button variant="secondary" size="compact" onClick={() => setShowAdd(true)}>
                <Icon name="add" size="compact" />
                Add evidence
              </Button>
            }
            preview={
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="blog" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>Website copy — homepage & pricing</span>
                  <span className={styles.previewMeta}>4,200 chars</span>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="post" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>June launch post</span>
                  <span className={styles.previewMeta}>1,100 chars</span>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="blog" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>Customer call notes — onboarding pains</span>
                  <span className={styles.previewMeta}>2,700 chars</span>
                </div>
              </div>
            }
          />
        ) : (
          <ul className="section-list">
            {view.documents.map((doc) => (
              <li key={doc.id} className="section-card">
                <div className="section-head">
                  <span className={styles.kindMark} title={originLabel(doc.kind)}>
                    <Icon name={kindIcon(doc.kind)} size="compact" />
                  </span>
                  <Badge
                    tone={
                      doc.status === "ready"
                        ? "approved"
                        : doc.status === "failed"
                          ? "rejected"
                          : "edited"
                    }
                  >
                    {doc.status}
                  </Badge>
                  <span className="layer-badge">{originLabel(doc.kind)}</span>
                  <span className="section-title">{doc.title}</span>
                  <span className="section-tokens">
                    {doc.chars.toLocaleString()} chars ·{" "}
                    {new Date(doc.createdAt).toLocaleDateString()}
                  </span>
                </div>
                {doc.error && <p className="error-inline">{doc.error}</p>}
                <div className="rating-row" style={{ marginTop: 8 }}>
                  <Button variant="danger" size="compact" onClick={() => remove(doc)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
