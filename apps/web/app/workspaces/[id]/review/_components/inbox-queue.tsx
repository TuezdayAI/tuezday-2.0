"use client";

import { TopBarActions } from "@/src/components/top-bar";
import { EmptyState } from "@/src/components/empty-state";
import { ShowMoreButton, useShowMore } from "@/src/components/show-more";
import { Button, ButtonLink } from "@/src/components/ui/button";
import { Badge, CountBadge, WorkflowStatusBadge } from "@/src/components/ui/badge";
import { BrandIcon, Icon } from "@/src/components/ui/icon";
import type { BrandName } from "@/src/components/ui/brand-icons";
import { Tabs } from "@/src/components/ui/tabs";
import styles from "./inbox-queue.module.css";


import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type {
  EmailReplyLabel,
  ExternalActionSubmission,
  InboxItemStatus,
  InboxItemWithContext,
  InboxRunResult,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";
import {
  actionAuthorizationHref,
  externalActionWorkflowStatus,
  submissionNote,
} from "@/lib/external-actions";
import { draftWorkflowStatus, inboxWorkflowStatus, reviewHref } from "@/lib/review-workspace";

const STATUS_LABELS: Record<InboxItemStatus, string> = {
  unread: "Unread",
  read: "Read",
  replied: "Replied",
  dismissed: "Dismissed",
};

type Filter = InboxItemStatus | "all";

/**
 * Email reply classification chip (Sprint 47) — label + existing badge tone.
 * Labels only this sprint; acting on them is Sprint 49.
 */
const REPLY_LABEL_VIEW: Record<
  EmailReplyLabel,
  { label: string; tone: "approved" | "rejected" | "edited" | "neutral" }
> = {
  positive: { label: "positive", tone: "approved" },
  not_interested: { label: "not interested", tone: "rejected" },
  out_of_office: { label: "out of office", tone: "neutral" },
  unsubscribe_request: { label: "unsubscribe request", tone: "edited" },
  bounce: { label: "bounce", tone: "rejected" },
  other: { label: "other", tone: "neutral" },
};

const KIND_LABELS: Record<InboxItemWithContext["kind"], string> = {
  comment: "comment",
  dm: "DM",
  email: "email reply",
};

/** Providers with a brand mark (spec §4 carve-out); others fall back to email. */
const PROVIDER_BRAND: Partial<Record<string, BrandName>> = {
  linkedin: "linkedin",
  twitter: "x",
  reddit: "reddit",
  instagram: "instagram",
};

export function InboxQueue({
  workspaceId: id,
  onUnreadCount,
}: {
  workspaceId: string;
  /** Reports the authoritative unread count to the Review shell. */
  onUnreadCount?: (count: number) => void;
}) {

  const [items, setItems] = useState<InboxItemWithContext[]>([]);
  const [filter, setFilter] = useState<Filter>("unread");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<InboxRunResult | null>(null);
  // The governed reply action returned by the last post attempt, per item.
  const [replyActions, setReplyActions] = useState<Record<string, ExternalActionSubmission>>({});

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${id}/inbox`);
      if (!res.ok) throw new Error("not found");
      const list = (await res.json()) as InboxItemWithContext[];
      setItems(list);
      onUnreadCount?.(list.filter((item) => item.status === "unread").length);
      setError(null);
    } catch {
      setError(`Could not load the inbox from ${API_URL}. Is "npm run dev" running?`);
    } finally {
      setLoaded(true);
    }
  }, [id, onUnreadCount]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/inbox/run`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setLastRun(body as InboxRunResult);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  async function setStatus(itemId: string, status: "read" | "dismissed") {
    setBusyId(itemId);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/inbox/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusyId(null);
    }
  }

  async function draftReply(itemId: string) {
    setBusyId(itemId);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/inbox/${itemId}/reply`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to draft a reply");
    } finally {
      setBusyId(null);
    }
  }

  /** Approve the gated reply draft (generic draft action), then post it back. */
  async function approveAndPost(item: InboxItemWithContext) {
    if (!item.replyDraft) return;
    setBusyId(item.id);
    setError(null);
    try {
      if (item.replyDraft.state !== "approved") {
        const approve = await apiFetch(
          `/workspaces/${id}/drafts/${item.replyDraft.id}/approve`,
          { method: "POST" },
        );
        if (!approve.ok) {
          const body = await approve.json().catch(() => null);
          throw new Error(body?.message ?? `Approve returned ${approve.status}`);
        }
      }
      const posted = await apiFetch(`/workspaces/${id}/inbox/${item.id}/post-reply`, {
        method: "POST",
      });
      const body = await posted.json().catch(() => null);
      if (!posted.ok && !body?.action) {
        throw new Error(body?.message ?? `Post returned ${posted.status}`);
      }
      // 202/201 both return the durable action; a stale 409 carries it too.
      const submission: ExternalActionSubmission =
        body.execution !== undefined
          ? (body as ExternalActionSubmission)
          : { action: body.action, execution: body.action.execution ?? null };
      setReplyActions((previous) => ({ ...previous, [item.id]: submission }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post the reply");
    } finally {
      setBusyId(null);
    }
  }

  const filteredItems = filter === "all" ? items : items.filter((i) => i.status === filter);
  const { visible, hasMore, remaining, showMore } = useShowMore(filteredItems, 50);
  const counts = (f: Filter) =>
    f === "all" ? items.length : items.filter((i) => i.status === f).length;
  const filters: Filter[] = ["unread", "read", "replied", "dismissed", "all"];

  if (error && !loaded) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  return (
    <>
      <TopBarActions>
        <Button variant="primary" size="compact" onClick={runNow} disabled={running}>
          <Icon name="regenerate" size="compact" />
          {running ? "Running…" : "Run inbox now"}
        </Button>
      </TopBarActions>

      <p className="subtitle">
        Comments on your published posts, replies to your DMs, and replies to your outreach
        emails, in one place. Draft a reply in your voice, approve it on the{" "}
        <Link href={reviewHref(id, { tab: "approvals" })}>Approvals tab</Link>, and it posts back
        to the platform.
      </p>

      {lastRun && (
        <p className="subtitle">
          Last run: {lastRun.newItems} new item(s), {lastRun.metricsCaptured} metric(s) captured,{" "}
          {lastRun.repliesGenerated} reply(ies) drafted, {lastRun.repliesAutoApproved} auto-approved,{" "}
          {lastRun.repliesPosted} posted.
        </p>
      )}

      <Tabs
        tabs={filters.map((f) => ({
          key: f,
          label: (
            <>
              {f === "all" ? "All" : STATUS_LABELS[f]}{" "}
              <CountBadge count={counts(f)} label={`${f} items`} />
            </>
          ),
        }))}
        active={filter}
        onChange={(key) => setFilter(key as Filter)}
      />

      {error && <p className="error">{error}</p>}

      {visible.length === 0 ? (
        <EmptyState
          description={<>{items.length === 0
            ? "Nothing inbound yet. When someone comments on a published post or replies to a DM, it shows up here — run the inbox to pull the latest."
            : "Nothing in this state."}</>}
          primaryAction={
            items.length === 0 ? (
              <Button variant="secondary" size="compact" onClick={runNow} disabled={running}>
                <Icon name="regenerate" size="compact" />
                {running ? "Running…" : "Run inbox now"}
              </Button>
            ) : undefined
          }
          preview={
            items.length === 0 ? (
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <span className={styles.previewAuthor}>
                    <BrandIcon name="linkedin" size="compact" /> Maya R. · comment
                  </span>
                  <p className={styles.previewBody}>
                    This is exactly the workflow gap we hit last quarter — how does it handle approvals?
                  </p>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.previewAuthor}>
                    <BrandIcon name="x" size="compact" /> @growthlee · DM
                  </span>
                  <p className={styles.previewBody}>
                    Saw your launch post. Curious what the pricing looks like for small teams.
                  </p>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.previewAuthor}>
                    <BrandIcon name="reddit" size="compact" /> u/saasfounder · comment
                  </span>
                  <p className={styles.previewBody}>
                    Been burned by tools like this before — what makes the brain thing different?
                  </p>
                </div>
              </div>
            ) : undefined
          }
        />
      ) : (
        <ul className="section-list">
          {visible.map((item) => {
            const draft = item.replyDraft;
            const replyPosted = Boolean(item.postedReplyExternalId);
            const brand = PROVIDER_BRAND[item.providerKey];
            const replyAction = replyActions[item.id] ?? null;
            const actionHref = replyAction
              ? actionAuthorizationHref(replyAction.action)
              : item.externalActionId
                ? reviewHref(id, { tab: "authorizations", action: item.externalActionId })
                : null;
            return (
              <li key={item.id} className="section-card">
                <div className="section-head">
                  <span className={styles.itemMark} title={item.providerKey}>
                    {brand ? (
                      <BrandIcon name={brand} size="compact" />
                    ) : (
                      <Icon name="email" size="compact" />
                    )}
                  </span>
                  <WorkflowStatusBadge status={inboxWorkflowStatus(item.status)} />
                  <span className="section-title">
                    {item.authorName || item.authorHandle || "someone"}
                    <span className="layer-badge" style={{ marginLeft: 8 }}>
                      {item.providerKey} · {KIND_LABELS[item.kind]}
                    </span>
                    {item.replyLabel && (
                      <Badge
                        tone={REPLY_LABEL_VIEW[item.replyLabel].tone}
                        style={{ marginLeft: 8 }}
                      >
                        {REPLY_LABEL_VIEW[item.replyLabel].label}
                      </Badge>
                    )}
                  </span>
                  <span className="section-tokens">
                    {new Date(item.externalCreatedAt).toLocaleString()}
                  </span>
                </div>

                <pre className="output-text">{item.content}</pre>

                <p className="section-reason">
                  {item.post ? (
                    <>
                      On your post{" "}
                      {item.post.url ? (
                        <a href={item.post.url} target="_blank" rel="noreferrer">
                          {item.post.title || "(view)"}
                        </a>
                      ) : (
                        <strong>{item.post.title}</strong>
                      )}
                    </>
                  ) : item.sentEmail ? (
                    <>
                      Re: <strong>{item.sentEmail.subject}</strong>
                      {item.sentEmail.sentAt != null && (
                        <> · sent {new Date(item.sentEmail.sentAt).toLocaleString()}</>
                      )}
                    </>
                  ) : item.kind === "email" ? (
                    "Reply to an outreach email"
                  ) : (
                    "Reply to an outbound DM"
                  )}
                  {item.url && (
                    <>
                      {" · "}
                      <a href={item.url} target="_blank" rel="noreferrer">
                        view on {item.providerKey}
                      </a>
                    </>
                  )}
                </p>

                {draft && (
                  <div className="draft-chain" style={{ marginTop: 10 }}>
                    <div className="section-head">
                      <WorkflowStatusBadge status={draftWorkflowStatus(draft.state)} />
                      <span className="meta">drafted reply</span>
                    </div>
                    <pre className="section-content">{draft.content}</pre>
                  </div>
                )}

                {replyAction && replyAction.action.status !== "succeeded" && (
                  <p className="section-reason">
                    <WorkflowStatusBadge
                      status={externalActionWorkflowStatus(replyAction.action)}
                    />{" "}
                    {submissionNote(replyAction)}{" "}
                    {actionHref && (
                      <ButtonLink variant="tertiary" size="compact" href={actionHref}>
                        view authorization
                      </ButtonLink>
                    )}
                  </p>
                )}

                <div className="rating-row" style={{ marginTop: 10 }}>
                  {!draft && !replyPosted && item.status !== "dismissed" && (
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={busyId === item.id}
                      onClick={() => draftReply(item.id)}
                    >
                      {busyId === item.id ? "Drafting…" : "Draft reply"}
                    </Button>
                  )}
                  {draft && !replyPosted && (
                    <>
                      <Button
                        variant="secondary"
                        size="compact"
                        className="rating-accepted"
                        disabled={busyId === item.id}
                        onClick={() => approveAndPost(item)}
                      >
                        {busyId === item.id
                          ? "Posting…"
                          : draft.state === "approved"
                            ? "Post reply"
                            : "Approve & post reply"}
                      </Button>
                      <ButtonLink
                        variant="tertiary"
                        size="compact"
                        href={reviewHref(id, { tab: "approvals" })}
                      >
                        review on Approvals
                      </ButtonLink>
                    </>
                  )}
                  {replyPosted && (
                    <span className="meta">
                      Replied
                      {item.postedReplyUrl && (
                        <>
                          {" · "}
                          <a href={item.postedReplyUrl} target="_blank" rel="noreferrer">
                            view reply
                          </a>
                        </>
                      )}
                      {actionHref && (
                        <>
                          {" · "}
                          <Link href={actionHref}>action record</Link>
                        </>
                      )}
                    </span>
                  )}
                  {item.status !== "replied" && item.status !== "dismissed" && (
                    <>
                      {item.status === "unread" && (
                        <Button
                          variant="tertiary"
                          size="compact"
                          disabled={busyId === item.id}
                          onClick={() => setStatus(item.id, "read")}
                        >
                          mark read
                        </Button>
                      )}
                      <Button
                        variant="tertiary"
                        size="compact"
                        disabled={busyId === item.id}
                        onClick={() => setStatus(item.id, "dismissed")}
                      >
                        dismiss
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ShowMoreButton hasMore={hasMore} remaining={remaining} onClick={showMore} />
    </>
  );
}
