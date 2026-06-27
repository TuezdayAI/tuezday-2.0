import React from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string | React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && (
          <div className="subtitle">
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
