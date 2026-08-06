// Pure view helpers for the deliverables page (Sprint 63) — kept in lib so
// they are unit-tested (node env). All judgment data comes from the API;
// these only derive presentation facts (latest variant, legal actions, slot
// labels). Transition legality always defers to the contracts machine.

import {
  canTransitionDeliverable,
  type Deliverable,
  type DeliverableDecisionAction,
  type Variant,
} from "@tuezday/contracts";

/** Latest variant by version — never assumes the API sort order. */
export function latestVariant(variants: Variant[]): Variant | undefined {
  let latest: Variant | undefined;
  for (const variant of variants) {
    if (!latest || variant.variantVersion > latest.variantVersion) {
      latest = variant;
    }
  }
  return latest;
}

/** Candidates the operator may select, newest first. */
export function selectableVariants(variants: Variant[]): Variant[] {
  return variants
    .filter((variant) => variant.status === "candidate")
    .sort((a, b) => b.variantVersion - a.variantVersion);
}

/**
 * Slot label: the planned slot's local date/time, or "Reactive" for
 * fan-out-born deliverables without a slot.
 */
export function slotLabel(deliverable: Pick<Deliverable, "kind" | "originalScheduledFor">): string {
  if (deliverable.kind === "reactive" || deliverable.originalScheduledFor === null) {
    return "Reactive";
  }
  return new Date(deliverable.originalScheduledFor).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * "Generate now" is offered when the queue would actually claim the
 * deliverable: a package is attached and generation is pending (or parked
 * `failed`, where the button doubles as the operator retry via regenerate).
 */
export function canGenerateNow(
  deliverable: Pick<Deliverable, "status" | "generationState" | "packageId">,
): boolean {
  if (deliverable.packageId === null) return false;
  if (deliverable.status !== "ready" && deliverable.status !== "candidate_ready") {
    return false;
  }
  return deliverable.generationState === "pending";
}

/**
 * Decision actions legal for the current status — mirrors the server rules:
 * regenerate is a queue action on ready/candidate_ready (with a package),
 * select needs candidate_ready, cancel follows the machine.
 */
export function actionsFor(
  deliverable: Pick<Deliverable, "status" | "packageId">,
): DeliverableDecisionAction[] {
  const actions: DeliverableDecisionAction[] = [];
  if (
    deliverable.packageId !== null &&
    (deliverable.status === "ready" || deliverable.status === "candidate_ready")
  ) {
    actions.push("regenerate");
  }
  if (deliverable.status === "candidate_ready") actions.push("select");
  if (canTransitionDeliverable(deliverable.status, "cancelled")) actions.push("cancel");
  return actions;
}
