"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import type { Draft, InboxItem } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import { reviewTab, type ReviewTab } from "@/lib/review-workspace";
import { CountBadge } from "@/src/components/ui/badge";
import { ApprovalsQueue } from "./_components/approvals-queue";
import { InboxQueue } from "./_components/inbox-queue";
import styles from "./review.module.css";

export default function ReviewWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const activeTab = reviewTab(searchParams.get("tab"));

  // Queue sizes for the inactive tab come from lightweight filtered fetches;
  // the mounted queue reports its authoritative count from data it already
  // loads, so the active tab never double-fetches.
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [draftsRes, inboxRes] = await Promise.all([
        apiFetch(`/workspaces/${id}/drafts?state=pending_review`).catch(() => null),
        apiFetch(`/workspaces/${id}/inbox?status=unread`).catch(() => null),
      ]);
      if (cancelled) return;
      if (draftsRes?.ok) setPendingCount(((await draftsRes.json()) as Draft[]).length);
      if (inboxRes?.ok) setUnreadCount(((await inboxRes.json()) as InboxItem[]).length);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const reportPending = useCallback((n: number) => setPendingCount(n), []);
  const reportUnread = useCallback((n: number) => setUnreadCount(n), []);

  const tabs: Array<{
    key: ReviewTab;
    href: string;
    label: string;
    count: number | null;
    countLabel: string;
  }> = [
    {
      key: "approvals",
      href: "?tab=approvals",
      label: "Approvals",
      count: pendingCount,
      countLabel: "drafts waiting for review",
    },
    {
      key: "inbox",
      href: "?tab=inbox",
      label: "Inbox",
      count: unreadCount,
      countLabel: "unread inbox items",
    },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Review</h1>
          <p className="subtitle">
            Everything waiting on your decision: approve, edit, or reject drafts before they go
            out, and answer the replies they earn. Every decision is recorded.
          </p>
        </div>
      </div>

      <nav className={styles.tabs} aria-label="Review workspace">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={activeTab === tab.key ? "page" : undefined}
          >
            {tab.label}
            {tab.count !== null && tab.count > 0 && (
              <CountBadge count={tab.count} label={tab.countLabel} />
            )}
          </Link>
        ))}
      </nav>

      {activeTab === "approvals" && (
        <ApprovalsQueue workspaceId={id} onPendingCount={reportPending} />
      )}
      {activeTab === "inbox" && <InboxQueue workspaceId={id} onUnreadCount={reportUnread} />}
    </>
  );
}
