"use client";

// Workspace Home — hero screen (spec §5.4). Three stacked zones under the
// header: the work queue ("Needs you now"), the setup checklist (activation
// phase only), and "What the brain learned" — plus a slim icon+count strip
// replacing the old four large stat cards.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  SETUP_CHECKLIST_ITEMS,
  type Campaign,
  type Channel,
  type Draft,
  type NextAction,
  type NextActionState,
  type NowSynthesis,
  type SetupChecklistItem,
  type Workspace,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";
import { previewKindFor } from "@/lib/preview-kind";
import { EmptyState } from "@/src/components/empty-state";
import { PageHeader } from "@/src/components/page-header";
import { PreviewCard } from "@/src/components/ui/preview-card";
import { Icon, type IconName } from "@/src/components/ui/icon";
import type { BrandName } from "@/src/components/ui/brand-icons";
import { CountBadge } from "@/src/components/ui/badge";
import { LoopGlyph } from "@/src/components/ui/diagram-kit";
import buttonStyles from "@/src/components/ui/button.module.css";
import styles from "./home-hero.module.css";

/** GET /workspaces/:id/next-action — shared next-action contract (spec §5.1). */
interface NextActionPayload {
  state: NextActionState;
  nextAction: NextAction;
  checklist: { done: number; total: number; complete: boolean };
}

interface HomeData {
  workspace: Workspace;
  drafts: Draft[];
  newSignals: number;
  syntheses: NowSynthesis[];
  campaigns: Campaign[];
  /** Null while the next-action endpoint isn't available — degrade gracefully. */
  next: NextActionPayload | null;
}

/** Channels with a real platform mark on the preview frame (spec §4 carve-out). */
const CHANNEL_BRAND: Partial<Record<Channel, BrandName>> = {
  linkedin: "linkedin",
  x: "x",
  instagram: "instagram",
};

/** Icon + deep link per checklist step (spec §5.4.2); order comes from contracts. */
const CHECKLIST_META: Record<SetupChecklistItem, { icon: IconName; label: string; path: string }> = {
  brain_reviewed: { icon: "brain", label: "Review your Brain", path: "/brain" },
  channel_connected: { icon: "connect", label: "Connect a channel", path: "/connectors" },
  first_campaign: { icon: "campaigns", label: "Create your first campaign", path: "/campaigns" },
  first_approval: { icon: "review", label: "Approve your first draft", path: "/approvals" },
  insights_live: { icon: "status-learning", label: "Turn on insights", path: "/connectors" },
  team_invited: { icon: "audience", label: "Invite your team", path: "/team" },
};

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Email/blog framings read title + body; lead line becomes the subject/title. */
function splitLead(content: string): { title: string; body: string } {
  const [first = "", ...rest] = content.split(/\r?\n/);
  const body = rest.join("\n").trim();
  return { title: truncate(first, 80), body: body || content };
}

export default function WorkspaceHomePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ws, drafts, signals, syntheses, campaigns, next] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/drafts`),
        apiFetch(`/workspaces/${id}/discovery/items?status=new`),
        apiFetch(`/workspaces/${id}/learning/syntheses`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/next-action`),
      ]);
      if (!ws.ok) throw new Error("not found");
      setData({
        workspace: await ws.json(),
        drafts: drafts.ok ? await drafts.json() : [],
        newSignals: signals.ok ? ((await signals.json()) as unknown[]).length : 0,
        syntheses: syntheses.ok ? await syntheses.json() : [],
        campaigns: campaigns.ok ? await campaigns.json() : [],
        next: next.ok ? await next.json() : null,
      });
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">{"<-"} Back to workspaces</Link>
      </>
    );
  }

  if (!data) return <EmptyState description="Loading..." />;

  const { workspace, drafts, newSignals, syntheses, campaigns, next } = data;
  const pendingReview = drafts.filter((d) => d.state === "pending_review").length;
  const proposedUpdates = syntheses.filter((s) => s.status === "proposed").length;
  const activeCampaigns = campaigns.filter((c) => c.status === "active").length;

  // Zone 1 — the work queue: oldest-waiting first, mirroring the review queue.
  const queue = drafts
    .filter((d) => d.state === "pending_review")
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, 8);
  // Pending drafts are priority 1 in the next-action engine, so the top card
  // mirrors the next action whenever the engine agrees (or isn't loaded yet).
  const topMirrorsNextAction = queue.length > 0 && (!next || next.nextAction.kind === "review");
  const generatingCount = next?.state.generatingCount ?? 0;

  // Zone 3 — recent learning-loop entries (dismissed ones taught us nothing).
  const learned = [...syntheses]
    .filter((s) => s.status !== "dismissed")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3);

  const campaignName = (draft: Draft): string | null =>
    draft.campaignId ? (campaigns.find((c) => c.id === draft.campaignId)?.name ?? null) : null;

  return (
    <>
      <PageHeader
        title="Command Center"
        subtitle={`The GTM loop for ${workspace.name}: review work, act on signals, update the Brain, and keep campaigns moving.`}
        actions={
          <Link
            className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.sm}`}
            href={`/workspaces/${id}/content`}
          >
            Create draft
          </Link>
        }
      />

      {/* Slim icon+count strip — passive muted-ink counts, each deep-linking. */}
      <nav className={styles.statStrip} aria-label="Workspace counts">
        <Link className={styles.stat} href={`/workspaces/${id}/approvals`}>
          <Icon name="review" size="sm" />
          Needs review
          <CountBadge count={pendingReview} label="drafts waiting for review" />
        </Link>
        <span className={styles.statSep} aria-hidden="true">·</span>
        <Link className={styles.stat} href={`/workspaces/${id}/discovery`}>
          <Icon name="discover" size="sm" />
          Signals
          <CountBadge count={newSignals} label="new market signals" />
        </Link>
        <span className={styles.statSep} aria-hidden="true">·</span>
        <Link className={styles.stat} href={`/workspaces/${id}/learning`}>
          <Icon name="status-learning" size="sm" />
          Brain updates
          <CountBadge count={proposedUpdates} label="proposed brain updates" />
        </Link>
        <span className={styles.statSep} aria-hidden="true">·</span>
        <Link className={styles.stat} href={`/workspaces/${id}/campaigns`}>
          <Icon name="status-live" size="sm" />
          Live
          <CountBadge count={activeCampaigns} label="campaigns live" />
        </Link>
      </nav>

      {/* Zone 1 — Needs you now: the work queue. */}
      <section className={styles.zone}>
        <div className={styles.zoneHead}>
          <h2 className={styles.zoneTitle}>Needs you now</h2>
          {next && queue.length > 0 && next.nextAction.kind === "review" && (
            <span className={styles.zoneMeta}>{next.nextAction.reason}</span>
          )}
          {queue.length > 0 && (
            <Link className={`link-button ${styles.zoneLink}`} href={`/workspaces/${id}/approvals`}>
              Open Review →
            </Link>
          )}
        </div>
        {queue.length === 0 ? (
          <p className={styles.allClear}>
            <Icon name="status-approved" size="sm" />
            All clear — nothing is waiting on you.
            {generatingCount > 0 && (
              <span className={styles.generating}>
                ⟳ Generating — {generatingCount} post{generatingCount === 1 ? "" : "s"} on the way
              </span>
            )}
          </p>
        ) : (
          <div className={styles.queue}>
            {queue.map((draft, i) => {
              const kind = previewKindFor(draft.channel);
              const campaign = campaignName(draft);
              const framedTitle =
                kind === "email" || kind === "blog"
                  ? splitLead(draft.content).title
                  : (campaign ?? workspace.name);
              const framedBody =
                kind === "email" || kind === "blog"
                  ? splitLead(draft.content).body
                  : draft.content;
              return (
                <div key={draft.id} className={styles.queueItem}>
                  <PreviewCard
                    kind={kind}
                    title={framedTitle}
                    body={framedBody}
                    scheduledAt={new Date(draft.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                    workflowStatus="review_required"
                    platform={CHANNEL_BRAND[draft.channel]}
                    onOpen={() => router.push(`/workspaces/${id}/approvals`)}
                  />
                  <span className={styles.caption}>
                    {i === 0 && topMirrorsNextAction && (
                      <span className={styles.nextTag}>Next up</span>
                    )}
                    <span className={styles.captionText}>
                      {draft.taskType.replace(/_/g, " ")}
                      {campaign ? ` · ${campaign}` : ""}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Zone 2 — Setup checklist: activation phase only, gone forever when done. */}
      {next && !next.checklist.complete && (
        <section className={styles.zone}>
          <div className={styles.zoneHead}>
            <h2 className={styles.zoneTitle}>Set up your GTM engine</h2>
            <CountBadge
              count={next.checklist.done}
              max={next.checklist.total}
              label="setup steps done"
            />
          </div>
          <div className={styles.checklist}>
            {SETUP_CHECKLIST_ITEMS.map((item) => {
              const meta = CHECKLIST_META[item];
              const done = next.state.checklist[item];
              const isNext = next.nextAction.checklistItem === item;
              return (
                <Link
                  key={item}
                  className={styles.step}
                  href={`/workspaces/${id}${meta.path}`}
                  data-done={done || undefined}
                  data-next={(isNext && !done) || undefined}
                >
                  <span className={styles.stepIcon}>
                    <Icon name={done ? "status-approved" : meta.icon} size="sm" />
                  </span>
                  <span className={styles.stepLabel}>{meta.label}</span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Zone 3 — What the brain learned: signal → change. Omitted when empty. */}
      {learned.length > 0 && (
        <section className={styles.zone}>
          <div className={styles.zoneHead}>
            <h2 className={styles.zoneTitle}>What the brain learned</h2>
            <Link className={`link-button ${styles.zoneLink}`} href={`/workspaces/${id}/learning`}>
              Open Learning →
            </Link>
          </div>
          <div className={styles.learned}>
            {learned.map((s) => (
              <LoopGlyph
                key={s.id}
                icon="doc-now"
                signal={truncate(s.rationale, 90) || "Recent approvals, edits and results"}
                change={truncate(s.proposal, 110)}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
