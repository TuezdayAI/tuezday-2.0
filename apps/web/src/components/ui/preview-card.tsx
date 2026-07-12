// apps/web/src/components/ui/preview-card.tsx — spec §6.1.
// Content rendered as itself: social/email/blog/ad framings, one shared chrome.
import type { ReactNode } from "react";
import type { WorkflowStatus } from "@tuezday/contracts";
import styles from "./preview-card.module.css";
import { Icon, BrandIcon, type IconName } from "./icon";
import type { BrandName } from "./brand-icons";
import { Badge, WorkflowStatusBadge } from "./badge";
import type { PreviewKind } from "../../../lib/preview-kind";

const KIND_ICON: Record<PreviewKind, IconName> = {
  social: "post",
  email: "email",
  blog: "blog",
  ad: "ad",
};
const KIND_LABEL: Record<PreviewKind, string> = {
  social: "Post",
  email: "Email",
  blog: "Blog post",
  ad: "Ad",
};

type StatusTone = "neutral" | "approved" | "pending" | "edited" | "rejected" | "draft" | "danger";

interface PreviewCardProps {
  kind: PreviewKind;
  title: string;
  /** Draft copy / subject-adjacent body text. Clamped by the renderer. */
  body: string;
  scheduledAt?: string;
  workflowStatus?: WorkflowStatus;
  status?: string;
  statusTone?: StatusTone;
  /** Platform mark for social/ad framings. */
  platform?: BrandName;
  mediaUrl?: string;
  onOpen?: () => void;
  /** Hover action rail — e.g. Approve / Open buttons (spec §6.1). */
  actions?: ReactNode;
}

export function PreviewCard({
  kind, title, body, scheduledAt, workflowStatus, status, statusTone = "pending",
  platform, mediaUrl, onOpen, actions,
}: PreviewCardProps) {
  return (
    <article className={styles.card} data-kind={kind}>
      <header className={styles.chrome} data-tone-kind={kind}>
        <span className={styles.kind}>
          <Icon name={KIND_ICON[kind]} size="sm" />
          {KIND_LABEL[kind]}
        </span>
        {scheduledAt && <time className={styles.time}>{scheduledAt}</time>}
        {workflowStatus ? (
          <WorkflowStatusBadge status={workflowStatus} />
        ) : (
          status && <Badge tone={statusTone}>{status}</Badge>
        )}
      </header>

      <button type="button" className={styles.surface} onClick={onOpen} disabled={!onOpen}>
        {kind === "social" && (
          <div className={styles.social}>
            <div className={styles.socialTop}>
              <span className={styles.avatar} aria-hidden="true" />
              <span className={styles.handle}>{title}</span>
              {platform && <BrandIcon name={platform} size="sm" className={styles.platform} />}
            </div>
            {mediaUrl ? (
              <img className={styles.media} src={mediaUrl} alt="" />
            ) : (
              <p className={styles.copy}>{body}</p>
            )}
            {mediaUrl && <p className={styles.copyClamp}>{body}</p>}
          </div>
        )}
        {kind === "email" && (
          <div className={styles.letter}>
            <div className={styles.subject}>{title}</div>
            <p className={styles.copy}>{body}</p>
          </div>
        )}
        {kind === "blog" && (
          <div className={styles.blog}>
            <h3 className={styles.blogTitle}>{title}</h3>
            <p className={styles.dek}>{body}</p>
            <span className={styles.readTime}>{Math.max(1, Math.round(body.split(/\s+/).length / 200))} min read</span>
          </div>
        )}
        {kind === "ad" && (
          <div className={styles.adFrame}>
            {mediaUrl && <img className={styles.media} src={mediaUrl} alt="" />}
            <div className={styles.adMeta}>
              <span className={styles.adHeadline}>{title}</span>
              {platform && <BrandIcon name={platform} size="sm" className={styles.platform} />}
            </div>
            {!mediaUrl && <p className={styles.copyClamp}>{body}</p>}
          </div>
        )}
      </button>

      {actions && <div className={styles.actions}>{actions}</div>}
    </article>
  );
}
