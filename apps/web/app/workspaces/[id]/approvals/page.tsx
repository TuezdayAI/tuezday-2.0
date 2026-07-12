"use client";

import { EmptyState } from "@/src/components/empty-state";
import { ConnectPrompt } from "@/src/components/connect-prompt";
import { WhyThisOutput } from "@/components/why-this-output";
import { Button, IconButton } from "@/src/components/ui/button";
import { Badge, CountBadge, WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Tabs } from "@/src/components/ui/tabs";
import { PreviewCard } from "@/src/components/ui/preview-card";
import { Icon, BrandIcon } from "@/src/components/ui/icon";
import type { BrandName } from "@/src/components/ui/brand-icons";
import { toast } from "@/src/components/ui/toast";
import styles from "./approvals.module.css";

import { API_URL, apiFetch } from "@/lib/api";
import { previewKindFor } from "@/lib/preview-kind";
import {
  connectionLabel,
  providerForPersonaSocialChannel,
} from "@/lib/persona-social-routing";
import {
  authorizeNangoOAuth,
  oauthSessionErrorMessage,
  type NangoOAuthSession,
} from "@/lib/nango-oauth";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  canTransition,
  type ApprovalDecision,
  type ApprovalState,
  type Campaign,
  type Channel,
  type Connection,
  type ConnectorProvider,
  type Draft,
  type Persona,
  type TaskType,
  type WorkflowStatus,
  type Workspace,
} from "@tuezday/contracts";

const TASK_LABELS: Record<TaskType, string> = {
  linkedin_post: "LinkedIn post",
  cold_email_opener: "Cold email opener",
  ad_copy_variant: "Ad copy variant",
  landing_page_hero: "Landing page hero",
  signal_response: "Signal response",
  outbound_email: "Outbound email",
  meta_ad_creative: "Meta ad creative",
  google_rsa: "Google RSA",
  pr_pitch: "Media pitch",
  press_boilerplate: "Press boilerplate",
  x_dm: "X DM",
  instagram_post: "Instagram post",
  engagement_reply: "Reply",
  instagram_carousel: "Instagram carousel",
};

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  edited: "Edited",
  approved: "Approved",
  rejected: "Rejected",
};

type Filter = ApprovalState | "all";

const APPROVAL_WORKFLOW_STATUS: Record<ApprovalState, WorkflowStatus> = {
  draft: "draft",
  pending_review: "review_required",
  edited: "changes_requested",
  approved: "approved",
  rejected: "rejected",
};

/** Platform mark shown inside the PreviewCard framing (social / ad kinds). */
const SOCIAL_PLATFORM: Partial<Record<Channel, BrandName>> = {
  linkedin: "linkedin",
  x: "x",
  instagram: "instagram",
};

function platformFor(d: Draft): BrandName | undefined {
  if (d.channel === "ads") {
    if (d.taskType === "meta_ad_creative") return "meta";
    if (d.taskType === "google_rsa") return "google";
    return undefined;
  }
  return SOCIAL_PLATFORM[d.channel];
}

/** Connector provider key → brand mark, for the "Posting to" rail. */
const PROVIDER_BRAND: Record<string, BrandName> = {
  linkedin: "linkedin",
  twitter: "x",
  instagram: "instagram",
  reddit: "reddit",
};

/** One-line GTM value promise per social provider (spec §5.7.3). */
const SOCIAL_PROMISE: Record<string, string> = {
  linkedin: "Publish approved posts on schedule, straight from Review",
  twitter: "Post approved content from your own handle",
  instagram: "Publish approved posts from your business account",
  reddit: "Post to your subreddits and feed threads into Discovery",
};

/** The API decorates OAuth providers with whether their app creds are set. */
type ProviderView = ConnectorProvider & { oauthConfigured?: boolean };

interface ConnectorsView {
  providers: ProviderView[];
  connections: Connection[];
  fabric: { healthy: boolean; detail?: string };
}

interface DraftGroup {
  key: string;
  kind: "campaign" | "day";
  title: string;
  /** Date range across the group's drafts; empty when it repeats the title. */
  range: string;
  drafts: Draft[];
}

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function dayLabel(t: number): string {
  const day = new Date(t).toDateString();
  const now = Date.now();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return fmtDay(t);
}

/** Gallery grouping (spec §5.5): by campaign, else by created day. */
function buildGroups(visible: Draft[], campaigns: Campaign[]): DraftGroup[] {
  const buckets = new Map<string, Draft[]>();
  for (const d of visible) {
    const key = d.campaignId ? `campaign:${d.campaignId}` : `day:${new Date(d.createdAt).toDateString()}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(d);
    else buckets.set(key, [d]);
  }
  const groups: DraftGroup[] = [...buckets.entries()].map(([key, drafts]) => {
    const kind: DraftGroup["kind"] = key.startsWith("campaign:") ? "campaign" : "day";
    const title =
      kind === "campaign"
        ? (campaigns.find((c) => c.id === drafts[0]!.campaignId)?.name ?? "Campaign")
        : dayLabel(drafts[0]!.createdAt);
    const times = drafts.map((d) => d.createdAt);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const range = fmtDay(min) === fmtDay(max) ? fmtDay(max) : `${fmtDay(min)} – ${fmtDay(max)}`;
    return { key, kind, title, range: kind === "day" ? "" : range, drafts };
  });
  groups.sort(
    (a, b) =>
      Math.max(...b.drafts.map((d) => d.createdAt)) - Math.max(...a.drafts.map((d) => d.createdAt)),
  );
  return groups;
}

export default function ApprovalsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [connectors, setConnectors] = useState<ConnectorsView | null>(null);
  const [filter, setFilter] = useState<Filter>("pending_review");
  const [error, setError] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ApprovalDecision[]>>({});
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);

  /** Draft whose card should take keyboard focus after the next reload. */
  const focusNextRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, dRes, cRes, conRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/drafts`),
        apiFetch(`/workspaces/${id}/campaigns`),
        // Connections power the "Posting to" rail; best-effort, never blocks.
        apiFetch(`/workspaces/${id}/connectors`).catch(() => null),
      ]);
      if (!wsRes.ok || !pRes.ok || !dRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setDrafts(await dRes.json());
      setCampaigns(await cRes.json());
      if (conRes?.ok) setConnectors(await conRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Approving advances focus to the next pending card (spec §5.5), so the
  // founder can chain approvals from the keyboard.
  useEffect(() => {
    const next = focusNextRef.current;
    if (!next) return;
    focusNextRef.current = null;
    const btn = document.getElementById(`approve-${next}`);
    if (btn instanceof HTMLElement) {
      btn.focus();
      btn.scrollIntoView({ block: "nearest" });
    }
  }, [drafts]);

  async function action(
    draftId: string,
    name: string,
    payload?: Record<string, unknown>,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      // Only set the JSON header when there is a body — Fastify rejects an
      // empty body that claims to be JSON.
      const res = await apiFetch(`/workspaces/${id}/drafts/${draftId}/${name}`, {
        method: "POST",
        ...(payload
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
          : {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setEditingId(null);
      await load();
      if (historyId === draftId) await loadHistory(draftId);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${name}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Approve/reject with a toast; approve queues focus onto the next card. */
  async function decide(draft: Draft, name: "approve" | "reject", orderedApprovable: string[]) {
    if (name === "approve") {
      const idx = orderedApprovable.indexOf(draft.id);
      focusNextRef.current = orderedApprovable[idx + 1] ?? orderedApprovable[idx - 1] ?? null;
    }
    const ok = await action(draft.id, name);
    if (ok) toast(name === "approve" ? "Approved" : "Rejected");
    else focusNextRef.current = null;
  }

  /** Sequential per-draft approves — there is no batch endpoint. */
  async function approveAll(group: DraftGroup) {
    const targets = group.drafts.filter((d) => canTransition(d.state, "approve"));
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    let ok = 0;
    let firstError: string | null = null;
    for (const d of targets) {
      try {
        const res = await apiFetch(`/workspaces/${id}/drafts/${d.id}/approve`, { method: "POST" });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
        ok++;
      } catch (err) {
        firstError ??= err instanceof Error ? err.message : "Approve failed";
      }
    }
    await load();
    setBusy(false);
    if (ok > 0) {
      toast(
        ok === targets.length
          ? `Approved ${ok} draft${ok === 1 ? "" : "s"}`
          : `Approved ${ok} of ${targets.length} drafts`,
      );
    }
    if (firstError) setError(firstError);
  }

  async function generateCarousel(draftId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/drafts/${draftId}/carousel`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // 402 already opened the standard upgrade modal via apiFetch.
        if (res.status === 402) return;
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setFilter("pending_review");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate carousel");
    } finally {
      setBusy(false);
    }
  }

  async function rerunReview(draftId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/drafts/${draftId}/review`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to re-run review");
    } finally {
      setBusy(false);
    }
  }

  async function loadHistory(draftId: string) {
    const res = await apiFetch(`/workspaces/${id}/drafts/${draftId}`);
    if (res.ok) {
      const detail = await res.json();
      setDecisions((d) => ({ ...d, [draftId]: detail.decisions }));
    }
  }

  async function toggleHistory(draftId: string) {
    if (historyId === draftId) {
      setHistoryId(null);
      return;
    }
    setHistoryId(draftId);
    if (!decisions[draftId]) await loadHistory(draftId);
  }

  /** Inline connect from the "Posting to" rail (spec §5.7.3): OAuth popup when
   * the provider app is configured, else hand off to the Integrations page. */
  async function connectSocial(providerKey: string) {
    const provider = connectors?.providers.find((p) => p.key === providerKey);
    if (
      !provider ||
      provider.authMode !== "oauth" ||
      !provider.oauthConfigured ||
      !connectors?.fabric.healthy
    ) {
      router.push(`/workspaces/${id}/connectors`);
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const result = await authorizeNangoOAuth(async (): Promise<NangoOAuthSession> => {
        const sessionRes = await apiFetch(
          `/workspaces/${id}/connectors/${provider.key}/oauth/session`,
          { method: "POST" },
        );
        const session = await sessionRes.json().catch(() => null);
        if (!sessionRes.ok) {
          throw new Error(oauthSessionErrorMessage(provider.label, sessionRes.status, session));
        }
        return session as NangoOAuthSession;
      });
      const completeRes = await apiFetch(
        `/workspaces/${id}/connectors/${provider.key}/oauth/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId: result.connectionId }),
        },
      );
      const body = await completeRes.json().catch(() => null);
      if (!completeRes.ok) throw new Error(body?.message ?? `API returned ${completeRes.status}`);
      toast(`${provider.label} connected`);
      await load();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : `${provider.label} authorization was not completed.`,
      );
    } finally {
      setConnecting(false);
    }
  }

  function personaName(pid: string | null): string {
    if (!pid) return "org voice";
    return personas.find((p) => p.id === pid)?.name ?? "deleted persona";
  }

  /** Title/body split for the PreviewCard renderers: social keeps the persona
   * as the handle; email/blog/ad lift the first line into the subject slot. */
  function splitContent(d: Draft): { title: string; body: string } {
    if (previewKindFor(d.channel) === "social") {
      return { title: personaName(d.personaId), body: d.content };
    }
    const lines = d.content.split("\n");
    const first = (lines[0] ?? "").replace(/^#+\s*/, "").trim();
    if (!first) return { title: TASK_LABELS[d.taskType], body: d.content };
    return { title: first, body: lines.slice(1).join("\n").trim() };
  }

  function openDetail(d: Draft) {
    setOpenId((prev) => (prev === d.id ? null : d.id));
    setEditingId(null);
  }

  const visible = filter === "all" ? drafts : drafts.filter((d) => d.state === filter);
  const counts = (state: Filter) =>
    state === "all" ? drafts.length : drafts.filter((d) => d.state === state).length;
  const filters: Filter[] = ["pending_review", "edited", "approved", "rejected", "all"];

  const groups = buildGroups(visible, campaigns);
  // The gallery's reading order — what "next card" means for focus advance.
  const orderedApprovableIds = groups.flatMap((g) =>
    g.drafts.filter((d) => canTransition(d.state, "approve")).map((d) => d.id),
  );

  function renderCard(d: Draft) {
    const editable = canTransition(d.state, "approve");
    const { title, body } = splitContent(d);
    return (
      <PreviewCard
        key={d.id}
        kind={previewKindFor(d.channel)}
        title={title}
        body={body}
        scheduledAt={fmtTime(d.createdAt)}
        workflowStatus={APPROVAL_WORKFLOW_STATUS[d.state]}
        platform={platformFor(d)}
        onOpen={() => openDetail(d)}
        actions={
          editable ? (
            <>
              <Button
                id={`approve-${d.id}`}
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => void decide(d, "approve", orderedApprovableIds)}
              >
                <Icon name="approve" size="sm" /> Approve
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setOpenId(d.id);
                  setEditingId(d.id);
                  setEditContent(d.content);
                }}
              >
                <Icon name="edit" size="sm" /> Edit
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => void decide(d, "reject", orderedApprovableIds)}
              >
                <Icon name="reject" size="sm" /> Reject
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => openDetail(d)}>
              {openId === d.id ? "Close" : "Open"}
            </Button>
          )
        }
      />
    );
  }

  function renderPostingTo(d: Draft) {
    const providerKey = providerForPersonaSocialChannel(d.channel);
    if (d.state !== "approved" || !providerKey || !connectors) return null;
    const brand = PROVIDER_BRAND[providerKey];
    if (!brand) return null;
    const accounts = connectors.connections.filter(
      (c) => c.providerKey === providerKey && c.status === "connected",
    );
    return (
      <div className={styles.postingTo}>
        <span className={styles.postingLabel}>
          <Icon name="connect" size="sm" /> Posting to
        </span>
        {accounts.length > 0 ? (
          <span className={styles.accounts}>
            {accounts.map((c) => (
              <span key={c.id} className={styles.account}>
                <BrandIcon name={brand} size="sm" />
                {connectionLabel(c)}
                {c.externalAccountHandle && <span className="meta">@{c.externalAccountHandle}</span>}
              </span>
            ))}
          </span>
        ) : (
          <ConnectPrompt
            provider={brand}
            promise={SOCIAL_PROMISE[providerKey] ?? "Publish approved posts on schedule"}
            onConnect={() => void connectSocial(providerKey)}
            connecting={connecting}
          />
        )}
      </div>
    );
  }

  function renderDetail(d: Draft) {
    const editable = canTransition(d.state, "approve");
    const isEditing = editingId === d.id;
    return (
      <div className={styles.detail}>
        <div className={styles.detailHead}>
          <WorkflowStatusBadge status={APPROVAL_WORKFLOW_STATUS[d.state]} />
          {decisions[d.id]?.some((dec) => dec.action === "approve" && dec.actor === "system") && (
            <Badge tone="approved" title="Approved automatically by scheduled-auto">
              Auto-approved
            </Badge>
          )}
          <span className={styles.detailTitle}>
            {TASK_LABELS[d.taskType]} · {d.channel} · {personaName(d.personaId)}
            {d.campaignId && (
              <span className="layer-badge layer-campaign" style={{ marginLeft: 8 }}>
                {campaigns.find((c) => c.id === d.campaignId)?.name ?? "campaign"}
              </span>
            )}
          </span>
          <span className={styles.detailTime}>{new Date(d.createdAt).toLocaleString()}</span>
          <IconButton
            label="Close"
            onClick={() => {
              setOpenId(null);
              setEditingId(null);
            }}
          >
            <Icon name="close" size="sm" />
          </IconButton>
        </div>

        {isEditing ? (
          <div className="doc-editor" style={{ marginTop: 10 }}>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={8}
            />
            <div className="editor-actions">
              <button
                disabled={busy || editContent.trim().length === 0}
                onClick={() => {
                  void action(d.id, "edit", { content: editContent }).then((ok) => {
                    if (ok) toast("Edit saved");
                  });
                }}
              >
                Save edit
              </button>
              <Button variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            {d.media && d.media.length > 0 && (
              <div
                className="carousel-strip"
                style={{ display: "flex", gap: 8, overflowX: "auto", margin: "10px 0" }}
              >
                {d.media.map((m, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={m.url}
                    src={m.url}
                    alt={`Slide ${i + 1}`}
                    style={{
                      width: 160,
                      height: 160,
                      objectFit: "cover",
                      borderRadius: 8,
                      flexShrink: 0,
                      border: "1px solid var(--border, #e5e7eb)",
                    }}
                  />
                ))}
              </div>
            )}
            <pre className="output-text">{d.content}</pre>
            {d.content !== d.originalContent && (
              <details className="original-content">
                <summary>Original (before edits)</summary>
                <pre className="section-content">{d.originalContent}</pre>
              </details>
            )}
            <WhyThisOutput review={d.review} />
          </>
        )}

        {renderPostingTo(d)}

        {!isEditing && (
          <div className="rating-row">
            {d.state === "approved" && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(d.content);
                    toast("Copied to clipboard");
                  }}
                >
                  ⧉ Copy
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(
                      new Blob([d.content], { type: "text/markdown" }),
                    );
                    a.download = `tuezday-${d.channel}-${d.id.slice(0, 8)}.md`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  ↓ Download .md
                </Button>
                {d.taskType !== "instagram_carousel" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    title="Render this approved copy as a branded Instagram carousel"
                    onClick={() => generateCarousel(d.id)}
                  >
                    ▦ Generate carousel
                  </Button>
                )}
              </>
            )}
            {editable && (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void decide(d, "approve", orderedApprovableIds)}
                >
                  <Icon name="approve" size="sm" /> Approve
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(d.id);
                    setEditContent(d.content);
                  }}
                >
                  <Icon name="edit" size="sm" /> Edit
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => void decide(d, "reject", orderedApprovableIds)}
                >
                  <Icon name="reject" size="sm" /> Reject
                </Button>
                {d.state === "edited" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void action(d.id, "resubmit").then((ok) => {
                        if (ok) toast("Resubmitted for review");
                      });
                    }}
                  >
                    ↺ Resubmit for review
                  </Button>
                )}
              </>
            )}
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => rerunReview(d.id)}>
              ⟳ {d.review ? "Re-run review" : "Run review"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => toggleHistory(d.id)}>
              {historyId === d.id ? "hide history" : "history"}
            </Button>
          </div>
        )}

        {historyId === d.id && decisions[d.id] && (
          <ul className="decision-log">
            {decisions[d.id]!.map((dec) => (
              <li key={dec.id}>
                <span className="meta">
                  {new Date(dec.createdAt).toLocaleString()} · {dec.actor}
                </span>{" "}
                <strong>{dec.action}</strong>: {STATE_LABELS[dec.fromState]} →{" "}
                {STATE_LABELS[dec.toState]}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace) return <EmptyState description="Loading…" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Review</h1>
          <p className="subtitle">
            Approve, edit, or reject before anything goes out. Nothing ships without your
            decision, and every decision is recorded.
          </p>
        </div>
      </div>

      <Tabs
        tabs={filters.map((f) => ({
          key: f,
          label: `${f === "all" ? "All" : STATE_LABELS[f]} (${counts(f)})`,
        }))}
        active={filter}
        onChange={(key) => setFilter(key as Filter)}
      />

      {error && <p className="error">{error}</p>}

      {visible.length === 0 ? (
        <EmptyState
          description={
            <>
              {drafts.length === 0
                ? "The queue is empty. Generate something in the sandbox and send it here."
                : "Nothing in this state."}
            </>
          }
        />
      ) : (
        groups.map((group) => {
          const approvable = group.drafts.filter((d) => canTransition(d.state, "approve"));
          const openDraft = openId ? group.drafts.find((d) => d.id === openId) : undefined;
          return (
            <section key={group.key} className={styles.group}>
              <header className={styles.groupHead}>
                <h2 className={styles.groupTitle}>
                  <Icon name={group.kind === "campaign" ? "campaigns" : "calendar"} size="sm" />
                  {group.title}
                </h2>
                {group.range && <span className={styles.groupRange}>{group.range}</span>}
                <CountBadge count={group.drafts.length} label="drafts in this group" />
                {approvable.length > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className={styles.approveAll}
                    disabled={busy}
                    onClick={() => void approveAll(group)}
                  >
                    <Icon name="approve" size="sm" /> Approve all ({approvable.length})
                  </Button>
                )}
              </header>
              <div className={styles.gallery}>{group.drafts.map(renderCard)}</div>
              {openDraft && renderDetail(openDraft)}
            </section>
          );
        })
      )}
    </>
  );
}
