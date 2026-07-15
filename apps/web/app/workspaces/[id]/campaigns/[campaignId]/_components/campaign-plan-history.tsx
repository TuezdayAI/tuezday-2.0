"use client";

import { useState } from "react";
import type {
  Audience,
  CampaignPlanDetail,
  CampaignPlanIssue,
  CreateCampaignPlanRevisionInput,
} from "@tuezday/contracts";
import { planStatus } from "@/lib/campaign-control-plane";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { CampaignPlanForm } from "./campaign-plan-form";
import styles from "../campaign-workspace.module.css";

interface CampaignPlanHistoryProps {
  revisions: CampaignPlanDetail[];
  currentPlanRevisionId: string | null;
  audiences: Audience[];
  busy: boolean;
  activationIssues: CampaignPlanIssue[];
  onCreateRevision(input: CreateCampaignPlanRevisionInput): Promise<void>;
  onActivate(revisionId: string): Promise<void>;
}

function timestamp(value: number | null): string {
  return value ? new Date(value).toLocaleString() : "Not activated";
}

export function CampaignPlanHistory({
  revisions,
  currentPlanRevisionId,
  audiences,
  busy,
  activationIssues,
  onCreateRevision,
  onActivate,
}: CampaignPlanHistoryProps) {
  const [showForm, setShowForm] = useState(false);
  const current = revisions.find(({ plan }) => plan.id === currentPlanRevisionId) ?? null;
  const draft = revisions.find(({ plan }) => plan.status === "draft") ?? null;
  const audienceNames = new Map(audiences.map((audience) => [audience.id, audience.name]));

  return (
    <section className={styles.planHistory}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.panelKicker}>Plan history</p>
          <h2>Immutable campaign strategy</h2>
          <p>Published work remains attached to the plan that produced it. Changes begin as a new draft.</p>
        </div>
        {!showForm && (
          <Button
            variant="primary"
            onClick={() => setShowForm(true)}
            disabled={Boolean(draft)}
            title={draft ? "Activate or resolve the existing draft first." : undefined}
          >
            <Icon name="add" size="sm" /> New revision
          </Button>
        )}
      </div>

      {showForm && (
        <div className={styles.editorPanel}>
          <div className={styles.editorHeading}>
            <div><p className={styles.panelKicker}>Draft revision</p><h3>Refine the operating plan</h3></div>
            <span>Channel configuration is copied from the active revision.</span>
          </div>
          <CampaignPlanForm
            initial={current?.plan ?? null}
            audiences={audiences}
            busy={busy}
            onCancel={() => setShowForm(false)}
            onSubmit={async (input) => {
              await onCreateRevision(input);
              setShowForm(false);
            }}
          />
        </div>
      )}

      {activationIssues.length > 0 && (
        <div className={styles.activationIssues} role="alert">
          <div><Icon name="warning" size="sm" /><strong>This revision cannot be activated yet.</strong></div>
          <ul>
            {activationIssues.map((issue) => <li key={`${issue.path}-${issue.code}`}>{issue.message}</li>)}
          </ul>
        </div>
      )}

      <div className={styles.revisionTimeline}>
        {revisions.map(({ plan, lanes }) => (
          <article key={plan.id} className={styles.revisionCard} data-current={plan.id === currentPlanRevisionId ? "true" : undefined}>
            <div className={styles.revisionRail}><span>{plan.revision}</span></div>
            <div className={styles.revisionBody}>
              <div className={styles.revisionHeader}>
                <div>
                  <div className={styles.revisionMeta}>
                    <WorkflowStatusBadge status={planStatus(plan.status)} />
                    <span>Revision {plan.revision}</span>
                    <span>Created {new Date(plan.createdAt).toLocaleString()}</span>
                  </div>
                  <h3>{plan.objective || "Untitled campaign objective"}</h3>
                </div>
                {plan.status === "draft" && (
                  <Button variant="primary" size="compact" disabled={busy} onClick={() => void onActivate(plan.id)}>
                    {busy ? "Activating…" : "Activate revision"}
                  </Button>
                )}
              </div>
              <dl className={styles.revisionFacts}>
                <div><dt>KPI</dt><dd>{plan.kpi || "Not configured"}</dd></div>
                <div><dt>Window</dt><dd>{plan.timeframe || "Not configured"}</dd></div>
                <div><dt>Channels</dt><dd>{lanes.length}</dd></div>
                <div><dt>Activated</dt><dd>{timestamp(plan.activatedAt)}</dd></div>
              </dl>
              <div className={styles.revisionDetails}>
                <p><strong>Audiences</strong> {plan.audienceIds.map((id) => audienceNames.get(id) ?? "Unavailable audience").join(" · ") || "Not configured"}</p>
                <p><strong>Pillars</strong> {plan.pillars.join(" · ") || "Not configured"}</p>
                <p><strong>Offers / CTAs</strong> {[...plan.offers, ...plan.ctas].join(" · ") || "Not configured"}</p>
                {plan.guidance && <p><strong>Guidance</strong> {plan.guidance}</p>}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
