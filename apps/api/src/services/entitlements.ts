import { PLANS, type Entitlements, type EntitlementUsage, type PlanId } from "@tuezday/contracts";
import type { Db } from "../db";
import { getSubscription } from "./subscriptions";
import { listMembers } from "./teams";
import { listConnections } from "./connections";
import { sumLlmSpendCents } from "./usage-ledger";

/** The rolling usage window — kept from the old monthlyGenerations semantics.
 * Stripe-period alignment is a deliberate non-goal this sprint (spec 59 §8.3). */
export const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class EntitlementError extends Error {
  constructor(public readonly key: keyof Entitlements, public readonly limit: number) {
    super(`Plan limit reached for ${key} (limit ${limit}).`);
    this.name = "EntitlementError";
  }
}

export async function getPlan(db: Db, workspaceId: string): Promise<PlanId> {
  const sub = await getSubscription(db, workspaceId);
  return sub && sub.status === "active" ? (sub.plan as PlanId) : "free";
}

export async function getEntitlements(db: Db, workspaceId: string): Promise<Entitlements> {
  return PLANS[(await getPlan(db, workspaceId))].entitlements;
}

export async function getUsage(db: Db, workspaceId: string): Promise<EntitlementUsage> {
  const periodStart = Date.now() - USAGE_WINDOW_MS;
  return {
    seats: (await listMembers(db, workspaceId)).length,
    connectors: (await listConnections(db, workspaceId)).length,
    // D6 (Sprint 59): the LLM entitlement is denominated in cost, summed from
    // the usage ledger — not a generation count.
    monthlyLlmCents: await sumLlmSpendCents(db, workspaceId, periodStart),
  };
}

function billingEnforced(): boolean {
  if (process.env.NODE_ENV === "test" && !process.env.TEST_BILLING_GATING) return false;
  return process.env.BILLING_ENFORCED !== "false";
}

export async function assertWithinLimit(db: Db, workspaceId: string, key: keyof Entitlements, current: number): Promise<void> {
  if (!billingEnforced()) return;
  const limit = (await getEntitlements(db, workspaceId))[key];
  if (limit !== -1 && current >= limit) throw new EntitlementError(key, limit);
}

/** Hard stop for interactive LLM routes: throws EntitlementError (mapped to
 * 402 upgrade_required by the app error handler) when the workspace's rolling
 * LLM spend has reached its plan budget. Fires BEFORE any model call. */
export async function assertLlmBudget(db: Db, workspaceId: string): Promise<void> {
  if (!billingEnforced()) return;
  await assertWithinLimit(db, workspaceId, "monthlyLlmCents", (await getUsage(db, workspaceId)).monthlyLlmCents);
}

/** Soft check for worker paths: over-budget work is skipped and left pending
 * (the queue is the pending state), never failed mid-run. */
export async function llmBudgetExhausted(db: Db, workspaceId: string): Promise<boolean> {
  if (!billingEnforced()) return false;
  const limit = (await getEntitlements(db, workspaceId)).monthlyLlmCents;
  if (limit === -1) return false;
  return (await getUsage(db, workspaceId)).monthlyLlmCents >= limit;
}
