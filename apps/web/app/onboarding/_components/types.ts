/**
 * Shared contract between the onboarding wizard shell (page.tsx) and its
 * per-step panels (Sprint 36.5). Each panel owns its own data fetching via
 * apiFetch; the shell owns the step cursor.
 */
export interface WizardPanelProps {
  workspaceId: string;
  /** The user's name, for greetings inside panels. */
  userName: string;
  /**
   * Advance the wizard: PATCHes the workspace's onboarding cursor to the next
   * step and moves the UI on success. Rejections (e.g. the 36.3 min-1 social
   * gate's 409) surface through onError — the panel just awaits.
   */
  onContinue: () => Promise<void>;
  /** Show (or clear, with null) the wizard-level error line. */
  onError: (message: string | null) => void;
}
