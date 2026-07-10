"use client";
// Event-based toast, same dispatch pattern as the existing upgrade_required
// modal. Fire from anywhere: toast("Settings saved").
import { useEffect, useState } from "react";
import styles from "./toast.module.css";

const EVENT = "tz_toast";
let nextId = 0;

export function toast(message: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { message } }));
}

interface ToastItem { id: number; message: string; }

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const onToast = (e: Event) => {
      const { message } = (e as CustomEvent).detail as { message: string };
      const id = nextId++;
      setItems((prev) => [...prev, { id, message }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3200);
    };
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);
  if (items.length === 0) return null;
  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={styles.toast}>{t.message}</div>
      ))}
    </div>
  );
}
