import { canonicalActionFingerprint } from "./external-action-fingerprint";

/**
 * Deliberately narrow identity for *exactly what a human approved* (Sprint 52).
 *
 * The external-action intent fingerprint hashes destination, timing and the
 * resolved policy — none of which exist at approval time — so it can never
 * match. This hashes content only, over the draft's identity, its text, and
 * its rendered visuals.
 *
 * `mediaJson` is included on purpose: approving the text and then swapping the
 * image must invalidate the approval and re-arm the second gate.
 */
export function draftApprovalFingerprint(draft: {
  id: string;
  content: string;
  mediaJson: string | null;
}): string {
  return canonicalActionFingerprint({
    draftId: draft.id,
    content: draft.content,
    media: draft.mediaJson ?? null,
  });
}
