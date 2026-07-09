import React from "react";
import styles from "./empty-state.module.css";

interface EmptyStateProps {
  title?: string;
  description: string | React.ReactNode;
  icon?: React.ReactNode;
  primaryAction?: React.ReactNode;
}

export function EmptyState({ title, description, icon, primaryAction }: EmptyStateProps) {
  return (
    <div className={styles.wrap}>
      {icon && <div className={styles.icon}>{icon}</div>}
      {title && <h3 className={styles.title}>{title}</h3>}
      <div className={styles.description}>{description}</div>
      {primaryAction && <div className={styles.action}>{primaryAction}</div>}
    </div>
  );
}
