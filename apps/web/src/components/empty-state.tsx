import React from "react";

interface EmptyStateProps {
  title?: string;
  description: string | React.ReactNode;
  icon?: React.ReactNode;
  primaryAction?: React.ReactNode;
}

export function EmptyState({ title, description, icon, primaryAction }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      {title && <h3>{title}</h3>}
      <div className="empty">{description}</div>
      {primaryAction && <div className="empty-state-action">{primaryAction}</div>}
    </div>
  );
}
