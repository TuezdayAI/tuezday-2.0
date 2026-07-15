"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  APPROVAL_STATES,
  CHANNELS,
  canTransition,
  type ApprovalState,
  type Campaign,
  type Channel,
  type Draft,
  type Persona,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";
import {
  draftChannels,
  draftWorkflowStatus,
  filterDrafts,
  queueNeighbors,
  reviewHref,
} from "@/lib/review-workspace";
import { previewKindFor } from "@/lib/preview-kind";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { CountBadge } from "@/src/components/ui/badge";
import { Tabs } from "@/src/components/ui/tabs";
import { PreviewCard } from "@/src/components/ui/preview-card";
import { Icon } from "@/src/components/ui/icon";
import type { BrandName } from "@/src/components/ui/brand-icons";
import { toast } from "@/src/components/ui/toast";
import { ConversationalEditor } from "./conversational-editor";
import styles from "./approvals-queue.module.css";

type Filter = ApprovalState | "all";

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  edited: "Edited",
  approved: "Approved",
  rejected: "Rejected",
};

const SOCIAL_PLATFORM: Partial<Record<Channel, BrandName>> = {
  linkedin: "linkedin",
  x: "x",
  instagram: "instagram",
};

interface DraftGroup {
  key: string;
  kind: "campaign" | "day";
  title: string;
  range: string;
  drafts: Draft[];
}

function parseState(value: string | null): Filter {
  return value === "all" || (APPROVAL_STATES as readonly string[]).includes(value ?? "")
    ? (value as Filter)
    : "pending_review";
}

function parseChannel(value: string | null): Channel | "all" {
  return value === "all" || (CHANNELS as readonly string[]).includes(value ?? "")
    ? (value as Channel | "all")
    : "all";
}

function fmtDay(value: number) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(value: number) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function dayLabel(value: number) {
  const target = new Date(value).toDateString();
  if (target === new Date().toDateString()) return "Today";
  if (target === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  return fmtDay(value);
}

function buildGroups(visible: Draft[], campaigns: Campaign[]): DraftGroup[] {
  const buckets = new Map<string, Draft[]>();
  for (const draft of visible) {
    const key = draft.campaignId
      ? `campaign:${draft.campaignId}`
      : `day:${new Date(draft.createdAt).toDateString()}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(draft);
    else buckets.set(key, [draft]);
  }
  return [...buckets.entries()]
    .map(([key, drafts]) => {
      const kind: DraftGroup["kind"] = key.startsWith("campaign:") ? "campaign" : "day";
      const newest = Math.max(...drafts.map((draft) => draft.createdAt));
      const oldest = Math.min(...drafts.map((draft) => draft.createdAt));
      return {
        key,
        kind,
        title:
          kind === "campaign"
            ? campaigns.find((campaign) => campaign.id === drafts[0]!.campaignId)?.name ?? "Campaign"
            : dayLabel(drafts[0]!.createdAt),
        range: kind === "campaign" ? (fmtDay(oldest) === fmtDay(newest) ? fmtDay(newest) : `${fmtDay(oldest)} – ${fmtDay(newest)}`) : "",
        drafts,
      };
    })
    .sort(
      (left, right) =>
        Math.max(...right.drafts.map((draft) => draft.createdAt)) -
        Math.max(...left.drafts.map((draft) => draft.createdAt)),
    );
}

export function ApprovalsQueue({
  workspaceId,
  onPendingCount,
}: {
  workspaceId: string;
  onPendingCount?: (count: number) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = parseState(searchParams.get("state"));
  const campaignFilter = searchParams.get("campaign") ?? "all";
  const channelFilter = parseChannel(searchParams.get("channel"));
  const openDraftId = searchParams.get("draft");
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const focusNextRef = useRef<string | null>(null);

  const load = useCallback(async (): Promise<Draft[]> => {
    try {
      const [personaResponse, draftResponse, campaignResponse] = await Promise.all([
        apiFetch(`/workspaces/${workspaceId}/personas`),
        apiFetch(`/workspaces/${workspaceId}/drafts`),
        apiFetch(`/workspaces/${workspaceId}/campaigns`),
      ]);
      if (!personaResponse.ok || !draftResponse.ok || !campaignResponse.ok) {
        throw new Error("Workspace data was not found.");
      }
      const nextDrafts = (await draftResponse.json()) as Draft[];
      setPersonas(await personaResponse.json());
      setCampaigns(await campaignResponse.json());
      setDrafts(nextDrafts);
      onPendingCount?.(nextDrafts.filter((draft) => draft.state === "pending_review").length);
      setLoaded(true);
      setError(null);
      return nextDrafts;
    } catch (loadError) {
      setLoaded(true);
      setError(
        loadError instanceof Error
          ? loadError.message
          : `Could not load this workspace from ${API_URL}.`,
      );
      return [];
    }
  }, [workspaceId, onPendingCount]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const next = focusNextRef.current;
    if (!next) return;
    focusNextRef.current = null;
    requestAnimationFrame(() => {
      const button = document.getElementById(`approve-${next}`);
      if (button instanceof HTMLElement) {
        button.focus();
        button.scrollIntoView({ block: "nearest" });
      }
    });
  }, [drafts]);

  const scoped = filterDrafts(drafts, {
    state: "all",
    campaignId: campaignFilter,
    channel: channelFilter,
  });
  const visible = filter === "all" ? scoped : scoped.filter((draft) => draft.state === filter);
  const groups = buildGroups(visible, campaigns);
  const orderedVisibleIds = groups.flatMap((group) => group.drafts.map((draft) => draft.id));
  const orderedApprovableIds = groups.flatMap((group) =>
    group.drafts.filter((draft) => canTransition(draft.state, "approve")).map((draft) => draft.id),
  );
  const neighbors = openDraftId
    ? queueNeighbors(orderedVisibleIds, openDraftId)
    : { prev: null, next: null };
  const filters: Filter[] = ["pending_review", "edited", "approved", "rejected", "all"];
  const channels = draftChannels(drafts);
  const hasScopeFilter = campaignFilter !== "all" || channelFilter !== "all";

  function href(overrides: {
    state?: Filter;
    campaign?: string;
    channel?: Channel | "all";
    draft?: string | null;
  } = {}) {
    return reviewHref(workspaceId, {
      tab: "approvals",
      state: overrides.state ?? filter,
      campaign:
        (overrides.campaign ?? campaignFilter) === "all"
          ? undefined
          : overrides.campaign ?? campaignFilter,
      channel: overrides.channel ?? channelFilter,
      draft:
        overrides.draft === null
          ? undefined
          : overrides.draft === undefined
            ? openDraftId ?? undefined
            : overrides.draft,
    });
  }

  function navigateToDraft(draft: string | null) {
    router.push(href({ draft }), { scroll: false });
  }

  function changeFilter(overrides: {
    state?: Filter;
    campaign?: string;
    channel?: Channel | "all";
  }) {
    router.replace(href({ ...overrides, draft: null }), { scroll: false });
  }

  async function action(draft: Draft, name: "approve" | "reject") {
    setBusy(true);
    setError(null);
    if (name === "approve") {
      const index = orderedApprovableIds.indexOf(draft.id);
      focusNextRef.current = orderedApprovableIds[index + 1] ?? orderedApprovableIds[index - 1] ?? null;
    }
    try {
      const response = await apiFetch(`/workspaces/${workspaceId}/drafts/${draft.id}/${name}`, {
        method: "POST",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message ?? `Could not ${name} this draft.`);
      await load();
      toast(name === "approve" ? "Approved" : "Rejected");
    } catch (actionError) {
      focusNextRef.current = null;
      setError(actionError instanceof Error ? actionError.message : `Could not ${name} draft.`);
    } finally {
      setBusy(false);
    }
  }

  async function approveAll(group: DraftGroup) {
    const targets = group.drafts.filter((draft) => canTransition(draft.state, "approve"));
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    let approved = 0;
    let firstError: string | null = null;
    for (const draft of targets) {
      try {
        const response = await apiFetch(`/workspaces/${workspaceId}/drafts/${draft.id}/approve`, {
          method: "POST",
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.message ?? "Approval failed.");
        approved += 1;
      } catch (approveError) {
        firstError ??= approveError instanceof Error ? approveError.message : "Approval failed.";
      }
    }
    await load();
    setBusy(false);
    if (approved > 0) toast(`Approved ${approved} draft${approved === 1 ? "" : "s"}`);
    if (firstError) setError(firstError);
  }

  async function handleEditorChanged() {
    const nextDrafts = await load();
    const current = nextDrafts.find((draft) => draft.id === openDraftId);
    if (!current || (current.state !== "approved" && current.state !== "rejected")) return;
    const candidates = filterDrafts(nextDrafts, {
      state: "all",
      campaignId: campaignFilter,
      channel: channelFilter,
    }).filter((draft) => canTransition(draft.state, "approve") && draft.id !== current.id);
    const previousIndex = orderedVisibleIds.indexOf(current.id);
    const next = candidates.find((draft) => orderedVisibleIds.indexOf(draft.id) > previousIndex) ?? candidates[0];
    navigateToDraft(next?.id ?? null);
  }

  function personaName(draft: Draft) {
    return personas.find((persona) => persona.id === draft.personaId)?.name ?? "Organization voice";
  }

  function previewCopy(draft: Draft) {
    if (previewKindFor(draft.channel) === "social") {
      return { title: personaName(draft), body: draft.content };
    }
    const lines = draft.content.split("\n");
    const title = (lines[0] ?? "").replace(/^#+\s*/, "").trim() || draft.taskType;
    return { title, body: lines.slice(1).join("\n").trim() || draft.content };
  }

  if (!loaded) return <EmptyState description="Loading approvals…" />;
  if (error && drafts.length === 0) {
    return <EmptyState description={error} primaryAction={<Button onClick={() => void load()}>Try again</Button>} />;
  }

  if (openDraftId) {
    return (
      <ConversationalEditor
        workspaceId={workspaceId}
        draftId={openDraftId}
        previousId={neighbors.prev}
        nextId={neighbors.next}
        onNavigate={navigateToDraft}
        onClose={() => navigateToDraft(null)}
        onChanged={handleEditorChanged}
      />
    );
  }

  return (
    <>
      <Tabs
        tabs={filters.map((state) => ({
          key: state,
          label: `${state === "all" ? "All" : STATE_LABELS[state]} (${state === "all" ? scoped.length : scoped.filter((draft) => draft.state === state).length})`,
        }))}
        active={filter}
        onChange={(state) => changeFilter({ state: state as Filter })}
      />

      <div className={styles.filterRow}>
        <label className={styles.filterField}>
          <span>Campaign</span>
          <select value={campaignFilter} onChange={(event) => changeFilter({ campaign: event.target.value })}>
            <option value="all">All campaigns</option>
            {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
        </label>
        <label className={styles.filterField}>
          <span>Channel</span>
          <select value={channelFilter} onChange={(event) => changeFilter({ channel: event.target.value as Channel | "all" })}>
            <option value="all">All channels</option>
            {channels.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
          </select>
        </label>
        {hasScopeFilter && <Button variant="tertiary" size="compact" onClick={() => changeFilter({ campaign: "all", channel: "all" })}>Clear filters</Button>}
      </div>

      {error && <p className="error">{error}</p>}
      {visible.length === 0 ? (
        <EmptyState
          description={drafts.length === 0 ? "The queue is empty. Generate content and send it to Review." : hasScopeFilter ? "Nothing matches these filters." : "Nothing in this state."}
          primaryAction={hasScopeFilter ? <Button variant="secondary" size="compact" onClick={() => changeFilter({ campaign: "all", channel: "all" })}>Clear filters</Button> : undefined}
        />
      ) : (
        groups.map((group) => {
          const approvable = group.drafts.filter((draft) => canTransition(draft.state, "approve"));
          return (
            <section key={group.key} className={styles.group}>
              <header className={styles.groupHead}>
                <h2 className={styles.groupTitle}><Icon name={group.kind === "campaign" ? "campaigns" : "calendar"} size="compact" />{group.title}</h2>
                {group.range && <span className={styles.groupRange}>{group.range}</span>}
                <CountBadge count={group.drafts.length} label="drafts in this group" />
                {approvable.length > 0 && <Button variant="secondary" size="compact" className={styles.approveAll} disabled={busy} onClick={() => void approveAll(group)}><Icon name="approve" size="compact" /> Approve all ({approvable.length})</Button>}
              </header>
              <div className={styles.gallery}>
                {group.drafts.map((draft) => {
                  const preview = previewCopy(draft);
                  const editable = canTransition(draft.state, "approve");
                  return (
                    <PreviewCard
                      key={draft.id}
                      kind={previewKindFor(draft.channel)}
                      title={preview.title}
                      body={preview.body}
                      scheduledAt={fmtTime(draft.createdAt)}
                      workflowStatus={draftWorkflowStatus(draft.state)}
                      platform={draft.channel === "ads" ? undefined : SOCIAL_PLATFORM[draft.channel]}
                      mediaUrl={draft.media?.[0]?.url}
                      onOpen={() => navigateToDraft(draft.id)}
                      actions={editable ? <><Button id={`approve-${draft.id}`} variant="primary" size="compact" disabled={busy} onClick={() => void action(draft, "approve")}><Icon name="approve" size="compact" /> Approve</Button><Button variant="secondary" size="compact" onClick={() => navigateToDraft(draft.id)}><Icon name="edit" size="compact" /> Open editor</Button><Button variant="danger" size="compact" disabled={busy} onClick={() => void action(draft, "reject")}><Icon name="reject" size="compact" /> Reject</Button></> : <Button variant="tertiary" size="compact" onClick={() => navigateToDraft(draft.id)}>Open editor</Button>}
                    />
                  );
                })}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}
