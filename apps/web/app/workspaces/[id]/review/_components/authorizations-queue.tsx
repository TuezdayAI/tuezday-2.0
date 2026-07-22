"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  EXTERNAL_ACTION_KINDS,
  type AuthorizationBatchDetail,
  type AuthorizationBatchSelection,
  type AuthorizationBatchItem,
  type Campaign,
  type ExternalAction,
  type ExternalActionDetail,
  type ExternalActionKind,
  type ExternalActionStatus,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";
import {
  SELECTED_AUTHORIZATION_LIMIT,
  authorizationBatchSummary,
  campaignBatchSelection,
  selectedAuthorizationIds,
} from "@/lib/authorization-batch";
import {
  actionKindLabel,
  actionRecoveryHref,
  actionTimingLabel,
  externalActionWorkflowStatus,
  impactSummary,
  policyExplanation,
} from "@/lib/external-actions";
import { campaignFilterName, reviewHref } from "@/lib/review-workspace";
import { EmptyState } from "@/src/components/empty-state";
import { Button, ButtonLink } from "@/src/components/ui/button";
import { CountBadge, WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Tabs } from "@/src/components/ui/tabs";
import styles from "./authorizations-queue.module.css";

type StatusFilter = ExternalActionStatus | "all";

/** The lifecycle states worth queueing for a human, in filter order. */
const STATUS_FILTERS: StatusFilter[] = [
  "authorization_required",
  "blocked",
  "stale",
  "failed",
  "scheduled",
  "all",
];

const STATUS_FILTER_LABELS: Record<string, string> = {
  authorization_required: "Needs authorization",
  blocked: "Blocked",
  stale: "Stale",
  failed: "Failed",
  scheduled: "Scheduled",
  all: "All",
};

export function AuthorizationsQueue({
  workspaceId: id,
  onQueueCount,
}: {
  workspaceId: string;
  /** Reports the authoritative authorization-required count to the shell. */
  onQueueCount?: (count: number) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("action");
  const campaign = searchParams.get("campaign");
  const kind = (searchParams.get("kind") as ExternalActionKind | null) ?? null;
  const statusParam = (searchParams.get("status") as StatusFilter | null) ?? null;
  const statusFilter: StatusFilter =
    statusParam && (STATUS_FILTERS as string[]).includes(statusParam)
      ? statusParam
      : "authorization_required";

  const [actions, setActions] = useState<ExternalAction[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [detail, setDetail] = useState<ExternalActionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [denyReason, setDenyReason] = useState("");
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [batchDetail, setBatchDetail] = useState<AuthorizationBatchDetail | null>(null);
  const [batchActions, setBatchActions] = useState<Map<string, ExternalAction>>(
    () => new Map(),
  );
  const [previewBusy, setPreviewBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [campaignKindMode, setCampaignKindMode] = useState<"all" | "selected">("all");
  const [campaignKinds, setCampaignKinds] = useState<Set<ExternalActionKind>>(
    () => new Set(EXTERNAL_ACTION_KINDS),
  );

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (kind) params.set("kind", kind);
      if (campaign) params.set("campaign", campaign);
      const res = await apiFetch(`/workspaces/${id}/external-actions?${params.toString()}`);
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const body = (await res.json()) as { actions: ExternalAction[] };
      setActions(body.actions);
      setError(null);
      const countRes = await apiFetch(
        `/workspaces/${id}/external-actions?status=authorization_required&limit=200`,
      );
      if (countRes.ok) {
        onQueueCount?.(((await countRes.json()) as { actions: ExternalAction[] }).actions.length);
      }
    } catch {
      setError(`Could not load external actions from ${API_URL}. Is "npm run dev" running?`);
    } finally {
      setLoaded(true);
    }
  }, [id, statusFilter, kind, campaign, onQueueCount]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const res = await apiFetch(`/workspaces/${id}/external-actions/${selectedId}`).catch(() => null);
    if (res?.ok) setDetail((await res.json()) as ExternalActionDetail);
    else setDetail(null);
  }, [id, selectedId]);

  const loadCampaigns = useCallback(async () => {
    if (!campaign) return;
    const res = await apiFetch(`/workspaces/${id}/campaigns`).catch(() => null);
    if (res?.ok) setCampaigns((await res.json()) as Campaign[]);
  }, [id, campaign]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);
  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);
  useEffect(() => {
    const visible = new Set(
      actions
        .filter((action) => action.status === "authorization_required")
        .map((action) => action.id),
    );
    setSelection((current) => {
      const next = new Set([...current].filter((actionId) => visible.has(actionId)));
      return next.size === current.size ? current : next;
    });
  }, [actions]);
  useEffect(() => {
    if (!batchDetail) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirmBusy) setBatchDetail(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [batchDetail, confirmBusy]);

  function hrefFor(opts: { status?: StatusFilter; action?: string }): string {
    return reviewHref(id, {
      tab: "authorizations",
      campaign: campaign ?? undefined,
      kind: kind ?? undefined,
      status: opts.status ?? statusFilter,
      action: opts.action,
    });
  }

  async function decide(actionId: string, decision: "authorize" | "deny") {
    setBusy(true);
    setAnnouncement("");
    try {
      const res = await apiFetch(`/workspaces/${id}/external-actions/${actionId}/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          decision === "deny" ? { reason: denyReason.trim() || null } : {},
        ),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok && res.status !== 409) {
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      const next = (body?.action ?? null) as ExternalAction | null;
      if (res.status === 409 && body?.error === "stale_action") {
        setAnnouncement("This action went stale — the content changed since it was proposed.");
      } else if (decision === "deny") {
        setAnnouncement("Denied. Nothing was sent.");
      } else if (next?.status === "succeeded") {
        setAnnouncement("Authorized and executed.");
      } else if (next?.status === "scheduled") {
        setAnnouncement("Authorized — it will go out at its scheduled time.");
      } else if (next?.status === "blocked") {
        setAnnouncement(`Authorized but blocked: ${next.blocker?.message ?? "a guardrail held it."}`);
      } else if (next?.status === "failed") {
        setAnnouncement(`Execution failed: ${next.execution?.error ?? "see the receipt."}`);
      } else {
        setAnnouncement("Decision recorded.");
      }
      setDenyReason("");
      await Promise.all([load(), loadDetail()]);
    } catch (err) {
      setAnnouncement(err instanceof Error ? err.message : "The decision failed.");
    } finally {
      setBusy(false);
    }
  }

  async function repropose(actionId: string) {
    setBusy(true);
    setAnnouncement("");
    try {
      const res = await apiFetch(`/workspaces/${id}/external-actions/${actionId}/repropose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      const successor = body?.action as ExternalAction | undefined;
      setAnnouncement("Re-proposed with the current content.");
      await load();
      if (successor) router.push(hrefFor({ action: successor.id }));
    } catch (err) {
      setAnnouncement(err instanceof Error ? err.message : "The re-proposal failed.");
    } finally {
      setBusy(false);
    }
  }

  function toggleSelection(actionId: string) {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(actionId)) {
        next.delete(actionId);
      } else if (next.size >= SELECTED_AUTHORIZATION_LIMIT) {
        setAnnouncement(`Select no more than ${SELECTED_AUTHORIZATION_LIMIT} authorizations.`);
        return current;
      } else {
        next.add(actionId);
      }
      return next;
    });
  }

  function toggleCampaignKind(actionKind: ExternalActionKind) {
    setCampaignKinds((current) => {
      const next = new Set(current);
      if (next.has(actionKind)) {
        if (next.size === 1) {
          setAnnouncement("Choose at least one action kind for a campaign preview.");
          return current;
        }
        next.delete(actionKind);
      } else {
        next.add(actionKind);
      }
      return next;
    });
  }

  async function previewAuthorizationBatch(
    batchSelection: AuthorizationBatchSelection,
    sourceActions: ExternalAction[],
  ) {
    setPreviewBusy(true);
    setAnnouncement("");
    setBatchActions(new Map(sourceActions.map((action) => [action.id, action])));
    try {
      const res = await apiFetch(`/workspaces/${id}/external-action-batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          selection: batchSelection,
        }),
      });
      const body = (await res.json().catch(() => null)) as AuthorizationBatchDetail | null;
      if (!res.ok || !body) throw new Error(`API returned ${res.status}`);
      setBatchDetail(body);
      const summary = authorizationBatchSummary(body);
      setAnnouncement(`Preview ready: ${summary.included} included, ${summary.excluded} excluded.`);
    } catch (err) {
      setAnnouncement(err instanceof Error ? err.message : "The batch preview failed.");
    } finally {
      setPreviewBusy(false);
    }
  }

  async function previewSelectedAuthorizations(actionIds: string[]) {
    if (actionIds.length === 0) return;
    await previewAuthorizationBatch(
      { mode: "selected", actionIds },
      actions.filter((action) => actionIds.includes(action.id)),
    );
  }

  async function previewCampaignAuthorizations() {
    if (!campaign) return;
    const kinds =
      campaignKindMode === "all"
        ? null
        : EXTERNAL_ACTION_KINDS.filter((actionKind) => campaignKinds.has(actionKind));
    await previewAuthorizationBatch(
      campaignBatchSelection(campaign, kinds),
      actions.filter(
        (action) =>
          action.context.campaignId === campaign && (!kinds || kinds.includes(action.kind)),
      ),
    );
  }

  async function authorizeIncludedActions() {
    if (!batchDetail || confirmBusy) return;
    setConfirmBusy(true);
    setAnnouncement(
      `Authorizing ${batchDetail.batch.includedCount} included actions one at a time…`,
    );
    try {
      const res = await apiFetch(
        `/workspaces/${id}/external-action-batches/${batchDetail.batch.id}/authorize`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as AuthorizationBatchDetail | null;
      if (!res.ok || !body) throw new Error(`API returned ${res.status}`);
      setBatchDetail(body);
      const summary = authorizationBatchSummary(body);
      const completed = summary.succeeded + summary.scheduled;
      const needsAttention = summary.failed + summary.blocked + summary.stale;
      if (body.batch.status === "partially_completed") {
        setAnnouncement(
          `Partially completed: ${completed} completed or scheduled; ${needsAttention} need attention.`,
        );
      } else if (body.batch.status === "completed") {
        setAnnouncement(`${completed} included actions completed or were scheduled.`);
      } else {
        setAnnouncement(`Batch failed: ${needsAttention} actions need attention.`);
      }
      await Promise.all([load(), loadDetail()]);
    } catch (err) {
      setAnnouncement(err instanceof Error ? err.message : "Batch authorization failed.");
    } finally {
      setConfirmBusy(false);
    }
  }

  if (error && !loaded) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  const selected = detail?.action ?? null;
  const selectedIds = selectedAuthorizationIds(actions, selection);
  const batchSummary = batchDetail ? authorizationBatchSummary(batchDetail) : null;
  const activeCampaignName = campaign ? campaignFilterName(campaigns, campaign) : null;
  const batchCampaignName =
    batchDetail?.batch.selection.mode === "campaign"
      ? campaignFilterName(campaigns, batchDetail.batch.selection.campaignId)
      : null;
  const batchGroups = batchDetail
    ? EXTERNAL_ACTION_KINDS.map((actionKind) => {
        const items = batchDetail.items.filter((item) => item.kind === actionKind);
        const included = items.filter((item) => item.eligible);
        const exclusions = Array.from(
          items
            .filter((item) => !item.eligible)
            .reduce((groups, item) => {
              const reason = item.exclusionReason ?? "Not eligible";
              groups.set(reason, [...(groups.get(reason) ?? []), item]);
              return groups;
            }, new Map<string, AuthorizationBatchItem[]>()),
          ([reason, excludedItems]) => ({ reason, items: excludedItems }),
        );
        return { actionKind, included, exclusions, count: items.length };
      }).filter((group) => group.count > 0)
    : [];

  function actionForItem(item: AuthorizationBatchItem): ExternalAction | undefined {
    return (
      item.submission?.action ??
      batchActions.get(item.actionId) ??
      actions.find((action) => action.id === item.actionId)
    );
  }

  function batchItemCard(item: AuthorizationBatchItem) {
    const sourceAction = actionForItem(item);
    const needsRecovery =
      item.status === "failed" || item.status === "blocked" || item.status === "stale";
    return (
      <li key={item.id} className={styles.batchItem}>
        <div className={styles.batchItemHead}>
          <strong>{item.eligible ? item.status : "excluded"}</strong>
        </div>
        <p>{item.impact}</p>
        <p className="meta">
          Timing: {sourceAction ? actionTimingLabel(sourceAction) : "fixed in preview"}
        </p>
        {item.error && <p className="error">{item.error}</p>}
        {needsRecovery && sourceAction && (
          <Link href={actionRecoveryHref(sourceAction)}>Open owning surface</Link>
        )}
      </li>
    );
  }

  return (
    <>
      <p className="subtitle">
        Every action that would leave the workspace — posts, replies, sends, and paid launches —
        waits here when policy requires your sign-off. Authorizing executes exactly what is shown;
        content approval stays on the Approvals tab.
      </p>

      <Tabs
        tabs={STATUS_FILTERS.map((filter) => ({
          key: filter,
          label: STATUS_FILTER_LABELS[filter] ?? filter,
        }))}
        active={statusFilter}
        onChange={(key) => router.push(hrefFor({ status: key as StatusFilter, action: undefined }))}
      />

      <p aria-live="polite" role="status" className={announcement ? styles.announcement : styles.announcementEmpty}>
        {announcement}
      </p>

      {campaign && (
        <section className={styles.campaignBatchPanel} aria-label="Campaign authorization preview">
          <div className={styles.campaignBatchIntro}>
            <div>
              <p className={styles.eyebrow}>Campaign-wide authorization</p>
              <h2>{activeCampaignName}</h2>
              <p>
                Snapshot up to 100 actions that currently need authorization. You will review the
                fixed list before anything is sent or launched.
              </p>
            </div>
            <Button
              variant="primary"
              size="standard"
              loading={previewBusy}
              onClick={previewCampaignAuthorizations}
            >
              Preview campaign authorizations
            </Button>
          </div>

          <fieldset className={styles.kindScope}>
            <legend>Action kinds</legend>
            <label>
              <input
                type="radio"
                name="campaign-authorization-kinds"
                checked={campaignKindMode === "all"}
                onChange={() => setCampaignKindMode("all")}
              />
              All action kinds
            </label>
            <label>
              <input
                type="radio"
                name="campaign-authorization-kinds"
                checked={campaignKindMode === "selected"}
                onChange={() => setCampaignKindMode("selected")}
              />
              Choose action kinds
            </label>
            {campaignKindMode === "selected" && (
              <div className={styles.kindGrid}>
                {EXTERNAL_ACTION_KINDS.map((actionKind) => (
                  <label key={actionKind}>
                    <input
                      type="checkbox"
                      checked={campaignKinds.has(actionKind)}
                      onChange={() => toggleCampaignKind(actionKind)}
                    />
                    {actionKindLabel(actionKind)}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </section>
      )}

      {actions.some((action) => action.status === "authorization_required") && (
        <div className={styles.batchToolbar} aria-label="Selected authorizations">
          <p>
            <strong>{selectedIds.length}</strong> of {SELECTED_AUTHORIZATION_LIMIT} selected
          </p>
          <Button
            variant="primary"
            size="standard"
            disabled={selectedIds.length === 0}
            loading={previewBusy}
            onClick={() => previewSelectedAuthorizations(selectedIds)}
          >
            Preview {selectedIds.length}{" "}
            {selectedIds.length === 1 ? "authorization" : "authorizations"}
          </Button>
        </div>
      )}

      {actions.length === 0 ? (
        <EmptyState
          description={
            <>
              Nothing waiting in this state. Actions land here when a publish, reply, send, or paid
              launch needs your authorization — or when one is blocked, stale, or failed.
            </>
          }
        />
      ) : (
        <div className={styles.split}>
          <ul className={`section-list ${styles.queue}`}>
            {actions.map((action) => (
              <li
                key={action.id}
                className={`section-card ${selected?.id === action.id ? styles.selectedCard : ""}`}
              >
                <div className="section-head">
                  {action.status === "authorization_required" && (
                    <label className={styles.selectionControl}>
                      <input
                        type="checkbox"
                        checked={selection.has(action.id)}
                        onChange={() => toggleSelection(action.id)}
                        aria-label={`Select ${action.subject.title} for batch authorization`}
                      />
                      <span>Select</span>
                    </label>
                  )}
                  <WorkflowStatusBadge status={externalActionWorkflowStatus(action)} />
                  <span className="section-title">
                    <Link href={hrefFor({ action: action.id })}>{action.subject.title}</Link>
                  </span>
                  <span className="layer-badge">{actionKindLabel(action.kind)}</span>
                </div>
                <p className="section-reason">
                  {action.subject.destination ?? "No destination"} · {actionTimingLabel(action)}
                  {action.context.campaignName && <> · {action.context.campaignName}</>}
                </p>
              </li>
            ))}
          </ul>

          {selected && (
            <section className={styles.detail} aria-label="Authorization detail">
              <div className="section-head">
                <WorkflowStatusBadge status={externalActionWorkflowStatus(selected)} />
                <span className="section-title">{selected.subject.title}</span>
                <span className="layer-badge">{actionKindLabel(selected.kind)}</span>
              </div>

              <p className={styles.impact}>{impactSummary(selected)}</p>
              <dl className={styles.facts}>
                <dt>Destination</dt>
                <dd>{selected.subject.destination ?? "—"}</dd>
                <dt>Requested timing</dt>
                <dd>{actionTimingLabel(selected)}</dd>
                <dt>Campaign</dt>
                <dd>{selected.context.campaignName ?? "—"}</dd>
                <dt>Persona</dt>
                <dd>{selected.context.personaName ?? "—"}</dd>
                <dt>Lane</dt>
                <dd>{selected.context.laneName ?? "—"}</dd>
                <dt>Proposed by</dt>
                <dd>
                  {selected.proposedBy.label} · {new Date(selected.createdAt).toLocaleString()}
                </dd>
              </dl>

              <h3>Exact content</h3>
              <pre className="output-text">{selected.subject.summary}</pre>

              <section aria-label="Policy" className={styles.region}>
                <h3>Policy</h3>
                <p>{policyExplanation(selected)}</p>
              </section>

              {selected.blocker && (
                <section aria-label="Guardrail" className={styles.region}>
                  <h3>Guardrail</h3>
                  <p className="error">
                    {selected.blocker.message}
                    {selected.blocker.retryable ? " (retryable)" : ""}
                  </p>
                </section>
              )}

              {selected.execution && (
                <section aria-label="Receipt" className={styles.region}>
                  <h3>Receipt</h3>
                  <p>
                    {selected.execution.kind} · {selected.execution.status}
                    {selected.execution.url && (
                      <>
                        {" · "}
                        <a href={selected.execution.url} target="_blank" rel="noreferrer">
                          view
                        </a>
                      </>
                    )}
                    {selected.execution.error && (
                      <span className="error"> · {selected.execution.error}</span>
                    )}
                  </p>
                </section>
              )}

              <section aria-label="Decisions" className={styles.region}>
                <h3>Decisions</h3>
                {detail!.decisions.length === 0 ? (
                  <p className="meta">No decision recorded yet.</p>
                ) : (
                  <ul className={styles.decisions}>
                    {detail!.decisions.map((decision) => (
                      <li key={decision.id}>
                        <strong>{decision.decision}</strong> by {decision.actor.label} ·{" "}
                        {new Date(decision.createdAt).toLocaleString()}
                        {decision.reason && <> — {decision.reason}</>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {selected.status === "authorization_required" && (
                <div className={styles.decisionRow}>
                  <Button
                    variant="primary"
                    size="compact"
                    disabled={busy}
                    onClick={() => decide(selected.id, "authorize")}
                  >
                    {busy ? "Working…" : "Authorize"}
                  </Button>
                  <input
                    className={styles.reasonInput}
                    placeholder="Reason (optional)"
                    value={denyReason}
                    onChange={(event) => setDenyReason(event.target.value)}
                    aria-label="Denial reason"
                  />
                  <Button
                    variant="danger"
                    size="compact"
                    disabled={busy}
                    onClick={() => decide(selected.id, "deny")}
                  >
                    Deny
                  </Button>
                </div>
              )}

              {(selected.status === "stale" || selected.status === "blocked") && (
                <div className={styles.decisionRow}>
                  <ButtonLink
                    variant="secondary"
                    size="standard"
                    href={actionRecoveryHref(selected)}
                  >
                    Open owning surface
                  </ButtonLink>
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={busy}
                    onClick={() => repropose(selected.id)}
                  >
                    {busy ? "Working…" : "Re-propose with current content"}
                  </Button>
                </div>
              )}
              {selected.supersededByActionId && (
                <p className="meta">
                  Superseded by{" "}
                  <Link href={hrefFor({ action: selected.supersededByActionId })}>
                    a newer proposal
                  </Link>
                  .
                </p>
              )}
            </section>
          )}
        </div>
      )}
      {actions.length > 0 && (
        <p className="meta">
          <CountBadge count={actions.length} label="actions in this view" /> in this view
        </p>
      )}

      {batchDetail && batchSummary && (
        <div
          className={styles.batchOverlay}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !confirmBusy) setBatchDetail(null);
          }}
        >
          <section
            className={styles.batchModal}
            role="dialog"
            aria-modal="true"
            aria-label="Authorization batch preview"
          >
            <header className={styles.batchModalHeader}>
              <div>
                <p className={styles.eyebrow}>Immutable preview</p>
                <h2>
                  {batchCampaignName
                    ? `Review ${batchCampaignName} authorizations`
                    : "Review selected authorizations"}
                </h2>
              </div>
              <Button
                variant="tertiary"
                size="compact"
                disabled={confirmBusy}
                onClick={() => setBatchDetail(null)}
              >
                Close
              </Button>
            </header>

            <div className={styles.batchModalBody}>
              <div
                className={`${styles.batchSummary} ${
                  batchDetail.batch.status === "partially_completed"
                    ? styles.batchPartial
                    : batchDetail.batch.status === "completed"
                      ? styles.batchComplete
                      : batchDetail.batch.status === "failed"
                        ? styles.batchFailed
                        : ""
                }`}
              >
                <strong>{batchSummary.included} included</strong>
                <span>{batchSummary.excluded} excluded</span>
                {batchDetail.batch.status !== "preview" && (
                  <span>
                    {batchSummary.succeeded} succeeded · {batchSummary.scheduled} scheduled ·{" "}
                    {batchSummary.failed + batchSummary.blocked + batchSummary.stale} need attention
                  </span>
                )}
              </div>

              <p className="meta">
                This preview is fixed. Confirmation processes each included action independently;
                completed external effects are not rolled back if another item fails.
              </p>

              {batchDetail.batch.selection.mode === "campaign" && (
                <aside className={styles.campaignSnapshotNotice}>
                  <strong>Bounded snapshot</strong>
                  <span>
                    Up to 100 actions are included per preview.{" "}
                    {batchDetail.batch.continuationCount} additional actions remain for another
                    preview.
                  </span>
                  <span>Actions created after this preview are not included.</span>
                </aside>
              )}

              <div className={styles.batchGroups}>
                {batchGroups.map((group) => (
                  <section key={group.actionKind} className={styles.batchKindGroup}>
                    <header>
                      <h3>{actionKindLabel(group.actionKind)}</h3>
                      <span>
                        {group.included.length} included ·{" "}
                        {group.exclusions.reduce((count, entry) => count + entry.items.length, 0)}{" "}
                        excluded
                      </span>
                    </header>

                    {group.included.length > 0 && (
                      <div className={styles.batchOutcomeGroup}>
                        <h4>Included</h4>
                        <ul className={styles.batchItems}>{group.included.map(batchItemCard)}</ul>
                      </div>
                    )}

                    {group.exclusions.map((exclusion) => (
                      <div key={exclusion.reason} className={styles.batchOutcomeGroup}>
                        <h4 className={styles.exclusion}>Excluded · {exclusion.reason}</h4>
                        <ul className={styles.batchItems}>{exclusion.items.map(batchItemCard)}</ul>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </div>

            <footer className={styles.batchModalFooter}>
              <span className="meta">
                {batchDetail.batch.status === "preview"
                  ? batchCampaignName
                    ? `Confirm exactly ${batchSummary.included} actions for ${batchCampaignName}.`
                    : `${batchSummary.included} actions will be authorized.`
                  : "Stored outcomes are safe to revisit."}
              </span>
              {batchDetail.batch.status === "preview" && (
                <Button
                  variant="primary"
                  size="standard"
                  loading={confirmBusy}
                  disabled={batchSummary.included === 0}
                  onClick={authorizeIncludedActions}
                >
                  {batchCampaignName
                    ? `Authorize ${batchSummary.included} for ${batchCampaignName}`
                    : "Authorize included actions"}
                </Button>
              )}
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
