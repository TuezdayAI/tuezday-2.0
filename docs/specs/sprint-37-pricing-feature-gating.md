# Sprint 37 — Pricing plans & feature gating

- **Status:** planned (branch not yet cut — awaiting founder go-ahead, per one-sprint-at-a-time)
- **Roadmap item:** U5, A6 (billing) — `docs/plans/sprint-guide-21-onward.md`, "Sprint 37"
- **Branch:** `sprint-37-pricing-feature-gating`, cut from `main`
- **Merge order:** none. "Builds on: Sprint 19 (teams/workspaces), Sprint 27 (mailer)" — both on `main` (verified: `apps/api/src/services/teams.ts`, `apps/api/src/services/workspaces.ts`, `apps/api/src/mail/mailer.ts`). `main` HEAD is Sprint 31; Sprints 32/34/35/36 are unmerged branches and are **not** dependencies of this sprint.
- **Size:** L. Three slices, each founder-acceptable on its own: (A) plan model + entitlement gating, (B) Stripe checkout + webhook, (C) billing UI + receipts.
- **Do NOT merge into `main`.** Push the branch; the founder reviews, accepts, and merges. End commit messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

> **For agentic workers:** self-contained spec. Strict TDD — failing test first, run red, implement, run green, commit. Checkboxes track steps. REQUIRED SUB-SKILL: superpowers:executing-plans (or superpowers:subagent-driven-development).

---

## Goal

Turn Tuezday into a commercial product: **plans/tiers**, **entitlement enforcement** at the service boundary, and **Stripe** subscriptions with webhooks and receipts.

Founder acceptance (from the roadmap):

> A free workspace hits a gated feature → upgrade prompt → subscribe via Stripe → entitlement unlocks.

---

## Decisions locked (recommended defaults)

1. **Entitlements are the single gate — derived from plan, never hardcoded tier checks.** The boundary rule: every limited action calls one `entitlements` service function (`assertWithinLimit(db, workspaceId, key, currentCount)`); no route compares `plan === "free"` inline. Adding/retuning a limit touches one map.
2. **Plans are static config in `packages/contracts`; per-workspace state is only the subscription row.** `PLANS` maps each plan → `Entitlements` (seat cap, connector cap, monthly generation cap, ad-spend cap cents, `-1` = unlimited). A workspace's plan comes from its `subscriptions` row (default **free** when none). No per-workspace entitlement table in v1 (custom overrides are YAGNI; noted in Known limitations).
3. **Gated resources in v1: seats, connectors, monthly generations.** These have clean existing counts (`listMembers`, `listConnections`, generations in the current period). Ad-spend cap is defined in the plan map but enforced only where ad **execution** spends (Sprint 20) — noted, not faked here (no-compromise rule).
4. **Stripe over REST, no SDK** (matches `GeminiGateway`/Resend/Nango). Injected `fetcher`. Hosted Checkout (we never touch card data); the **webhook** is the source of truth for subscription state — Checkout success only redirects.
5. **Webhook signatures are verified** (`Stripe-Signature`, HMAC-SHA256 over `timestamp.payload` with the signing secret). An unverified webhook is `400`. The webhook route is public (Stripe is unauthenticated) but signature-gated.
6. **Receipts via the Sprint 27 `Mailer`** (Console default in dev). A successful subscription sends a receipt; failures never throw.
7. **Graceful when unconfigured:** no `STRIPE_SECRET_KEY` ⇒ checkout returns `503 billing_not_configured`; gating still works (everyone is on free). Enforcement can be globally relaxed with `BILLING_ENFORCED=false` for dev.

---

## Out of scope (YAGNI)

- Per-workspace custom entitlement overrides, usage-based metered billing, proration UI, annual plans, coupons, tax.
- Dunning automation beyond a single failed-payment email.
- Seat **purchasing** flows (seats are a cap; buying more = upgrading plan in v1).
- Ad-spend cap **enforcement** (defined in the plan map; wired where ad execution spends, Sprint 20).
- A web test runner (web verification = typecheck + build).

---

## Architecture & boundary

```
Route handler (consuming a limited resource)
  └─ entitlements.assertWithinLimit(db, wsId, "generations", count)  ──► EntitlementError → 402 upgrade_required
Billing
  Web → POST /workspaces/:id/billing/checkout ──► stripe.createCheckoutSession() → { url } → redirect to Stripe
  Stripe ──► POST /billing/webhook (public, signature-verified) ──► subscriptions service updates plan/status ──► Mailer receipt
  Web → GET /workspaces/:id/billing ──► current plan + entitlement usage
```

- **Native (owned):** the plan/entitlement model and the gate. **Integrated behind a boundary:** Stripe, reached only from `apps/api/src/billing/stripe.ts` via the injected fetcher.

### New files
- `apps/api/src/services/entitlements.ts` — `getPlan`, `getEntitlements`, `getUsage`, `assertWithinLimit`, `EntitlementError`.
- `apps/api/src/billing/stripe.ts` — `createCheckoutSession`, `verifyWebhookSignature`, `parseSubscriptionEvent`; `StripeError`.
- `apps/api/src/services/subscriptions.ts` — `getSubscription`, `upsertFromStripe`.
- `apps/api/src/routes/billing.ts` — checkout, webhook, GET billing.
- `apps/web/app/workspaces/[id]/billing/page.tsx` — plan + usage + upgrade.
- Tests: `apps/api/test/entitlements.test.ts`, `apps/api/test/stripe.test.ts`, `apps/api/test/billing.test.ts`.

### Modified files
- `packages/contracts/src/index.ts` — `PLANS`, `PLAN_IDS`, `Entitlements`, `entitlementUsageSchema`, `checkoutInputSchema`.
- `apps/api/src/db/schema.ts` — `subscriptions` table.
- `apps/api/drizzle/00NN_subscriptions.sql` — generated (next after `0022_rich_bloodstorm.sql` on `main`; renumber if it collides with another branch, per the repo's migration-regeneration practice).
- `apps/api/src/app.ts` — `registerBillingRoutes(app, db, mailer, fetcher)`; thread entitlement checks into existing routes (Task 4).
- `apps/api/src/auth/guard.ts` — add `POST /billing/webhook` to `PUBLIC_ROUTES`.
- `apps/api/src/routes/generations.ts`, `routes/connectors.ts`, `routes/teams.ts` — add the gate at the consuming action (Task 4).
- `.env.example` — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_SCALE`, `BILLING_ENFORCED`, `APP_BASE_URL`.

---

## Data model

```ts
// packages/contracts/src/index.ts
export const PLAN_IDS = ["free", "pro", "scale"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Entitlements {
  seats: number;          // -1 = unlimited
  connectors: number;
  monthlyGenerations: number;
  adSpendCapCents: number;
}

export const PLANS: Record<PlanId, { label: string; priceEnv: string | null; entitlements: Entitlements }> = {
  free:  { label: "Free",  priceEnv: null,                entitlements: { seats: 1,  connectors: 1,  monthlyGenerations: 50,   adSpendCapCents: 0 } },
  pro:   { label: "Pro",   priceEnv: "STRIPE_PRICE_PRO",  entitlements: { seats: 5,  connectors: 10, monthlyGenerations: 1000, adSpendCapCents: 500_00 } },
  scale: { label: "Scale", priceEnv: "STRIPE_PRICE_SCALE",entitlements: { seats: -1, connectors: -1, monthlyGenerations: -1,   adSpendCapCents: -1 } },
};
```

```ts
// apps/api/src/db/schema.ts
export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  plan: text("plan").notNull().default("free"),                 // PlanId
  status: text("status").notNull().default("active"),           // active|past_due|canceled
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  currentPeriodEnd: integer("current_period_end"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("subscriptions_workspace").on(t.workspaceId)]);
```

---

## Implementation plan (TDD, bite-sized)

> Baseline: `git checkout main && git pull`, `npm install`, `npm test` (record green count), `git checkout -b sprint-37-pricing-feature-gating`.

### Task 1: Plan/entitlement contracts + subscriptions schema
- [ ] **Test** (`packages/contracts/test/plans.test.ts`): `PLANS.free.entitlements.seats === 1`; `PLAN_IDS` contains `pro`; `checkoutInputSchema` rejects an unknown plan.
- [ ] **Run red** → implement `PLAN_IDS`/`PLANS`/`Entitlements`/`checkoutInputSchema = z.object({ plan: z.enum(["pro","scale"]) })`/`entitlementUsageSchema`.
- [ ] **Schema:** add `subscriptions` table; `npm run db:generate -w apps/api`.
- [ ] **Run green** + `npm test -w @tuezday/api` (migration applies). **Commit:** `feat: plan/entitlement contracts + subscriptions table`.

### Task 2: entitlements + subscriptions services
- [ ] **Test** (`apps/api/test/entitlements.test.ts`): a workspace with no subscription resolves to `free`; `getUsage` counts seats/connectors/generations; `assertWithinLimit` throws `EntitlementError` at the cap and passes under it; unlimited (`-1`) never throws; `BILLING_ENFORCED=false` disables throwing.
- [ ] **Run red** → implement:

```typescript
// apps/api/src/services/entitlements.ts
import { PLANS, type Entitlements, type PlanId } from "@tuezday/contracts";
import type { Db } from "../db";
import { getSubscription } from "./subscriptions";
import { listMembers } from "./teams";
import { listConnections } from "./connections";
import { countGenerationsSince } from "./generations"; // add: count in current 30-day window

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
  return {
    seats: listMembers(db, workspaceId).length,
    connectors: listConnections(db, workspaceId).length,
    monthlyGenerations: countGenerationsSince(db, workspaceId, periodStart),
  };
}
export function assertWithinLimit(db: Db, workspaceId: string, key: keyof Entitlements, current: number): void {
  if (process.env.BILLING_ENFORCED === "false") return;
  const limit = getEntitlements(db, workspaceId)[key];
  if (limit !== -1 && current >= limit) throw new EntitlementError(key, limit);
}
```

(Add `countGenerationsSince` to `services/generations.ts`; add `getSubscription`/`upsertFromStripe` to a new `services/subscriptions.ts`.)
- [ ] **Run green. Commit:** `feat(api): entitlements + subscriptions services`.

### Task 3: gate the consuming routes (the boundary) → 402
- [ ] **Test** (`apps/api/test/billing.test.ts`, part 1): on a free workspace, the 51st generate returns `402 upgrade_required`; a 2nd connector returns `402`; inviting a 2nd member returns `402`.
- [ ] **Run red** → in `routes/generations.ts` (before generating), `routes/connectors.ts` connect (before connect), `routes/teams.ts` invite/add (before add): call the gate and map the error, e.g.:

```typescript
import { assertWithinLimit, EntitlementError, getUsage } from "../services/entitlements";
// ...
try {
  assertWithinLimit(db, request.params.id, "monthlyGenerations", getUsage(db, request.params.id).monthlyGenerations);
} catch (err) {
  if (err instanceof EntitlementError) {
    return reply.status(402).send({ error: "upgrade_required", key: err.key, limit: err.limit });
  }
  throw err;
}
```

- [ ] **Run green** + full `npm test -w @tuezday/api`. **Commit:** `feat(api): entitlement gating at generate/connect/invite`.

### Task 4: Stripe client (checkout + webhook verification)
- [ ] **Test** (`apps/api/test/stripe.test.ts`, fixture fetcher): `createCheckoutSession` POSTs to `https://api.stripe.com/v1/checkout/sessions` with the price + success/cancel URLs and returns the session `url`; `verifyWebhookSignature` accepts a correctly-HMAC'd payload and rejects a tampered one; `parseSubscriptionEvent` maps `checkout.session.completed` / `customer.subscription.deleted` to `{ workspaceId, plan, status, … }`.
- [ ] **Run red** → implement `apps/api/src/billing/stripe.ts` (REST, `application/x-www-form-urlencoded` bodies; `client_reference_id = workspaceId`; HMAC-SHA256 signature check over `${t}.${payload}` from the `Stripe-Signature` header with `STRIPE_WEBHOOK_SECRET`, with a timestamp tolerance). **Commit:** `feat(api): Stripe REST client (checkout + signed webhook)`.

### Task 5: billing routes + receipt
- [ ] **Test** (`apps/api/test/billing.test.ts`, part 2): `GET /workspaces/:id/billing` returns plan `free` + usage; `POST /workspaces/:id/billing/checkout {plan:"pro"}` returns a `url` (injected Stripe fetcher) and `503` when unconfigured; `POST /billing/webhook` with a valid signature flips the workspace to `pro` (and a follow-up `GET billing` shows `pro`); an invalid signature is `400`; the webhook is **public** (no bearer token needed).
- [ ] **Run red** → add `POST /billing/webhook` to `PUBLIC_ROUTES`; `registerBillingRoutes(app, db, mailer, fetcher)` in `app.ts`; implement the three handlers (webhook calls `subscriptions.upsertFromStripe` then `mailer.send(receipt)` best-effort).
- [ ] **Run green** + full `npm test`. **Commit:** `feat(api): billing routes (checkout, webhook, status) + receipt email`.

### Task 6: billing UI
- [ ] Add `apps/web/app/workspaces/[id]/billing/page.tsx`: current plan, usage bars (from `GET billing`), and **Upgrade** buttons (POST checkout → `window.location = url`). When any gated call returns `402`, surface an inline "Upgrade to continue" prompt linking to billing (handle the `402` in the shared `apiFetch` or per-call).
- [ ] **Verify:** `npm run typecheck -w @tuezday/web && npm run build -w @tuezday/web`. **Commit:** `feat(web): billing page + upgrade prompts`.

### Task 7: env + whole-repo verify + push
- [ ] Append the `STRIPE_*` / `BILLING_ENFORCED` / `APP_BASE_URL` vars to `.env.example` (with setup notes: create Products/Prices in Stripe, set the webhook endpoint to `${APP_BASE_URL}/billing/webhook`).
- [ ] `npm test && npm run typecheck` green. **Commit:** `docs: billing env vars`. Then `git push -u origin sprint-37-pricing-feature-gating` (**do not merge**).

---

## Automated verification
- Contracts: plan map + checkout input.
- entitlements: free default, usage counts, assert at/over/under cap, unlimited, `BILLING_ENFORCED=false` bypass.
- Stripe (fixture fetcher): checkout request shape; signature accept/reject; event parsing.
- Routes: 402 on each gated action; checkout url + 503 unconfigured; webhook flips plan; invalid signature 400; webhook public.
- Web: typecheck + build.

## Founder acceptance checklist
- [ ] A free workspace generates until the cap → next generate shows an **upgrade prompt** (402).
- [ ] Click Upgrade → Stripe Checkout (test mode) → pay → redirected back; the webhook flips the workspace to Pro and the gated feature now works.
- [ ] A receipt email is logged/sent.
- [ ] With `STRIPE_*` unset, the app runs; checkout reports "billing not configured"; everyone is on free.

## Known limitations
- No custom per-workspace entitlement overrides; no metered/usage billing; ad-spend cap is defined but enforced only at ad execution (Sprint 20).
- Monthly generation window is a rolling 30 days, not aligned to the Stripe billing period (acceptable for v1; align when metered billing lands).
- Single failed-payment email; no full dunning sequence.

## Progress log
- 2026-06-26 — Spec drafted against `main` (HEAD Sprint 31). Verified reuse points: `teams.ts` (`listMembers`/`createInvite`/`addMember`), `connections.ts` (`listConnections`), `mailer.ts` (`Mailer`/`ConsoleMailer`), `auth/guard.ts` `PUBLIC_ROUTES`, `WORKSPACE_ROLES = [owner, member]`. Highest migration on `main` = `0022_rich_bloodstorm.sql`. Sprint 34/35/36 unmerged and not required. Branch not yet cut (awaiting founder go-ahead).
- 2026-06-27 — Re-saved after the untracked working-tree copy was lost during branch switches; content unchanged.
