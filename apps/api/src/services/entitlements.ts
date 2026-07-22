import { PLANS, type Entitlements, type PlanId } from "@tuezday/contracts";
import type { Db } from "../db";
import { getSubscription } from "./subscriptions";
import { listMembers } from "./teams";
import { listConnections } from "./connections";
import { countGenerationsSince } from "./generations";
import { countCompletedRevisionTurnsSince } from "./draft-revisions";

export class EntitlementError extends Error {
  constructor(public readonly key: keyof Entitlements, public readonly limit: number) {
    super(`Plan limit reached for ${key} (limit ${limit}).`);
    this.name = "EntitlementError";
  }
}

export function getPlan(db: Db, workspaceId: string): PlanId {
  const sub = getSubscription(db, workspaceId);
  return sub && sub.status === "active" ? (sub.plan as PlanId) : "free";
}

export function getEntitlements(db: Db, workspaceId: string): Entitlements {
  return PLANS[getPlan(db, workspaceId)].entitlements;
}

export function getUsage(db: Db, workspaceId: string) {
  const periodStart = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const monthlyGenerationCount = countGenerationsSince(db, workspaceId, periodStart);
  const monthlyRevisionCount = countCompletedRevisionTurnsSince(db, workspaceId, periodStart);
  return {
    seats: listMembers(db, workspaceId).length,
    connectors: listConnections(db, workspaceId).length,
    monthlyGenerations: monthlyGenerationCount + monthlyRevisionCount,
  };
}

export function assertWithinLimit(db: Db, workspaceId: string, key: keyof Entitlements, current: number): void {
  if (process.env.NODE_ENV === "test" && !process.env.TEST_BILLING_GATING) {
    return;
  }
  if (process.env.BILLING_ENFORCED === "false") return;
  const limit = getEntitlements(db, workspaceId)[key];
  if (limit !== -1 && current >= limit) throw new EntitlementError(key, limit);
}
