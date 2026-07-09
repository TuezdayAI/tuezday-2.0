// apps/web/src/components/ui/badge.tsx
import type { HTMLAttributes, ReactNode } from "react";
import styles from "./badge.module.css";

type BadgeTone = "neutral" | "approved" | "pending" | "edited" | "rejected" | "draft" | "danger";

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
