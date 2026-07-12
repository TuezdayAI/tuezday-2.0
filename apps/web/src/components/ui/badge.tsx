// apps/web/src/components/ui/badge.tsx
import type { HTMLAttributes, ReactNode } from "react";
import type { WorkflowStatus } from "@tuezday/contracts";
import { workflowStatusView } from "@/lib/workflow-status";
import styles from "./badge.module.css";
import { formatCount, formatProgress } from "../../../lib/badge-format";
import { Icon } from "./icon";

type StateTone = "neutral" | "approved" | "pending" | "edited" | "rejected" | "draft" | "danger";
type NavTone = "belief" | "voice" | "history" | "icp" | "system" | "signal";
type BadgeTone = StateTone | NavTone;

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children: ReactNode;
}

export function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  const classes = [styles.badge, styles[tone], className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}

interface CountBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  count: number;
  /** When set, renders progress "count/max" (e.g. Integrations 1/5). */
  max?: number;
  /** Screen-reader context, e.g. "drafts waiting for review". */
  label?: string;
}

/** Passive muted state count — never animated, never accent-colored (spec §5.3). */
export function CountBadge({ count, max, label, className, ...rest }: CountBadgeProps) {
  const text = max != null ? formatProgress(count, max) : formatCount(count);
  const classes = [styles.badge, styles.count, className].filter(Boolean).join(" ");
  return (
    <span className={classes} aria-label={label ? `${text} ${label}` : undefined} {...rest}>
      {text}
    </span>
  );
}

interface GuideDotProps {
  /** Hover explanation, e.g. "1 draft waiting for review". */
  reason: string;
}

/** THE guide dot — exactly one may be rendered app-wide at any moment (spec §5.3). */
export function GuideDot({ reason }: GuideDotProps) {
  return <span className={styles.guideDot} title={reason} role="status" aria-label={reason} />;
}

interface WorkflowStatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  status: WorkflowStatus;
  label?: string;
}

export function WorkflowStatusBadge({
  status,
  label,
  className,
  ...rest
}: WorkflowStatusBadgeProps) {
  const view = workflowStatusView(status);
  const classes = [styles.badge, styles.workflow, styles[view.family], className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} data-workflow-status={status} {...rest}>
      <Icon name={view.icon} size="sm" />
      <span>{label ?? view.label}</span>
    </span>
  );
}
