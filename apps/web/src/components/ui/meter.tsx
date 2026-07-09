// apps/web/src/components/ui/meter.tsx
import styles from "./meter.module.css";

export type MeterState = "ok" | "near" | "over" | "unlimited";

interface MeterProps {
  label: string;
  figure: string;
  percent: number;
  state: MeterState;
}

export function Meter({ label, figure, percent, state }: MeterProps) {
  return (
    <div>
      <div className={styles.head}>
        <span className={styles.title}>{label}</span>
        <span className={styles.figure}>{figure}</span>
      </div>
      <div className={styles.track}>
        <div
          className={`${styles.fill} ${styles[state]}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}
