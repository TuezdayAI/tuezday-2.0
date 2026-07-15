import Link from "next/link";
import type {
  ApprovalState,
  Campaign,
  CampaignInsights,
  CampaignPlanWorkspace,
} from "@tuezday/contracts";
import { calendarHref } from "@/lib/calendar-workspace";
import { formatLaneSchedule, laneStatus } from "@/lib/campaign-control-plane";
import { Badge, WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { CampaignActionPolicy } from "./campaign-action-policy";
import styles from "../campaign-workspace.module.css";

interface AdTotals {
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface CampaignDetailView {
  campaign: Campaign;
  draftCounts: Record<ApprovalState, number>;
  drafts: Array<{
    id: string;
    state: ApprovalState;
    taskType: string;
    channel: string;
    createdAt: number;
  }>;
  adMetrics: {
    totals: AdTotals;
    adCampaigns: Array<{
      id: string;
      name: string;
      accountName: string;
      currency: string;
      totals: AdTotals;
    }>;
  } | null;
  audiences: Array<{
    id: string;
    name: string;
    kind: "static" | "dynamic";
    memberCount: number;
  }>;
}

interface CampaignOverviewProps {
  workspaceId: string;
  detail: CampaignDetailView;
  planWorkspace: CampaignPlanWorkspace;
  insights: CampaignInsights | null;
}

function money(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function CampaignOverview({
  workspaceId,
  detail,
  planWorkspace,
  insights,
}: CampaignOverviewProps) {
  const { campaign } = detail;
  const activePlan =
    planWorkspace.revisions.find(({ plan }) => plan.id === planWorkspace.currentPlanRevisionId) ??
    null;
  const reviewCount = detail.draftCounts.pending_review;
  const attentionCount = planWorkspace.issues.length + reviewCount + (activePlan ? 0 : 1);

  return (
    <div className={styles.overviewGrid}>
      <section className={`${styles.panel} ${styles.attentionPanel}`}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>Needs attention</p>
            <h2>{attentionCount === 0 ? "Campaign is operational" : `${attentionCount} items need direction`}</h2>
          </div>
          <WorkflowStatusBadge status={attentionCount > 0 ? "review_required" : "active"} />
        </div>
        <div className={styles.attentionList}>
          {!activePlan && (
            <div><Icon name="warning" size="compact" /><span><strong>Campaign plan is not initialized.</strong> Preserve the current campaign fields and create revision 1.</span></div>
          )}
          {planWorkspace.issues.map((issue) => (
            <div key={`${issue.path}-${issue.code}`}>
              <Icon name="warning" size="compact" />
              <span><strong>Channel setup required.</strong> {issue.message}</span>
            </div>
          ))}
          {reviewCount > 0 && (
            <div>
              <Icon name="status-review" size="compact" />
              <span><strong>{reviewCount} item{reviewCount === 1 ? "" : "s"} awaiting review.</strong> Decide what is ready before scheduling.</span>
            </div>
          )}
          {attentionCount === 0 && (
            <p className={styles.quietState}>No plan, channel, or content-review blockers are visible.</p>
          )}
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><p className={styles.panelKicker}>Plan snapshot</p><h2>{activePlan ? `Revision ${activePlan.plan.revision}` : "Not initialized"}</h2></div>
          {activePlan && <WorkflowStatusBadge status="active" />}
        </div>
        {activePlan ? (
          <dl className={styles.detailList}>
            <div><dt>Objective</dt><dd>{activePlan.plan.objective || "Not configured"}</dd></div>
            <div><dt>KPI</dt><dd>{activePlan.plan.kpi || "Not configured"}</dd></div>
            <div><dt>Timeframe</dt><dd>{activePlan.plan.timeframe || "Not configured"}</dd></div>
            <div><dt>Audiences</dt><dd>{activePlan.plan.audienceIds.length || "Not configured"}</dd></div>
            <div><dt>Pillars</dt><dd>{activePlan.plan.pillars.join(" · ") || "Not configured"}</dd></div>
            <div><dt>Offers / CTAs</dt><dd>{[...activePlan.plan.offers, ...activePlan.plan.ctas].join(" · ") || "Not configured"}</dd></div>
          </dl>
        ) : (
          <p className={styles.quietState}>Initialize the plan to make strategy, versions, and channel commitments inspectable.</p>
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><p className={styles.panelKicker}>Channels</p><h2>{activePlan?.lanes.length ?? 0} configured</h2></div>
          <Link href={`?tab=channels`} className={styles.panelLink}>Manage channels <Icon name="chevron-right" size="compact" /></Link>
        </div>
        {activePlan?.lanes.length ? (
          <div className={styles.laneList}>
            {activePlan.lanes.map((lane) => (
              <div key={lane.id}>
                <div><strong>{lane.name}</strong><span>{lane.channel} · {lane.format}</span></div>
                <div><WorkflowStatusBadge status={laneStatus(lane.status)} /><span>{formatLaneSchedule(lane)}</span></div>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.quietState}>No active channel commitments are configured.</p>
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><p className={styles.panelKicker}>Work and results</p><h2>Campaign activity</h2></div>
        </div>
        <div className={styles.resultMetrics}>
          <div><span>Drafts</span><strong>{Object.values(detail.draftCounts).reduce((sum, count) => sum + count, 0)}</strong></div>
          <div><span>Approved</span><strong>{detail.draftCounts.approved}</strong></div>
          <div><span>Published</span><strong>{insights?.organic.publishedCount ?? 0}</strong></div>
          <div><span>Outbound sent</span><strong>{insights?.outbound.sentCount ?? 0}</strong></div>
        </div>
        {detail.adMetrics && (
          <p className={styles.performanceLine}>
            <Badge>Paid</Badge>
            {money(detail.adMetrics.totals.spendCents, detail.adMetrics.adCampaigns[0]?.currency)} spend · {detail.adMetrics.totals.impressions.toLocaleString()} impressions · {detail.adMetrics.totals.conversions} conversions
          </p>
        )}
        <nav className={styles.contextLinks} aria-label="Campaign work surfaces">
          <Link href={`/workspaces/${workspaceId}/review?tab=approvals&campaign=${campaign.id}`}>Review</Link>
          <Link href={calendarHref(workspaceId, { campaign: campaign.id })}>Calendar</Link>
          <Link href={`/workspaces/${workspaceId}/ads?campaign=${campaign.id}`}>Ads</Link>
          <Link href={`/workspaces/${workspaceId}/insights?campaign=${campaign.id}`}>Insights</Link>
        </nav>
      </section>

      <CampaignActionPolicy workspaceId={workspaceId} campaignId={campaign.id} />
    </div>
  );
}
