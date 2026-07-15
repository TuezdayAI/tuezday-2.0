"use client";

// Workspace Home — hero screen (spec §5.4). Three stacked zones under the
// header: the work queue ("Needs you now"), the setup checklist (activation
// phase only), and "What the brain learned" — plus a slim icon+count strip
// replacing the old four large stat cards.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  SETUP_CHECKLIST_ITEMS,
  type Campaign,
  type NextAction,
  type NextActionState,
  type NowSynthesis,
  type PriorityQueue,
  type SetupChecklistItem,
  type Workspace,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";
import { priorityQueueState, priorityView } from "@/lib/priorities";
import { EmptyState } from "@/src/components/empty-state";
import { PageHeader } from "@/src/components/page-header";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { CountBadge, WorkflowStatusBadge } from "@/src/components/ui/badge";
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
  priorities: PriorityQueue;
  newSignals: number;
  syntheses: NowSynthesis[];
  campaigns: Campaign[];
  /** Null while the next-action endpoint isn't available — degrade gracefully. */
  next: NextActionPayload | null;
}

/** Icon + deep link per checklist step (spec §5.4.2); order comes from contracts. */
const CHECKLIST_META: Record<SetupChecklistItem, { icon: IconName; label: string; path: string }> = {
  brain_reviewed: { icon: "brain", label: "Review your Brain", path: "/brain" },
  channel_connected: { icon: "connect", label: "Connect a channel", path: "/connectors" },
  first_campaign: { icon: "campaigns", label: "Create your first campaign", path: "/campaigns" },
  first_approval: { icon: "review", label: "Approve your first draft", path: "/review" },
  insights_live: { icon: "status-learning", label: "Turn on insights", path: "/connectors" },
  team_invited: { icon: "audience", label: "Invite your team", path: "/team" },
};

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export default function WorkspaceHomePage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ws, priorities, signals, syntheses, campaigns, next] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/priorities`),
        apiFetch(`/workspaces/${id}/discovery/items?status=new`),
        apiFetch(`/workspaces/${id}/learning/syntheses`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/next-action`),
      ]);
      if (!ws.ok || !priorities.ok) throw new Error("not found");
      setData({
        workspace: await ws.json(),
        priorities: await priorities.json(),
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

  const { workspace, priorities, newSignals, syntheses, campaigns, next } = data;
  const pendingReview = priorities.items.filter((item) => item.kind === "content_review").length;
  const proposedUpdates = syntheses.filter((s) => s.status === "proposed").length;
  const activeCampaigns = campaigns.filter((c) => c.status === "active").length;

  // The API owns urgency and deterministic ordering across authorization,
  // blockers, failures, stale actions, and content review.
  const queue = priorities.items.slice(0, 8);
  const queueState = priorityQueueState(priorities);
  const generatingCount = next?.state.generatingCount ?? 0;

  // Zone 3 — recent learning-loop entries (dismissed ones taught us nothing).
  const learned = [...syntheses]
    .filter((s) => s.status !== "dismissed")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3);

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
        <Link className={styles.stat} href={`/workspaces/${id}/review`}>
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
          {queue.length > 0 && <span className={styles.zoneMeta}>Ranked by urgency and due time</span>}
        </div>
        {queueState === "all_clear" ? (
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
          <div className={styles.priorityGrid}>
            {queue.map((priority, index) => {
              const view = priorityView(priority);
              return (
                <article key={priority.id} className={styles.priorityCard}>
                  <div className={styles.priorityHead}>
                    <span className={styles.priorityKind}>
                      <Icon name={view.icon} size="sm" />
                      {index === 0 && <span className={styles.nextTag}>Next up</span>}
                      {view.label}
                    </span>
                    <WorkflowStatusBadge status={view.status} />
                  </div>
                  <h3>{priority.title}</h3>
                  <p className={styles.priorityReason}>{priority.reason}</p>
                  <p className={styles.priorityConsequence}>{priority.consequence}</p>
                  <div className={styles.priorityContext}>
                    {priority.campaignId && (
                      <Link href={`/workspaces/${id}/campaigns/${priority.campaignId}`}>
                        {priority.campaignName ?? "Open campaign"}
                      </Link>
                    )}
                    {priority.dueAt && (
                      <time dateTime={new Date(priority.dueAt).toISOString()}>
                        Due {new Date(priority.dueAt).toLocaleString()}
                      </time>
                    )}
                  </div>
                  <Link
                    href={priority.href}
                    className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.sm}`}
                  >
                    {view.cta}
                  </Link>
                </article>
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
