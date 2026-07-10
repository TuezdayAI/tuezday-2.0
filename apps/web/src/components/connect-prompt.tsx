// apps/web/src/components/connect-prompt.tsx — spec §5.7.3.
// The contextual "connect at the moment of need" card. Value promise is a GTM
// outcome, not a feature description.
import styles from "./connect-prompt.module.css";
import { BrandIcon } from "./ui/icon";
import type { BrandName } from "./ui/brand-icons";
import { Button } from "./ui/button";

const PROVIDER_LABEL: Record<BrandName, string> = {
  linkedin: "LinkedIn", x: "X", reddit: "Reddit", instagram: "Instagram",
  meta: "Meta", google: "Google", freshsales: "Freshsales",
};

interface ConnectPromptProps {
  provider: BrandName;
  /** One-line GTM value promise, e.g. "Publish approved posts on schedule". */
  promise: string;
  onConnect: () => void;
  connecting?: boolean;
}

export function ConnectPrompt({ provider, promise, onConnect, connecting = false }: ConnectPromptProps) {
  const label = PROVIDER_LABEL[provider];
  return (
    <div className={styles.prompt}>
      <BrandIcon name={provider} size="lg" brandColor className={styles.mark} />
      <div className={styles.copy}>
        <div className={styles.title}>Connect {label}</div>
        <div className={styles.promise}>{promise}</div>
      </div>
      <Button variant="primary" size="sm" onClick={onConnect} disabled={connecting}>
        {connecting ? "Connecting…" : "Connect"}
      </Button>
    </div>
  );
}
