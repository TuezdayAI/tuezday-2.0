import type { TaskType } from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// One task-type label map (Sprint 78, closing the D-76.6 half-deviation).
//
// Four surfaces used to declare this map each. Sprint 76 tried to narrow them
// to GENERATION_TASK_TYPES and could not: /learning, /sandbox and /resolver
// index the map with a task type read off a STORED ROW, so a narrowed map turns
// a legitimate lookup into a type error and, at runtime, an undefined label.
//
// The resolution is that offering a task and labelling one are different
// questions, which the duplication was hiding:
//
//   - LABELLING is total over TaskType. Anything the platform can store, it
//     must be able to display. `gtm_conversation` belongs here.
//   - OFFERING iterates GENERATION_TASK_TYPES. A picker that let a founder
//     generate a "GTM conversation" would be offering a thing that does not
//     exist as an output.
//
// Both live in one place now, so the next task type is added once.
// ---------------------------------------------------------------------------

export const TASK_LABELS: Record<TaskType, string> = {
  linkedin_post: "LinkedIn post",
  cold_email_opener: "Cold email opener",
  ad_copy_variant: "Ad copy variant",
  landing_page_hero: "Landing page hero",
  signal_response: "Signal response",
  outbound_email: "Outbound email",
  meta_ad_creative: "Meta ad creative",
  google_rsa: "Google RSA",
  pr_pitch: "Media pitch",
  press_boilerplate: "Press boilerplate",
  x_dm: "X DM",
  instagram_post: "Instagram post",
  engagement_reply: "Reply",
  instagram_carousel: "Instagram carousel",
  // Labelled, never offered — see the note above.
  gtm_conversation: "GTM conversation",
};

/**
 * The label for a task type read off a stored row, which may be a value this
 * build does not know (an older row, a newer server). Falls back to the raw
 * value rather than rendering "undefined".
 */
export function taskTypeLabel(taskType: string): string {
  return TASK_LABELS[taskType as TaskType] ?? taskType;
}
