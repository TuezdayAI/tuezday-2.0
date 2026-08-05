"use client";
// Sprint 65 — generation path A/B (spec §9). One section on the Automation
// page: pick which path drafts (legacy / shadow / pipeline), read the
// comparison, review shadow pairs, and record the rollout decision that
// freezes the snapshot and flips the flag.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AUTOMATION_GENERATION_PATHS,
  ROLLOUT_DECISION_KINDS,
  type AutomationComparison,
  type AutomationGenerationPath,
  type PipelineShadowPair,
  type RolloutDecision,
  type RolloutDecisionKind,
  type ShadowVerdict,
  type SocialAutomationSettings,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import { comparisonLeader, formatCents, formatRate, pathLabel } from "@/lib/automation-ab-view";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Icon } from "@/src/components/ui/icon";
import { Input } from "@/src/components/ui/input";
import styles from "./automation.module.css";

const DECISION_LABEL: Record<RolloutDecisionKind, string> = {
  adopt_engine: "Adopt the engine (flag → pipeline)",
  keep_legacy: "Keep legacy (flag → legacy)",
  extend_shadow: "Extend the shadow period (flag → shadow)",
};

export function GenerationPath({ workspaceId }: { workspaceId: string }) {
  const [settings, setSettings] = useState<SocialAutomationSettings | null>(null);
  const [comparison, setComparison] = useState<AutomationComparison | null>(null);
  const [pairs, setPairs] = useState<PipelineShadowPair[]>([]);
  const [decisions, setDecisions] = useState<RolloutDecision[]>([]);
  const [hasActiveDefinition, setHasActiveDefinition] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [decision, setDecision] = useState<RolloutDecisionKind>("adopt_engine");
  const [rationale, setRationale] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [settingsRes, comparisonRes, pairsRes, decisionsRes, pipelinesRes] = await Promise.all([
      apiFetch(`/workspaces/${workspaceId}/automation/settings`),
      apiFetch(`/workspaces/${workspaceId}/automation/comparison`),
      apiFetch(`/workspaces/${workspaceId}/automation/shadow-pairs?reviewed=false`),
      apiFetch(`/workspaces/${workspaceId}/automation/rollout-decisions`),
      apiFetch(`/workspaces/${workspaceId}/pipelines`),
    ]);
    if (settingsRes.ok) setSettings(await settingsRes.json());
    if (comparisonRes.ok) setComparison(await comparisonRes.json());
    if (pairsRes.ok) setPairs(await pairsRes.json());
    if (decisionsRes.ok) setDecisions(await decisionsRes.json());
    if (pipelinesRes.ok) {
      const body = (await pipelinesRes.json()) as { definitions: { status: string }[] };
      setHasActiveDefinition(body.definitions.some((d) => d.status === "active"));
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setPath(generationPath: AutomationGenerationPath) {
    const res = await apiFetch(`/workspaces/${workspaceId}/automation/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationPath }),
    });
    if (res.ok) {
      setSettings(await res.json());
      void load();
    }
  }

  async function verdict(pairId: string, value: ShadowVerdict) {
    const res = await apiFetch(
      `/workspaces/${workspaceId}/automation/shadow-pairs/${pairId}/verdict`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict: value, notes: notes[pairId] ?? "" }),
      },
    );
    if (res.ok) void load();
  }

  async function recordDecision() {
    if (!rationale.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/automation/rollout-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, rationale: rationale.trim() }),
      });
      if (res.ok) {
        setRationale("");
        void load();
      }
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;
  const needsDefinition = settings.generationPath !== "legacy" && !hasActiveDefinition;
  const leader = comparison ? comparisonLeader(comparison) : null;

  return (
    <>
      <Card>
        <h2 className={styles.head}>
          <Icon name="status-generating" size="compact" /> Generation path
        </h2>
        <p className="subtitle">
          Which generator drafts when automation runs. <strong>Shadow</strong> keeps legacy in
          charge while the pipeline engine runs the same signals in parallel, so you can compare
          before switching.
        </p>
        <div className={styles.pathGrid}>
          {AUTOMATION_GENERATION_PATHS.map((path) => {
            const label = pathLabel(path);
            const active = settings.generationPath === path;
            return (
              <label
                key={path}
                className={`${styles.pathCard} ${active ? styles.pathCardActive : ""}`}
              >
                <span className={styles.pathTitle}>
                  <input
                    type="radio"
                    name="generation-path"
                    checked={active}
                    onChange={() => void setPath(path)}
                  />
                  {label.title}
                </span>
                <p className={styles.pathConsequence}>{label.consequence}</p>
              </label>
            );
          })}
        </div>
        {needsDefinition && (
          <p className="error" style={{ marginTop: 10 }}>
            <Icon name="warning" size="compact" /> No active pipeline definition — automation
            falls back to legacy until one is activated on{" "}
            <Link href={`/workspaces/${workspaceId}/pipelines`}>Pipelines</Link>.
          </p>
        )}
        <p className={styles.pathConsequence} style={{ marginTop: 10 }}>
          This comparison only sees drafts that actually happened. To ask the counterfactual —
          what would the engine produce for signals you have already ruled on? — replay them on{" "}
          <Link href={`/workspaces/${workspaceId}/evals`}>Evals</Link>.
        </p>
      </Card>

      {comparison && (
        <Card>
          <h2 className={styles.head}>
            <Icon name="status-learning" size="compact" /> Legacy vs engine — last{" "}
            {comparison.windowDays} days
          </h2>
          <table className="data-table" style={{ width: "100%", textAlign: "left" }}>
            <thead>
              <tr>
                <th></th>
                <th>Drafts</th>
                <th>Decided</th>
                <th>Approval rate</th>
                <th>Avg edit distance</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>Legacy</strong>
                  {leader === "legacy" ? " ← leading" : ""}
                </td>
                <td>{comparison.legacy.drafts}</td>
                <td>{comparison.legacy.decided}</td>
                <td>{formatRate(comparison.legacy.approvalRate)}</td>
                <td>{formatRate(comparison.legacy.avgEditDistance)}</td>
                <td>{formatCents(comparison.legacy.costCents)}</td>
              </tr>
              <tr>
                <td>
                  <strong>Engine</strong>
                  {leader === "engine" ? " ← leading" : ""}
                </td>
                <td>{comparison.engine.drafts}</td>
                <td>{comparison.engine.decided}</td>
                <td>{formatRate(comparison.engine.approvalRate)}</td>
                <td>{formatRate(comparison.engine.avgEditDistance)}</td>
                <td>{formatCents(comparison.engine.costCents)}</td>
              </tr>
            </tbody>
          </table>
          <p className="meta" style={{ marginTop: 10 }}>
            Engine runs: {comparison.engine.health.runs} ({comparison.engine.health.succeeded}{" "}
            succeeded, {comparison.engine.health.failed} failed,{" "}
            {comparison.engine.health.escalated} escalated) · Shadow pairs:{" "}
            {comparison.shadow.pairs} ({comparison.shadow.reviewed} reviewed —{" "}
            {comparison.shadow.engineWins} engine, {comparison.shadow.legacyWins} legacy,{" "}
            {comparison.shadow.ties} tie)
          </p>
          <p className={styles.costNote}>
            Costs are measured differently: engine cost is per-run metered spend (shadow runs
            included), legacy cost is the workspace's signal-draft + review LLM usage, which also
            counts manually triggered drafts. Compare trends, not absolutes.
          </p>
        </Card>
      )}

      {pairs.length > 0 && (
        <Card>
          <h2 className={styles.head}>
            <Icon name="status-review" size="compact" /> Shadow review ({pairs.length})
          </h2>
          <p className="subtitle">
            Same signal, both generators. Pick the better draft — your verdicts feed the
            comparison above.
          </p>
          {pairs.map((pair) => (
            <div key={pair.id} className={styles.pairItem}>
              <div className={styles.pairGrid}>
                <div className={styles.pairSide}>
                  <h4>Legacy draft{pair.draftState ? ` (${pair.draftState})` : ""}</h4>
                  {pair.draftContent ?? "Draft no longer available."}
                </div>
                <div className={styles.pairSide}>
                  <h4>Engine proposal ({pair.runStatus})</h4>
                  {pair.proposalContent ??
                    (pair.runStatus === "failed" || pair.runStatus === "escalated"
                      ? "The engine run did not produce a proposal."
                      : "Still running — check back after the next tick.")}
                </div>
              </div>
              <div className={styles.pairActions}>
                <Button size="compact" onClick={() => void verdict(pair.id, "engine")}>
                  Engine wins
                </Button>
                <Button size="compact" onClick={() => void verdict(pair.id, "legacy")}>
                  Legacy wins
                </Button>
                <Button size="compact" variant="tertiary" onClick={() => void verdict(pair.id, "tie")}>
                  Tie
                </Button>
                <Input
                  placeholder="Why? (optional)"
                  value={notes[pair.id] ?? ""}
                  onChange={(e) => setNotes({ ...notes, [pair.id]: e.target.value })}
                  style={{ flex: 1, minWidth: 180 }}
                />
              </div>
            </div>
          ))}
        </Card>
      )}

      <Card>
        <h2 className={styles.head}>
          <Icon name="status-approved" size="compact" /> Rollout decision
        </h2>
        <p className="subtitle">
          Recording a decision freezes the comparison snapshot above and flips the generation
          path in the same step. Decisions are append-only — extend the shadow period if the
          data is not conclusive yet.
        </p>
        <div className="resolve-controls" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ minWidth: 260 }}>
            Decision
            <select
              className="select"
              value={decision}
              onChange={(e) => setDecision(e.target.value as RolloutDecisionKind)}
            >
              {ROLLOUT_DECISION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {DECISION_LABEL[kind]}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1, minWidth: 220 }}>
            Rationale
            <Input
              placeholder="What the data showed and why this call."
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
            />
          </label>
          <Button
            variant="primary"
            onClick={() => void recordDecision()}
            disabled={saving || !rationale.trim()}
          >
            Record decision
          </Button>
        </div>
        {decisions.length === 0 ? (
          <EmptyState description="No rollout decisions yet — run in shadow first, then decide here." />
        ) : (
          <ul className="draft-chain" style={{ marginTop: 12 }}>
            {decisions.map((d) => (
              <li key={d.id}>
                <span className="meta">
                  <strong>{DECISION_LABEL[d.decision]}</strong> —{" "}
                  {new Date(d.createdAt).toLocaleDateString()} · “{d.rationale}” · snapshot:
                  legacy {formatRate(d.metrics.legacy.approvalRate)} approval vs engine{" "}
                  {formatRate(d.metrics.engine.approvalRate)}, {d.metrics.shadow.reviewed}/
                  {d.metrics.shadow.pairs} pairs reviewed
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
