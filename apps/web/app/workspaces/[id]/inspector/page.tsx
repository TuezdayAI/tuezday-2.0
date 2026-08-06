"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge } from "@/src/components/ui/badge";
import { Input } from "@/src/components/ui/input";
import styles from "./inspector.module.css";

import { API_URL, apiFetch } from "@/lib/api";
import {
  formatCost,
  formatElapsed,
  formatJson,
  formatTokens,
  groupSteps,
  runBadge,
} from "@/lib/agent-inspector";

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import type { AgentProposal, AgentRunDetail, AgentRunStep, AgentRunSummary } from "@tuezday/contracts";
import { proposalLine, proposalTone } from "@/lib/agent-proposals-view";

function RunStatusBadge({ run }: { run: Pick<AgentRunSummary, "status" | "stopReason"> }) {
  const view = runBadge(run);
  return <Badge tone={view.tone}>{view.label}</Badge>;
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className={styles.jsonBlock}>
      <span className="meta">{label}</span>
      <pre className="section-content">{formatJson(value)}</pre>
    </div>
  );
}

function ToolStep({ step }: { step: AgentRunStep }) {
  return (
    <div className={styles.toolStep}>
      <div className={styles.stepHead}>
        <Badge tone={step.toolError ? "danger" : "neutral"}>{step.toolName ?? "tool"}</Badge>
        <span className="meta">
          step {step.stepIndex} · {step.durationMs}ms
        </span>
      </div>
      <JsonBlock label="arguments" value={step.toolArgs} />
      {step.toolError ? (
        <JsonBlock label="error" value={step.toolError} />
      ) : (
        <JsonBlock label="result" value={step.toolResult} />
      )}
    </div>
  );
}

function RunDetailView({ detail }: { detail: AgentRunDetail }) {
  const timeline = groupSteps(detail.steps);
  return (
    <div className={styles.detail}>
      <div className={styles.detailMeta}>
        <RunStatusBadge run={detail} />
        <span className="meta">
          {detail.model || "—"} ({detail.provider || "—"}) · {formatTokens(detail.usage.inputTokens)}{" "}
          in / {formatTokens(detail.usage.outputTokens)} out
          {detail.usage.cachedTokens > 0 ? ` (${formatTokens(detail.usage.cachedTokens)} cached)` : ""} ·{" "}
          {formatCost(detail.usage.costCents)} · {formatElapsed(detail.startedAt, detail.finishedAt)} · by{" "}
          {detail.createdBy}
        </span>
      </div>
      {detail.error ? <p className="error">{detail.error}</p> : null}

      <details className={styles.systemPrompt}>
        <summary className="meta">System prompt + input</summary>
        <pre className="section-content">{detail.system}</pre>
        {detail.inputMessages.map((message, i) => (
          <pre key={i} className="section-content">
            {message.role}: {message.content}
          </pre>
        ))}
      </details>

      {timeline.map((entry) => (
        <div key={entry.model.stepIndex} className={styles.modelStep}>
          <div className={styles.stepHead}>
            <Badge tone="neutral">model call</Badge>
            <span className="meta">
              step {entry.model.stepIndex} · {formatTokens(entry.model.usage.inputTokens)} in /{" "}
              {formatTokens(entry.model.usage.outputTokens)} out · {formatCost(entry.model.usage.costCents)} ·{" "}
              {entry.model.durationMs}ms
            </span>
          </div>
          {entry.model.message?.content ? (
            <pre className="section-content">{entry.model.message.content}</pre>
          ) : null}
          {entry.tools.map((tool) => (
            <ToolStep key={tool.stepIndex} step={tool} />
          ))}
        </div>
      ))}

      {detail.proposals.length > 0 ? (
        <section className={styles.proposals} aria-label="What this run proposed">
          <span className="meta">What this run proposed</span>
          {detail.proposals.map((proposal: AgentProposal) => (
            <div key={proposal.id} className={styles.proposal}>
              <Badge tone={proposalTone(proposal)}>{proposal.tool}</Badge>
              <span className="section-content">{proposalLine(proposal)}</span>
            </div>
          ))}
        </section>
      ) : null}

      {detail.output !== null && detail.output !== undefined ? (
        <JsonBlock label="final output" value={detail.output} />
      ) : null}
    </div>
  );
}

export default function InspectorPage() {
  const { id } = useParams<{ id: string }>();
  // Deep link from the authorization queue: "an agent proposed this — why?"
  // should be one click, not a hunt through the run list.
  const requestedRun = useSearchParams().get("run");

  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${id}/agent-runs`);
      if (!res.ok) throw new Error(`agent runs: ${res.status}`);
      const body = (await res.json()) as { runs: AgentRunSummary[] };
      setRuns(body.runs);
      setError(null);
    } catch {
      setError(`Could not load agent runs from ${API_URL}.`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const openRun = useCallback(
    async (runId: string) => {
      try {
        const res = await apiFetch(`/workspaces/${id}/agent-runs/${runId}`);
        if (!res.ok) throw new Error(`run detail: ${res.status}`);
        setDetail((await res.json()) as AgentRunDetail);
        setError(null);
      } catch {
        setError("Could not load that run.");
      }
    },
    [id],
  );

  useEffect(() => {
    if (requestedRun) void openRun(requestedRun);
  }, [openRun, requestedRun]);

  const runProof = useCallback(async () => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/agent-runs/proof`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });
      if (!res.ok) throw new Error(`proof: ${res.status}`);
      const body = (await res.json()) as { runId: string };
      setQuestion("");
      await load();
      await openRun(body.runId);
    } catch {
      setError("The proof run failed to start. Is the API's LLM configured?");
    } finally {
      setBusy(false);
    }
  }, [busy, id, load, openRun, question]);

  const proofForm = (
    <div className={styles.proofForm}>
      <Input
        value={question}
        placeholder="Ask something about this workspace, e.g. “What is our tone of voice?”"
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void runProof();
        }}
      />
      <Button onClick={() => void runProof()} disabled={busy || !question.trim()}>
        {busy ? "Running…" : "Run proof agent"}
      </Button>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Agent inspector"
        subtitle="Every run, step by step: what the agent looked up, in what order, and what it cost."
      />
      {error ? <p className="error">{error}</p> : null}

      <Card>
        <CardHeader
          title="Ask the workspace agent"
          actions={
            <Button variant="secondary" size="compact" onClick={() => void load()}>
              Refresh
            </Button>
          }
        />
        <p className="meta">
          Runs a bounded read-only agent over the workspace tools (brain, evidence, campaigns,
          publications, discovery) and records the full trace below.
        </p>
        {proofForm}
      </Card>

      <Card>
        <CardHeader title="Runs" />
        {runs.length === 0 ? (
          <EmptyState
            title="No agent runs yet"
            description="Every agent run in this workspace lands here with its full transcript, tool calls, tokens and cost. Trigger a proof run above to see one."
          />
        ) : (
          <table className="matrix-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>By</th>
                <th>Model</th>
                <th>Steps</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Elapsed</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className={detail?.id === run.id ? styles.selectedRow : styles.row}
                  onClick={() => void openRun(run.id)}
                >
                  <td>{run.task}</td>
                  <td>
                    <RunStatusBadge run={run} />
                  </td>
                  <td>{run.createdBy}</td>
                  <td>{run.model || "—"}</td>
                  <td>{run.stepCount}</td>
                  <td>
                    {formatTokens(run.usage.inputTokens)} / {formatTokens(run.usage.outputTokens)}
                  </td>
                  <td>{formatCost(run.usage.costCents)}</td>
                  <td>{formatElapsed(run.startedAt, run.finishedAt)}</td>
                  <td>{new Date(run.startedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {detail ? (
        <Card>
          <CardHeader
            title={`Run: ${detail.task}`}
            actions={
              <Button variant="tertiary" size="compact" onClick={() => setDetail(null)}>
                Close
              </Button>
            }
          />
          <RunDetailView detail={detail} />
        </Card>
      ) : null}
    </div>
  );
}
