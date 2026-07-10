"use client";

import { TopBarActions } from "@/src/components/top-bar";
import { EmptyState } from "@/src/components/empty-state";
import { ShowMoreButton, useShowMore } from "@/src/components/show-more";
import { Button } from "@/src/components/ui/button";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { BrandIcon, Icon } from "@/src/components/ui/icon";
import type { BrandName } from "@/src/components/ui/brand-icons";
import { Tabs } from "@/src/components/ui/tabs";
import styles from "./inbox.module.css";


import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  ApprovalState,
  InboxItemStatus,
  InboxItemWithContext,
  InboxRunResult,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  edited: "Edited",
  approved: "Approved",
  rejected: "Rejected",
};

const STATUS_LABELS: Record<InboxItemStatus, string> = {
  unread: "Unread",
  read: "Read",
  replied: "Replied",
  dismissed: "Dismissed",
};

type Filter = InboxItemStatus | "all";

/** Providers with a brand mark (spec §4 carve-out); others fall back to email. */
const PROVIDER_BRAND: Partial<Record<string, BrandName>> = {
  linkedin: "linkedin",
  twitter: "x",
  reddit: "reddit",
  instagram: "instagram",
};

export default function InboxPage() {
  const { id } = useParams<{ id: string }>();

  const [items, setItems] = useState<InboxItemWithContext[]>([]);
  const [filter, setFilter] = useState<Filter>("unread");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<InboxRunResult | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${id}/inbox`);
      if (!res.ok) throw new Error("not found");
      setItems(await res.json());
      setError(null);
    } catch {
      setError(`Could not load the inbox from ${API_URL}. Is "npm run dev" running?`);
    } finally {
      setLoaded(true);
    }
  }, [id]);

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
      if (!posted.ok) throw new Error(body?.message ?? `Post returned ${posted.status}`);
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
        <Button variant="primary" size="sm" onClick={runNow} disabled={running}>
          <Icon name="regenerate" size="sm" />
          {running ? "Running…" : "Run inbox now"}
        </Button>
      </TopBarActions>

      <p className="subtitle">
        Comments on your published posts and replies to your DMs, in one place. Draft a reply in
        your voice, approve it on <Link href={`/workspaces/${id}/approvals`}>Review</Link>, and it
        posts back to the platform.
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
              <Button variant="secondary" size="sm" onClick={runNow} disabled={running}>
                <Icon name="regenerate" size="sm" />
                {running ? "Running…" : "Run inbox now"}
              </Button>
            ) : undefined
          }
          preview={
            items.length === 0 ? (
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <span className={styles.previewAuthor}>
                    <BrandIcon name="linkedin" size="sm" /> Maya R. · comment
                  </span>
                  <p className={styles.previewBody}>
                    This is exactly the workflow gap we hit last quarter — how does it handle approvals?
                  </p>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.previewAuthor}>
                    <BrandIcon name="x" size="sm" /> @growthlee · DM
                  </span>
                  <p className={styles.previewBody}>
                    Saw your launch post. Curious what the pricing looks like for small teams.
                  </p>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.previewAuthor}>
                    <BrandIcon name="reddit" size="sm" /> u/saasfounder · comment
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
            return (
              <li key={item.id} className="section-card">
                <div className="section-head">
                  <span className={styles.itemMark} title={item.providerKey}>
                    {brand ? (
                      <BrandIcon name={brand} size="sm" />
                    ) : (
                      <Icon name="email" size="sm" />
                    )}
                  </span>
                  <Badge tone={item.status === "replied" ? "approved" : item.status === "dismissed" ? "rejected" : "edited"}>
                    {STATUS_LABELS[item.status]}
                  </Badge>
                  <span className="section-title">
                    {item.authorName || item.authorHandle || "someone"}
                    <span className="layer-badge" style={{ marginLeft: 8 }}>
                      {item.providerKey} · {item.kind === "dm" ? "DM" : "comment"}
                    </span>
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
                      <Badge tone={draft.state === "pending_review" ? "pending" : draft.state}>
                        {STATE_LABELS[draft.state]}
                      </Badge>
                      <span className="meta">drafted reply</span>
                    </div>
                    <pre className="section-content">{draft.content}</pre>
                  </div>
                )}

                <div className="rating-row" style={{ marginTop: 10 }}>
                  {!draft && !replyPosted && item.status !== "dismissed" && (
                    <Button
                      variant="secondary"
                      size="sm"
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
                        size="sm"
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
                      <Link className="link-button" href={`/workspaces/${id}/approvals`}>
                        review on Review
                      </Link>
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
                    </span>
                  )}
                  {item.status !== "replied" && item.status !== "dismissed" && (
                    <>
                      {item.status === "unread" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === item.id}
                          onClick={() => setStatus(item.id, "read")}
                        >
                          mark read
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
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
