import type {
  AuthorizationBatchDetail,
  AuthorizationBatchSelection,
  ExternalAction,
  ExternalActionKind,
} from "@tuezday/contracts";

export const SELECTED_AUTHORIZATION_LIMIT = 25;

/** Build the bounded campaign preview request. `null` deliberately means all kinds. */
export function campaignBatchSelection(
  campaignId: string,
  kinds: ExternalActionKind[] | null,
): AuthorizationBatchSelection {
  if (kinds?.length === 0) {
    throw new Error("Select at least one action kind, or include all action kinds.");
  }
  if (kinds && new Set(kinds).size !== kinds.length) {
    throw new Error("Campaign action kinds cannot contain duplicates.");
  }
  return {
    mode: "campaign",
    campaignId,
    kinds: kinds ? [...kinds] : null,
  };
}

/** Return the explicit, still-authorizable selection in the queue's stable order. */
export function selectedAuthorizationIds(
  actions: ExternalAction[],
  selection: ReadonlySet<string>,
): string[] {
  const ids = actions
    .filter(
      (action) => action.status === "authorization_required" && selection.has(action.id),
    )
    .map((action) => action.id);
  if (ids.length > SELECTED_AUTHORIZATION_LIMIT) {
    throw new Error(`Select no more than ${SELECTED_AUTHORIZATION_LIMIT} authorizations.`);
  }
  return ids;
}

export interface AuthorizationBatchSummary {
  included: number;
  excluded: number;
  pending: number;
  succeeded: number;
  scheduled: number;
  failed: number;
  blocked: number;
  stale: number;
  isPartial: boolean;
}

/** Counts stored batch outcomes without treating partial completion as success. */
export function authorizationBatchSummary(
  detail: AuthorizationBatchDetail,
): AuthorizationBatchSummary {
  const count = (status: AuthorizationBatchDetail["items"][number]["status"]) =>
    detail.items.filter((item) => item.status === status).length;
  return {
    included: detail.batch.includedCount,
    excluded: detail.batch.excludedCount,
    pending: count("pending"),
    succeeded: count("succeeded"),
    scheduled: count("scheduled"),
    failed: count("failed"),
    blocked: count("blocked"),
    stale: count("stale"),
    isPartial: detail.batch.status === "partially_completed",
  };
}
