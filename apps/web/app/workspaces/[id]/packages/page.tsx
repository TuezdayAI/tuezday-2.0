"use client";

import { TopBarActions } from "@/src/components/top-bar";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Select } from "@/src/components/ui/input";
import styles from "./packages.module.css";

import { API_URL, apiFetch } from "@/lib/api";
import { blockingChecks, blockingSummary, latestAssessment } from "@/lib/package-view";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  PACKAGE_DECISION_ACTIONS,
  PACKAGE_DECISION_TARGETS,
  PACKAGE_STATUSES,
  canTransitionPackage,
} from "@tuezday/contracts";
import type {
  ContentPackage,
  PackageDecisionAction,
  PackageDetail,
  PackageRunResult,
  PackageStatus,
  SufficiencyVerdict,
  Workspace,
} from "@tuezday/contracts";

const PAGE_SIZE = 20;

/** Badge tone per package status — ready reads as live, cancelled as rejected. */
function statusTone(
  status: PackageStatus,
): "draft" | "approved" | "pending" | "edited" | "rejected" | "danger" | "neutral" {
  switch (status) {
    case "assessing":
      return "neutral";
    case "research_needed":
      return "pending";
    case "ready":
      return "approved";
    case "blocked":
      return "danger";
    case "cancelled":
      return "rejected";
    default:
      return "neutral";
  }
}

function statusLabel(status: PackageStatus | SufficiencyVerdict): string {
  return status.replace(/_/g, " ");
}

function verdictTone(verdict: SufficiencyVerdict): "approved" | "pending" {
  return verdict === "sufficient" ? "approved" : "pending";
}

const DECISION_LABELS: Record<PackageDecisionAction, string> = {
  reassess: "Reassess",
  cancel: "Cancel package",
};

/** Actions whose target transition is legal from the current status — mirrors
 * the contracts state machine; never rolls its own transition logic. The one
 * addition is the queue reset: reassessing an `assessing` package whose
 * sufficiency queue exhausted retries (the server accepts it even though the
 * machine has no assessing→assessing edge). */
function actionsFor(pkg: ContentPackage): PackageDecisionAction[] {
  return PACKAGE_DECISION_ACTIONS.filter((action) => {
    if (canTransitionPackage(pkg.status, PACKAGE_DECISION_TARGETS[action])) return true;
    return (
      action === "reassess" && pkg.status === "assessing" && pkg.assessmentState === "failed"
    );
  });
}

function truncateExcerpt(excerpt: string): string {
  return excerpt.length > 180 ? `${excerpt.slice(0, 180)}…` : excerpt;
}

export default function PackagesPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [packages, setPackages] = useState<ContentPackage[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<PackageStatus | "all">("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<PackageRunResult | null>(null);

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, PackageDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const [deciding, setDeciding] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [assessingId, setAssessingId] = useState<string | null>(null);
  const [assessNotes, setAssessNotes] = useState<Record<string, string>>({});
  const [fanningId, setFanningId] = useState<string | null>(null);

  const statusQuery = statusFilter === "all" ? "" : `&status=${statusFilter}`;

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/packages?limit=${PAGE_SIZE}&offset=0${statusQuery}`),
      ]);
      if (!wsRes.ok || !pRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      const body = await pRes.json();
      setPackages(body.packages);
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
    if (!packages) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/workspaces/${id}/packages?limit=${PAGE_SIZE}&offset=${packages.length}${statusQuery}`,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setPackages((prev) => [...(prev ?? []), ...body.packages]);
      setTotal(body.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more packages");
    } finally {
      setLoadingMore(false);
    }
  }

  /** Detail responses carry the fresh package row — swap it into the list and
   * the detail cache together so both stay consistent. */
  function applyDetail(detail: PackageDetail) {
    setPackages(
      (prev) => prev?.map((p) => (p.id === detail.package.id ? detail.package : p)) ?? prev,
    );
    setDetails((prev) => ({ ...prev, [detail.package.id]: detail }));
  }

  async function toggleDetail(packageId: string) {
    if (open[packageId]) {
      setOpen((prev) => ({ ...prev, [packageId]: false }));
      return;
    }
    setOpen((prev) => ({ ...prev, [packageId]: true }));
    if (details[packageId]) return;
    setDetailLoading(packageId);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/packages/${packageId}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      applyDetail(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load package detail");
      setOpen((prev) => ({ ...prev, [packageId]: false }));
    } finally {
      setDetailLoading(null);
    }
  }

  async function decide(packageId: string, action: PackageDecisionAction, reason?: string) {
    // Cancel requires a reason (contracts decision schema) — never call without one.
    if (action === "cancel" && !reason) return;
    setDeciding(packageId);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/packages/${packageId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { action, reason } : { action }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      applyDetail(body);
      setReasonFor(null);
      setReasonText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setDeciding(null);
    }
  }

  async function assessNow(packageId: string) {
    setAssessingId(packageId);
    setError(null);
    setAssessNotes((prev) => ({ ...prev, [packageId]: "" }));
    try {
      const res = await apiFetch(`/workspaces/${id}/packages/${packageId}/assess`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (res.status === 409 && body?.error === "not_due") {
        // Non-fatal: already assessed, leased elsewhere, or otherwise not due.
        setAssessNotes((prev) => ({
          ...prev,
          [packageId]: "Not due for assessment right now — it may already be in progress.",
        }));
        return;
      }
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      applyDetail(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assessment failed");
    } finally {
      setAssessingId(null);
    }
  }

  // Sprint 63: fan a ready package out into lane deliverables (§9.5).
  async function fanOut(packageId: string) {
    setFanningId(packageId);
    setError(null);
    setAssessNotes((prev) => ({ ...prev, [packageId]: "" }));
    try {
      const res = await apiFetch(`/workspaces/${id}/packages/${packageId}/fan-out`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      const skipped =
        body.skipped.length > 0
          ? ` (${body.skipped.length} lane${body.skipped.length === 1 ? "" : "s"} skipped)`
          : "";
      setAssessNotes((prev) => ({
        ...prev,
        [packageId]: `Fan-out created ${body.deliverablesCreated} deliverable${
          body.deliverablesCreated === 1 ? "" : "s"
        }${skipped} — see the Deliverables page.`,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fan-out failed");
    } finally {
      setFanningId(null);
    }
  }

  async function runPipeline() {
    setRunning(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/packages/run`, { method: "POST" });
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

  if (!workspace || !packages) return <EmptyState description="Loading…" />;

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
        Source-grounded content packages — the narrative unit between a qualified opportunity and
        its deliverables. Every claim must be supported by package sources, or the package stays in
        research. This layer runs in shadow: nothing is generated or dispatched yet.
      </p>

      {error && <p className="error">{error}</p>}

      {runResult && (
        <p className={styles.runNote}>
          Pipeline complete — created {runResult.packagesCreated.toLocaleString()} packages,
          assessed {runResult.packagesAssessed.toLocaleString()}
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
              Packages <CountBadge count={total} label="content packages" />
            </span>
          }
          actions={
            <label className={styles.filterLabel}>
              Status
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as PackageStatus | "all")}
              >
                <option value="all">All statuses</option>
                {PACKAGE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </Select>
            </label>
          }
        />
        {packages.length === 0 ? (
          <EmptyState
            description={
              statusFilter === "all" ? (
                <>No packages yet — qualify opportunities, then run the pipeline.</>
              ) : (
                <>No packages with status “{statusLabel(statusFilter)}”.</>
              )
            }
            primaryAction={statusFilter === "all" ? runButton : undefined}
            preview={
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="discover" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>
                    Position against the competitor’s Series B
                  </span>
                  <span className={styles.previewMeta}>Launch campaign · ready · novelty 84</span>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="discover" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>
                    Benchmark report take for GTM leaders
                  </span>
                  <span className={styles.previewMeta}>
                    Thought leadership · research needed · novelty 71
                  </span>
                </div>
              </div>
            }
          />
        ) : (
          <ul className={styles.pkgList}>
            {packages.map((pkg) => {
              const actions = actionsFor(pkg);
              const reasonOpen = reasonFor === pkg.id;
              const detail = open[pkg.id] ? details[pkg.id] : undefined;
              const assessment = detail ? latestAssessment(detail.assessments) : undefined;
              const blockedLine = detail ? blockingSummary(detail.eligibility) : "";
              const canAssess =
                pkg.assessmentState === "pending" || pkg.assessmentState === "failed";
              const assessNote = assessNotes[pkg.id];
              return (
                <li key={pkg.id} className={styles.pkg}>
                  <div className={styles.pkgHead}>
                    <span className={styles.campaignName}>{pkg.campaignName}</span>
                    <Badge tone={statusTone(pkg.status)}>{statusLabel(pkg.status)}</Badge>
                    {pkg.latestVerdict !== null && (
                      <Badge tone={verdictTone(pkg.latestVerdict)}>
                        {statusLabel(pkg.latestVerdict)}
                      </Badge>
                    )}
                    <span className={styles.chip}>novelty {pkg.novelty}</span>
                    <span className="section-tokens">
                      created {new Date(pkg.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className={styles.angle}>{pkg.angle}</p>
                  {pkg.storyTitle !== null && <p className="meta">Story: {pkg.storyTitle}</p>}
                  {pkg.assessmentState === "failed" && (
                    <p className={styles.failedNote}>
                      Assessment failed after {pkg.assessmentAttempts} attempt
                      {pkg.assessmentAttempts === 1 ? "" : "s"} — retries exhausted, reassess to
                      queue it again.
                    </p>
                  )}
                  {assessNote && <p className={styles.assessNote}>{assessNote}</p>}
                  {!reasonOpen && (
                    <div className={styles.actionRow}>
                      <Button
                        variant="tertiary"
                        size="compact"
                        disabled={detailLoading === pkg.id}
                        onClick={() => void toggleDetail(pkg.id)}
                      >
                        {detailLoading === pkg.id
                          ? "Loading…"
                          : open[pkg.id]
                            ? "Hide details"
                            : "Details"}
                      </Button>
                      {canAssess && (
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={assessingId === pkg.id}
                          onClick={() => void assessNow(pkg.id)}
                        >
                          {assessingId === pkg.id ? "Assessing…" : "Assess now"}
                        </Button>
                      )}
                      {pkg.status === "ready" && (
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={fanningId === pkg.id}
                          onClick={() => void fanOut(pkg.id)}
                        >
                          {fanningId === pkg.id ? "Fanning out…" : "Fan out"}
                        </Button>
                      )}
                      {actions.map((action) => (
                        <Button
                          key={action}
                          variant={action === "cancel" ? "danger" : "secondary"}
                          size="compact"
                          disabled={deciding === pkg.id}
                          onClick={() => {
                            if (action === "cancel") {
                              setReasonFor(pkg.id);
                              setReasonText("");
                            } else {
                              void decide(pkg.id, action);
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
                        disabled={deciding === pkg.id || reasonText.trim().length === 0}
                        onClick={() => void decide(pkg.id, "cancel", reasonText.trim())}
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
                  {detail && (
                    <div className={styles.detail}>
                      <div className={styles.detailSection}>
                        <h4 className={styles.detailTitle}>Sources</h4>
                        {detail.sources.length === 0 ? (
                          <p className="meta">No sources recorded.</p>
                        ) : (
                          <ul className={styles.sourceList}>
                            {detail.sources.map((source) => (
                              <li key={source.id} className={styles.source}>
                                <div className={styles.sourceHead}>
                                  <Badge tone="neutral">{source.role}</Badge>
                                  <span className={styles.sourceTitle}>
                                    {source.url !== null ? (
                                      <a href={source.url} target="_blank" rel="noreferrer">
                                        {source.title}
                                        <Icon
                                          name="external"
                                          size="compact"
                                          className={styles.externalIcon}
                                        />
                                      </a>
                                    ) : (
                                      source.title
                                    )}
                                  </span>
                                </div>
                                {source.excerpt && (
                                  <p className={styles.sourceExcerpt}>
                                    {truncateExcerpt(source.excerpt)}
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className={styles.detailSection}>
                        <h4 className={styles.detailTitle}>Latest assessment</h4>
                        {!assessment ? (
                          <p className="meta">Not assessed yet.</p>
                        ) : (
                          <>
                            <div className={styles.chipRow}>
                              <Badge tone={verdictTone(assessment.verdict)}>
                                {statusLabel(assessment.verdict)}
                              </Badge>
                              <span className={styles.chip}>conf {assessment.confidence}</span>
                              <span className={styles.chip}>v{assessment.assessmentVersion}</span>
                            </div>
                            {assessment.supportedClaims.length > 0 && (
                              <ul className={styles.claimList}>
                                {assessment.supportedClaims.map((claim, i) => (
                                  <li key={i} className={styles.claim}>
                                    <span>{claim.claim}</span>
                                    <span className={styles.claimSources}>
                                      {claim.sourceIds.length} source
                                      {claim.sourceIds.length === 1 ? "" : "s"}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {assessment.missingFacts.length > 0 && (
                              <ul className={styles.factList}>
                                {assessment.missingFacts.map((fact, i) => (
                                  <li key={i} className={styles.factItem}>
                                    Missing fact: {fact}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {assessment.missingMedia.length > 0 && (
                              <ul className={styles.factList}>
                                {assessment.missingMedia.map((media, i) => (
                                  <li key={i} className={styles.factItem}>
                                    Missing media: {media}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {assessment.researchActions.length > 0 && (
                              <ul className={styles.factList}>
                                {assessment.researchActions.map((action, i) => (
                                  <li key={i} className={styles.factItem}>
                                    Research: {action}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </div>

                      <div className={styles.detailSection}>
                        <h4 className={styles.detailTitle}>Lane eligibility</h4>
                        {blockedLine && <p className={styles.blockingSummary}>{blockedLine}</p>}
                        {detail.eligibility.length === 0 ? (
                          <p className="meta">No lane decisions yet.</p>
                        ) : (
                          <div className={styles.eligTableWrap}>
                            <table className={styles.eligTable}>
                              <thead>
                                <tr>
                                  <th>Lane</th>
                                  <th>Channel / format</th>
                                  <th>Eligible</th>
                                  <th>Failed checks</th>
                                </tr>
                              </thead>
                              <tbody>
                                {detail.eligibility.map((decision) => (
                                  <tr key={decision.id}>
                                    <td>{decision.laneName}</td>
                                    <td>
                                      <span className={styles.laneFormat}>
                                        {decision.channel} / {decision.format}
                                      </span>
                                    </td>
                                    <td>
                                      <Badge tone={decision.eligible ? "approved" : "danger"}>
                                        {decision.eligible ? "eligible" : "blocked"}
                                      </Badge>
                                    </td>
                                    <td>
                                      <div className={styles.chipRow}>
                                        {blockingChecks(decision).map((check) => (
                                          <span
                                            key={check.rule}
                                            className={styles.chip}
                                            title={check.detail}
                                          >
                                            {check.rule}
                                            {check.detail ? ` — ${check.detail}` : ""}
                                          </span>
                                        ))}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>

                      <div className={styles.detailSection}>
                        <h4 className={styles.detailTitle}>Events</h4>
                        <ul className={styles.eventList}>
                          {detail.events.map((event) => (
                            <li key={event.id} className={styles.event}>
                              <span className={styles.eventTransition}>
                                {event.fromStatus === null
                                  ? statusLabel(event.toStatus)
                                  : `${statusLabel(event.fromStatus)} → ${statusLabel(event.toStatus)}`}
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
        {packages.length > 0 && packages.length < total && (
          <div className={styles.loadMoreRow}>
            <Button variant="secondary" size="compact" disabled={loadingMore} onClick={loadMore}>
              {loadingMore
                ? "Loading…"
                : `Load more (${(total - packages.length).toLocaleString()} remaining)`}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
