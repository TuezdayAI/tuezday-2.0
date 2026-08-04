"use client";

import { TopBarActions } from "@/src/components/top-bar";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Select } from "@/src/components/ui/input";
import styles from "./opportunities.module.css";

import { API_URL, apiFetch } from "@/lib/api";
import { groupOpportunitiesByStory } from "@/lib/opportunity-groups";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  OPPORTUNITY_DECISION_ACTIONS,
  OPPORTUNITY_DECISION_TARGETS,
  OPPORTUNITY_STATUSES,
  canTransitionOpportunity,
} from "@tuezday/contracts";
import type {
  CampaignOpportunity,
  OpportunityDecisionAction,
  OpportunityMatchRunResult,
  OpportunityStatus,
  Workspace,
} from "@tuezday/contracts";

const PAGE_SIZE = 20;

/** Badge tone per opportunity status — qualified reads as live, dismissed as rejected. */
function statusTone(
  status: OpportunityStatus,
): "draft" | "approved" | "pending" | "edited" | "rejected" | "neutral" {
  switch (status) {
    case "candidate":
      return "draft";
    case "auto_qualified":
    case "qualified":
    case "package_created":
      return "approved";
    case "needs_review":
      return "pending";
    case "watchlisted":
      return "edited";
    case "dismissed":
      return "rejected";
    default:
      return "neutral"; // expired, superseded
  }
}

function statusLabel(status: OpportunityStatus): string {
  return status.replace(/_/g, " ");
}

const DECISION_LABELS: Record<OpportunityDecisionAction, string> = {
  qualify: "Qualify",
  dismiss: "Dismiss",
  watch: "Watch",
  reopen: "Reopen",
};

/** Actions whose target transition is legal from the current status — mirrors
 * the contracts state machine; never rolls its own transition logic. */
function actionsFor(status: OpportunityStatus): OpportunityDecisionAction[] {
  return OPPORTUNITY_DECISION_ACTIONS.filter((action) =>
    canTransitionOpportunity(status, OPPORTUNITY_DECISION_TARGETS[action]),
  );
}

/** Dismiss and reopen require an operator reason (contracts decision schema). */
function needsReason(action: OpportunityDecisionAction): action is "dismiss" | "reopen" {
  return action === "dismiss" || action === "reopen";
}

export default function OpportunitiesPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [opportunities, setOpportunities] = useState<CampaignOpportunity[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<OpportunityStatus | "all">("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchResult, setMatchResult] = useState<OpportunityMatchRunResult | null>(null);

  const [deciding, setDeciding] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<{
    opportunityId: string;
    action: "dismiss" | "reopen";
  } | null>(null);
  const [reasonText, setReasonText] = useState("");

  const statusQuery = statusFilter === "all" ? "" : `&status=${statusFilter}`;

  const load = useCallback(async () => {
    try {
      const [wsRes, oRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/opportunities?limit=${PAGE_SIZE}&offset=0${statusQuery}`),
      ]);
      if (!wsRes.ok || !oRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      const body = await oRes.json();
      setOpportunities(body.opportunities);
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
    if (!opportunities) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/workspaces/${id}/opportunities?limit=${PAGE_SIZE}&offset=${opportunities.length}${statusQuery}`,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setOpportunities((prev) => [...(prev ?? []), ...body.opportunities]);
      setTotal(body.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more opportunities");
    } finally {
      setLoadingMore(false);
    }
  }

  async function decide(
    opportunityId: string,
    action: OpportunityDecisionAction,
    reason?: string,
  ) {
    // Dismiss/reopen require a reason — never call the API without one.
    if (needsReason(action) && !reason) return;
    setDeciding(opportunityId);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/opportunities/${opportunityId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { action, reason } : { action }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      // Detail response — swap the updated opportunity into the list in place.
      setOpportunities(
        (prev) => prev?.map((o) => (o.id === opportunityId ? body.opportunity : o)) ?? prev,
      );
      setReasonFor(null);
      setReasonText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setDeciding(null);
    }
  }

  async function runMatching() {
    setMatching(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/opportunities/match`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setMatchResult(body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Matching run failed");
    } finally {
      setMatching(false);
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

  if (!workspace || !opportunities) return <EmptyState description="Loading…" />;

  const matchButton = (
    <Button variant="secondary" size="compact" disabled={matching} onClick={runMatching}>
      <Icon name="regenerate" size="compact" />
      {matching ? "Matching…" : "Run matching"}
    </Button>
  );

  const groups = groupOpportunitiesByStory(opportunities);

  return (
    <>
      <TopBarActions>{matchButton}</TopBarActions>

      <p className="subtitle">
        Campaign-scoped opportunities from canonical stories — decisions for one campaign never
        affect another. This layer runs in shadow: qualifying or dismissing here changes nothing
        downstream yet.
      </p>

      {error && <p className="error">{error}</p>}

      {matchResult && (
        <p className={styles.matchNote}>
          Matching complete — considered {matchResult.storiesConsidered.toLocaleString()} stories,
          routed {matchResult.storiesRouted.toLocaleString()}, created{" "}
          {matchResult.opportunitiesCreated.toLocaleString()} opportunities
          {matchResult.failures > 0
            ? `, ${matchResult.failures.toLocaleString()} failures`
            : ", no failures"}
          .
        </p>
      )}

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="campaigns" size="compact" className={styles.headIcon} />
              Opportunities <CountBadge count={total} label="campaign opportunities" />
            </span>
          }
          actions={
            <label className={styles.filterLabel}>
              Status
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as OpportunityStatus | "all")}
              >
                <option value="all">All statuses</option>
                {OPPORTUNITY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </Select>
            </label>
          }
        />
        {opportunities.length === 0 ? (
          <EmptyState
            description={
              statusFilter === "all" ? (
                <>No opportunities yet — run matching once stories exist.</>
              ) : (
                <>No opportunities with status “{statusLabel(statusFilter)}”.</>
              )
            }
            primaryAction={statusFilter === "all" ? matchButton : undefined}
            preview={
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="signal" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>Competitor raises Series B</span>
                  <span className={styles.previewMeta}>Launch campaign · fit 82 · conf 74</span>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="signal" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>New GTM benchmark report drops</span>
                  <span className={styles.previewMeta}>Thought leadership · fit 77 · conf 69</span>
                </div>
              </div>
            }
          />
        ) : (
          <ul className={styles.groupList}>
            {groups.map((group) => (
              <li key={group.key} className="section-card">
                <div className={`section-head ${styles.groupHead}`}>
                  <span className={styles.kindMark}>
                    <Icon name="signal" size="compact" />
                  </span>
                  <span className="section-title">
                    {group.url ? (
                      <a href={group.url} target="_blank" rel="noreferrer">
                        {group.title}
                        <Icon name="external" size="compact" className={styles.externalIcon} />
                      </a>
                    ) : (
                      group.title
                    )}
                  </span>
                  <span className="section-tokens">
                    {group.opportunities.length} opportunit
                    {group.opportunities.length === 1 ? "y" : "ies"}
                  </span>
                </div>
                <ul className={styles.oppList}>
                  {group.opportunities.map((opp) => {
                    const actions = actionsFor(opp.status);
                    const reasonOpen = reasonFor?.opportunityId === opp.id;
                    return (
                      <li key={opp.id} className={styles.opp}>
                        <div className={styles.oppHead}>
                          <span className={styles.campaignName}>{opp.campaignName}</span>
                          <Badge tone={statusTone(opp.status)}>{statusLabel(opp.status)}</Badge>
                          <span className="layer-badge">policy: {opp.policy.band}</span>
                          {opp.expiresAt !== null && (
                            <span className="section-tokens">
                              expires {new Date(opp.expiresAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        <p className={styles.angle}>{opp.angle}</p>
                        <div className={styles.scoreRow}>
                          <span className={styles.scoreChip}>rel {opp.workspaceRelevance}</span>
                          <span className={styles.scoreChip}>fit {opp.campaignFit}</span>
                          <span className={styles.scoreChip}>conf {opp.confidence}</span>
                          <span className={styles.scoreChip}>act {opp.actionability}</span>
                          <span className={styles.scoreChip}>trust {opp.sourceTrust}</span>
                        </div>
                        {opp.reason && <p className="meta">{opp.reason}</p>}
                        {opp.decisionReason && (
                          <p className={styles.decisionNote}>
                            Decision
                            {opp.decidedAt !== null
                              ? ` (${new Date(opp.decidedAt).toLocaleDateString()})`
                              : ""}
                            {" — "}
                            {opp.decisionReason}
                          </p>
                        )}
                        {actions.length > 0 && !reasonOpen && (
                          <div className={styles.actionRow}>
                            {actions.map((action) => (
                              <Button
                                key={action}
                                variant={
                                  action === "qualify"
                                    ? "primary"
                                    : action === "dismiss"
                                      ? "danger"
                                      : "secondary"
                                }
                                size="compact"
                                disabled={deciding === opp.id}
                                onClick={() => {
                                  if (needsReason(action)) {
                                    setReasonFor({ opportunityId: opp.id, action });
                                    setReasonText("");
                                  } else {
                                    void decide(opp.id, action);
                                  }
                                }}
                              >
                                {DECISION_LABELS[action]}
                              </Button>
                            ))}
                          </div>
                        )}
                        {reasonOpen && reasonFor && (
                          <div className={styles.reasonRow}>
                            <Input
                              placeholder={`Reason to ${reasonFor.action} (required)`}
                              value={reasonText}
                              onChange={(e) => setReasonText(e.target.value)}
                              autoFocus
                            />
                            <Button
                              variant="primary"
                              size="compact"
                              disabled={deciding === opp.id || reasonText.trim().length === 0}
                              onClick={() =>
                                void decide(opp.id, reasonFor.action, reasonText.trim())
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
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {opportunities.length > 0 && opportunities.length < total && (
          <div className={styles.loadMoreRow}>
            <Button variant="secondary" size="compact" disabled={loadingMore} onClick={loadMore}>
              {loadingMore
                ? "Loading…"
                : `Load more (${(total - opportunities.length).toLocaleString()} remaining)`}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
