"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

interface BrainDocTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
}

export function BrainTemplates({ onApply }: { onApply: (content: string) => void }) {
  const [templates, setTemplates] = useState<BrainDocTemplate[] | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch("/brain/templates")
      .then(async (res) => {
        if (!res.ok) throw new Error("failed");
        const data = await res.json();
        if (active) setTemplates(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!templates || templates.length === 0) return null;

  return (
    <div className="brain-templates">
      <h3>Not sure where to start?</h3>
      <p>Click a template to apply it, then edit as needed.</p>
      <ul className="template-list">
        {templates.map((t) => (
          <li key={t.id} className="template-card">
            <div className="template-head">
              <strong>{t.name}</strong>
            </div>
            <p className="template-desc">{t.description}</p>
            <button className="button-secondary template-apply" onClick={() => onApply(t.content)}>
              Apply template
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
