"use client";
// apps/web/src/components/ui/settings-modal.tsx — spec §6.6.
// Centered modal over a blurred canvas; serif title; optional left subnav;
// Save → caller fires toast("Settings saved") on success.
import { useEffect, type ReactNode } from "react";
import styles from "./settings-modal.module.css";
import { Button } from "./button";
import { Icon } from "./icon";

interface SettingsSection { id: string; label: string; }

interface SettingsModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  saving?: boolean;
  /** >1 settings group → left subnav (spec §6.6). */
  sections?: SettingsSection[];
  activeSection?: string;
  onSectionChange?: (id: string) => void;
  children: ReactNode;
}

export function SettingsModal({
  title, open, onClose, onSave, saving = false,
  sections, activeSection, onSectionChange, children,
}: SettingsModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={title}>
        <header className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <Icon name="close" size="sm" />
          </button>
        </header>
        <div className={styles.body}>
          {sections && sections.length > 1 && (
            <nav className={styles.subnav} aria-label={`${title} sections`}>
              {sections.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`${styles.subnavItem} ${s.id === activeSection ? styles.subnavActive : ""}`}
                  onClick={() => onSectionChange?.(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </nav>
          )}
          <div className={styles.content}>{children}</div>
        </div>
        <footer className={styles.foot}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
