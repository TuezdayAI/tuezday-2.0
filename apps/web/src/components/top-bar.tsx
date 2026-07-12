"use client";
// apps/web/src/components/top-bar.tsx — spec §3.1.
// Title/breadcrumb left · contextual actions (portal) center-right · workspace
// health + user far right. Pages fill actions via <TopBarActions>.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { WORKSPACE_NAV, navEntryForPath } from "@tuezday/contracts";
import { Icon, type IconName } from "./ui/icon";
import { CountBadge } from "./ui/badge";
import buttonStyles from "./ui/button.module.css";
import styles from "./top-bar.module.css";

const ACTIONS_SLOT_ID = "tz-topbar-actions";

interface TopBarProps {
  workspaceName: string | null;
  reviewCount: number;
  userLabel: string | null;
}

export function TopBar({ workspaceName, reviewCount, userLabel }: TopBarProps) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const base = `/workspaces/${id}`;
  const relative = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  const entry = navEntryForPath(WORKSPACE_NAV, relative);

  return (
    <header className={styles.bar} data-tone={entry?.tone ?? "system"}>
      <div className={styles.title}>
        {entry?.icon && <Icon name={entry.icon as IconName} size="md" className={styles.titleIcon} />}
        {entry?.parentLabel && <span className={styles.crumb}>{entry.parentLabel} /</span>}
        <h1 className={styles.heading}>{entry?.label ?? workspaceName ?? "Workspace"}</h1>
      </div>
      <Link
        href={`/workspaces/${id}/content`}
        className={`${buttonStyles.button} ${buttonStyles.primary} ${buttonStyles.sm} ${styles.create}`}
      >
        <Icon name="add" size="sm" />
        Create New
      </Link>
      <div id={ACTIONS_SLOT_ID} className={styles.actions} />
      <div className={styles.meta}>
        {reviewCount > 0 && <CountBadge count={reviewCount} label="drafts waiting for review" />}
        <span className={styles.workspace}>{workspaceName ?? ""}</span>
        {userLabel && (
          <span className={styles.avatar} title={userLabel}>
            {userLabel.slice(0, 1).toUpperCase()}
          </span>
        )}
      </div>
    </header>
  );
}

/** Render inside any workspace page to place actions in the TopBar. */
export function TopBarActions({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById(ACTIONS_SLOT_ID));
  }, []);
  return slot ? createPortal(children, slot) : null;
}
