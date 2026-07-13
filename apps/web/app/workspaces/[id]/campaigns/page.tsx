"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { AutomationMode, Campaign, Persona, Workspace } from "@tuezday/contracts";
import { API_URL, apiDownload, apiFetch } from "@/lib/api";
import {
  campaignMutationResult,
  orderCampaignInventory,
} from "@/lib/campaign-control-plane";
import { EmptyState } from "@/src/components/empty-state";
import { TopBarActions } from "@/src/components/top-bar";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { SettingsModal } from "@/src/components/ui/settings-modal";
import { toast } from "@/src/components/ui/toast";
import { AutomationGuardrails } from "../automation/guardrails";
import { CadenceManager } from "../cadence/cadence-manager";
import {
  CampaignCard,
  type CampaignControlPlaneSummary,
} from "./_components/campaign-card";
import { CampaignForm } from "./_components/campaign-form";
import styles from "./campaigns.module.css";

type CampaignFilter = "all" | "active" | "archived";

const EMPTY_SUMMARY: CampaignControlPlaneSummary = {
  planRevision: null,
  laneCount: 0,
  configurationIssueCount: 0,
};

export default function CampaignsPage() {
  const { id } = useParams<{ id: string }>();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([]);
  const [summaries, setSummaries] = useState<Record<string, CampaignControlPlaneSummary>>({});
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CampaignFilter>("all");
  const [editing, setEditing] = useState<Campaign | "new" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("automation");
  const [pendingCampaignIds, setPendingCampaignIds] = useState<Set<string>>(() => new Set());
  const pendingCampaignIdsRef = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const [workspaceResponse, personaResponse, campaignsResponse] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/campaigns`),
      ]);
      if (!workspaceResponse.ok || !personaResponse.ok || !campaignsResponse.ok) {
        throw new Error("not found");
      }
      const campaigns = (await campaignsResponse.json()) as Campaign[];
      const summaryEntries = await Promise.all(
        campaigns.map(async (campaign) => {
          const response = await apiFetch(
            `/workspaces/${id}/campaigns/${campaign.id}/plan/summary`,
          ).catch(() => null);
          if (!response?.ok) return [campaign.id, EMPTY_SUMMARY] as const;
          return [campaign.id, (await response.json()) as CampaignControlPlaneSummary] as const;
        }),
      );
      setWorkspace(await workspaceResponse.json());
      setPersonas(await personaResponse.json());
      setCampaignsList(campaigns);
      setSummaries(Object.fromEntries(summaryEntries));
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleCampaigns = useMemo(() => {
    const filtered = filter === "all"
      ? campaignsList
      : campaignsList.filter((campaign) => campaign.status === filter);
    return orderCampaignInventory(filtered);
  }, [campaignsList, filter]);

  function beginCampaignMutation(campaignId: string): boolean {
    if (pendingCampaignIdsRef.current.has(campaignId)) return false;
    pendingCampaignIdsRef.current.add(campaignId);
    setPendingCampaignIds(new Set(pendingCampaignIdsRef.current));
    return true;
  }

  function endCampaignMutation(campaignId: string) {
    pendingCampaignIdsRef.current.delete(campaignId);
    setPendingCampaignIds(new Set(pendingCampaignIdsRef.current));
  }

  async function setStatus(campaign: Campaign, status: "active" | "archived") {
    if (!beginCampaignMutation(campaign.id)) return;
    setError(null);
    try {
      const result = await campaignMutationResult(
        () => apiFetch(`/workspaces/${id}/campaigns/${campaign.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: campaign.name,
            purpose: campaign.purpose,
            objective: campaign.objective,
            kpi: campaign.kpi,
            timeframe: campaign.timeframe,
            audience: campaign.audience,
            pillars: campaign.pillars,
            channels: campaign.channels,
            personaIds: campaign.personaIds,
            overlay: campaign.overlay,
            status,
            automationMode: campaign.automationMode,
            autoDailyCap: campaign.autoDailyCap,
          }),
        }),
        "Could not update the campaign status.",
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await load();
    } finally {
      endCampaignMutation(campaign.id);
    }
  }

  async function saveAutomation(
    campaign: Campaign,
    automationMode: AutomationMode,
    autoDailyCap: number | null,
  ) {
    if (!beginCampaignMutation(campaign.id)) return;
    setError(null);
    try {
      const result = await campaignMutationResult(
        () => apiFetch(`/workspaces/${id}/campaigns/${campaign.id}/automation`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ automationMode, autoDailyCap }),
        }),
        "Could not update campaign automation.",
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await load();
    } finally {
      endCampaignMutation(campaign.id);
    }
  }

  if (error && !workspace) {
    return (
      <div className={styles.loadError}>
        <p className="error">{error}</p>
        <Link href="/">Back to workspaces</Link>
      </div>
    );
  }

  if (!workspace) return <EmptyState description="Loading campaigns…" />;

  return (
    <>
      <TopBarActions>
        <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
          <Icon name="add" size="sm" /> New campaign
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
          <Icon name="module-settings" size="sm" /> Settings
        </Button>
      </TopBarActions>

      <header className={styles.pageHeader}>
        <div>
          <p className={styles.kicker}>Operate / Campaigns</p>
          <h1>Campaign control room</h1>
          <p>
            Plan the objective, coordinate channels, review work, and follow outcomes from one
            durable operating context.
          </p>
        </div>
        <div className={styles.headerStats} aria-label="Campaign summary">
          <div><strong>{campaignsList.filter((campaign) => campaign.status === "active").length}</strong><span>Active</span></div>
          <div><strong>{Object.values(summaries).reduce((total, summary) => total + summary.configurationIssueCount, 0)}</strong><span>Need setup</span></div>
        </div>
      </header>

      {editing && (
        <CampaignForm
          key={editing === "new" ? "new" : editing.id}
          workspaceId={id}
          campaign={editing === "new" ? undefined : editing}
          personas={personas}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      <div className={styles.toolbar}>
        <div className={styles.filters} aria-label="Filter campaigns">
          {(["all", "active", "archived"] as CampaignFilter[]).map((value) => (
            <Button
              key={value}
              variant={filter === value ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value[0]!.toUpperCase() + value.slice(1)}
            </Button>
          ))}
        </div>
        <span>{visibleCampaigns.length} campaign{visibleCampaigns.length === 1 ? "" : "s"}</span>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {campaignsList.length === 0 && !editing ? (
        <EmptyState
          icon={<Icon name="campaigns" size="lg" />}
          title="No campaigns yet"
          description="Create a campaign to connect an objective, audiences, work, channels, review, and results."
          primaryAction={
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Icon name="add" size="sm" /> New campaign
            </Button>
          }
        />
      ) : visibleCampaigns.length === 0 ? (
        <EmptyState title={`No ${filter} campaigns`} description="Choose another filter to see your campaigns." />
      ) : (
        <section className={styles.campaignGrid} aria-label="Campaign inventory">
          {visibleCampaigns.map((campaign) => (
            <CampaignCard
              key={campaign.id}
              workspaceId={id}
              campaign={campaign}
              summary={summaries[campaign.id] ?? EMPTY_SUMMARY}
              busy={pendingCampaignIds.has(campaign.id)}
              onEdit={setEditing}
              onSetStatus={setStatus}
              onAutomation={saveAutomation}
              onExport={(selected) =>
                apiDownload(
                  `/workspaces/${id}/campaigns/${selected.id}/insights?format=csv`,
                  `campaign-insights-${selected.id}.csv`,
                )
              }
            />
          ))}
        </section>
      )}

      <SettingsModal
        title="Campaign settings"
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSave={() => {
          setSettingsOpen(false);
          toast("Settings saved");
        }}
        sections={[
          { id: "automation", label: "Automation guardrails" },
          { id: "cadence", label: "Posting cadence" },
        ]}
        activeSection={settingsSection}
        onSectionChange={setSettingsSection}
      >
        {settingsSection === "automation" ? (
          <>
            <p className={styles.settingsHint}>
              Limits for campaigns in an automated mode. Changes apply immediately.
            </p>
            <AutomationGuardrails workspaceId={id} />
          </>
        ) : (
          <>
            <p className={styles.settingsHint}>
              Recurring posting slots that approved drafts fill automatically.
            </p>
            <CadenceManager workspaceId={id} />
          </>
        )}
      </SettingsModal>
    </>
  );
}
