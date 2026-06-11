"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  APPROVAL_STATES,
  type ApprovalDecision,
  type ApprovalState,
  type Campaign,
  type Draft,
  type Persona,
  type TaskType,
  type Workspace,
} from "@tuezday/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const TASK_LABELS: Record<TaskType, string> = {
  linkedin_post: "LinkedIn post",
  cold_email_opener: "Cold email opener",
  ad_copy_variant: "Ad copy variant",
  landing_page_hero: "Landing page hero",
  signal_response: "Signal response",
};

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  edited: "Edited",
  approved: "Approved",
  rejected: "Rejected",
};

type Filter = ApprovalState | "all";

export default function ApprovalsPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [filter, setFilter] = useState<Filter>("pending_review");
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ApprovalDecision[]>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, dRes, cRes] = await Promise.all([
        fetch(`${API_URL}/workspaces/${id}`),
        fetch(`${API_URL}/workspaces/${id}/personas`),
        fetch(`${API_URL}/workspaces/${id}/drafts`),
        fetch(`${API_URL}/workspaces/${id}/campaigns`),
      ]);
      if (!wsRes.ok || !pRes.ok || !dRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setDrafts(await dRes.json());
      setCampaigns(await cRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function action(draftId: string, name: string, payload?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      // Only set the JSON header when there is a body — Fastify rejects an
      // empty body that claims to be JSON.
      const res = await fetch(`${API_URL}/workspaces/${id}/drafts/${draftId}/${name}`, {
        method: "POST",
        ...(payload
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
          : {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setEditingId(null);
      await load();
      if (historyId === draftId) await loadHistory(draftId);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${name}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadHistory(draftId: string) {
    const res = await fetch(`${API_URL}/workspaces/${id}/drafts/${draftId}`);
    if (res.ok) {
      const detail = await res.json();
      setDecisions((d) => ({ ...d, [draftId]: detail.decisions }));
    }
  }

  async function toggleHistory(draftId: string) {
    if (historyId === draftId) {
      setHistoryId(null);
      return;
    }
    setHistoryId(draftId);
    if (!decisions[draftId]) await loadHistory(draftId);
  }

  function personaName(pid: string | null): string {
    if (!pid) return "org voice";
    return personas.find((p) => p.id === pid)?.name ?? "deleted persona";
  }

  const visible = filter === "all" ? drafts : drafts.filter((d) => d.state === filter);
  const counts = (state: Filter) =>
    state === "all" ? drafts.length : drafts.filter((d) => d.state === state).length;
  const filters: Filter[] = ["pending_review", "edited", "approved", "rejected", "all"];

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
            <Link href={`/workspaces/${id}`}>{workspace.name}</Link> / Approvals
          </p>
          <h1>Approval Queue</h1>
          <p className="subtitle">
            Nothing ships without a human decision. Every action here is recorded.
          </p>
        </div>
        <div className="persona-actions">
          <Link className="button-secondary" href={`/workspaces/${id}`}>
            ← Brain
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/sandbox`}>
            Sandbox
          </Link>
          <Link className="button-secondary" href={`/workspaces/${id}/content`}>
            Content
          </Link>
        </div>
      </div>

      <div className="filter-tabs">
        {filters.map((f) => (
          <button
            key={f}
            className={`filter-tab ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : STATE_LABELS[f]} ({counts(f)})
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {visible.length === 0 ? (
        <p className="empty">
          {drafts.length === 0
            ? "The queue is empty. Generate something in the sandbox and send it here."
            : "Nothing in this state."}
        </p>
      ) : (
        <ul className="section-list">
          {visible.map((d) => {
            const editable = d.state === "pending_review" || d.state === "edited";
            const isEditing = editingId === d.id;
            return (
              <li key={d.id} className="section-card">
                <div className="section-head">
                  <span className={`layer-badge state-${d.state}`}>{STATE_LABELS[d.state]}</span>
                  <span className="section-title">
                    {TASK_LABELS[d.taskType]} · {d.channel} · {personaName(d.personaId)}
                    {d.campaignId && (
                      <span className="layer-badge layer-campaign" style={{ marginLeft: 8 }}>
                        {campaigns.find((c) => c.id === d.campaignId)?.name ?? "campaign"}
                      </span>
                    )}
                  </span>
                  <span className="section-tokens">
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                </div>

                {isEditing ? (
                  <div className="doc-editor" style={{ marginTop: 10 }}>
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={8}
                    />
                    <div className="editor-actions">
                      <button
                        disabled={busy || editContent.trim().length === 0}
                        onClick={() => action(d.id, "edit", { content: editContent })}
                      >
                        Save edit
                      </button>
                      <button className="button-secondary" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <pre className="output-text">{d.content}</pre>
                    {d.content !== d.originalContent && (
                      <details className="original-content">
                        <summary>Original (before edits)</summary>
                        <pre className="section-content">{d.originalContent}</pre>
                      </details>
                    )}
                  </>
                )}

                {!isEditing && (
                  <div className="rating-row">
                    {d.state === "approved" && (
                      <>
                        <button
                          className="button-secondary"
                          onClick={async () => {
                            await navigator.clipboard.writeText(d.content);
                          }}
                        >
                          ⧉ Copy
                        </button>
                        <button
                          className="button-secondary"
                          onClick={() => {
                            const a = document.createElement("a");
                            a.href = URL.createObjectURL(
                              new Blob([d.content], { type: "text/markdown" }),
                            );
                            a.download = `tuezday-${d.channel}-${d.id.slice(0, 8)}.md`;
                            a.click();
                            URL.revokeObjectURL(a.href);
                          }}
                        >
                          ↓ Download .md
                        </button>
                      </>
                    )}
                    {editable && (
                      <>
                        <button
                          className="button-secondary rating-accepted"
                          disabled={busy}
                          onClick={() => action(d.id, "approve")}
                        >
                          ✓ Approve
                        </button>
                        <button
                          className="button-secondary"
                          disabled={busy}
                          onClick={() => {
                            setEditingId(d.id);
                            setEditContent(d.content);
                          }}
                        >
                          ✎ Edit
                        </button>
                        <button
                          className="button-secondary rating-rejected"
                          disabled={busy}
                          onClick={() => action(d.id, "reject")}
                        >
                          ✗ Reject
                        </button>
                        {d.state === "edited" && (
                          <button
                            className="button-secondary"
                            disabled={busy}
                            onClick={() => action(d.id, "resubmit")}
                          >
                            ↺ Resubmit for review
                          </button>
                        )}
                      </>
                    )}
                    <button className="link-button" onClick={() => toggleHistory(d.id)}>
                      {historyId === d.id ? "hide history" : "history"}
                    </button>
                  </div>
                )}

                {historyId === d.id && decisions[d.id] && (
                  <ul className="decision-log">
                    {decisions[d.id]!.map((dec) => (
                      <li key={dec.id}>
                        <span className="meta">
                          {new Date(dec.createdAt).toLocaleString()} · {dec.actor}
                        </span>{" "}
                        <strong>{dec.action}</strong>: {STATE_LABELS[dec.fromState]} →{" "}
                        {STATE_LABELS[dec.toState]}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
