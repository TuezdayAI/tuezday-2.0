import React from "react";
import styles from "./empty-state.module.css";

interface EmptyStateProps {
  title?: string;
  description: string | React.ReactNode;
  icon?: React.ReactNode;
  primaryAction?: React.ReactNode;
  /** Preview-value mode (spec §6.5): blurred sample content rendered behind
   * the centered copy/action — previews value instead of showing a blank page. */
  preview?: React.ReactNode;
}

export function EmptyState({ title, description, icon, primaryAction, preview }: EmptyStateProps) {
  const center = (
    <div className={styles.wrap}>
      {icon && <div className={styles.icon}>{icon}</div>}
      {title && <h3 className={styles.title}>{title}</h3>}
      <div className={styles.description}>{description}</div>
      {primaryAction && <div className={styles.action}>{primaryAction}</div>}
    </div>
  );
  if (!preview) return center;
  return (
    <div className={styles.previewShell}>
      <div className={styles.previewBackdrop} aria-hidden="true">
        {preview}
      </div>
      <div className={styles.previewCenter}>{center}</div>
    </div>
  );
}
