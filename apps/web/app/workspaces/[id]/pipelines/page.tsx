"use client";

import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Select } from "@/src/components/ui/input";
import styles from "./pipelines.module.css";

import { API_URL, apiFetch } from "@/lib/api";
import {
  checklistRollup,
  decisionsFor,
  parseSpecInput,
  stepSummary,
} from "@/lib/pipeline-view";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CHANNELS, PIPELINE_RUN_STATUSES } from "@tuezday/contracts";
import type {
  Channel,
  DryRunPipelineResult,
  PipelineDefinition,
  PipelineRun,
  PipelineRunDecisionAction,
  PipelineRunDetail,
  PipelineRunStatus,
  Workspace,
} from "@tuezday/contracts";

const RUNS_PAGE_SIZE = 20;

interface SignalOption {
  id: string;
  content: string;
}

function runTone(
  status: PipelineRunStatus,
): "draft" | "approved" | "pending" | "edited" | "rejected" | "danger" | "neutral" {
  switch (status) {
    case "queued":
      return "draft";
    case "running":
      return "pending";
    case "escalated":
      return "edited";
    case "succeeded":
      return "approved";
    case "failed":
      return "danger";
    case "cancelled":
      return "rejected";
    default:
      return "neutral";
  }
}

function definitionTone(status: PipelineDefinition["status"]): "approved" | "draft" | "rejected" {
  return status === "active" ? "approved" : status === "archived" ? "rejected" : "draft";
}

function label(value: string): string {
  return value.replace(/_/g, " ");
}

function scopeLabel(definition: PipelineDefinition): string {
  if (definition.laneId) return "lane-scoped";
  if (definition.campaignId) return "campaign-scoped";
  return "workspace default";
}

export default function PipelinesPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [definitions, setDefinitions] = useState<PipelineDefinition[] | null>(null);
  const [signals, setSignals] = useState<SignalOption[]>([]);
  const [runs, setRuns] = useState<PipelineRun[] | null>(null);
  const [runsTotal, setRunsTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<PipelineRunStatus | "all">("all");
  const [error, setError] = useState<string | null>(null);

  const [editorFor, setEditorFor] = useState<string | null>(null);
  const [editorText, setEditorText] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [runSignal, setRunSignal] = useState("");
  const [runChannel, setRunChannel] = useState<Channel>("linkedin");
  const [dryRunResult, setDryRunResult] = useState<DryRunPipelineResult | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [openRun, setOpenRun] = useState<Record<string, boolean>>({});
  const [runDetails, setRunDetails] = useState<Record<string, PipelineRunDetail>>({});
  const [decidingRun, setDecidingRun] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const statusQuery = statusFilter === "all" ? "" : `&status=${statusFilter}`;

  const load = useCallback(async () => {
    try {
      const [wsRes, defRes, signalRes, runsRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/pipelines`),
        apiFetch(`/workspaces/${id}/signals`),
        apiFetch(`/workspaces/${id}/pipeline-runs?limit=${RUNS_PAGE_SIZE}&offset=0${statusQuery}`),
      ]);
      if (!wsRes.ok || !defRes.ok || !runsRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setDefinitions((await defRes.json()).definitions);
      if (signalRes.ok) {
        const signalBody = (await signalRes.json()) as SignalOption[];
        setSignals(signalBody.slice(0, 10));
      }
      const runsBody = await runsRes.json();
      setRuns(runsBody.runs);
      setRunsTotal(runsBody.total);
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id, statusQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMoreRuns() {
    if (!runs) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch(
        `/workspaces/${id}/pipeline-runs?limit=${RUNS_PAGE_SIZE}&offset=${runs.length}${statusQuery}`,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setRuns((prev) => [...(prev ?? []), ...body.runs]);
      setRunsTotal(body.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more runs");
    } finally {
      setLoadingMore(false);
    }
  }

  function openEditor(definition: PipelineDefinition) {
    setEditorFor(definition.id);
    setEditorText(JSON.stringify(definition.spec, null, 2));
    setEditorError(null);
  }

  async function saveSpec(definitionId: string) {
    const parsed = parseSpecInput(editorText);
    if (parsed.error) {
      setEditorError(parsed.error);
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/pipelines/${definitionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: parsed.spec }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setEditorFor(null);
      setNote(`Saved as version ${body.currentVersion}.`);
      await load();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(definitionId: string, action: "activate" | "archive") {
    setBusyId(definitionId);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/pipelines/${definitionId}/${action}`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Status change failed");
    } finally {
      setBusyId(null);
    }
  }

  async function runLive(definitionId: string) {
    if (!runSignal) return;
    setBusyId(definitionId);
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/pipelines/${definitionId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId: runSignal, channel: runChannel }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `API returned ${res.status}`);
      setNote(
        body.status === "succeeded"
          ? "Run succeeded — the draft is waiting at the approval gate."
          : `Run finished as ${label(body.status)}${body.escalationReason ? ` (${body.escalationReason})` : ""}.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setBusyId(null);
    }
  }

  async function dryRun(definitionId: string) {
    setBusyId(definitionId);
    setError(null);
    setDryRunResult(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/pipelines/${definitionId}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 3, channel: runChannel }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `API returned ${res.status}`);
      setDryRunResult(body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dry run failed");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleRunDetail(runId: string) {
    if (openRun[runId]) {
      setOpenRun((prev) => ({ ...prev, [runId]: false }));
      return;
    }
    setOpenRun((prev) => ({ ...prev, [runId]: true }));
    if (runDetails[runId]) return;
    try {
      const res = await apiFetch(`/workspaces/${id}/pipeline-runs/${runId}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setRunDetails((prev) => ({ ...prev, [runId]: body }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load run detail");
      setOpenRun((prev) => ({ ...prev, [runId]: false }));
    }
  }

  async function decideRun(runId: string, action: PipelineRunDecisionAction, reason?: string) {
    if (action === "cancel" && !reason) return;
    setDecidingRun(runId);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/pipeline-runs/${runId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `API returned ${res.status}`);
      setRuns((prev) => prev?.map((run) => (run.id === body.id ? body : run)) ?? prev);
      setRunDetails((prev) => {
        const { [runId]: _evicted, ...rest } = prev;
        return rest;
      });
      setCancelFor(null);
      setCancelReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setDecidingRun(null);
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

  if (!workspace || !definitions || !runs) return <EmptyState description="Loading…" />;

  return (
    <>
      <p className="subtitle">
        A pipeline is data, not code: an ordered list of bounded agent steps — each with its own
        tool allowlist, model tier, output schema and caps — versioned like brain docs. The engine
        owns sequencing, retries, budgets and the approval-gate handoff. Edit a definition and the
        next run behaves differently, with no deploy.
      </p>

      {error && <p className="error">{error}</p>}
      {note && <p className={styles.runNote}>{note}</p>}

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="discover" size="compact" className={styles.headIcon} />
              Definitions <CountBadge count={definitions.length} label="definitions" />
            </span>
          }
        />
        {definitions.length === 0 ? (
          <EmptyState description="No pipeline definitions yet — reload to seed the reference." />
        ) : (
          <ul className={styles.itemList}>
            {definitions.map((definition) => {
              const busy = busyId === definition.id;
              const editing = editorFor === definition.id;
              return (
                <li key={definition.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span className={styles.name}>{definition.name}</span>
                    <Badge tone={definitionTone(definition.status)}>{definition.status}</Badge>
                    <span className={styles.chip}>v{definition.currentVersion}</span>
                    <span className={styles.chip}>{scopeLabel(definition)}</span>
                    <span className={styles.chip}>{label(definition.taskKey)}</span>
                  </div>
                  <div className={styles.chipRow}>
                    {definition.spec.steps.map((step) => (
                      <span key={step.key} className={styles.stepChip}>
                        {stepSummary(step)}
                      </span>
                    ))}
                  </div>
                  {!editing && (
                    <div className={styles.actionRow}>
                      <Button
                        variant="tertiary"
                        size="compact"
                        onClick={() => openEditor(definition)}
                      >
                        Edit spec
                      </Button>
                      {definition.status !== "active" && (
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={busy}
                          onClick={() => void setStatus(definition.id, "activate")}
                        >
                          Activate
                        </Button>
                      )}
                      {definition.status !== "archived" && (
                        <Button
                          variant="tertiary"
                          size="compact"
                          disabled={busy}
                          onClick={() => void setStatus(definition.id, "archive")}
                        >
                          Archive
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="compact"
                        disabled={busy}
                        onClick={() => void dryRun(definition.id)}
                      >
                        {busy ? "Working…" : "Dry run (last 3 signals)"}
                      </Button>
                      <Select
                        value={runChannel}
                        onChange={(e) => setRunChannel(e.target.value as Channel)}
                      >
                        {CHANNELS.map((channel) => (
                          <option key={channel} value={channel}>
                            {channel}
                          </option>
                        ))}
                      </Select>
                      <Select value={runSignal} onChange={(e) => setRunSignal(e.target.value)}>
                        <option value="">Pick a signal…</option>
                        {signals.map((signal) => (
                          <option key={signal.id} value={signal.id}>
                            {signal.content.slice(0, 60)}
                          </option>
                        ))}
                      </Select>
                      <Button
                        variant="primary"
                        size="compact"
                        disabled={busy || !runSignal}
                        onClick={() => void runLive(definition.id)}
                      >
                        Run on signal
                      </Button>
                    </div>
                  )}
                  {editing && (
                    <div className={styles.editor}>
                      <textarea
                        className={styles.editorArea}
                        value={editorText}
                        onChange={(e) => setEditorText(e.target.value)}
                        spellCheck={false}
                      />
                      {editorError && <p className={styles.editorError}>{editorError}</p>}
                      <div className={styles.actionRow}>
                        <Button
                          variant="primary"
                          size="compact"
                          disabled={saving}
                          onClick={() => void saveSpec(definition.id)}
                        >
                          {saving ? "Saving…" : "Save as new version"}
                        </Button>
                        <Button
                          variant="tertiary"
                          size="compact"
                          onClick={() => setEditorFor(null)}
                        >
                          Discard
                        </Button>
                      </div>
                    </div>
                  )}
                  {dryRunResult && busyId === null && (
                    <div className={styles.dryRunResult}>
                      <p className={styles.detailTitle}>
                        Dry run — what this version would have produced
                      </p>
                      {dryRunResult.runs.map((entry) => (
                        <div key={entry.runId}>
                          <div className={styles.stepRow}>
                            <Badge tone={runTone(entry.status)}>{label(entry.status)}</Badge>
                            <span>
                              checklist {checklistRollup(entry.checklist).passed}/
                              {checklistRollup(entry.checklist).total}
                            </span>
                            {entry.failureReason && <span>{entry.failureReason}</span>}
                            {entry.escalationReason && <span>{entry.escalationReason}</span>}
                          </div>
                          {entry.proposal && (
                            <p className={styles.proposal}>{entry.proposal.content}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="discover" size="compact" className={styles.headIcon} />
              Runs <CountBadge count={runsTotal} label="runs" />
            </span>
          }
          actions={
            <label className={styles.filterLabel}>
              Status
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as PipelineRunStatus | "all")}
              >
                <option value="all">All statuses</option>
                {PIPELINE_RUN_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {label(status)}
                  </option>
                ))}
              </Select>
            </label>
          }
        />
        {runs.length === 0 ? (
          <EmptyState
            description="No runs yet — dry-run the reference definition against recent signals to see what it would produce."
            preview={
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="discover" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>signal → social post · v2</span>
                  <span className={styles.previewMeta}>succeeded · checklist 6/6</span>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="discover" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>signal → social post · v2</span>
                  <span className={styles.previewMeta}>escalated · guardrail uncertain</span>
                </div>
              </div>
            }
          />
        ) : (
          <ul className={styles.itemList}>
            {runs.map((run) => {
              const rollup = checklistRollup(run.checklist);
              const decisions = decisionsFor(run.status);
              const detail = openRun[run.id] ? runDetails[run.id] : undefined;
              const cancelOpen = cancelFor === run.id;
              return (
                <li key={run.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <Badge tone={runTone(run.status)}>{label(run.status)}</Badge>
                    <span className={styles.chip}>{run.mode === "dry_run" ? "dry run" : "live"}</span>
                    <span className={styles.chip}>v{run.definitionVersion}</span>
                    <span className={styles.chip}>{run.channel}</span>
                    {rollup.total > 0 && (
                      <span className={styles.chip}>
                        checklist {rollup.passed}/{rollup.total}
                      </span>
                    )}
                    {run.costCents > 0 && (
                      <span className={styles.chip}>{run.costCents.toFixed(2)}¢</span>
                    )}
                    <span className="section-tokens">
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {run.status === "escalated" && (
                    <div className={styles.escalation}>
                      <span>
                        Paused at “{run.pausedAtStepKey}” — {run.escalationReason}. Resume to
                        continue from the pause point, or cancel with a reason.
                      </span>
                      {!cancelOpen ? (
                        <div className={styles.actionRow}>
                          <Button
                            variant="primary"
                            size="compact"
                            disabled={decidingRun === run.id}
                            onClick={() => void decideRun(run.id, "resume")}
                          >
                            Resume
                          </Button>
                          <Button
                            variant="tertiary"
                            size="compact"
                            onClick={() => setCancelFor(run.id)}
                          >
                            Cancel run
                          </Button>
                        </div>
                      ) : (
                        <div className={styles.reasonRow}>
                          <Input
                            value={cancelReason}
                            placeholder="Why cancel this run?"
                            onChange={(e) => setCancelReason(e.target.value)}
                          />
                          <Button
                            variant="danger"
                            size="compact"
                            disabled={!cancelReason.trim() || decidingRun === run.id}
                            onClick={() => void decideRun(run.id, "cancel", cancelReason.trim())}
                          >
                            Confirm
                          </Button>
                          <Button
                            variant="tertiary"
                            size="compact"
                            onClick={() => setCancelFor(null)}
                          >
                            Keep
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  {run.failureReason && run.status === "failed" && (
                    <p className={styles.editorError}>{run.failureReason}</p>
                  )}
                  <div className={styles.actionRow}>
                    <Button
                      variant="tertiary"
                      size="compact"
                      onClick={() => void toggleRunDetail(run.id)}
                    >
                      {openRun[run.id] ? "Hide steps" : "Show steps"}
                    </Button>
                    {run.status !== "escalated" &&
                      decisions.includes("cancel") &&
                      (cancelOpen ? (
                        <div className={styles.reasonRow}>
                          <Input
                            value={cancelReason}
                            placeholder="Why cancel this run?"
                            onChange={(e) => setCancelReason(e.target.value)}
                          />
                          <Button
                            variant="danger"
                            size="compact"
                            disabled={!cancelReason.trim() || decidingRun === run.id}
                            onClick={() => void decideRun(run.id, "cancel", cancelReason.trim())}
                          >
                            Confirm
                          </Button>
                          <Button
                            variant="tertiary"
                            size="compact"
                            onClick={() => setCancelFor(null)}
                          >
                            Keep
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="tertiary"
                          size="compact"
                          onClick={() => setCancelFor(run.id)}
                        >
                          Cancel run
                        </Button>
                      ))}
                  </div>
                  {detail && (
                    <div className={styles.detail}>
                      <div className={styles.detailSection}>
                        <p className={styles.detailTitle}>Steps</p>
                        <ul className={styles.stepList}>
                          {detail.steps.map((step) => (
                            <li key={step.id} className={styles.stepRow}>
                              <span
                                className={step.passes ? styles.checkPass : styles.checkFail}
                              >
                                {step.passes ? "✓" : step.status === "skipped" ? "—" : "✗"}
                              </span>
                              <span className={styles.stepKey}>
                                {step.stepKey}#{step.iteration}
                              </span>
                              <span>attempt {step.attempt}</span>
                              <span>{label(step.status)}</span>
                              {step.stopReason && <span>{label(step.stopReason)}</span>}
                              {step.failureReason && <span>{step.failureReason}</span>}
                              <span>
                                {(step.inputTokens + step.outputTokens).toLocaleString()} tok
                              </span>
                              {step.agentRunId && (
                                <Link href={`/workspaces/${id}/inspector`}>inspect</Link>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                      {detail.result && (
                        <div className={styles.detailSection}>
                          <p className={styles.detailTitle}>
                            {detail.result.simulated
                              ? "Proposal (simulated — dry run)"
                              : "Proposed to the approval gate"}
                          </p>
                          <p className={styles.proposal}>{detail.result.content}</p>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {runs.length < runsTotal && (
          <div className={styles.actionRow}>
            <Button
              variant="tertiary"
              size="compact"
              disabled={loadingMore}
              onClick={() => void loadMoreRuns()}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
