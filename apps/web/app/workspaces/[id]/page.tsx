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
  type AgentInboxFeed,
  type AgentInboxItem,
  type AgentQuestion,
  type Campaign,
  type NextAction,
  type NextActionState,
  type NowSynthesis,
  type SetupChecklistItem,
  type Workspace,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";
import {
  answerCta,
  answerOptions,
  inboxIsClear,
  inboxItemView,
  itemsInLane,
  laneMeta,
  questionTypeLabel,
  suggestedRule,
  LANE_ORDER,
} from "@/lib/agent-inbox-view";
import { EmptyState } from "@/src/components/empty-state";
import { PageHeader } from "@/src/components/page-header";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { CountBadge, WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button, ButtonLink } from "@/src/components/ui/button";
import { LoopGlyph } from "@/src/components/ui/diagram-kit";
import styles from "./home-hero.module.css";

/** GET /workspaces/:id/next-action — shared next-action contract (spec §5.1). */
interface NextActionPayload {
  state: NextActionState;
  nextAction: NextAction;
  checklist: { done: number; total: number; complete: boolean };
}

interface HomeData {
  workspace: Workspace;
  /** Sprint 70: one ranked feed, three lanes — the only ranking on this page. */
  feed: AgentInboxFeed;
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

/** An ordinary feed item: the API wrote the reason and the consequence. */
function InboxCard({ workspaceId, item }: { workspaceId: string; item: AgentInboxItem }) {
  const view = inboxItemView(item);
  return (
    <article className={styles.priorityCard}>
      <div className={styles.priorityHead}>
        <span className={styles.priorityKind}>
          <Icon name={view.icon} size="compact" />
          {view.label}
        </span>
        <WorkflowStatusBadge status={view.status} />
      </div>
      <h3>{item.title}</h3>
      <p className={styles.priorityReason}>{item.reason}</p>
      <p className={styles.priorityConsequence}>{item.consequence}</p>
      <div className={styles.priorityContext}>
        {item.campaignId && (
          <Link href={`/workspaces/${workspaceId}/campaigns/${item.campaignId}`}>
            {item.campaignName ?? "Open campaign"}
          </Link>
        )}
        {item.dueAt && (
          <time dateTime={new Date(item.dueAt).toISOString()}>
            Due {new Date(item.dueAt).toLocaleString()}
          </time>
        )}
      </div>
      <ButtonLink variant="secondary" size="standard" href={item.href}>
        {view.cta}
      </ButtonLink>
    </article>
  );
}

/**
 * The ask lane's card (Sprint 70). Answering here is the whole feature: one
 * click on an option the agent offered, or a sentence, and the suspended run
 * picks up where it stopped.
 */
function AskCard({
  workspaceId,
  question,
  item,
  onAnswered,
}: {
  workspaceId: string;
  question: AgentQuestion;
  item: AgentInboxItem;
  onAnswered: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function send(text: string, action: "answer" | "dismiss" = "answer") {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    const body: Record<string, unknown> = { action };
    if (action === "answer") {
      body.answer = text;
      // D-70.11: the rule is what the founder chose to keep, prefilled from
      // their own answer — never something parsed out of it server-side.
      if (remember) body.remember = { rule: suggestedRule(question, text), polarity: "do" };
    }
    const res = await apiFetch(`/workspaces/${workspaceId}/questions/${question.id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setFailed("That did not go through. Try again.");
      return;
    }
    onAnswered();
  }

  return (
    <article className={styles.priorityCard}>
      <div className={styles.priorityHead}>
        <span className={styles.priorityKind}>
          <Icon name="status-review" size="compact" />
          {questionTypeLabel(question)}
        </span>
        <WorkflowStatusBadge status={item.status} />
      </div>
      <h3>{question.question}</h3>
      <p className={styles.priorityReason}>{question.why}</p>
      <p className={styles.priorityConsequence}>{item.consequence}</p>

      {answerOptions(question).length > 0 && (
        <div className={styles.askOptions}>
          {answerOptions(question).map((option) => (
            <Button
              key={option}
              variant="secondary"
              size="compact"
              disabled={busy}
              onClick={() => void send(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}

      <textarea
        className={styles.askInput}
        rows={2}
        placeholder="Or answer in your own words…"
        value={answer}
        disabled={busy}
        onChange={(event) => setAnswer(event.target.value)}
      />
      <label className={styles.askRemember}>
        <input
          type="checkbox"
          checked={remember}
          disabled={busy}
          onChange={(event) => setRemember(event.target.checked)}
        />
        Remember this for next time
      </label>
      {failed && <p className={styles.priorityReason}>{failed}</p>}
      <div className={styles.askActions}>
        <Button
          variant="primary"
          size="standard"
          loading={busy}
          disabled={busy || answer.trim().length === 0}
          onClick={() => void send(answer)}
        >
          {answerCta(question)}
        </Button>
        <Button
          variant="tertiary"
          size="standard"
          disabled={busy}
          onClick={() => void send("", "dismiss")}
        >
          Not now
        </Button>
      </div>
    </article>
  );
}

export default function WorkspaceHomePage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ws, feed, signals, syntheses, campaigns, next] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/agent-inbox`),
        apiFetch(`/workspaces/${id}/discovery/items?status=new`),
        apiFetch(`/workspaces/${id}/learning/syntheses`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/next-action`),
      ]);
      if (!ws.ok || !feed.ok) throw new Error("not found");
      setData({
        workspace: await ws.json(),
        feed: await feed.json(),
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

  const { workspace, feed, newSignals, syntheses, campaigns, next } = data;
  const pendingReview = feed.items.filter((item) => item.kind === "content_review").length;
  const proposedUpdates = syntheses.filter((s) => s.status === "proposed").length;
  const activeCampaigns = campaigns.filter((c) => c.status === "active").length;

  // Sprint 70: the API owns lane assignment and the single ranking. This page
  // renders the order it was given and never re-sorts — the whole point of
  // collapsing the two engines was to stop two surfaces disagreeing.
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
          <ButtonLink variant="secondary" size="standard" href={`/workspaces/${id}/content`}>
            Create draft
          </ButtonLink>
        }
      />

      {/* Slim icon+count strip — passive muted-ink counts, each deep-linking. */}
      <nav className={styles.statStrip} aria-label="Workspace counts">
        <Link className={styles.stat} href={`/workspaces/${id}/review`}>
          <Icon name="review" size="compact" />
          Needs review
          <CountBadge count={pendingReview} label="drafts waiting for review" />
        </Link>
        <span className={styles.statSep} aria-hidden="true">·</span>
        <Link className={styles.stat} href={`/workspaces/${id}/discovery`}>
          <Icon name="discover" size="compact" />
          Signals
          <CountBadge count={newSignals} label="new market signals" />
        </Link>
        <span className={styles.statSep} aria-hidden="true">·</span>
        <Link className={styles.stat} href={`/workspaces/${id}/learning`}>
          <Icon name="status-learning" size="compact" />
          Brain updates
          <CountBadge count={proposedUpdates} label="proposed brain updates" />
        </Link>
        <span className={styles.statSep} aria-hidden="true">·</span>
        <Link className={styles.stat} href={`/workspaces/${id}/campaigns`}>
          <Icon name="status-live" size="compact" />
          Live
          <CountBadge count={activeCampaigns} label="campaigns live" />
        </Link>
      </nav>

      {/* Zone 1 — the agent inbox: notify / ask / review over one ranked feed. */}
      {inboxIsClear(feed) ? (
        <section className={styles.zone}>
          <div className={styles.zoneHead}>
            <h2 className={styles.zoneTitle}>Your inbox</h2>
          </div>
          <p className={styles.allClear}>
            <Icon name="status-approved" size="compact" />
            All clear — nothing is waiting on you.
            {generatingCount > 0 && (
              <span className={styles.generating}>
                ⟳ Generating — {generatingCount} post{generatingCount === 1 ? "" : "s"} on the way
              </span>
            )}
          </p>
        </section>
      ) : (
        LANE_ORDER.map((lane) => {
          const items = itemsInLane(feed, lane);
          if (items.length === 0) return null;
          const meta = laneMeta(lane);
          return (
            <section key={lane} className={styles.zone}>
              <div className={styles.zoneHead}>
                <h2 className={styles.zoneTitle}>{meta.title}</h2>
                <CountBadge count={feed.counts[lane]} label={meta.blurb} />
              </div>
              <div className={styles.priorityGrid}>
                {items.map((item) =>
                  item.question ? (
                    <AskCard
                      key={item.id}
                      workspaceId={id}
                      question={item.question}
                      item={item}
                      onAnswered={() => void load()}
                    />
                  ) : (
                    <InboxCard key={item.id} workspaceId={id} item={item} />
                  ),
                )}
              </div>
            </section>
          );
        })
      )}

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
                    <Icon name={done ? "status-approved" : meta.icon} size="compact" />
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
            <ButtonLink
              variant="tertiary"
              size="compact"
              className={styles.zoneLink}
              href={`/workspaces/${id}/learning`}
            >
              Open Learning →
            </ButtonLink>
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
