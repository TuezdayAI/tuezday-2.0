// apps/web/src/components/ui/input.tsx
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import styles from "./input.module.css";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const classes = [styles.field, className].filter(Boolean).join(" ");
  return <input className={classes} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const classes = [styles.field, styles.textarea, className].filter(Boolean).join(" ");
  return <textarea className={classes} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const classes = [styles.field, styles.select, className].filter(Boolean).join(" ");
  return (
    <select className={classes} {...rest}>
      {children}
    </select>
  );
}
