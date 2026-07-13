"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  canTransition,
  type ApprovalAction,
  type DraftEditorContext,
  type WorkflowStatus,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import {
  automationExplanation,
  editorRecoveryHref,
  editorVersionContent,
  editorVersionOptions,
  groupEditorSections,
  stalenessExplanation,
  type EditorVersionId,
} from "@/lib/conversational-editor";
import { draftWorkflowStatus } from "@/lib/review-workspace";
import { executionWorkflowStatus } from "@/lib/execution-results";
import { previewKindFor } from "@/lib/preview-kind";
import { Button, IconButton } from "@/src/components/ui/button";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { PreviewCard } from "@/src/components/ui/preview-card";
import { BrandIcon, Icon } from "@/src/components/ui/icon";
import type { BrandName } from "@/src/components/ui/brand-icons";
import { toast } from "@/src/components/ui/toast";
import styles from "./conversational-editor.module.css";

interface ConversationalEditorProps {
  workspaceId: string;
  draftId: string;
  previousId: string | null;
  nextId: string | null;
  onNavigate(id: string): void;
  onClose(): void;
  onChanged(): Promise<void> | void;
}

type BusyAction = "revise" | "edit" | "approve" | "reject" | "resubmit" | "review" | "carousel" | null;

const PLATFORM: Partial<Record<DraftEditorContext["draft"]["channel"], BrandName>> = {
  linkedin: "linkedin",
  x: "x",
  instagram: "instagram",
};

function fmtDate(value: number) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function previewCopy(context: DraftEditorContext, content: string) {
  const persona = context.persona?.name ?? "Organization voice";
  if (previewKindFor(context.draft.channel) === "social") {
    return { title: persona, body: content };
  }
  const lines = content.split("\n");
  const title = (lines[0] ?? "").replace(/^#+\s*/, "").trim() || context.draft.taskType;
  return { title, body: lines.slice(1).join("\n").trim() || content };
}

function decisionStatus(action: ApprovalAction): WorkflowStatus {
  switch (action) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "submit":
    case "resubmit":
      return "review_required";
    case "edit":
      return "changes_requested";
  }
}

export function ConversationalEditor({
  workspaceId,
  draftId,
  previousId,
  nextId,
  onNavigate,
  onClose,
  onChanged,
}: ConversationalEditorProps) {
  const [context, setContext] = useState<DraftEditorContext | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<EditorVersionId>("current");
  const [instruction, setInstruction] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [retryLatest, setRetryLatest] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    const response = await apiFetch(`/workspaces/${workspaceId}/drafts/${draftId}/editor`);
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message ?? "Could not load this draft.");
    setContext(body as DraftEditorContext);
    return body as DraftEditorContext;
  }, [workspaceId, draftId]);

  useEffect(() => {
    let cancelled = false;
    setContext(null);
    setSelectedVersion("current");
    setInstruction("");
    setRetryLatest(false);
    setEditing(false);
    setError(null);
    void load()
      .then((next) => {
        if (cancelled) return;
        setEditContent(next.draft.content);
        requestAnimationFrame(() => headingRef.current?.focus());
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load draft.");
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function submitRevision() {
    if (!context || !instruction.trim()) return;
    setBusyAction("revise");
    setError(null);
    setAnnouncement("Tuezday is revising the draft.");
    try {
      const response = await apiFetch(`/workspaces/${workspaceId}/drafts/${draftId}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          instruction,
          expectedDraftUpdatedAt: context.draft.updatedAt,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (body?.error === "draft_changed") {
          await load();
          setRetryLatest(true);
          throw new Error("The draft changed while this revision was running. Review the latest copy, then try again.");
        }
        throw new Error(body?.message ?? `Revision failed (${response.status}).`);
      }
      const next = await load();
      setEditContent(next.draft.content);
      setInstruction("");
      setRetryLatest(false);
      setSelectedVersion("current");
      setAnnouncement("Revision applied to the current draft.");
      toast("Revision applied");
      await onChanged();
    } catch (revisionError) {
      setError(revisionError instanceof Error ? revisionError.message : "Revision failed.");
      setAnnouncement("Revision failed. Your instruction is still available.");
    } finally {
      setBusyAction(null);
    }
  }

  async function draftAction(action: ApprovalAction, payload?: Record<string, unknown>) {
    if (!context) return;
    setBusyAction(action as BusyAction);
    setError(null);
    try {
      const response = await apiFetch(`/workspaces/${workspaceId}/drafts/${draftId}/${action}`, {
        method: "POST",
        ...(payload
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
          : {}),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message ?? `Could not ${action} this draft.`);
      const next = await load();
      setEditContent(next.draft.content);
      setEditing(false);
      setSelectedVersion("current");
      setAnnouncement(`${action === "edit" ? "Edit saved" : `${action} recorded`}.`);
      toast(action === "edit" ? "Edit saved" : `${action[0]!.toUpperCase()}${action.slice(1)}`);
      await onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Could not ${action} draft.`);
    } finally {
      setBusyAction(null);
    }
  }

  async function rerunReview() {
    setBusyAction("review");
    setError(null);
    try {
      const response = await apiFetch(`/workspaces/${workspaceId}/drafts/${draftId}/review`, {
        method: "POST",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message ?? "Could not run review.");
      await load();
      setAnnouncement("Pre-review checks updated.");
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Could not run review.");
    } finally {
      setBusyAction(null);
    }
  }

  async function generateCarousel() {
    setBusyAction("carousel");
    setError(null);
    try {
      const response = await apiFetch(`/workspaces/${workspaceId}/drafts/${draftId}/carousel`, {
        method: "POST",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 402) return;
        throw new Error(body?.message ?? "Could not generate the carousel.");
      }
      setAnnouncement("Carousel generated and added to Review.");
      toast("Carousel generated");
      await onChanged();
      if (body?.id) onNavigate(body.id as string);
    } catch (carouselError) {
      setError(
        carouselError instanceof Error ? carouselError.message : "Could not generate carousel.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function copyCurrent() {
    if (!context) return;
    await navigator.clipboard.writeText(context.draft.content);
    toast("Copied to clipboard");
  }

  function downloadCurrent() {
    if (!context) return;
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([context.draft.content], { type: "text/markdown" }));
    anchor.download = `tuezday-${context.draft.channel}-${context.draft.id.slice(0, 8)}.md`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  if (!context) {
    return (
      <section className={styles.loading} aria-live="polite">
        {error ? (
          <>
            <p className={styles.error}>{error}</p>
            <Button onClick={() => void load()}>Try again</Button>
          </>
        ) : (
          <p>Loading conversational editor…</p>
        )}
      </section>
    );
  }

  const { draft } = context;
  const grouped = groupEditorSections(context.contextSections);
  const content = editorVersionContent(context, selectedVersion);
  const preview = previewCopy(context, content);
  const legalEdit = canTransition(draft.state, "edit");
  const legalApprove = canTransition(draft.state, "approve");
  const legalReject = canTransition(draft.state, "reject");
  const legalResubmit = canTransition(draft.state, "resubmit");
  const mode = context.campaign?.automationMode ?? "manual";

  return (
    <div className={styles.editor}>
      <header className={styles.topbar}>
        <div>
          <span className={styles.eyebrow}>Conversational editor</span>
          <h2 ref={headingRef} tabIndex={-1}>Review and shape this output</h2>
          <p>{draft.taskType.replaceAll("_", " ")} · {draft.channel}</p>
        </div>
        <div className={styles.queueNav}>
          <IconButton label="Previous in queue" disabled={!previousId} onClick={() => previousId && onNavigate(previousId)}>
            <Icon name="chevron-left" size="sm" />
          </IconButton>
          <IconButton label="Next in queue" disabled={!nextId} onClick={() => nextId && onNavigate(nextId)}>
            <Icon name="chevron-right" size="sm" />
          </IconButton>
          <IconButton label="Close editor" onClick={onClose}>
            <Icon name="close" size="sm" />
          </IconButton>
        </div>
      </header>

      {context.staleness.stale && (
        <div className={styles.stale} role="alert">
          <Icon name="warning" size="sm" />
          <span>{stalenessExplanation(context.staleness)}</span>
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <p className={styles.srOnly} aria-live="polite">{announcement}</p>

      <div className={styles.layout}>
        <section className={`${styles.region} ${styles.guidance}`} aria-label="Guidance">
          <div className={styles.regionHead}>
            <div>
              <span className={styles.eyebrow}>Guidance</span>
              <h3>Why Tuezday made this</h3>
            </div>
            <Icon name="brain" size="sm" />
          </div>

          {draft.review ? (
            <div className={styles.reviewChecks}>
              <strong>Pre-review checks</strong>
              {draft.review.checks.map((check) => (
                <div key={check.check} className={styles.checkRow}>
                  <span>{check.check.replaceAll("_", " ")}</span>
                  <span>{check.score === null ? "Unavailable" : `${check.score}/100`}</span>
                </div>
              ))}
              {draft.review.flagged && <p className={styles.warningText}>One or more checks need attention.</p>}
            </div>
          ) : (
            <p className={styles.muted}>No pre-review has been run on this version.</p>
          )}

          <details className={styles.disclosure} open>
            <summary>Sources and context ({grouped.included.length} used)</summary>
            <div className={styles.sectionList}>
              {grouped.included.map((section) => (
                <details key={section.key} className={styles.sourceCard}>
                  <summary><span>{section.title}</span><small>{section.layer}</small></summary>
                  <p>{section.content}</p>
                  <small>{section.reason}</small>
                  {section.evidence?.chunks.map((citation) => (
                    <p key={`${section.key}-${citation.documentId}`} className={styles.citation}>
                      {citation.url ? <a href={citation.url} target="_blank" rel="noreferrer">{citation.title}</a> : citation.title}
                      <span>{citation.kept ? "Used" : citation.exclusionReason ?? "Not used"}</span>
                    </p>
                  ))}
                </details>
              ))}
            </div>
          </details>

          <details className={styles.disclosure}>
            <summary>What was not used ({grouped.excluded.length})</summary>
            <ul className={styles.excludedList}>
              {grouped.excluded.map((section) => (
                <li key={section.key}><strong>{section.title}</strong><span>{section.reason}</span></li>
              ))}
            </ul>
          </details>

          <div className={styles.conversation}>
            <h4>Revision history</h4>
            {context.turns.length === 0 && <p className={styles.muted}>No conversational revisions yet.</p>}
            {context.turns.map((turn) => (
              <article key={turn.id} className={styles.turn} data-status={turn.status}>
                <p><strong>You</strong> {turn.instruction}</p>
                {turn.status === "completed" && <p><strong>Tuezday</strong> Revision applied.</p>}
                {turn.status === "failed" && <p className={styles.errorText}><strong>Failed</strong> {turn.error}</p>}
                <small>{fmtDate(turn.createdAt)}{turn.model ? ` · ${turn.provider}/${turn.model}` : ""}</small>
              </article>
            ))}
          </div>

          {legalEdit && (
            <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void submitRevision(); }}>
              <label htmlFor={`revision-${draft.id}`}>Ask Tuezday to revise</label>
              <textarea
                id={`revision-${draft.id}`}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Make the opening sharper, keep the proof point, and shorten the close."
                maxLength={2000}
                rows={4}
              />
              <div className={styles.composerFoot}>
                <small>{instruction.length}/2,000</small>
                <Button type="submit" variant="primary" size="sm" disabled={busyAction !== null || !instruction.trim()}>
                  <Icon name="regenerate" size="sm" />
                  {busyAction === "revise" ? "Revising…" : retryLatest ? "Try again on latest" : context.turns.some((turn) => turn.status === "failed") ? "Retry revision" : "Revise draft"}
                </Button>
              </div>
            </form>
          )}
        </section>

        <main className={`${styles.region} ${styles.preview}`} aria-label="Preview">
          <div className={styles.regionHead}>
            <div>
              <span className={styles.eyebrow}>Preview</span>
              <h3>Destination preview</h3>
            </div>
            <span className={styles.channel}>{draft.channel}</span>
          </div>

          {(context.siblings.length > 0) && (
            <nav className={styles.siblings} aria-label="Channel variants">
              <button type="button" aria-current="page">{draft.channel}</button>
              {context.siblings.map((sibling) => (
                <button key={sibling.draftId} type="button" onClick={() => onNavigate(sibling.draftId)}>
                  {sibling.channel}
                </button>
              ))}
            </nav>
          )}

          <div className={styles.versions} role="tablist" aria-label="Version history">
            {editorVersionOptions(context).map((version) => (
              <button
                key={version.id}
                type="button"
                role="tab"
                aria-selected={selectedVersion === version.id}
                onClick={() => setSelectedVersion(version.id)}
              >
                {version.label}
              </button>
            ))}
          </div>

          <div className={styles.previewFrame}>
            <PreviewCard
              kind={previewKindFor(draft.channel)}
              title={preview.title}
              body={preview.body}
              workflowStatus={draftWorkflowStatus(draft.state)}
              platform={draft.channel === "ads" ? undefined : PLATFORM[draft.channel]}
              mediaUrl={draft.media?.[0]?.url}
            />
            {draft.media && draft.media.length > 1 && (
              <div className={styles.mediaStrip} aria-label={`${draft.media.length} media items`}>
                {draft.media.map((media, index) => <img key={media.url} src={media.url} alt={`Media ${index + 1}`} />)}
              </div>
            )}
          </div>
        </main>

        <aside className={`${styles.region} ${styles.execution}`} aria-label="Execution">
          <div className={styles.regionHead}>
            <div>
              <span className={styles.eyebrow}>Execution</span>
              <h3>Policy and destination</h3>
            </div>
            <WorkflowStatusBadge status={draftWorkflowStatus(draft.state)} />
          </div>

          <dl className={styles.facts}>
            <div><dt>Campaign</dt><dd>{context.campaign ? <Link href={`/workspaces/${workspaceId}/campaigns/${context.campaign.id}`}>{context.campaign.name}</Link> : "No campaign"}</dd></div>
            <div><dt>Persona</dt><dd>{context.persona?.name ?? "Organization voice"}</dd></div>
            <div><dt>Destination</dt><dd>{context.destination ? <><span className={styles.destination}>{PLATFORM[draft.channel] && <BrandIcon name={PLATFORM[draft.channel]!} size="sm" />}{context.destination.label}</span><small>{context.destination.status}{context.destination.error ? ` · ${context.destination.error}` : ""}</small></> : "Not connected"}</dd></div>
          </dl>

          <div className={styles.policyBox}>
            <h4>Automation policy · {mode.replaceAll("_", " ")}</h4>
            <p>{automationExplanation(mode)}</p>
          </div>

          <div className={styles.authorizationBox}>
            <h4>External action authorization</h4>
            <p>Content approval does not authorize posting, spending, sending, or changing a live destination. Those decisions stay separate and auditable.</p>
            <span>Authorization queue foundation is the next Stage 3 slice.</span>
          </div>

          {context.publications.length > 0 && (
            <div className={styles.activity}>
              <h4>Schedule</h4>
              {context.publications.map((publication) => (
                <Link key={publication.id} href={editorRecoveryHref(workspaceId, publication)} className={styles.activityRow}>
                  <span><strong>{publication.title}</strong><small>{fmtDate(publication.scheduledFor)} · {publication.target}</small></span>
                  <WorkflowStatusBadge status={publication.status === "scheduled" ? "scheduled" : publication.status === "published" ? "completed" : "failed"} />
                </Link>
              ))}
            </div>
          )}

          {context.executions.length > 0 && (
            <div className={styles.activity}>
              <h4>Execution outcomes</h4>
              {context.executions.map((execution) => (
                <Link key={`${execution.kind}-${execution.id}`} href={editorRecoveryHref(workspaceId, execution)} className={styles.activityRow}>
                  <span><strong>{execution.title}</strong><small>{fmtDate(execution.at)}{execution.error ? ` · ${execution.error}` : ""}</small></span>
                  <WorkflowStatusBadge status={executionWorkflowStatus(execution)} />
                </Link>
              ))}
            </div>
          )}

          <div className={styles.tools}>
            <Button variant="secondary" size="sm" onClick={() => void copyCurrent()}>Copy</Button>
            <Button variant="secondary" size="sm" onClick={downloadCurrent}>Download .md</Button>
            {draft.state === "approved" && draft.taskType !== "instagram_carousel" && (
              <Button variant="secondary" size="sm" disabled={busyAction !== null} onClick={() => void generateCarousel()}>
                <Icon name="carousel" size="sm" />
                {busyAction === "carousel" ? "Rendering…" : "Generate carousel"}
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => void rerunReview()}>{draft.review ? "Re-run review" : "Run review"}</Button>
          </div>

          {legalEdit && (
            <div className={styles.directEdit}>
              <Button variant="ghost" size="sm" onClick={() => setEditing((value) => !value)}>
                <Icon name="edit" size="sm" /> {editing ? "Cancel focused edit" : "Focused direct edit"}
              </Button>
              {editing && (
                <div>
                  <textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} rows={7} />
                  <Button variant="primary" size="sm" disabled={busyAction !== null || !editContent.trim()} onClick={() => void draftAction("edit", { content: editContent })}>Save edit</Button>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      <footer className={styles.decisionBar} aria-label="Content decision">
        <div>
          <strong>Content decision</strong>
          <span>Recorded separately from any external action.</span>
        </div>
        <div className={styles.decisionActions}>
          {legalApprove && <Button variant="primary" disabled={busyAction !== null} onClick={() => void draftAction("approve")}><Icon name="approve" size="sm" /> Approve content</Button>}
          {legalReject && <Button variant="danger" disabled={busyAction !== null} onClick={() => void draftAction("reject")}><Icon name="reject" size="sm" /> Reject</Button>}
          {legalResubmit && <Button variant="secondary" disabled={busyAction !== null} onClick={() => void draftAction("resubmit")}><Icon name="regenerate" size="sm" /> Resubmit</Button>}
          {!legalApprove && !legalReject && !legalResubmit && <WorkflowStatusBadge status={draftWorkflowStatus(draft.state)} />}
        </div>
      </footer>

      <div className={styles.decisionAudit} aria-label="Decision history">
        {context.decisions.map((decision) => (
          <span key={decision.id}><WorkflowStatusBadge status={decisionStatus(decision.action)} label={decision.action} /> {decision.actor} · {fmtDate(decision.createdAt)}</span>
        ))}
      </div>
    </div>
  );
}
