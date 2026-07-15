import Link from "next/link";
import type { AutomationMode, Campaign } from "@tuezday/contracts";
import { campaignStatus } from "@/lib/campaign-control-plane";
import { Badge, WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { Input, Select } from "@/src/components/ui/input";
import styles from "../campaigns.module.css";

export interface CampaignControlPlaneSummary {
  planRevision: number | null;
  laneCount: number;
  configurationIssueCount: number;
}

const AUTOMATION_LABELS: Record<AutomationMode, string> = {
  manual: "Manual",
  human_in_the_loop: "Human-in-the-loop",
  scheduled_auto: "Scheduled-auto",
};

interface CampaignCardProps {
  workspaceId: string;
  campaign: Campaign;
  summary: CampaignControlPlaneSummary;
  busy: boolean;
  onEdit(campaign: Campaign): void;
  onSetStatus(campaign: Campaign, status: "active" | "archived"): Promise<void>;
  onAutomation(
    campaign: Campaign,
    automationMode: AutomationMode,
    autoDailyCap: number | null,
  ): Promise<void>;
  onExport(campaign: Campaign): void;
}

export function CampaignCard({
  workspaceId,
  campaign,
  summary,
  busy,
  onEdit,
  onSetStatus,
  onAutomation,
  onExport,
}: CampaignCardProps) {
  const campaignHref = `/workspaces/${workspaceId}/campaigns/${campaign.id}`;

  return (
    <article className={styles.campaignCard}>
      <div className={styles.cardTopline}>
        <WorkflowStatusBadge status={campaignStatus(campaign.status)} />
        <span className={styles.timeframe}>{campaign.timeframe || "No timeframe"}</span>
      </div>

      <div className={styles.cardHeading}>
        <div>
          <p className={styles.eyebrow}>{campaign.purpose}</p>
          <h2>
            <Link href={campaignHref}>{campaign.name}</Link>
          </h2>
        </div>
        <span className={styles.origin}>{campaign.origin === "system" ? "System" : "User"}</span>
      </div>

      <p className={styles.objective}>{campaign.objective || "Define the campaign objective."}</p>

      <dl className={styles.metrics}>
        <div>
          <dt>Plan</dt>
          <dd>{summary.planRevision ? `v${summary.planRevision}` : "Not initialized"}</dd>
        </div>
        <div>
          <dt>Channels</dt>
          <dd>{summary.laneCount}</dd>
        </div>
        <div data-needs-setup={summary.configurationIssueCount > 0 ? "true" : undefined}>
          <dt>Needs setup</dt>
          <dd>{summary.configurationIssueCount}</dd>
        </div>
      </dl>

      <div className={styles.channelRow} aria-label="Campaign channels">
        {campaign.channels.length > 0 ? (
          campaign.channels.map((channel) => <Badge key={channel}>{channel}</Badge>)
        ) : (
          <span className={styles.muted}>No channels selected</span>
        )}
      </div>

      <div className={styles.automationRow}>
        <label>
          <span>Automation</span>
          <Select
            value={campaign.automationMode}
            disabled={busy}
            onChange={(event) =>
              void onAutomation(
                campaign,
                event.target.value as AutomationMode,
                campaign.autoDailyCap,
              )
            }
          >
            {(Object.keys(AUTOMATION_LABELS) as AutomationMode[]).map((mode) => (
              <option key={mode} value={mode}>{AUTOMATION_LABELS[mode]}</option>
            ))}
          </Select>
        </label>
        {campaign.automationMode === "scheduled_auto" && (
          <label>
            <span>Daily cap</span>
            <Input
              type="number"
              min={1}
              max={1000}
              defaultValue={campaign.autoDailyCap ?? ""}
              placeholder="Default"
              disabled={busy}
              onBlur={(event) => {
                const value = event.target.value.trim();
                const cap = value === "" ? null : Math.max(1, Math.min(1000, Number(value)));
                if (cap !== campaign.autoDailyCap) {
                  void onAutomation(campaign, campaign.automationMode, cap);
                }
              }}
            />
          </label>
        )}
      </div>

      <div className={styles.cardFooter}>
        <Link className={styles.openCampaign} href={campaignHref}>
          Open campaign <Icon name="chevron-right" size="sm" />
        </Link>
        <div className={styles.cardActions}>
          <Button variant="tertiary" size="compact" onClick={() => onExport(campaign)}>Export</Button>
          <Button variant="tertiary" size="compact" onClick={() => onEdit(campaign)}>Edit</Button>
          <Button
            variant={campaign.status === "archived" ? "tertiary" : "danger"}
            size="compact"
            disabled={busy}
            onClick={() =>
              void onSetStatus(campaign, campaign.status === "archived" ? "active" : "archived")
            }
          >
            {busy ? "Updating…" : campaign.status === "archived" ? "Unarchive" : "Archive"}
          </Button>
        </div>
      </div>
    </article>
  );
}
