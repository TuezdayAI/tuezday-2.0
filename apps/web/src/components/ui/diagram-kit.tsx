// apps/web/src/components/ui/diagram-kit.tsx — spec §6.3.
// Show-your-work primitives, drawn at 1.75 stroke with hairlines — penned, not imported.
import styles from "./diagram-kit.module.css";
import { Icon, type IconName } from "./icon";

interface FlowNode {
  icon: IconName;
  label: string;
  detail?: string;
  emphasis?: boolean;
}

/** Connected icon nodes: soul → icp → voice → now → bundle (resolver trace). */
export function FlowStrip({ nodes }: { nodes: FlowNode[] }) {
  return (
    <div className={styles.flow} role="list">
      {nodes.map((node, i) => (
        <div key={node.label} className={styles.flowSeg} role="listitem">
          <div className={`${styles.node} ${node.emphasis ? styles.nodeEmphasis : ""}`}>
            <Icon name={node.icon} size="compact" />
            <span className={styles.nodeLabel}>{node.label}</span>
            {node.detail && <span className={styles.nodeDetail}>{node.detail}</span>}
          </div>
          {i < nodes.length - 1 && <span className={styles.connector} aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}

type NavTone = "belief" | "voice" | "history" | "icp" | "system" | "signal";

interface DocTileProps {
  icon: IconName;
  title: string;
  tone: NavTone;
  /** e.g. "updated 2h ago" */
  freshness: string;
  /** e.g. "by learning loop" | "by Varun" */
  updatedBy: string;
  onOpen?: () => void;
}

/** Brain-doc tile: tone icon + freshness + update source (spec §5.6). */
export function DocTile({ icon, title, tone, freshness, updatedBy, onOpen }: DocTileProps) {
  return (
    <button type="button" className={styles.tile} data-tone={tone} onClick={onOpen} disabled={!onOpen}>
      <span className={styles.tileIcon}>
        <Icon name={icon} size="emphasized" />
      </span>
      <span className={styles.tileTitle}>{title}</span>
      <span className={styles.tileMeta}>
        {freshness} · {updatedBy}
      </span>
    </button>
  );
}

interface LoopGlyphProps {
  /** What was observed, e.g. "12 approvals this week". */
  signal: string;
  /** What it changed, e.g. "voice: shorter openers". */
  change: string;
  icon?: IconName;
}

/** Learning-loop entry: signal → change (spec §6.3). */
export function LoopGlyph({ signal, change, icon = "status-learning" }: LoopGlyphProps) {
  return (
    <div className={styles.loop}>
      <Icon name={icon} size="compact" className={styles.loopIcon} />
      <span className={styles.loopSignal}>{signal}</span>
      <span className={styles.loopArrow} aria-hidden="true">→</span>
      <span className={styles.loopChange}>{change}</span>
    </div>
  );
}
