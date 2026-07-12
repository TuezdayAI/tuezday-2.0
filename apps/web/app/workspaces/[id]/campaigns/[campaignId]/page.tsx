"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import type {
  Audience,
  CampaignInsights,
  CampaignPlanIssue,
  CampaignPlanWorkspace,
  Connection,
  CreateCampaignPlanRevisionInput,
  Persona,
  UpsertCampaignLaneRevisionInput,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";
import { campaignStatus, campaignTab } from "@/lib/campaign-control-plane";
import { EmptyState } from "@/src/components/empty-state";
import { TopBarActions } from "@/src/components/top-bar";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import {
  CampaignOverview,
  type CampaignDetailView,
} from "./_components/campaign-overview";
import { CampaignPlanHistory } from "./_components/campaign-plan-history";
import { CampaignChannels } from "./_components/campaign-channels";
import styles from "./campaign-workspace.module.css";

interface ConnectorResponse {
  connections: Connection[];
}

const tabs = [
  ["overview", "Overview"],
  ["plan", "Plan history"],
  ["channels", "Channels"],
] as const;

export default function CampaignWorkspacePage() {
  const { id, campaignId } = useParams<{ id: string; campaignId: string }>();
  const searchParams = useSearchParams();
  const activeTab = campaignTab(searchParams.get("tab"));
  const [detail, setDetail] = useState<CampaignDetailView | null>(null);
  const [planWorkspace, setPlanWorkspace] = useState<CampaignPlanWorkspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [insights, setInsights] = useState<CampaignInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [activationIssues, setActivationIssues] = useState<CampaignPlanIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connectionWarning, setConnectionWarning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [campaignRes, planRes, personaRes, audienceRes, connectorRes, insightRes] =
        await Promise.all([
          apiFetch(`/workspaces/${id}/campaigns/${campaignId}`),
          apiFetch(`/workspaces/${id}/campaigns/${campaignId}/plan/workspace`),
          apiFetch(`/workspaces/${id}/personas`),
          apiFetch(`/workspaces/${id}/audiences`),
          apiFetch(`/workspaces/${id}/connectors`).catch(() => null),
          apiFetch(`/workspaces/${id}/campaigns/${campaignId}/insights`).catch(() => null),
        ]);
      if (!campaignRes.ok) throw new Error("Campaign not found in this workspace.");
      if (!planRes.ok) throw new Error("Campaign planning data is unavailable.");
      if (!personaRes.ok || !audienceRes.ok) throw new Error("Campaign context is unavailable.");

      setDetail((await campaignRes.json()) as CampaignDetailView);
      setPlanWorkspace((await planRes.json()) as CampaignPlanWorkspace);
      setPersonas((await personaRes.json()) as Persona[]);
      setAudiences((await audienceRes.json()) as Audience[]);
      if (connectorRes?.ok) {
        const connectorBody = (await connectorRes.json()) as ConnectorResponse;
        setConnections(connectorBody.connections);
        setConnectionWarning(false);
      } else {
        setConnections([]);
        setConnectionWarning(true);
      }
      setInsights(insightRes?.ok ? ((await insightRes.json()) as CampaignInsights) : null);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `Could not load this campaign from ${API_URL}.`,
      );
    } finally {
      setLoading(false);
    }
  }, [campaignId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function initializePlan() {
    setInitializing(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/workspaces/${id}/campaigns/${campaignId}/plan/backfill`,
        { method: "POST" },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.message ?? "Could not initialize the campaign plan.");
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not initialize the campaign plan.");
    } finally {
      setInitializing(false);
    }
  }

  async function createRevision(input: CreateCampaignPlanRevisionInput) {
    setMutationBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/workspaces/${id}/campaigns/${campaignId}/plan/revisions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.message ?? "Could not create the plan revision.");
      }
      setActivationIssues([]);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not create the plan revision.";
      setError(message);
      throw cause;
    } finally {
      setMutationBusy(false);
    }
  }

  async function activateRevision(revisionId: string) {
    setMutationBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/workspaces/${id}/campaigns/${campaignId}/plan/revisions/${revisionId}/activate`,
        { method: "POST" },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setActivationIssues(
          body?.issues ?? [
            {
              path: "plan",
              code: body?.error ?? "activation_failed",
              message: body?.message ?? "Could not activate the revision.",
            },
          ],
        );
        return;
      }
      setActivationIssues([]);
      await load();
    } catch {
      setActivationIssues([
        {
          path: "plan",
          code: "activation_failed",
          message: "Could not reach the API to activate this revision.",
        },
      ]);
    } finally {
      setMutationBusy(false);
    }
  }

  async function saveLane(
    planRevisionId: string,
    input: UpsertCampaignLaneRevisionInput,
  ) {
    setMutationBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/workspaces/${id}/campaigns/${campaignId}/plan/revisions/${planRevisionId}/lanes`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.message ?? "Could not save the channel configuration.");
      }
      setActivationIssues([]);
      await load();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not save the channel configuration.";
      setError(message);
      throw cause;
    } finally {
      setMutationBusy(false);
    }
  }

  if (loading && !detail) return <EmptyState description="Loading campaign control plane…" />;

  if (error && !detail) {
    return (
      <EmptyState
        icon={<Icon name="warning" size="lg" />}
        title="Campaign unavailable"
        description={error}
        primaryAction={
          <Button variant="primary" onClick={() => void load()}>Try again</Button>
        }
      />
    );
  }

  if (!detail || !planWorkspace) return null;
  const { campaign } = detail;
  const activePlan = planWorkspace.revisions.find(
    ({ plan }) => plan.id === planWorkspace.currentPlanRevisionId,
  );

  return (
    <>
      <TopBarActions>
        <Link className={styles.reviewAction} href={`/workspaces/${id}/approvals?campaign=${campaignId}`}>
          <Icon name="review" size="sm" /> Open Review
        </Link>
      </TopBarActions>

      <header className={styles.campaignHeader}>
        <Link className={styles.breadcrumb} href={`/workspaces/${id}/campaigns`}>
          <Icon name="chevron-right" size="sm" /> Campaigns
        </Link>
        <div className={styles.headerMain}>
          <div>
            <div className={styles.headerMeta}>
              <WorkflowStatusBadge status={campaignStatus(campaign.status)} />
              <span>{campaign.purpose}</span>
              <span>{campaign.timeframe || "No timeframe"}</span>
              <span>{activePlan ? `Plan v${activePlan.plan.revision}` : "Plan not initialized"}</span>
            </div>
            <h1>{campaign.name}</h1>
            <p>{campaign.objective || "Define the campaign objective to focus the operating plan."}</p>
          </div>
          <div className={styles.issueCounter} data-has-issues={planWorkspace.issues.length > 0 ? "true" : undefined}>
            <strong>{planWorkspace.issues.length}</strong>
            <span>Setup issues</span>
          </div>
        </div>
      </header>

      <nav className={styles.tabs} aria-label="Campaign workspace">
        {tabs.map(([value, label]) => (
          <Link
            key={value}
            href={`?tab=${value}`}
            aria-current={activeTab === value ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>

      {connectionWarning && (
        <div className={styles.inlineWarning} role="status">
          <Icon name="warning" size="sm" />
          <span>Publishing connections could not be loaded. Campaign context remains available.</span>
          <Link href={`/workspaces/${id}/connectors`}>Open Integrations</Link>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      {planWorkspace.revisions.length === 0 && (
        <section className={styles.initializePanel}>
          <div>
            <p className={styles.panelKicker}>Campaign plan required</p>
            <h2>Turn the existing campaign into an inspectable operating plan</h2>
            <p>
              Tuezday will preserve the current objective, KPI, timeframe, audience, pillars, and
              cadence mappings while creating immutable revision 1.
            </p>
          </div>
          <Button variant="primary" onClick={() => void initializePlan()} disabled={initializing}>
            {initializing ? "Initializing…" : "Initialize campaign plan"}
          </Button>
        </section>
      )}

      {activeTab === "overview" && (
        <CampaignOverview
          workspaceId={id}
          detail={detail}
          planWorkspace={planWorkspace}
          insights={insights}
        />
      )}

      {activeTab === "plan" && (
        <CampaignPlanHistory
          revisions={planWorkspace.revisions}
          currentPlanRevisionId={planWorkspace.currentPlanRevisionId}
          audiences={audiences}
          busy={mutationBusy}
          activationIssues={activationIssues}
          onCreateRevision={createRevision}
          onActivate={activateRevision}
        />
      )}

      {activeTab === "channels" && (
        <CampaignChannels
          workspaceId={id}
          revisions={planWorkspace.revisions}
          currentPlanRevisionId={planWorkspace.currentPlanRevisionId}
          campaignChannels={campaign.channels}
          personas={personas}
          audiences={audiences}
          connections={connections}
          busy={mutationBusy}
          onSaveLane={saveLane}
        />
      )}
    </>
  );
}
