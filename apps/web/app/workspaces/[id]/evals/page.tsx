"use client";

import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Select } from "@/src/components/ui/input";
import styles from "./evals.module.css";

import { API_URL, apiFetch } from "@/lib/api";
import {
  HEADLINE_METRICS,
  failedChecks,
  formatMetric,
  metricLabel,
  regressionSeverity,
  runSummary,
  verdictTone,
} from "@/lib/evals-view";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CHANNELS, CTA_EXPECTATIONS } from "@tuezday/contracts";
import type {
  BannedClaim,
  Channel,
  CtaExpectation,
  EvalComparison,
  EvalRun,
  EvalRunDetail,
  EvalSuite,
  Workspace,
} from "@tuezday/contracts";

export default function EvalsPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [suites, setSuites] = useState<EvalSuite[] | null>(null);
  const [runs, setRuns] = useState<EvalRun[] | null>(null);
  const [claims, setClaims] = useState<BannedClaim[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [suiteName, setSuiteName] = useState("");
  const [suiteChannel, setSuiteChannel] = useState<Channel>("linkedin");
  const [suiteCta, setSuiteCta] = useState<CtaExpectation>("any");
  const [suiteLimit, setSuiteLimit] = useState("20");

  const [runSuiteId, setRunSuiteId] = useState("");
  const [judge, setJudge] = useState(false);
  const [baselineLabel, setBaselineLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const [claimPhrase, setClaimPhrase] = useState("");
  const [openRun, setOpenRun] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, EvalRunDetail>>({});
  const [comparisons, setComparisons] = useState<Record<string, EvalComparison>>({});

  const load = useCallback(async () => {
    try {
      const [wsRes, suiteRes, runRes, claimRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/evals/suites`),
        apiFetch(`/workspaces/${id}/evals/runs`),
        apiFetch(`/workspaces/${id}/banned-claims`),
      ]);
      if (!wsRes.ok || !suiteRes.ok || !runRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      const suiteBody = (await suiteRes.json()).suites as EvalSuite[];
      setSuites(suiteBody);
      setRunSuiteId((prev) => prev || (suiteBody[0]?.id ?? ""));
      setRuns((await runRes.json()).runs);
      if (claimRes.ok) setClaims((await claimRes.json()).claims);
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function buildSuite() {
    if (!suiteName.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/evals/suites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: suiteName.trim(),
          channel: suiteChannel,
          ctaExpectation: suiteCta,
          limit: Number(suiteLimit) || 20,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setNote(
        body.suite.caseCount === 0
          ? "No decided drafts on that channel yet — the suite is empty until the gate has history."
          : `Froze ${body.suite.caseCount} historical case(s) into "${body.suite.name}".`,
      );
      setSuiteName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the suite");
    } finally {
      setBusy(false);
    }
  }

  async function startRun() {
    if (!runSuiteId) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/evals/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suiteId: runSuiteId,
          judge,
          ...(baselineLabel.trim() ? { baselineLabel: baselineLabel.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setNote(`Replayed ${body.metrics.completed} of ${body.metrics.cases} case(s).`);
      setBaselineLabel("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The eval run failed");
    } finally {
      setBusy(false);
    }
  }

  async function addClaim() {
    if (!claimPhrase.trim()) return;
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/banned-claims`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase: claimPhrase.trim() }),
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      setClaimPhrase("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the claim");
    }
  }

  async function removeClaim(claimId: string) {
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/banned-claims/${claimId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the claim");
    }
  }

  async function toggleRun(runId: string) {
    if (openRun[runId]) {
      setOpenRun((prev) => ({ ...prev, [runId]: false }));
      return;
    }
    setOpenRun((prev) => ({ ...prev, [runId]: true }));
    if (details[runId]) return;
    try {
      const [detailRes, comparisonRes] = await Promise.all([
        apiFetch(`/workspaces/${id}/evals/runs/${runId}`),
        apiFetch(`/workspaces/${id}/evals/runs/${runId}/comparison`),
      ]);
      if (!detailRes.ok) throw new Error(`API returned ${detailRes.status}`);
      const detail = (await detailRes.json()) as EvalRunDetail;
      setDetails((prev) => ({ ...prev, [runId]: detail }));
      if (comparisonRes.ok) {
        const comparison = (await comparisonRes.json()) as EvalComparison;
        setComparisons((prev) => ({ ...prev, [runId]: comparison }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the run");
      setOpenRun((prev) => ({ ...prev, [runId]: false }));
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

  if (!workspace || !suites || !runs) return <EmptyState description="Loading…" />;

  return (
    <>
      <p className="subtitle">
        Replay historical signals through the current pipeline and compare what it produces against
        what you actually approved, rejected or rewrote. Hard checks are deterministic and gate CI;
        the rubric judge is advisory. Label a run as a baseline and every later run is measured
        against it.
      </p>

      {error && <p className="error">{error}</p>}
      {note && <p className={styles.note}>{note}</p>}

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="discover" size="compact" className={styles.headIcon} />
              Build a suite from approval history
            </span>
          }
        />
        <div className={styles.row}>
          <label className={styles.field}>
            Name
            <Input
              value={suiteName}
              onChange={(event) => setSuiteName(event.target.value)}
              placeholder="Pre-Sprint-66 baseline"
              maxLength={120}
            />
          </label>
          <label className={styles.field}>
            Channel
            <Select
              value={suiteChannel}
              onChange={(event) => setSuiteChannel(event.target.value as Channel)}
            >
              {CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channel}
                </option>
              ))}
            </Select>
          </label>
          <label className={styles.field}>
            Call to action
            <Select
              value={suiteCta}
              onChange={(event) => setSuiteCta(event.target.value as CtaExpectation)}
            >
              {CTA_EXPECTATIONS.map((expectation) => (
                <option key={expectation} value={expectation}>
                  {expectation}
                </option>
              ))}
            </Select>
          </label>
          <label className={styles.field}>
            Cases
            <Input
              type="number"
              min={1}
              max={50}
              value={suiteLimit}
              onChange={(event) => setSuiteLimit(event.target.value)}
            />
          </label>
          <Button onClick={buildSuite} disabled={busy || !suiteName.trim()}>
            Build suite
          </Button>
        </div>
        {suites.length > 0 && (
          <ul className={styles.claimList} style={{ marginTop: 10 }}>
            {suites.map((suite) => (
              <li key={suite.id} className={styles.claim}>
                {suite.name} · {suite.channel} · {suite.caseCount} case(s)
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="settings" size="compact" className={styles.headIcon} />
              Banned claims
            </span>
          }
        />
        <p className={styles.note}>
          Exact phrases that must never be published. Unlike channel guidance, these are checked
          literally — the harness fails any draft containing one, and the critic can cite the
          phrase it tripped on.
        </p>
        <div className={styles.row}>
          <label className={styles.field}>
            Phrase
            <Input
              value={claimPhrase}
              onChange={(event) => setClaimPhrase(event.target.value)}
              placeholder="the only platform that"
              maxLength={120}
            />
          </label>
          <Button variant="secondary" onClick={addClaim} disabled={!claimPhrase.trim()}>
            Add
          </Button>
        </div>
        {claims.length > 0 && (
          <ul className={styles.claimList} style={{ marginTop: 10 }}>
            {claims.map((claim) => (
              <li key={claim.id} className={styles.claim}>
                {claim.phrase}
                <Button variant="tertiary" size="compact" onClick={() => removeClaim(claim.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-generating" size="compact" className={styles.headIcon} />
              Run the harness
            </span>
          }
        />
        <div className={styles.row}>
          <label className={styles.field}>
            Suite
            <Select value={runSuiteId} onChange={(event) => setRunSuiteId(event.target.value)}>
              {suites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name} ({suite.caseCount})
                </option>
              ))}
            </Select>
          </label>
          <label className={styles.field}>
            Baseline label (optional)
            <Input
              value={baselineLabel}
              onChange={(event) => setBaselineLabel(event.target.value)}
              placeholder="pre-sprint-66"
              maxLength={60}
            />
          </label>
          <label className={styles.field}>
            <span>
              <input
                type="checkbox"
                checked={judge}
                onChange={(event) => setJudge(event.target.checked)}
              />{" "}
              Run the rubric judge (costs tokens)
            </span>
          </label>
          <Button onClick={startRun} disabled={busy || !runSuiteId}>
            Replay
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Runs" />
        {runs.length === 0 ? (
          <EmptyState description="No eval runs yet. Build a suite, then replay it." />
        ) : (
          <ul className={styles.itemList}>
            {runs.map((run) => {
              const comparison = comparisons[run.id];
              const severity = comparison ? regressionSeverity(comparison) : null;
              return (
                <li key={run.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span>
                      {new Date(run.createdAt).toLocaleString()}
                      {run.baselineLabel && (
                        <>
                          {" "}
                          <Badge tone="approved">baseline: {run.baselineLabel}</Badge>
                        </>
                      )}
                    </span>
                    <Button variant="tertiary" size="compact" onClick={() => toggleRun(run.id)}>
                      {openRun[run.id] ? "Hide" : "Open"}
                    </Button>
                  </div>
                  <span className={styles.metricLabel}>{runSummary(run)}</span>
                  <div className={styles.metrics}>
                    {HEADLINE_METRICS.map((metric) => (
                      <div key={metric} className={styles.metric}>
                        <span className={styles.metricLabel}>{metricLabel(metric)}</span>
                        <span className={styles.metricValue}>
                          {formatMetric(metric, run.metrics[metric])}
                        </span>
                      </div>
                    ))}
                  </div>

                  {openRun[run.id] && comparison && severity && (
                    <div
                      className={[
                        styles.gate,
                        severity === "blocked"
                          ? styles.gateBlocked
                          : severity === "clean"
                            ? styles.gateClean
                            : styles.gateUnmeasured,
                      ].join(" ")}
                    >
                      {severity === "unmeasured"
                        ? "No baseline labelled yet — nothing to compare against. Label a run to start measuring."
                        : severity === "clean"
                          ? `No regression against "${comparison.baselineLabel}".`
                          : `Regression against "${comparison.baselineLabel}" — this would block a merge.`}
                      {comparison.regressions.length > 0 && (
                        <ul className={styles.deltaList}>
                          {comparison.regressions.map((delta) => (
                            <li key={delta.metric}>
                              {metricLabel(delta.metric)}: {delta.baseline} → {delta.current} (
                              {delta.delta > 0 ? "+" : ""}
                              {delta.delta}, tolerance ±{delta.tolerance})
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {openRun[run.id] && details[run.id] && (
                    <ul className={styles.caseList}>
                      {details[run.id]!.results.map((result) => (
                        <li key={result.id} className={styles.case}>
                          <div className={styles.itemHead}>
                            <Badge tone={verdictTone(result.verdict)}>
                              {result.verdict ?? "not scored"}
                            </Badge>
                            <span className={styles.metricLabel}>
                              {result.failureReason
                                ? `Replay failed: ${result.failureReason}`
                                : `${result.editDistanceToFinal}% from what shipped${
                                    result.judge ? ` · judge ${result.judge.overall}/100` : ""
                                  }`}
                            </span>
                          </div>
                          {result.producedContent && (
                            <p className={styles.caseContent}>{result.producedContent}</p>
                          )}
                          {failedChecks(result.checks).map((check) => (
                            <p key={check.kind} className={styles.violation}>
                              {check.kind.replace(/_/g, " ")}: {check.detail}
                            </p>
                          ))}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
