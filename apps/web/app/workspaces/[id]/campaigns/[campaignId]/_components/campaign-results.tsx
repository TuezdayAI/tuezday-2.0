"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ExecutionResult } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import {
  EXECUTION_KIND_LABELS,
  destinationSummary,
  executionAuthorizationLink,
  executionTargetHref,
  executionWorkflowStatus,
} from "@/lib/execution-results";
import { EmptyState } from "@/src/components/empty-state";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import styles from "../campaign-workspace.module.css";

interface CampaignResultsProps {
  workspaceId: string;
  campaignId: string;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function CampaignResults({ workspaceId, campaignId }: CampaignResultsProps) {
  const [results, setResults] = useState<ExecutionResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/executions?campaign=${campaignId}`);
      if (!res.ok) throw new Error();
      setResults((await res.json()) as ExecutionResult[]);
      setError(null);
    } catch {
      setError("Execution results could not be loaded.");
    }
  }, [workspaceId, campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function retryPublication(publicationId: string) {
    setBusyId(publicationId);
    try {
      await apiFetch(`/workspaces/${workspaceId}/publications/${publicationId}/retry`, {
        method: "POST",
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return <p className="error" role="alert">{error}</p>;
  }
  if (results === null) {
    return <p className={styles.quietState}>Loading execution results…</p>;
  }
  if (results.length === 0) {
    return (
      <EmptyState
        title="Nothing has executed yet"
        description="Once this campaign publishes posts, dispatches targeted sends, or launches ads, every outcome lands here — including what failed and how to recover."
      />
    );
  }

  return (
    <section className={styles.panel} aria-label="Execution results">
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.panelKicker}>Execution results</p>
          <h2>What Tuezday executed for this campaign</h2>
        </div>
      </div>
      <ul className={styles.resultsList}>
        {results.map((result) => {
          const actionLink = executionAuthorizationLink(workspaceId, result);
          return (
          <li key={`${result.kind}:${result.id}`} className={styles.resultRow}>
            <div className={styles.resultMain}>
              <div className={styles.resultMeta}>
                <WorkflowStatusBadge status={executionWorkflowStatus(result)} />
                <span>{EXECUTION_KIND_LABELS[result.kind]}</span>
                {result.channel && <span>{result.channel}</span>}
                <span>{timeFormat.format(new Date(result.at))}</span>
                {result.platformStatus && <span>Platform: {result.platformStatus}</span>}
              </div>
              <p className={styles.resultTitle}>{result.title}</p>
              {destinationSummary(result) && (
                <p className={styles.resultDestinations}>{destinationSummary(result)}</p>
              )}
              {result.error && <p className={styles.resultError}>{result.error}</p>}
            </div>
            <div className={styles.resultActions}>
              {result.kind === "publication" && result.status === "failed" && (
                <Button
                  size="sm"
                  onClick={() => void retryPublication(result.id)}
                  disabled={busyId === result.id}
                >
                  Retry now
                </Button>
              )}
              {result.url && (
                <a href={result.url} target="_blank" rel="noreferrer" className={styles.panelLink}>
                  View post
                </a>
              )}
              <Link href={executionTargetHref(workspaceId, result)} className={styles.panelLink}>
                Open {EXECUTION_KIND_LABELS[result.kind].toLowerCase()}
              </Link>
              {actionLink && (
                <Link href={actionLink.href} className={styles.panelLink}>
                  {actionLink.label}
                </Link>
              )}
            </div>
          </li>
          );
        })}
      </ul>
    </section>
  );
}
