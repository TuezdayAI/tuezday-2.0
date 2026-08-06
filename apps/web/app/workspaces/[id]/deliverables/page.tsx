"use client";

import { TopBarActions } from "@/src/components/top-bar";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Select } from "@/src/components/ui/input";
import styles from "./deliverables.module.css";

import { API_URL, apiFetch } from "@/lib/api";
import {
  actionsFor,
  canGenerateNow,
  selectableVariants,
  slotLabel,
} from "@/lib/deliverable-view";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { DELIVERABLE_PRODUCTION_STATUSES } from "@tuezday/contracts";
import type {
  ContextSnapshot,
  Deliverable,
  DeliverableDecisionAction,
  DeliverableDetail,
  DeliverableProductionStatus,
  DeliverableRunResult,
  Variant,
  VariantStatus,
  Workspace,
} from "@tuezday/contracts";

const PAGE_SIZE = 20;

/** Badge tone per production status — fulfilled reads as live, stale as aging. */
function statusTone(
  status: DeliverableProductionStatus,
): "draft" | "approved" | "pending" | "edited" | "rejected" | "danger" | "neutral" {
  switch (status) {
    case "planned":
      return "draft";
    case "ready":
    case "candidate_ready":
      return "pending";
    case "generating":
      return "edited";
    case "fulfilled":
      return "approved";
    case "blocked":
      return "danger";
    case "stale":
    case "cancelled":
      return "rejected";
    default:
      return "neutral";
  }
}

function variantTone(status: VariantStatus): "approved" | "neutral" | "rejected" {
  switch (status) {
    case "selected":
      return "approved";
    case "superseded":
      return "rejected";
    default:
      return "neutral";
  }
}

function label(value: string): string {
  return value.replace(/_/g, " ");
}

const DECISION_LABELS: Record<DeliverableDecisionAction, string> = {
  regenerate: "Regenerate",
  select: "Select",
  cancel: "Cancel deliverable",
};

interface SnapshotSection {
  key: string;
  title?: string;
  included?: boolean;
  reason?: string;
  tokens?: number;
}

function snapshotSections(snapshot: ContextSnapshot): SnapshotSection[] {
  const resolved = snapshot.resolvedContext as { sections?: SnapshotSection[] } | null;
  return Array.isArray(resolved?.sections) ? resolved.sections : [];
}

export default function DeliverablesPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [items, setItems] = useState<Deliverable[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<DeliverableProductionStatus | "all">(
    "all",
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<DeliverableRunResult | null>(null);

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, DeliverableDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const [deciding, setDeciding] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [selectFor, setSelectFor] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const [snapshots, setSnapshots] = useState<Record<string, ContextSnapshot>>({});
  const [snapshotOpenFor, setSnapshotOpenFor] = useState<string | null>(null);

  const statusQuery = statusFilter === "all" ? "" : `&status=${statusFilter}`;

  const load = useCallback(async () => {
    try {
      const [wsRes, dRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/deliverables?limit=${PAGE_SIZE}&offset=0${statusQuery}`),
      ]);
      if (!wsRes.ok || !dRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      const body = await dRes.json();
      setItems(body.deliverables);
      setTotal(body.total);
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id, statusQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!items) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/workspaces/${id}/deliverables?limit=${PAGE_SIZE}&offset=${items.length}${statusQuery}`,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setItems((prev) => [...(prev ?? []), ...body.deliverables]);
      setTotal(body.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more deliverables");
    } finally {
      setLoadingMore(false);
    }
  }

  /** Detail responses carry the fresh row — keep list and cache consistent. */
  function applyDetail(detail: DeliverableDetail) {
    setItems(
      (prev) =>
        prev?.map((entry) =>
          entry.id === detail.deliverable.id ? detail.deliverable : entry,
        ) ?? prev,
    );
    setDetails((prev) => ({ ...prev, [detail.deliverable.id]: detail }));
  }

  async function toggleDetail(deliverableId: string) {
    if (open[deliverableId]) {
      setOpen((prev) => ({ ...prev, [deliverableId]: false }));
      return;
    }
    setOpen((prev) => ({ ...prev, [deliverableId]: true }));
    if (details[deliverableId]) return;
    setDetailLoading(deliverableId);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/deliverables/${deliverableId}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      applyDetail(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load deliverable detail");
      setOpen((prev) => ({ ...prev, [deliverableId]: false }));
    } finally {
      setDetailLoading(null);
    }
  }

  async function decide(
    deliverableId: string,
    action: DeliverableDecisionAction,
    extra: { variantId?: string; reason?: string } = {},
  ) {
    // Contracts decision schema: cancel needs a reason, select a variant.
    if (action === "cancel" && !extra.reason) return;
    if (action === "select" && !extra.variantId) return;
    setDeciding(deliverableId);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/deliverables/${deliverableId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      applyDetail(body);
      setReasonFor(null);
      setReasonText("");
      setSelectFor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setDeciding(null);
    }
  }

  async function generateNow(deliverableId: string) {
    setGeneratingId(deliverableId);
    setError(null);
    setNotes((prev) => ({ ...prev, [deliverableId]: "" }));
    try {
      const res = await apiFetch(
        `/workspaces/${id}/deliverables/${deliverableId}/generate`,
        { method: "POST" },
      );
      const body = await res.json().catch(() => null);
      if (res.status === 409 && body?.error === "not_due") {
        setNotes((prev) => ({
          ...prev,
          [deliverableId]:
            "Not due for generation right now — it may already be in progress.",
        }));
        return;
      }
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      applyDetail(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGeneratingId(null);
    }
  }

  async function toggleSnapshot(deliverableId: string, variant: Variant) {
    if (snapshotOpenFor === variant.id) {
      setSnapshotOpenFor(null);
      return;
    }
    setSnapshotOpenFor(variant.id);
    if (snapshots[variant.id]) return;
    try {
      const res = await apiFetch(
        `/workspaces/${id}/deliverables/${deliverableId}/variants/${variant.id}/snapshot`,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setSnapshots((prev) => ({ ...prev, [variant.id]: body }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the context snapshot");
      setSnapshotOpenFor(null);
    }
  }

  async function runPipeline() {
    setRunning(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/deliverables/run`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setRunResult(body);
      setDetails({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pipeline run failed");
    } finally {
      setRunning(false);
    }
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace || !items) return <EmptyState description="Loading…" />;

  const runButton = (
    <Button variant="secondary" size="compact" disabled={running} onClick={runPipeline}>
      <Icon name="regenerate" size="compact" />
      {running ? "Running…" : "Run pipeline"}
    </Button>
  );

  return (
    <>
      <TopBarActions>{runButton}</TopBarActions>

      <p className="subtitle">
        Lane commitments and their candidate executions. Planned slots come from each lane&#39;s
        schedule; ready packages fan out into them. Every variant keeps a replayable context
        snapshot, and regeneration never overwrites history. This layer runs in shadow: nothing
        is dispatched yet.
      </p>

      {error && <p className="error">{error}</p>}

      {runResult && (
        <p className={styles.runNote}>
          Pipeline complete — {runResult.slotsMaterialized.toLocaleString()} slots materialized,{" "}
          {runResult.packagesFannedOut.toLocaleString()} packages fanned out (
          {runResult.deliverablesCreated.toLocaleString()} deliverables),{" "}
          {runResult.variantsGenerated.toLocaleString()} variants generated
          {runResult.staled > 0 ? `, ${runResult.staled.toLocaleString()} went stale` : ""}
          {runResult.failures > 0
            ? `, ${runResult.failures.toLocaleString()} failures`
            : ", no failures"}
          .
        </p>
      )}

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="discover" size="compact" className={styles.headIcon} />
              Deliverables <CountBadge count={total} label="deliverables" />
            </span>
          }
          actions={
            <label className={styles.filterLabel}>
              Status
              <Select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as DeliverableProductionStatus | "all")
                }
              >
                <option value="all">All statuses</option>
                {DELIVERABLE_PRODUCTION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </Select>
            </label>
          }
        />
        {items.length === 0 ? (
          <EmptyState
            description={
              statusFilter === "all" ? (
                <>
                  No deliverables yet — activate a plan with scheduled lanes, get packages to
                  ready, then run the pipeline.
                </>
              ) : (
                <>No deliverables with status “{label(statusFilter)}”.</>
              )
            }
            primaryAction={statusFilter === "all" ? runButton : undefined}
            preview={
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="discover" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>Founder LinkedIn · Tue 10:00</span>
                  <span className={styles.previewMeta}>candidate ready · v2</span>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="discover" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>Instagram reactive</span>
                  <span className={styles.previewMeta}>fulfilled · v1 selected</span>
                </div>
              </div>
            }
          />
        ) : (
          <ul className={styles.itemList}>
            {items.map((item) => {
              const actions = actionsFor(item);
              const reasonOpen = reasonFor === item.id;
              const selectOpen = selectFor === item.id;
              const detail = open[item.id] ? details[item.id] : undefined;
              const note = notes[item.id];
              const candidates = detail ? selectableVariants(detail.variants) : [];
              return (
                <li key={item.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span className={styles.laneName}>{item.laneName}</span>
                    <Badge tone={statusTone(item.status)}>{label(item.status)}</Badge>
                    <span className={styles.chip}>
                      {item.channel} / {item.format}
                    </span>
                    <span className={styles.chip}>{slotLabel(item)}</span>
                    {item.variantCount > 0 && (
                      <span className={styles.chip}>
                        {item.variantCount} variant{item.variantCount === 1 ? "" : "s"}
                      </span>
                    )}
                    <span className="section-tokens">{item.campaignName}</span>
                  </div>
                  {item.angle && <p className={styles.angle}>{item.angle}</p>}
                  {item.generationState === "failed" && (
                    <p className={styles.failedNote}>
                      Generation failed after {item.generationAttempts} attempt
                      {item.generationAttempts === 1 ? "" : "s"} — retries exhausted,
                      regenerate to queue it again.
                    </p>
                  )}
                  {note && <p className={styles.assessNote}>{note}</p>}
                  {!reasonOpen && !selectOpen && (
                    <div className={styles.actionRow}>
                      <Button
                        variant="tertiary"
                        size="compact"
                        disabled={detailLoading === item.id}
                        onClick={() => void toggleDetail(item.id)}
                      >
                        {detailLoading === item.id
                          ? "Loading…"
                          : open[item.id]
                            ? "Hide details"
                            : "Details"}
                      </Button>
                      {canGenerateNow(item) && (
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={generatingId === item.id}
                          onClick={() => void generateNow(item.id)}
                        >
                          {generatingId === item.id ? "Generating…" : "Generate now"}
                        </Button>
                      )}
                      {actions.map((action) => (
                        <Button
                          key={action}
                          variant={action === "cancel" ? "danger" : "secondary"}
                          size="compact"
                          disabled={deciding === item.id}
                          onClick={() => {
                            if (action === "cancel") {
                              setReasonFor(item.id);
                              setReasonText("");
                            } else if (action === "select") {
                              setSelectFor(item.id);
                              if (!details[item.id]) void toggleDetail(item.id);
                            } else {
                              void decide(item.id, action);
                            }
                          }}
                        >
                          {DECISION_LABELS[action]}
                        </Button>
                      ))}
                    </div>
                  )}
                  {reasonOpen && (
                    <div className={styles.reasonRow}>
                      <Input
                        placeholder="Reason to cancel (required)"
                        value={reasonText}
                        onChange={(e) => setReasonText(e.target.value)}
                        autoFocus
                      />
                      <Button
                        variant="primary"
                        size="compact"
                        disabled={deciding === item.id || reasonText.trim().length === 0}
                        onClick={() =>
                          void decide(item.id, "cancel", { reason: reasonText.trim() })
                        }
                      >
                        Confirm
                      </Button>
                      <Button
                        variant="tertiary"
                        size="compact"
                        onClick={() => {
                          setReasonFor(null);
                          setReasonText("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                  {selectOpen && (
                    <div className={styles.actionRow}>
                      {candidates.length === 0 ? (
                        <span className={styles.assessNote}>No candidates to select.</span>
                      ) : (
                        candidates.map((candidate) => (
                          <Button
                            key={candidate.id}
                            variant="primary"
                            size="compact"
                            disabled={deciding === item.id}
                            onClick={() =>
                              void decide(item.id, "select", { variantId: candidate.id })
                            }
                          >
                            Select v{candidate.variantVersion}
                          </Button>
                        ))
                      )}
                      <Button
                        variant="tertiary"
                        size="compact"
                        onClick={() => setSelectFor(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                  {detail && (
                    <div className={styles.detail}>
                      <div className={styles.detailSection}>
                        <h4 className={styles.detailTitle}>Variants</h4>
                        {detail.variants.length === 0 ? (
                          <p className="meta">No variants generated yet.</p>
                        ) : (
                          <ul className={styles.variantList}>
                            {detail.variants.map((variant) => (
                              <li key={variant.id} className={styles.variant}>
                                <div className={styles.variantHead}>
                                  <Badge tone={variantTone(variant.status)}>
                                    v{variant.variantVersion} · {label(variant.status)}
                                  </Badge>
                                  <span className={styles.chip}>{variant.model}</span>
                                  <span className="section-tokens">
                                    {new Date(variant.createdAt).toLocaleString()}
                                  </span>
                                  <Button
                                    variant="tertiary"
                                    size="compact"
                                    onClick={() => void toggleSnapshot(item.id, variant)}
                                  >
                                    {snapshotOpenFor === variant.id
                                      ? "Hide context"
                                      : "Why this"}
                                  </Button>
                                </div>
                                <p className={styles.variantContent}>{variant.content}</p>
                                {snapshotOpenFor === variant.id &&
                                  snapshots[variant.id] && (
                                    <div className={styles.snapshotBox}>
                                      {snapshotSections(snapshots[variant.id]!).map(
                                        (section) => (
                                          <div
                                            key={section.key}
                                            className={styles.snapshotSection}
                                          >
                                            <span className={styles.snapshotKey}>
                                              {section.included ? "✓" : "—"}{" "}
                                              {section.title ?? section.key}
                                            </span>
                                            {section.reason && (
                                              <span className={styles.snapshotReason}>
                                                {section.reason}
                                              </span>
                                            )}
                                          </div>
                                        ),
                                      )}
                                    </div>
                                  )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className={styles.detailSection}>
                        <h4 className={styles.detailTitle}>Events</h4>
                        <ul className={styles.eventList}>
                          {detail.events.map((event) => (
                            <li key={event.id} className={styles.event}>
                              <span className={styles.eventTransition}>
                                {event.fromStatus === null
                                  ? label(event.toStatus)
                                  : `${label(event.fromStatus)} → ${label(event.toStatus)}`}
                              </span>
                              {event.reason && <span>{event.reason}</span>}
                              <span className={styles.eventDate}>
                                {new Date(event.createdAt).toLocaleString()}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {items.length > 0 && items.length < total && (
          <div className={styles.loadMoreRow}>
            <Button variant="secondary" size="compact" disabled={loadingMore} onClick={loadMore}>
              {loadingMore
                ? "Loading…"
                : `Load more (${(total - items.length).toLocaleString()} remaining)`}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
