# Desktop Platform Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining governed Meta/email/policy/priority capabilities and migrate Tuezday to one desktop-grade action and icon system through independently resumable coding-agent sessions.

**Architecture:** Extend the existing external-action coordinator rather than creating parallel execution paths. Provider-specific Meta and Resend code remains behind injected interfaces; durable batches and email deliveries record partial outcomes honestly. Every UI capability lives on its owning surface and consumes contract-owned vocabulary, while shared desktop primitives replace page-level button/icon styling incrementally.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle ORM + SQLite, injectable Meta Graph/Nango and Resend HTTP adapters, Svix webhook verification, Next.js 15 App Router, React 19, CSS Modules, Lucide, Vitest, Playwright.

## Sprint Map

| Sprint | Agent sessions | Outcome | Release checkpoint |
|---|---:|---|---|
| 1 — Desktop controls and scoped policy | 1–6 | Shared 36/40/44px actions, refined icons, conflict-safe persona/connection/lane editors | Policy suites + web typecheck |
| 2 — Governed Meta mutations | 7–11 | Real Meta budget and country/age changes with provider revalidation and owning UI | Meta/action regression suites |
| 3 — Batch authorization | 12–16 | Durable selected and campaign-wide previews, bounded confirmation, partial results, resume | Batch persistence/API/Review suites |
| 4 — Native email foundation | 17–24 | Sender verification, permissions, suppression, caps, Resend send/webhook delivery, shared UI | Email provider/safety/delivery suites |
| 5 — Native email origins | 25–27 | Launches/sequences, Outbound, and PR send through governed external actions | Origin and social-send regression suites |
| 6 — Home completion | 28–31 | Signal, learning, connection-health, and campaign-risk sources in one ranked queue | Priority API/Home suites |
| 7 — Desktop UI convergence | 32–35 | Every product, setup, and onboarding action migrated; compatibility aliases removed | Repository-wide action/icon audit |
| 8 — Acceptance and release | 36–37 | Deterministic four-width evidence, full gates, migrations, registry, and progress record | Full test/typecheck/build/desktop gates |

Each numbered session is deliberately smaller than a sprint. Stop at any release checkpoint if product review or provider credentials are needed; the next sprint starts only from a green, committed checkpoint.

## Global Constraints

- Commit this plan on `ui-revamp/external-action-authorization`, then create `ui-revamp/desktop-platform-completion` from that planning commit in an isolated worktree before Task 1. The approved design baseline is `8c71381`.
- Design of record: `docs/superpowers/specs/2026-07-15-desktop-platform-completion-design.md`.
- One task equals one coding-agent session, one RED/GREEN cycle, one reviewable commit, and one progress-log entry.
- Run every command unpiped. Every task ends with its focused tests and `npm run typecheck` exit 0.
- Enum vocabularies and public schemas live only in `@tuezday/contracts`; API and web code import them.
- External actions use `canTransitionExternalAction()` and the shared coordinator. No route, UI, worker, or batch may invoke Meta or Resend around it.
- Workspace/campaign rules may be autonomous or human-required. Persona, connection, and lane rules are tightening-only and expose `inherit|human_required`.
- Content approval, paid-launch setup approval, and external-action authorization remain separate records and controls.
- Provider clients, fetchers, analytics, clocks, and webhook verifiers remain injectable. Automated tests never access Meta, Resend, DNS, or other networks.
- Store money as integer minor units. Never store provider secrets in action snapshots, database JSON, logs, analytics, or client responses.
- Resend send calls use `Idempotency-Key` values no longer than 256 characters. Tuezday's durable receipt remains the source of truth beyond Resend's 24-hour idempotency window.
- Resend webhook verification uses the raw request body and `svix-id`, `svix-timestamp`, and `svix-signature` headers before parsing or mutating state.
- No page imports `lucide-react` directly. Product icons resolve through `ICON_REGISTRY`; provider marks resolve through `BRAND_ICONS`.
- Desktop visual acceptance targets exactly 1024, 1280, 1440, and 1728px. Mobile screenshots and mobile layout are not release gates.
- Generate migrations with `npm run db:generate -w apps/api`; never hand-write migration SQL.
- Do not change login/session semantics, onboarding, dev-admin bootstrap, or environment-loading behavior. The only public-route additions are the signed unsubscribe endpoint and the signature-verified Resend webhook.
- Do not add Google Ads execution, broader Meta targeting, SMTP, another email provider, batch content approval, or distributed queue infrastructure.
- Before final push, run `npm test`, `npm run typecheck`, and `npm run build -w apps/web` unpiped and record exact counts/exit codes.

---

### Task 1: Establish the desktop action primitives

**Files:**
- Modify: `apps/web/src/components/ui/button.tsx`
- Modify: `apps/web/src/components/ui/button.module.css`
- Modify: `apps/web/app/tokens.css`
- Create: `apps/web/lib/button-system.test.ts`

**Interfaces:**
- Produces exported `ButtonVariant`, `ButtonSize`, `Button`, `ButtonLink`, and `IconButton`.
- `ButtonVariant = "primary" | "secondary" | "tertiary" | "danger"`.
- `ButtonSize = "compact" | "standard" | "large"` maps to 36/40/44px minimum heights.
- `Button` and `ButtonLink` accept `loading?: boolean`, `leadingIcon?: ReactNode`, and preserve label width while loading.
- `IconButton` requires `label`, supports `size?: "compact" | "standard"`, and renders a tooltip through `title` when none is supplied.

- [x] **Step 1: Write the failing desktop button contract test**

```ts
it("defines the approved desktop hierarchy and sizes", () => {
  expect(source).toContain('type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger"');
  expect(source).toContain("export function ButtonLink");
  expect(css).toMatch(/\.large[\s\S]*min-height:\s*44px/);
  expect(css).toMatch(/\.standard[\s\S]*min-height:\s*40px/);
  expect(css).toMatch(/\.compact[\s\S]*min-height:\s*36px/);
  expect(css).toMatch(/\.iconStandard[\s\S]*width:\s*40px[\s\S]*height:\s*40px/);
  expect(css).toMatch(/\.primary[\s\S]*background:\s*var\(--button-primary\)/);
});
```

- [x] **Step 2: Run the test and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/button-system.test.ts`  
Expected: FAIL because the current component exposes `ghost`, `sm|md`, 32px icon buttons, and no `ButtonLink`.

- [x] **Step 3: Add action tokens and implement the primitives**

Add these semantic tokens:

```css
--button-primary: var(--ink);
--button-primary-hover: color-mix(in oklch, var(--ink) 88%, white);
--button-primary-ink: var(--surface);
--button-danger: var(--status-blocked);
--control-compact: 36px;
--control-standard: 40px;
--control-large: 44px;
```

Render loading state without changing the accessible name:

```tsx
const content = (
  <>
    {loading ? <Icon name="status-generating" size="compact" /> : leadingIcon}
    <span>{children}</span>
  </>
);
```

`ButtonLink` uses `next/link`, shares the exact class builder, and never accepts `disabled`; callers omit the link or use `aria-disabled` with prevented navigation. Tertiary is an unfilled command, not an underlined link. Danger is outline by default; add `data-confirmed-danger` for the filled final-confirmation state.

- [x] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/button-system.test.ts lib/design-tokens.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/button.tsx apps/web/src/components/ui/button.module.css apps/web/app/tokens.css apps/web/lib/button-system.test.ts
git commit -m "feat(web): establish desktop action primitives"
```

### Task 2: Refine the typed Lucide vocabulary

**Files:**
- Modify: `apps/web/src/components/ui/icon.tsx`
- Modify: `apps/web/lib/icon-registry.test.ts`
- Modify: `apps/web/lib/workflow-status.ts`

**Interfaces:**
- Adds `"compact" | "standard" | "emphasized"` mapped to 16/18/20px while temporarily accepting legacy `sm|md|lg` aliases inside `Icon` and `BrandIcon`.
- Adds typed names `authorize`, `batch`, `budget`, `targeting`, `send`, `signal`, `connection-lost`, and `campaign-risk`.
- Keeps `BrandIcon` on the same size vocabulary and preserves generated brand paths.

- [ ] **Step 1: Write failing registry and optical-size tests**

```ts
expect(REQUIRED).toEqual(expect.arrayContaining([
  "authorize", "batch", "budget", "targeting", "send",
  "signal", "connection-lost", "campaign-risk",
]));
expect(source).toContain('compact: "16px"');
expect(source).toContain('standard: "18px"');
expect(source).toContain('emphasized: "20px"');
expect(source).toContain("strokeWidth={1.8}");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/icon-registry.test.ts`  
Expected: FAIL on missing names and the old token-based size map.

- [ ] **Step 3: Implement the refined registry**

Use Lucide `BadgeCheck`, `ListChecks`, `WalletCards`, `SlidersHorizontal`, `Send`, `Radar`, `Unplug`, and `ShieldAlert` respectively. Preserve existing registry keys and accept legacy size aliases until Tasks 32–35 migrate every caller. Keep the compatibility mapper private to `icon.tsx`; new code may use only the three semantic sizes.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/icon-registry.test.ts lib/workflow-status.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0 without broad caller churn because legacy aliases remain temporarily accepted.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/icon.tsx apps/web/lib/icon-registry.test.ts apps/web/lib/workflow-status.ts
git commit -m "feat(web): refine the product icon vocabulary"
```

### Task 3: Add optimistic scope snapshots to policy writes

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/external-actions.test.ts`
- Modify: `apps/api/src/services/external-action-policy.ts`
- Modify: `apps/api/src/routes/external-action-policies.ts`
- Modify: `apps/api/test/external-action-policy.test.ts`

**Interfaces:**
- Produces `externalActionPolicyViewSchema` and `ExternalActionPolicyView` with `updatedAt: number | null`.
- Extends `UpsertExternalActionPoliciesInput` with `expectedUpdatedAt: number | null`.
- Produces `ExternalActionPolicyConflictError`, mapped to HTTP 409 `{ error: "policy_conflict", current }`.
- A single PUT is a full six-kind replacement for the scope; non-workspace `inherit` deletes stored rows transactionally.

- [ ] **Step 1: Write failing contract and API conflict tests**

```ts
expect(upsertExternalActionPoliciesInputSchema.parse({
  scope: "persona",
  scopeId: PERSONA_ID,
  expectedUpdatedAt: null,
  rules: EXTERNAL_ACTION_KINDS.map((actionKind) => ({ actionKind, rule: "inherit" })),
})).toMatchObject({ expectedUpdatedAt: null });

expect(conflict.statusCode).toBe(409);
expect(conflict.json()).toMatchObject({ error: "policy_conflict" });
expect(after.rules).toEqual(before.rules);
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w packages/contracts -- external-actions.test.ts`  
Expected: FAIL on missing `expectedUpdatedAt`/view schema.  
Run: `npm test -w apps/api -- external-action-policy.test.ts`  
Expected: FAIL because stale writes currently overwrite and inherit rows are stored.

- [ ] **Step 3: Implement atomic replacement and conflict handling**

`listExternalActionPolicies()` returns the maximum stored `updatedAt`, or `null` when the scope has no rows. In `db.transaction()`, compare it to `expectedUpdatedAt`, delete non-workspace rows whose requested rule is `inherit`, and upsert concrete rows with one shared timestamp. Preserve the existing validator that rejects `autonomous` for persona/connection/lane.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w packages/contracts -- external-actions.test.ts`  
Run: `npm test -w apps/api -- external-action-policy.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0 after current workspace/campaign clients send `expectedUpdatedAt` and complete six-kind arrays.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/external-actions.test.ts apps/api/src/services/external-action-policy.ts apps/api/src/routes/external-action-policies.ts apps/api/test/external-action-policy.test.ts apps/web/app/workspaces/[id]/automation/action-policy.tsx apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-action-policy.tsx
git commit -m "feat(policy): guard scoped action policy writes"
```

### Task 4: Build the reusable tightening-policy editor

**Files:**
- Create: `apps/web/src/components/scoped-action-policy.tsx`
- Create: `apps/web/src/components/scoped-action-policy.module.css`
- Create: `apps/web/lib/scoped-action-policy.test.ts`
- Modify: `apps/web/lib/external-actions.ts`

**Interfaces:**
- Produces `ScopedActionPolicy({ workspaceId, scope, scopeId, title })` for `persona|connection|lane`.
- Produces pure helpers `tighteningPolicyDraft(view)`, `tighteningPolicyDirty(view,draft)`, and `policyConflictCopy()`.
- Renders exactly `inherit|human_required`; it never presents `autonomous` at a tightening scope.

- [ ] **Step 1: Write failing view-model and shell tests**

```ts
expect(tighteningPolicyDraft(view).publish).toBe("inherit");
expect(tighteningPolicyDraft(view).paid_launch).toBe("human_required");
expect(shell).toContain('<option value="inherit">');
expect(shell).toContain('<option value="human_required">');
expect(shell).not.toContain('<option value="autonomous">');
expect(shell).toContain("expectedUpdatedAt");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/scoped-action-policy.test.ts`  
Expected: FAIL because the component/helpers do not exist.

- [ ] **Step 3: Implement self-fetching conflict-safe editor**

Load the policy view with `scope`/`scopeId`, render all `EXTERNAL_ACTION_KINDS`, show `WorkflowStatusBadge` plus every non-inherit contribution, and PUT one full six-kind array with `expectedUpdatedAt`. On 409, retain the attempted draft, show the server's current rules side-by-side, and expose **Reload current policy**. Announce save/conflict/error via a polite live region.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/scoped-action-policy.test.ts lib/external-actions.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/scoped-action-policy.tsx apps/web/src/components/scoped-action-policy.module.css apps/web/lib/scoped-action-policy.test.ts apps/web/lib/external-actions.ts
git commit -m "feat(web): add tightening policy editor"
```

### Task 5: Mount persona and connection policy editors

**Files:**
- Modify: `apps/web/app/workspaces/[id]/resolver/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/connectors/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/connectors/connectors.module.css`
- Create: `apps/web/lib/persona-connection-policy-shell.test.ts`

**Interfaces:**
- Consumes `ScopedActionPolicy` from Task 4.
- Persona editor mounts inside the expanded/editing persona card, keyed by persona ID.
- Connection editor mounts in the selected connection detail/setup region, keyed by connection ID.

- [ ] **Step 1: Write failing shell contracts**

```ts
expect(resolver).toContain('scope="persona"');
expect(resolver).toContain("scopeId={p.id}");
expect(connectors).toContain('scope="connection"');
expect(connectors).toContain("scopeId={connection.id}");
expect(connectors).toContain("Action permission");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/persona-connection-policy-shell.test.ts`  
Expected: FAIL because neither owning surface mounts the editor.

- [ ] **Step 3: Mount each editor without changing ownership**

Persona rules stay under Resolver's persona management, not Automation. Connection rules stay beside the live account identity and connection health, not in a workspace-wide list. Lazy-mount only the expanded entity so the page does not fetch six policies per collapsed row.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/persona-connection-policy-shell.test.ts lib/persona-social-routing.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/workspaces/[id]/resolver/page.tsx apps/web/app/workspaces/[id]/connectors/page.tsx apps/web/app/workspaces/[id]/connectors/connectors.module.css apps/web/lib/persona-connection-policy-shell.test.ts
git commit -m "feat(web): edit persona and connection action policy"
```

### Task 6: Mount campaign-lane policy editors

**Files:**
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-channels.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/campaign-workspace.module.css`
- Create: `apps/web/lib/lane-policy-shell.test.ts`

**Interfaces:**
- Consumes `ScopedActionPolicy` from Task 4.
- Uses the active `CampaignLaneRevision.id` as `scopeId`; immutable inactive revisions remain read-only.

- [ ] **Step 1: Write the failing lane ownership test**

```ts
expect(source).toContain('scope="lane"');
expect(source).toContain("scopeId={lane.revision.id}");
expect(source).toContain("active plan is immutable");
expect(source).toContain("Action permission for this lane");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/lane-policy-shell.test.ts`  
Expected: FAIL because Campaign Channels has no policy control.

- [ ] **Step 3: Add active-revision editors**

Mount one editor in each active lane's expanded detail. The copy states that lane policy can only tighten workspace/campaign permission. Render inactive revision contributions read-only; do not let a policy write mutate a plan revision.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/lane-policy-shell.test.ts lib/campaign-workspace-contract.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-channels.tsx apps/web/app/workspaces/[id]/campaigns/[campaignId]/campaign-workspace.module.css apps/web/lib/lane-policy-shell.test.ts
git commit -m "feat(web): edit campaign lane action policy"
```

### Task 7: Define Meta mutation contracts and result vocabulary

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/external-actions.test.ts`
- Modify: `packages/contracts/test/execution-results.test.ts`

**Interfaces:**
- Produces `metaAdSetStateSchema`, `budgetChangeIntentSchema`, `targetingChangeIntentSchema` and inferred types matching the design.
- Produces `proposeBudgetChangeInputSchema` and `proposeTargetingChangeInputSchema`, each requiring a UUID `idempotencyKey`.
- Adds `ad_mutation` to `EXTERNAL_ACTION_EXECUTION_KINDS` and `EXECUTION_RESULT_KINDS`.
- Extends `executionResultSchema` with optional `actionKind: ExternalActionKind | null`; it is `budget_change|targeting_change` for `ad_mutation` results and null for legacy kinds.

- [ ] **Step 1: Write failing schema/refinement tests**

```ts
expect(EXTERNAL_ACTION_EXECUTION_KINDS).toContain("ad_mutation");
expect(proposeBudgetChangeInputSchema.parse({
  dailyBudgetCents: 12_500,
  idempotencyKey: crypto.randomUUID(),
}).dailyBudgetCents).toBe(12_500);
expect(proposeTargetingChangeInputSchema.safeParse({
  countries: ["US", "US"], ageMin: 45, ageMax: 21,
  idempotencyKey: crypto.randomUUID(),
}).success).toBe(false);
expect(targetingChangeIntentSchema.parse(fixture).after.countries).toEqual(["DE", "US"]);
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w packages/contracts -- external-actions.test.ts execution-results.test.ts`  
Expected: FAIL on missing exports and vocabularies.

- [ ] **Step 3: Implement canonical schemas**

Reuse the existing two-letter country refinement and 18–65 age bounds. Transform country arrays with `Array.from(new Set(values)).sort()`. Refine budget intents so before/after differ and targeting intents so at least one country/age value differs. `providerUpdatedAt` remains nullable because Meta may omit it.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w packages/contracts -- external-actions.test.ts execution-results.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0 after exhaustive result-kind maps add `ad_mutation`.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/external-actions.test.ts packages/contracts/test/execution-results.test.ts apps/api/src/services/executions.ts apps/web/lib/execution-results.ts
git commit -m "feat(contracts): define Meta action mutations"
```

### Task 8: Extend the Meta adapter with revalidated mutations

**Files:**
- Modify: `apps/api/src/connectors/ads/index.ts`
- Modify: `apps/api/src/connectors/ads/meta.ts`
- Modify: `apps/api/test/ads-execution.test.ts`

**Interfaces:**
- Adds `getAdSetState`, `updateDailyBudget`, and `updateTargeting` to `AdsExecutionAdapter` with the exact signatures in the design.
- `MetaAdsAdapter.getAdSetState()` reads `daily_budget,targeting,updated_time` for one ad set.
- Update methods return a fresh `MetaAdSetState` read after the provider accepts the mutation.

- [ ] **Step 1: Write failing Meta proxy tests**

```ts
expect(await adapter.getAdSetState("act_1", "set_1")).toEqual({
  externalAdSetId: "set_1",
  dailyBudgetCents: 5000,
  countries: ["DE", "US"],
  ageMin: 25,
  ageMax: 54,
  updatedAt: Date.parse("2026-07-15T08:00:00Z"),
});
expect(recordedPost.body).toEqual({ daily_budget: 7500 });
expect(targetPost.body).toEqual({
  targeting: { geo_locations: { countries: ["GB", "US"] }, age_min: 30, age_max: 60 },
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- ads-execution.test.ts`  
Expected: FAIL because the interface and methods do not exist.

- [ ] **Step 3: Implement Graph reads and writes**

Use the existing pinned `GRAPH_VERSION` and Nango proxy. Parse `daily_budget` as integer minor units, normalize `targeting.geo_locations.countries`, and parse `updated_time` to epoch milliseconds or null. Reject missing/malformed budget or targeting with `ConnectorFabricError`; never substitute Tuezday's local value for a missing provider field.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- ads-execution.test.ts ads.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/connectors/ads/index.ts apps/api/src/connectors/ads/meta.ts apps/api/test/ads-execution.test.ts
git commit -m "feat(api): mutate Meta ad set settings"
```

### Task 9: Execute governed budget changes

**Files:**
- Modify: `apps/api/src/services/external-action-adapters.ts`
- Modify: `apps/api/src/services/ad-launches.ts`
- Modify: `apps/api/src/routes/ad-launches.ts`
- Create: `apps/api/test/external-action-budget-change.test.ts`

**Interfaces:**
- Produces async `prepareBudgetChangeAction(db,fabric,fetcher,workspaceId,launchId,input)`.
- Registers `budgetChangeActionAdapter()` under `budget_change` in `createExternalActionAdapters()`.
- Adds `POST /workspaces/:id/ad-launches/:launchId/budget-change` returning `ExternalActionSubmission`.
- Success receipt: `{ kind:"ad_mutation", id:launchId, status:"budget_updated", url:null, error:null }`.

- [ ] **Step 1: Write failing proposal, stale, guardrail, idempotency, and success tests**

```ts
expect(proposed.action.kind).toBe("budget_change");
expect(proposed.action.status).toBe("authorization_required");
expect(JSON.parse(row.payloadJson)).toMatchObject({
  beforeDailyBudgetCents: 5000,
  afterDailyBudgetCents: 7500,
});
expect(stale.action.status).toBe("stale");
expect(killSwitch.action.blocker?.code).toBe("kill_switch");
expect(meta.updateDailyBudget).toHaveBeenCalledTimes(1);
expect(getLaunch(db, WS, launchId)?.dailyBudgetCents).toBe(7500);
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- external-action-budget-change.test.ts`  
Expected: FAIL because unsupported kinds are still blocked in the coordinator and no adapter/route exists.

- [ ] **Step 3: Implement the complete budget vertical**

Eligibility requires `status === "launched"`, non-null `externalAdSetId`, connected Meta account, and a real provider state read. Build the fingerprint from normalized provider before-state, requested after-state, launch/account/connection context, and effective policy. Revalidation repeats the provider read. Guard the requested total by replacing the launch's current committed budget in the daily-cap calculation rather than double-counting it. Execute exactly once, persist the returned budget locally only after success, and remove `budget_change` from the coordinator's unsupported-kind branch.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- external-action-budget-change.test.ts external-actions.test.ts external-action-paid-launch.test.ts ads-execution.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/external-action-adapters.ts apps/api/src/services/ad-launches.ts apps/api/src/routes/ad-launches.ts apps/api/test/external-action-budget-change.test.ts
git commit -m "feat(api): authorize Meta budget changes"
```

### Task 10: Execute governed targeting changes

**Files:**
- Modify: `apps/api/src/services/external-action-adapters.ts`
- Modify: `apps/api/src/services/ad-launches.ts`
- Modify: `apps/api/src/routes/ad-launches.ts`
- Create: `apps/api/test/external-action-targeting-change.test.ts`

**Interfaces:**
- Produces async `prepareTargetingChangeAction(db,fabric,fetcher,workspaceId,launchId,input)`.
- Registers `targetingChangeActionAdapter()` under `targeting_change`.
- Adds `POST /workspaces/:id/ad-launches/:launchId/targeting-change` returning `ExternalActionSubmission`.
- Success receipt uses `status:"targeting_updated"`.

- [ ] **Step 1: Write failing normalization, staleness, validation, and success tests**

```ts
expect(JSON.parse(row.payloadJson).after).toEqual({
  countries: ["DE", "US"], ageMin: 25, ageMax: 54,
});
expect(remoteDrift.action.status).toBe("stale");
expect(invalid.statusCode).toBe(400);
expect(meta.updateTargeting).toHaveBeenCalledTimes(1);
expect(getLaunch(db, WS, launchId)).toMatchObject({
  countries: ["DE", "US"], ageMin: 25, ageMax: 54,
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- external-action-targeting-change.test.ts`  
Expected: FAIL because targeting remains unsupported.

- [ ] **Step 3: Implement the targeting vertical**

Reuse Task 9 eligibility and account resolution. Reject no-op changes and dimensions outside countries/age. Fingerprint sorted country codes and both age bounds. After the provider returns, require its normalized state to equal the requested state; a mismatched provider response is a failed action and does not update local projection. Remove `targeting_change` from the coordinator's unsupported branch only when this adapter is registered.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- external-action-targeting-change.test.ts external-action-budget-change.test.ts external-actions.test.ts ads-execution.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/external-action-adapters.ts apps/api/src/services/ad-launches.ts apps/api/src/routes/ad-launches.ts apps/api/test/external-action-targeting-change.test.ts
git commit -m "feat(api): authorize Meta targeting changes"
```

### Task 11: Add Meta mutation controls and outcomes to owning surfaces

**Files:**
- Modify: `apps/web/app/workspaces/[id]/ad-launches/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/ad-launches/ad-launches.module.css`
- Modify: `apps/web/lib/external-actions.ts`
- Modify: `apps/web/lib/execution-results.ts`
- Modify: `apps/web/lib/execution-results.test.ts`
- Create: `apps/web/lib/ad-mutation-shell.test.ts`
- Modify: `apps/api/src/services/executions.ts`
- Modify: `apps/api/test/executions.test.ts`

**Interfaces:**
- Adds launched-row forms for budget and targeting proposal only.
- Projects terminal `budget_change|targeting_change` actions as `ad_mutation` execution results.
- Uses `externalActionHref()` for authorization/stale/failed recovery.

- [ ] **Step 1: Write failing UI and projection tests**

```ts
expect(shell).toContain("Change budget");
expect(shell).toContain("Change targeting");
expect(shell).toContain("beforeDailyBudgetCents");
expect(shell).toContain("countries added");
expect(results[0]).toMatchObject({ kind: "ad_mutation", actionKind: "budget_change" });
expect(executionOwnerHref(WS, results[0])).toContain("ad-launches");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/ad-mutation-shell.test.ts lib/execution-results.test.ts`  
Run: `npm test -w apps/api -- executions.test.ts`  
Expected: FAIL on missing controls/result kind.

- [ ] **Step 3: Implement exact diffs and recovery**

Fetch current provider state through a read endpoint added to `ad-launches.ts`; never initialize from stale page data. Budget shows currency, absolute delta, and percent delta. Targeting shows countries added/removed plus age before/after. Retain one UUID per form retry. Show canonical badge, effective policy, blocker, provider receipt, and **Open authorization**; never authorize inline. Execution projection reads terminal actions without fabricating mutation results for legacy launches.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/ad-mutation-shell.test.ts lib/execution-results.test.ts lib/external-actions.test.ts`  
Run: `npm test -w apps/api -- executions.test.ts external-action-budget-change.test.ts external-action-targeting-change.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/workspaces/[id]/ad-launches apps/web/lib/external-actions.ts apps/web/lib/execution-results.ts apps/web/lib/execution-results.test.ts apps/web/lib/ad-mutation-shell.test.ts apps/api/src/services/executions.ts apps/api/test/executions.test.ts
git commit -m "feat(web): manage governed Meta mutations"
```

### Task 12: Define durable authorization-batch contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/external-actions.test.ts`

**Interfaces:**
- Produces `AUTHORIZATION_BATCH_MODES`, `AUTHORIZATION_BATCH_STATUSES`, and `AUTHORIZATION_BATCH_ITEM_STATUSES`.
- Produces `authorizationBatchSelectionSchema`, `createAuthorizationBatchInputSchema`, `authorizationBatchSchema`, `authorizationBatchItemSchema`, `authorizationBatchDetailSchema`, and inferred types.
- Selected batches accept 1–25 unique action IDs. Campaign batches require campaign ID, optional unique kinds, and snapshot at most 100 included items.

- [ ] **Step 1: Write failing vocabulary and refinement tests**

```ts
expect(AUTHORIZATION_BATCH_MODES).toEqual(["selected", "campaign"]);
expect(AUTHORIZATION_BATCH_STATUSES).toEqual([
  "preview", "running", "completed", "partially_completed", "failed",
]);
expect(createAuthorizationBatchInputSchema.safeParse({
  requestId: crypto.randomUUID(),
  selection: { mode: "selected", actionIds: Array(26).fill(ACTION_ID) },
}).success).toBe(false);
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w packages/contracts -- external-actions.test.ts`  
Expected: FAIL on missing batch exports.

- [ ] **Step 3: Implement schemas with discriminated selections**

Item snapshots include `actionId`, `actionFingerprint`, `actionUpdatedAt`, `kind`, `campaignId`, `impact`, `eligible`, `exclusionReason`, `status`, `error`, and `submission`. Batch details include `continuationCount`, included/excluded counts, and timestamps. Refine completed states so every included item is terminal.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w packages/contracts -- external-actions.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/external-actions.test.ts
git commit -m "feat(contracts): define authorization batches"
```

### Task 13: Persist immutable batch previews and item outcomes

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: generated `apps/api/drizzle/0046_*.sql`
- Create: generated `apps/api/drizzle/meta/0046_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Create: `apps/api/test/external-action-batch-persistence.test.ts`

**Interfaces:**
- Produces Drizzle tables `externalActionBatches` and `externalActionBatchItems`.
- Unique `(workspaceId, requestId)` makes preview creation idempotent.
- Unique `(batchId, actionId)` prevents duplicate membership; deleting a batch cascades items, deleting an action is restricted while its audit item exists.

- [ ] **Step 1: Write the failing persistence tests**

Test unique request IDs, unique membership, workspace indexes, immutable snapshot JSON, nullable submission JSON/error, and cascade/restrict behavior.

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- external-action-batch-persistence.test.ts`  
Expected: FAIL because the tables do not exist.

- [ ] **Step 3: Add schema and generate migration**

Batch rows store selection JSON, status, continuation count, createdBy, created/confirmed/completed timestamps. Item rows store the immutable action snapshot plus mutable item status, submission JSON, error, and processed timestamp.

Run: `npm run db:generate -w apps/api`  
Expected: `0046_*.sql` with exactly two new tables and their indexes; no unrelated table rewrite.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- external-action-batch-persistence.test.ts external-action-persistence.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/external-action-batch-persistence.test.ts
git commit -m "feat(api): persist authorization batches"
```

### Task 14: Preview, confirm, and resume authorization batches

**Files:**
- Create: `apps/api/src/services/external-action-batches.ts`
- Create: `apps/api/src/routes/external-action-batches.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/external-action-batches.test.ts`

**Interfaces:**
- Produces `createAuthorizationBatchPreview(db,workspaceId,input,actor)`.
- Produces `runAuthorizationBatch(db,runtime,workspaceId,batchId,actor)` and `getAuthorizationBatchDetail()`.
- Adds `POST /workspaces/:id/external-action-batches`, `GET /workspaces/:id/external-action-batches/:batchId`, and `POST .../:batchId/authorize`.

- [ ] **Step 1: Write failing selection, isolation, partial-result, and retry tests**

```ts
expect(preview.items.filter((i) => i.eligible)).toHaveLength(2);
expect(preview.items.find((i) => i.actionId === staleId)?.exclusionReason).toBe("not_authorization_required");
expect(campaignPreview.continuationCount).toBe(12);
expect(result.batch.status).toBe("partially_completed");
expect(runtime.authorize).toHaveBeenCalledTimes(2);
expect(retry.items).toEqual(result.items);
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- external-action-batches.test.ts`  
Expected: FAIL because service/routes are missing.

- [ ] **Step 3: Implement bounded snapshots and resumable execution**

Selected mode preserves caller order after deduplication. Campaign mode orders by requested time, creation time, then ID and snapshots only the first 100. Preview marks workspace mismatch, wrong campaign, non-authorization status, and duplicated action as excluded with exact reasons. Confirmation processes eligible unfinished items sequentially through `runtime.authorize`; catch item errors, persist each outcome immediately, and continue. A second confirmation returns stored terminal outcomes and resumes only pending items.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- external-action-batches.test.ts external-actions.test.ts external-action-batch-persistence.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/external-action-batches.ts apps/api/src/routes/external-action-batches.ts apps/api/src/app.ts apps/api/test/external-action-batches.test.ts
git commit -m "feat(api): execute authorization batches"
```

### Task 15: Add explicit multi-select authorization to Review

**Files:**
- Modify: `apps/web/app/workspaces/[id]/review/_components/authorizations-queue.tsx`
- Modify: `apps/web/app/workspaces/[id]/review/_components/authorizations-queue.module.css`
- Create: `apps/web/lib/authorization-batch.test.ts`
- Modify: `apps/web/lib/authorization-shell-contract.test.ts`

**Interfaces:**
- Produces pure `selectedAuthorizationIds(actions,selection)` and `authorizationBatchSummary(detail)` helpers.
- Review selection is explicit and capped at 25; only `authorization_required` cards expose checkboxes.

- [ ] **Step 1: Write failing selection and shell tests**

```ts
expect(selectedAuthorizationIds(actions, new Set([a,b]))).toEqual([a,b]);
expect(() => selectedAuthorizationIds(actions, new Set(ids26))).toThrow(/25/);
expect(shell).toContain("Preview 2 authorizations");
expect(shell).toContain("external-action-batches");
expect(shell).not.toContain("Approve selected content");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/authorization-batch.test.ts lib/authorization-shell-contract.test.ts`  
Expected: FAIL because Review supports only single-item authorization.

- [ ] **Step 3: Implement preview-first explicit batches**

Keep selection across detail-panel navigation and clear it when filters remove an action. **Preview authorizations** creates a batch and opens a modal listing included/excluded items, kind, impact, and timing. **Authorize included actions** confirms once, disables double submit, announces progress, and renders every item outcome with its owning recovery link. Partial success is not styled as complete success.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/authorization-batch.test.ts lib/authorization-shell-contract.test.ts lib/external-actions.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/workspaces/[id]/review/_components/authorizations-queue.tsx apps/web/app/workspaces/[id]/review/_components/authorizations-queue.module.css apps/web/lib/authorization-batch.test.ts apps/web/lib/authorization-shell-contract.test.ts
git commit -m "feat(web): authorize explicit action batches"
```

### Task 16: Add campaign-wide authorization previews

**Files:**
- Modify: `apps/web/app/workspaces/[id]/review/_components/authorizations-queue.tsx`
- Modify: `apps/web/app/workspaces/[id]/review/_components/authorizations-queue.module.css`
- Modify: `apps/web/lib/authorization-batch.test.ts`
- Modify: `apps/web/lib/review-workspace.ts`
- Modify: `apps/web/lib/review-workspace.test.ts`

**Interfaces:**
- Produces campaign-mode preview from the active campaign filter plus optional selected kinds.
- UI never sends a server query directly to authorize; it confirms the immutable batch ID returned by preview.

- [ ] **Step 1: Write failing campaign preview tests**

```ts
expect(campaignBatchSelection(CAMPAIGN_ID, ["publish", "send"])).toEqual({
  mode: "campaign", campaignId: CAMPAIGN_ID, kinds: ["publish", "send"],
});
expect(shell).toContain("Preview campaign authorizations");
expect(shell).toContain("continuationCount");
expect(shell).toContain("Actions created after this preview are not included");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/authorization-batch.test.ts lib/review-workspace.test.ts`  
Expected: FAIL because campaign-wide selection is absent.

- [ ] **Step 3: Implement campaign-wide flow**

Expose the control only when `?campaign=` is active. Let the founder include all kinds or a non-empty subset. Preview groups included/excluded items by kind and reason, displays the 100-item cap and continuation count, and requires a second confirmation naming the campaign and exact included count. Reuse the item-result UI from Task 15.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/authorization-batch.test.ts lib/review-workspace.test.ts lib/authorization-shell-contract.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/workspaces/[id]/review/_components/authorizations-queue.tsx apps/web/app/workspaces/[id]/review/_components/authorizations-queue.module.css apps/web/lib/authorization-batch.test.ts apps/web/lib/review-workspace.ts apps/web/lib/review-workspace.test.ts
git commit -m "feat(web): authorize campaign action batches"
```

### Task 17: Define outbound email contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/outbound-email.test.ts`
- Modify: `packages/contracts/test/execution-results.test.ts`

**Interfaces:**
- Produces `EMAIL_SENDER_STATUSES = ["not_configured","pending","verified","failed"]`.
- Produces `EMAIL_PERMISSION_STATUSES = ["unknown","allowed","suppressed"]`.
- Produces `EMAIL_DELIVERY_STATUSES = ["queued","accepted","delivered","bounced","complained","failed"]`.
- Produces `EMAIL_DELIVERY_ORIGINS = ["launch_message","outbound_draft","pr_draft"]`.
- Produces sender/DNS record, recipient permission, suppression, delivery, immutable event, and mutation input schemas.
- Sender configuration includes `killSwitch: boolean` and `dailyCap: number`; these are workspace safety settings, not provider fields.
- Adds `email_delivery` to external-action execution kinds and unified execution-result kinds.

- [ ] **Step 1: Write failing vocabulary and schema tests**

```ts
expect(EMAIL_DELIVERY_STATUSES).toEqual([
  "queued", "accepted", "delivered", "bounced", "complained", "failed",
]);
expect(updateEmailSenderInputSchema.safeParse({
  domain: "example.com", fromLocalPart: "hello", fromName: "Acme", replyTo: "founder@example.com",
}).success).toBe(true);
expect(emailDeliverySchema.parse(deliveryFixture())).toMatchObject({
  status: "accepted", origin: "launch_message",
});
expect(EXTERNAL_ACTION_EXECUTION_KINDS).toContain("email_delivery");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w packages/contracts -- outbound-email.test.ts execution-results.test.ts`  
Expected: FAIL because email governance contracts do not exist.

- [ ] **Step 3: Implement schemas and legal transitions**

Export `canTransitionEmailDelivery(from,to)`. Permit `queued→accepted|failed`, `accepted→delivered|bounced|complained|failed`, and no terminal reversal. Normalize email addresses to lowercase. Sender local-part allows RFC-safe ASCII characters but no domain; `replyTo` is nullable. DNS records expose only public name/type/value/priority/status.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w packages/contracts -- outbound-email.test.ts execution-results.test.ts external-actions.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0 after exhaustive execution maps add `email_delivery`.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/outbound-email.test.ts packages/contracts/test/execution-results.test.ts apps/api/src/services/executions.ts apps/web/lib/execution-results.ts
git commit -m "feat(contracts): define governed outbound email"
```

### Task 18: Persist senders, permissions, suppressions, and delivery events

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: generated `apps/api/drizzle/0047_*.sql`
- Create: generated `apps/api/drizzle/meta/0047_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Create: `apps/api/test/outbound-email-persistence.test.ts`

**Interfaces:**
- Produces tables `workspaceEmailSenders`, `emailRecipientPermissions`, `emailSuppressions`, `emailDeliveries`, and `emailDeliveryEvents`.
- One sender row per workspace. Permission and suppression uniqueness use `(workspaceId, normalizedEmail)`.
- Delivery uniqueness uses `(workspaceId, idempotencyKey)` and nullable unique `(provider,providerMessageId)`.
- Event uniqueness uses `(provider,providerEventId)`.

- [ ] **Step 1: Write failing persistence tests**

Test workspace cascades, normalized-email uniqueness, action/delivery link, immutable delivery payload, duplicate provider-event rejection, suppression reason/timestamp, and provider-message uniqueness.

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- outbound-email-persistence.test.ts`  
Expected: FAIL because the tables do not exist.

- [ ] **Step 3: Add tables and generate migration**

The sender row also stores workspace `killSwitch` and `dailyCap`, defaulting to safe values for existing workspaces. Delivery stores `externalActionId`, origin kind/ID, normalized recipient, sender/reply-to, subject/text/html snapshots, idempotency key, provider/message ID, status, accepted/completed timestamps, and last error. Event stores raw verified event type plus bounded JSON payload; it never stores webhook secrets.

Run: `npm run db:generate -w apps/api`  
Expected: `0047_*.sql` creates exactly five tables and indexes with no unrelated rewrite.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- outbound-email-persistence.test.ts external-action-persistence.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/outbound-email-persistence.test.ts
git commit -m "feat(api): persist governed email delivery"
```

### Task 19: Build the Resend outbound provider

**Files:**
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Create: `apps/api/src/outbound-email/provider.ts`
- Create: `apps/api/src/outbound-email/resend.ts`
- Create: `apps/api/test/outbound-email-provider.test.ts`

**Interfaces:**
- Produces `OutboundEmailProvider` with `createDomain`, `verifyDomain`, `getDomain`, and `send`.
- Produces `ResendOutboundEmailProvider(apiKey,fetcher)` and `createOutboundEmailProviderFromEnv(fetcher)`.
- `send` returns `{ provider:"resend", messageId, acceptedAt }` and throws typed `OutboundEmailProviderError` with status/code/retryable.

- [ ] **Step 1: Write failing HTTP contract tests**

```ts
expect(domainCall).toMatchObject({ method: "POST", url: "https://api.resend.com/domains" });
expect(verifyCall.url).toMatch(`/domains/${DOMAIN_ID}/verify`);
expect(sendCall.headers["Idempotency-Key"]).toBe("send/action-id");
expect(JSON.parse(sendCall.body)).toMatchObject({
  from: "Acme <hello@example.com>", to: ["lead@buyer.com"], reply_to: "founder@example.com",
});
expect(result.messageId).toBe("email_123");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- outbound-email-provider.test.ts`  
Expected: FAIL because the provider seam is absent.

- [ ] **Step 3: Implement strict Resend mapping**

Use `POST /domains`, `POST /domains/:id/verify`, `GET /domains/:id`, and `POST /emails`. Send the action-derived idempotency key in the `Idempotency-Key` header and reject keys over 256 characters. Map 409 `concurrent_idempotent_requests` as retryable, 409 `invalid_idempotent_request` as non-retryable, and require a provider message ID on 2xx. Add `svix` now for Task 22 without coupling it to the provider class.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- outbound-email-provider.test.ts mail.test.ts`  
Expected: PASS; the transactional mailer remains unchanged.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json package-lock.json apps/api/src/outbound-email/provider.ts apps/api/src/outbound-email/resend.ts apps/api/test/outbound-email-provider.test.ts
git commit -m "feat(api): add Resend outbound provider"
```

### Task 20: Manage verified workspace sender domains

**Files:**
- Create: `apps/api/src/services/email-senders.ts`
- Create: `apps/api/src/routes/email-senders.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/email-senders.test.ts`
- Modify: `apps/web/app/workspaces/[id]/connectors/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/connectors/connectors.module.css`
- Create: `apps/web/lib/email-sender-shell.test.ts`

**Interfaces:**
- Adds `GET|PUT /workspaces/:id/email-sender`, `POST .../email-sender/verify`, and `POST .../email-sender/refresh`.
- `buildApp` accepts injected `outboundEmail?: OutboundEmailProvider`.
- Connections renders sender identity, public DNS records, verification status, refresh, and failure recovery.

- [ ] **Step 1: Write failing API and shell tests**

```ts
expect(created.status).toBe("pending");
expect(created.dnsRecords.length).toBeGreaterThan(0);
expect(await getSenderStatus()).toBe("pending");
expect(refreshed.status).toBe("verified");
expect(shell).toContain("Verified email sender");
expect(shell).toContain("DNS records");
expect(shell).toContain("Check verification");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- email-senders.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/email-sender-shell.test.ts`  
Expected: FAIL because routes/service/UI are missing.

- [ ] **Step 3: Implement sender lifecycle and UI**

PUT creates/replaces provider domain only when the domain changes; name/local-part/reply-to edits retain verified state for the same domain. Verify triggers the asynchronous provider cycle and stores pending. Refresh reads provider status/records and maps `verified` only when sending capability is enabled. The UI never asks for or displays a Resend API key.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- email-senders.test.ts outbound-email-provider.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/email-sender-shell.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/email-senders.ts apps/api/src/routes/email-senders.ts apps/api/src/app.ts apps/api/test/email-senders.test.ts apps/web/app/workspaces/[id]/connectors/page.tsx apps/web/app/workspaces/[id]/connectors/connectors.module.css apps/web/lib/email-sender-shell.test.ts
git commit -m "feat(email): verify workspace sender domains"
```

### Task 21: Enforce recipient permission, suppression, caps, and unsubscribe

**Files:**
- Create: `apps/api/src/services/email-recipient-safety.ts`
- Create: `apps/api/src/routes/email-recipient-safety.ts`
- Create: `apps/api/src/outbound-email/unsubscribe.ts`
- Modify: `apps/api/src/auth/guard.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/email-recipient-safety.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/outbound-email.test.ts`

**Interfaces:**
- Adds `GET|PUT /workspaces/:id/email-permissions/:normalizedEmail` for authenticated founder decisions.
- Adds `GET|PUT /workspaces/:id/email-safety` for the workspace kill switch and daily cap.
- Adds signed public `GET /u/:token` and `POST /u/:token` unsubscribe endpoints.
- Produces `checkEmailRecipientSafety(db,workspaceId,email)` and workspace email settings `{ killSwitch,dailyCap }` routes.

- [ ] **Step 1: Write failing permission and public-token tests**

```ts
expect(checkEmailRecipientSafety(db, WS, "unknown@example.com")).toMatchObject({ ok:false, code:"permission_unknown" });
expect(checkEmailRecipientSafety(db, WS, "blocked@example.com")).toMatchObject({ ok:false, code:"suppressed" });
expect(unsubscribe.statusCode).toBe(200);
expect(replay.statusCode).toBe(200);
expect(dbSuppression.reason).toBe("unsubscribe");
expect(tampered.statusCode).toBe(400);
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- email-recipient-safety.test.ts`  
Expected: FAIL because permission/suppression services and signed routes are absent.

- [ ] **Step 3: Implement deterministic safety gates**

Use a dedicated `EMAIL_UNSUBSCRIBE_SECRET` HMAC token containing workspace ID and normalized email; it does not expire. Extend the auth guard public allowlist only for `/u/` and the Task 22 webhook, without changing login/session behavior. Unknown permission blocks; `allowed` passes unless suppression exists. `suppressed` permission and suppression rows agree transactionally. Daily cap counts accepted/delivered sends during the current UTC day; kill switch wins first.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w packages/contracts -- outbound-email.test.ts`  
Run: `npm test -w apps/api -- email-recipient-safety.test.ts auth.test.ts`  
Expected: PASS and existing authentication behavior unchanged.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/email-recipient-safety.ts apps/api/src/routes/email-recipient-safety.ts apps/api/src/outbound-email/unsubscribe.ts apps/api/src/auth/guard.ts apps/api/src/app.ts apps/api/test/email-recipient-safety.test.ts packages/contracts/src/index.ts packages/contracts/test/outbound-email.test.ts
git commit -m "feat(email): enforce recipient send safety"
```

### Task 22: Verify Resend webhooks and project delivery outcomes

**Files:**
- Create: `apps/api/src/outbound-email/webhook.ts`
- Create: `apps/api/src/services/email-deliveries.ts`
- Create: `apps/api/src/routes/resend-webhooks.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/resend-webhooks.test.ts`

**Interfaces:**
- Produces injectable `ResendWebhookVerifier.verify(rawBody,headers)`; default implementation uses `svix.Webhook` and `RESEND_WEBHOOK_SECRET`.
- Adds public `POST /webhooks/resend` with route-scoped raw body.
- Produces `recordVerifiedEmailEvent(db,event)` with provider-event idempotency and legal delivery transitions.

- [ ] **Step 1: Write failing signature, idempotency, and monotonic-state tests**

```ts
expect(invalid.statusCode).toBe(400);
expect(verifier.verify).toHaveBeenCalledWith(rawBody, {
  id: "msg_1", timestamp: "123", signature: "v1,sig",
});
expect(delivery.status).toBe("bounced");
expect(duplicate.statusCode).toBe(200);
expect(eventCount).toBe(1);
expect(afterLateDelivered.status).toBe("bounced");
expect(suppression.reason).toBe("bounce");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- resend-webhooks.test.ts`  
Expected: FAIL because webhook verification/projection is absent.

- [ ] **Step 3: Implement raw-body verification and event mapping**

Request verification must happen before `JSON.parse`. Handle `email.sent|delivered|bounced|complained|failed`; unknown verified types are acknowledged and stored without changing a delivery. Bounce/complaint transactionally add suppression. Duplicate provider event IDs return the existing event. Never transition bounced/complained/failed back to delivered.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- resend-webhooks.test.ts outbound-email-persistence.test.ts auth.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/outbound-email/webhook.ts apps/api/src/services/email-deliveries.ts apps/api/src/routes/resend-webhooks.ts apps/api/src/app.ts apps/api/test/resend-webhooks.test.ts
git commit -m "feat(email): ingest verified delivery events"
```

### Task 23: Execute governed email send actions

**Files:**
- Create: `apps/api/src/services/external-action-email.ts`
- Modify: `apps/api/src/services/external-action-adapters.ts`
- Modify: `apps/api/src/services/external-action-coordinator.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/external-action-email.test.ts`
- Modify: `apps/api/src/services/executions.ts`
- Modify: `apps/api/test/executions.test.ts`

**Interfaces:**
- Produces `EmailActionPayload` discriminated by `{ channel:"email", origin, originId }`.
- Extends the existing `send` adapter: email payloads use `emailActionAdapter`; existing social/launch payloads retain their adapter.
- Produces `prepareEmailAction(command)` helpers used by three origin tasks.
- Success receipt: `{ kind:"email_delivery", id:deliveryId, status:"accepted", url:null, error:null }`.

- [ ] **Step 1: Write failing guard, idempotency, crash-recovery, and result tests**

```ts
expect(proposed.action.kind).toBe("send");
expect(unverified.action.blocker?.code).toBe("sender_unverified");
expect(unknownPermission.action.blocker?.code).toBe("permission_unknown");
expect(provider.send).toHaveBeenCalledTimes(1);
expect(retry.execution?.id).toBe(first.execution?.id);
expect(provider.send).toHaveBeenCalledTimes(1);
expect(results[0]).toMatchObject({ kind:"email_delivery", status:"running" });
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- external-action-email.test.ts executions.test.ts`  
Expected: FAIL because governed email execution does not exist.

- [ ] **Step 3: Implement durable delivery-before-send semantics**

Revalidate exact current origin content/recipient/sender and policy. Guard through Task 21. Insert/reuse the queued delivery before calling Resend. Send with idempotency key `send/<actionId>`; on accepted response, persist provider ID and accepted state in the same recovery path. If a queued delivery has a provider ID, return its receipt without sending. If no ID exists, retry with the same provider key. Execution results map accepted to running, delivered to completed, bounced/complained/failed to failed.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- external-action-email.test.ts executions.test.ts external-action-messaging.test.ts resend-webhooks.test.ts`  
Expected: PASS and social sends unchanged.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/external-action-email.ts apps/api/src/services/external-action-adapters.ts apps/api/src/services/external-action-coordinator.ts apps/api/src/app.ts apps/api/test/external-action-email.test.ts apps/api/src/services/executions.ts apps/api/test/executions.test.ts
git commit -m "feat(api): execute governed email sends"
```

### Task 24: Add reusable email permission and receipt UI

**Files:**
- Create: `apps/web/src/components/email-send-status.tsx`
- Create: `apps/web/src/components/email-send-status.module.css`
- Create: `apps/web/lib/email-send-status.test.ts`
- Modify: `apps/web/lib/execution-results.ts`
- Modify: `apps/web/lib/execution-results.test.ts`

**Interfaces:**
- Produces `EmailPermissionControl({workspaceId,email,status,onChange})`.
- Produces `EmailSendStatus({submission,delivery})` with canonical badge, accepted-vs-delivered copy, Review/recovery links, and provider message ID disclosure.
- Produces `emailDeliveryWorkflowStatus(status)` and `emailDeliveryCopy(status)`.

- [ ] **Step 1: Write failing status/copy tests**

```ts
expect(emailDeliveryWorkflowStatus("accepted")).toBe("sending");
expect(emailDeliveryWorkflowStatus("delivered")).toBe("completed");
expect(emailDeliveryWorkflowStatus("complained")).toBe("failed");
expect(emailDeliveryCopy("accepted")).toContain("accepted by Resend");
expect(emailDeliveryCopy("accepted")).not.toContain("delivered");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/email-send-status.test.ts lib/execution-results.test.ts`  
Expected: FAIL because helpers/components are absent.

- [ ] **Step 3: Implement shared safety and outcome controls**

Permission changes require explicit **Allow native email** or **Suppress email** labels. Unknown never renders as allowed. Delivery state shows accepted, delivered, bounced, complained, or failed distinctly and uses a live region for refresh changes. Provider IDs are copyable secondary metadata, not external links.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/email-send-status.test.ts lib/execution-results.test.ts lib/button-system.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/email-send-status.tsx apps/web/src/components/email-send-status.module.css apps/web/lib/email-send-status.test.ts apps/web/lib/execution-results.ts apps/web/lib/execution-results.test.ts
git commit -m "feat(web): show governed email safety and results"
```

### Task 25: Cut Launches and sequences over to native email

**Files:**
- Modify: `apps/api/src/services/launch-sequences.ts`
- Modify: `apps/api/src/services/launches.ts`
- Modify: `apps/api/src/routes/launches.ts`
- Modify: `apps/api/test/launch-sequences.test.ts`
- Modify: `apps/api/test/launches.test.ts`
- Modify: `apps/web/app/workspaces/[id]/launches/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/launches/launches.module.css`
- Modify: `apps/web/lib/action-origin-shell-contract.test.ts`

**Interfaces:**
- Email `launch_messages` propose governed `send` actions instead of being marked sent/export-only.
- Sequence due runner pauses/retries on blockers and preserves stop-on-reply behavior.
- CSV export remains available.

- [ ] **Step 1: Write failing manual and scheduled email tests**

```ts
expect(manual.json().action.kind).toBe("send");
expect(emailMessage.externalActionId).toBe(manual.json().action.id);
expect(provider.send).toHaveBeenCalledTimes(1);
expect(blockedSequence.message.status).toBe("pending");
expect(blockedSequence.action.blocker?.code).toBe("permission_unknown");
expect(exportCsv.statusCode).toBe(200);
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- launch-sequences.test.ts launches.test.ts external-action-email.test.ts`  
Expected: FAIL because email dispatch still uses export/current shortcuts.

- [ ] **Step 3: Route every launch email through the coordinator**

Build subject/body from the approved launch-message draft, require recipient permission, derive one key from launch message/step/content, and return `ExternalActionSubmission`. Scheduled-auto email actions may execute autonomously under policy. Human-required sequence actions remain pending without advancing the next step. The UI shows permission, action, delivery, and CSV recovery through Task 24 components.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- launch-sequences.test.ts launches.test.ts external-action-email.test.ts external-action-messaging.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/action-origin-shell-contract.test.ts lib/email-send-status.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/launch-sequences.ts apps/api/src/services/launches.ts apps/api/src/routes/launches.ts apps/api/test/launch-sequences.test.ts apps/api/test/launches.test.ts apps/web/app/workspaces/[id]/launches apps/web/lib/action-origin-shell-contract.test.ts
git commit -m "feat(email): send launch sequences natively"
```

### Task 26: Send approved Outbound drafts natively

**Files:**
- Modify: `apps/api/src/services/leads.ts`
- Modify: `apps/api/src/routes/outbound.ts`
- Modify: `apps/api/test/outbound.test.ts`
- Modify: `apps/web/app/workspaces/[id]/outbound/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/outbound/outbound.module.css`
- Create: `apps/web/lib/outbound-email-shell.test.ts`

**Interfaces:**
- Adds `POST /workspaces/:id/outbound/drafts/:draftId/send` returning `ExternalActionSubmission`.
- Eligibility requires approved email draft, linked lead, allowed recipient, and exact current content.

- [ ] **Step 1: Write failing origin and shell tests**

```ts
expect(send.json().action.subject.kind).toBe("draft");
expect(send.json().action.subject.destination).toBe("lead@example.com");
expect(duplicate.json().action.id).toBe(send.json().action.id);
expect(shell).toContain("Send from Tuezday");
expect(shell).toContain("EmailPermissionControl");
expect(shell).toContain("EmailSendStatus");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- outbound.test.ts external-action-email.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/outbound-email-shell.test.ts`  
Expected: FAIL because Outbound has no governed send route/UI.

- [ ] **Step 3: Implement individual and explicit selected sends**

Parse subject from the first non-empty line and body from the remainder, matching current preview behavior. One draft/lead produces one action. For a selected set, the client proposes each independently and reports partial results; it does not use authorization-batch APIs before actions exist. Preserve CSV export and draft generation.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- outbound.test.ts external-action-email.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/outbound-email-shell.test.ts lib/email-send-status.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/leads.ts apps/api/src/routes/outbound.ts apps/api/test/outbound.test.ts apps/web/app/workspaces/[id]/outbound apps/web/lib/outbound-email-shell.test.ts
git commit -m "feat(email): send outbound drafts natively"
```

### Task 27: Send approved PR pitches natively

**Files:**
- Modify: `apps/api/src/services/media-contacts.ts`
- Modify: `apps/api/src/routes/pr.ts`
- Modify: `apps/api/test/pr.test.ts`
- Modify: `apps/web/app/workspaces/[id]/pr/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/pr/pr.module.css`
- Create: `apps/web/lib/pr-email-shell.test.ts`

**Interfaces:**
- Adds `POST /workspaces/:id/pr/drafts/:draftId/send` returning `ExternalActionSubmission`.
- PR mailto remains secondary recovery; native send is the primary action after permission/sender readiness.

- [ ] **Step 1: Write failing PR origin and shell tests**

```ts
expect(send.json().action.subject.destination).toContain("journalist@example.com");
expect(send.json().action.context.campaignId).toBe(CAMPAIGN_ID);
expect(shell).toContain("Send pitch from Tuezday");
expect(shell).toContain("Open in email client");
expect(shell).toContain("EmailSendStatus");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- pr.test.ts external-action-email.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/pr-email-shell.test.ts`  
Expected: FAIL because PR only exposes mailto/export behavior.

- [ ] **Step 3: Implement governed PR sending**

Require an approved PR-channel draft linked to the exact media contact. Reuse the existing subject/body parser, preserve persona/campaign context, and keep mailto as secondary recovery. Selected contacts propose actions independently with retained UUIDs and item-level results.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w apps/api -- pr.test.ts external-action-email.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/pr-email-shell.test.ts lib/email-send-status.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/media-contacts.ts apps/api/src/routes/pr.ts apps/api/test/pr.test.ts apps/web/app/workspaces/[id]/pr apps/web/lib/pr-email-shell.test.ts
git commit -m "feat(email): send PR pitches natively"
```

### Task 28: Add actionable signal priorities

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/external-actions.test.ts`
- Modify: `apps/api/src/services/priorities.ts`
- Modify: `apps/api/test/priorities.test.ts`
- Modify: `apps/web/lib/priorities.ts`
- Modify: `apps/web/lib/priorities.test.ts`

**Interfaces:**
- Adds `signal_triage` to `PRIORITY_ITEM_KINDS` and its typed Home presentation metadata.
- Produces pure `signalPriorityCandidate(signal, now)` returning either a priority input or `null`.
- A signal is actionable when it has no response draft and either has an active-campaign match or is at least 24 hours old.

- [ ] **Step 1: Write failing contract, projection, and presentation tests**

```ts
expect(PRIORITY_ITEM_KINDS).toContain("signal_triage");
expect(await priorities()).toContainEqual(expect.objectContaining({
  id: matchedSignal.id,
  kind: "signal_triage",
  href: `/workspaces/${workspaceId}/discovery?signal=${matchedSignal.id}`,
  campaignId,
}));
expect((await priorities()).some((item) => item.id === draftedSignal.id)).toBe(false);
expect(priorityView(signalItem)).toMatchObject({ icon: "signal", cta: "Review signal" });
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w packages/contracts -- external-actions.test.ts`  
Run: `npm test -w apps/api -- priorities.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/priorities.test.ts`  
Expected: FAIL because the kind and source projection do not exist.

- [ ] **Step 3: Implement deterministic signal selection**

Reuse `listSignals()` so draft and match state is not reimplemented. Prefer the highest-scoring active campaign match for context. A fresh unmatched signal remains informational; an unmatched signal becomes overdue after 24 hours. Use the signal ID as the stable item ID, name the missing campaign decision in `reason`, and link to the exact signal query. Do not duplicate a signal already represented by a draft review.

- [ ] **Step 4: Run focused tests and typecheck**

Run the three focused commands from Step 2.  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/external-actions.test.ts apps/api/src/services/priorities.ts apps/api/test/priorities.test.ts apps/web/lib/priorities.ts apps/web/lib/priorities.test.ts
git commit -m "feat(home): prioritize actionable signals"
```

### Task 29: Add pending learning priorities

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/services/priorities.ts`
- Modify: `apps/api/test/priorities.test.ts`
- Modify: `apps/web/lib/priorities.ts`
- Modify: `apps/web/lib/priorities.test.ts`

**Interfaces:**
- Adds `learning_review` to `PRIORITY_ITEM_KINDS`.
- Projects only `now_syntheses.status === "proposed"` with exact `/learning?synthesis=<id>` recovery URLs.

- [ ] **Step 1: Write failing inclusion/exclusion and UI metadata tests**

```ts
expect(items).toContainEqual(expect.objectContaining({
  id: proposed.id,
  kind: "learning_review",
  status: "review_required",
  href: `/workspaces/${workspaceId}/learning?synthesis=${proposed.id}`,
}));
expect(items.some((item) => item.id === accepted.id || item.id === dismissed.id)).toBe(false);
expect(priorityView(learningItem).cta).toBe("Review learning");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- priorities.test.ts learning.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/priorities.test.ts`  
Expected: FAIL because proposed syntheses are absent from Home.

- [ ] **Step 3: Project only unresolved learning decisions**

Use `listSyntheses()` and preserve its status vocabulary. Derive the title from the first 80 characters of the proposal, the reason from its rationale, and make the consequence explicit: the Brain will not change until the founder accepts or dismisses it. Use the synthesis creation time and stable synthesis ID.

- [ ] **Step 4: Run focused tests and typecheck**

Run the commands from Step 2.  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts apps/api/src/services/priorities.ts apps/api/test/priorities.test.ts apps/web/lib/priorities.ts apps/web/lib/priorities.test.ts
git commit -m "feat(home): prioritize pending learning"
```

### Task 30: Add impact-aware connection-health priorities

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/services/priorities.ts`
- Modify: `apps/api/test/priorities.test.ts`
- Modify: `apps/web/lib/priorities.ts`
- Modify: `apps/web/lib/priorities.test.ts`

**Interfaces:**
- Adds `connection_health` to `PRIORITY_ITEM_KINDS`.
- Produces `connectionImpact(db, workspaceId, connectionId)` with affected active campaign IDs and dependency labels.
- Emits one item only for non-connected/error connections with a live campaign lane, scheduled publication/action, sender configuration, discovery source, CRM sync, or ad account dependency.

- [ ] **Step 1: Write failing impact and deduplication tests**

```ts
expect(items).toContainEqual(expect.objectContaining({
  id: brokenConnection.id,
  kind: "connection_health",
  status: "connection_lost",
  campaignId,
  href: `/workspaces/${workspaceId}/connectors?connection=${brokenConnection.id}`,
}));
expect(items.some((item) => item.id === unusedBrokenConnection.id)).toBe(false);
expect(items.filter((item) => item.id === blockedAction.context.connectionId)).toHaveLength(0);
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- priorities.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/priorities.test.ts`  
Expected: FAIL because connection health is not projected.

- [ ] **Step 3: Implement dependency-aware projection**

Inspect active lane revisions, pending/scheduled publications and actions, enabled discovery sources, CRM sync settings, and ad accounts. Prefer a single affected campaign for card context and name all dependency classes in `reason`. If an attention-state external action already references that connection, keep the action's more exact recovery item and suppress the generic connection card.

- [ ] **Step 4: Run focused tests and typecheck**

Run the commands from Step 2.  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts apps/api/src/services/priorities.ts apps/api/test/priorities.test.ts apps/web/lib/priorities.ts apps/web/lib/priorities.test.ts
git commit -m "feat(home): prioritize connection health"
```

### Task 31: Add campaign-risk priorities and finalize ranking

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/services/priorities.ts`
- Modify: `apps/api/test/priorities.test.ts`
- Modify: `apps/web/lib/priorities.ts`
- Modify: `apps/web/lib/priorities.test.ts`
- Modify: `apps/web/app/workspaces/[id]/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/home-hero.module.css`
- Create: `apps/web/lib/home-priority-shell.test.ts`

**Interfaces:**
- Adds `campaign_risk` to `PRIORITY_ITEM_KINDS`.
- Produces pure `deriveCampaignRisks(db, workspaceId, now)` for active campaigns only.
- Final ranking preserves overdue failures/blocks/stale, overdue authorization, other failures/blocks/stale, and authorization first; stopping signal/learning/connection/campaign risks follow, then ordinary content review and non-stopping triage.

- [ ] **Step 1: Write failing risk, ranking, and shell tests**

```ts
expect(items).toContainEqual(expect.objectContaining({
  kind: "campaign_risk",
  campaignId,
  href: `/workspaces/${workspaceId}/campaigns/${campaignId}`,
}));
expect(repeatedFailures.reason).toContain("3 failed deliveries in 7 days");
expect(items.indexOf(connectionRisk)).toBeLessThan(items.indexOf(contentReview));
expect(home).toContain("priorityView(priority)");
expect(home).toContain("WorkflowStatusBadge");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -w apps/api -- priorities.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/priorities.test.ts lib/home-priority-shell.test.ts`  
Expected: FAIL on missing campaign risk and final tier behavior.

- [ ] **Step 3: Derive explainable campaign risk and finish Home**

Emit one card per active campaign for the highest-severity evidence: a blocked active lane; three or more failed/partially-failed executions within seven days; overdue scheduled publication/launch work; or no active lane capable of delivery. Use the campaign UUID itself as the stable item ID, include the exact count/time in the reason, and never treat low performance as urgent. Update Home to render all new types with canonical badges, refined icons, campaign link, due time, and a standard secondary `ButtonLink`.

- [ ] **Step 4: Run focused and regression tests**

Run: `npm test -w apps/api -- priorities.test.ts executions.test.ts campaigns.test.ts`  
Run: `npm exec --prefix apps/web vitest -- run lib/priorities.test.ts lib/home-priority-shell.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts apps/api/src/services/priorities.ts apps/api/test/priorities.test.ts apps/web/lib/priorities.ts apps/web/lib/priorities.test.ts apps/web/app/workspaces/[id]/page.tsx apps/web/app/workspaces/[id]/home-hero.module.css apps/web/lib/home-priority-shell.test.ts
git commit -m "feat(home): surface ranked campaign risk"
```

### Task 32: Migrate Home, Review, and delivery actions

**Files:**
- Modify: `apps/web/app/workspaces/[id]/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/review/_components/approvals-queue.tsx`
- Modify: `apps/web/app/workspaces/[id]/review/_components/authorizations-queue.tsx`
- Modify: `apps/web/app/workspaces/[id]/review/_components/conversational-editor.tsx`
- Modify: `apps/web/app/workspaces/[id]/review/_components/inbox-queue.tsx`
- Modify: `apps/web/app/workspaces/[id]/content/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/calendar/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/launches/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/outbound/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/pr/page.tsx`
- Create: `apps/web/lib/desktop-actions-operate.test.ts`

**Interfaces:**
- Replaces raw command buttons and manual button CSS composition on the highest-frequency operating surfaces.
- Enforces one large primary per decision region, standard secondary/tertiary alternatives, compact controls only in dense rows, and labelled 40px icon controls.

- [ ] **Step 1: Write the failing surface audit**

The test reads the listed sources, rejects raw `<button` except semantic tabs/toggles declared in an allowlist, rejects `buttonStyles.*`, `link-button`, `button-secondary`, and legacy `size="sm|md"`, and asserts destructive actions use `variant="danger"` with object-specific confirmation copy.

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/desktop-actions-operate.test.ts`  
Expected: FAIL with the current small/manual actions.

- [ ] **Step 3: Migrate surface by surface**

Use `ButtonLink` for navigation, `Button` for commands, and `IconButton` only for familiar toolbar actions. Keep batch selection controls as checkboxes, Review tabs as tabs, and filters as filters. Preserve all handlers, disabled rules, loading labels, keyboard behavior, analytics, and existing recovery URLs.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/desktop-actions-operate.test.ts lib/review-shell-contract.test.ts lib/calendar-shell-contract.test.ts lib/action-origin-shell-contract.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/workspaces/[id]/page.tsx apps/web/app/workspaces/[id]/review apps/web/app/workspaces/[id]/content apps/web/app/workspaces/[id]/calendar apps/web/app/workspaces/[id]/launches apps/web/app/workspaces/[id]/outbound apps/web/app/workspaces/[id]/pr apps/web/lib/desktop-actions-operate.test.ts
git commit -m "refactor(web): normalize operating actions"
```

### Task 33: Migrate campaigns, ads, and growth actions

**Files:**
- Modify: `apps/web/app/workspaces/[id]/campaigns/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/_components/campaign-card.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/_components/campaign-form.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-action-policy.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-channels.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-lane-form.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-form.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-history.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-results.tsx`
- Modify: `apps/web/app/workspaces/[id]/ad-creatives/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/ad-launches/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/ads/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/discovery/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/insights/page.tsx`
- Create: `apps/web/lib/desktop-actions-growth.test.ts`

**Interfaces:**
- Applies the same hierarchy to campaign planning, lane operations, Meta setup/mutations, discovery triage, and Insights navigation.
- Uses the refined `campaign-risk`, `budget`, `targeting`, `authorize`, and `signal` icons only where the adjacent label confirms meaning.

- [ ] **Step 1: Write and run the failing growth-surface audit**

Run: `npm exec --prefix apps/web vitest -- run lib/desktop-actions-growth.test.ts`  
Expected: FAIL on legacy sizes/manual classes/raw commands.

- [ ] **Step 2: Migrate actions without changing plan semantics**

Active-plan revision controls, lane forms, mutation forms, and campaign cards keep their current ownership and immutable-revision rules. Dense history tables may use compact controls; create/activate/submit actions use large primary only when dominant in their region. Provider brand marks remain `BrandIcon`, never Lucide substitutes.

- [ ] **Step 3: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/desktop-actions-growth.test.ts lib/campaign-workspace-contract.test.ts lib/ad-mutation-shell.test.ts lib/icon-registry.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/workspaces/[id]/campaigns apps/web/app/workspaces/[id]/ad-creatives apps/web/app/workspaces/[id]/ad-launches apps/web/app/workspaces/[id]/ads apps/web/app/workspaces/[id]/discovery apps/web/app/workspaces/[id]/insights apps/web/lib/desktop-actions-growth.test.ts
git commit -m "refactor(web): normalize campaign and growth actions"
```

### Task 34: Migrate Brain, audience, and workflow actions

**Files:**
- Modify: `apps/web/app/workspaces/[id]/brain/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/learning/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/resolver/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/lists/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/crm/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/evidence/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/cadence/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/cadence/cadence-manager.tsx`
- Modify: `apps/web/app/workspaces/[id]/sandbox/page.tsx`
- Modify: `apps/web/src/components/show-more.tsx`
- Modify: `apps/web/src/components/ui/diagram-kit.tsx`
- Modify: `apps/web/src/components/ui/preview-card.tsx`
- Create: `apps/web/lib/desktop-actions-workflow.test.ts`

**Interfaces:**
- Normalizes authoring, learning, persona, list, CRM, evidence, cadence, and sandbox decisions while leaving tiles/cards/tabs semantically distinct from buttons.

- [ ] **Step 1: Write and run the failing workflow-surface audit**

Run: `npm exec --prefix apps/web vitest -- run lib/desktop-actions-workflow.test.ts`  
Expected: FAIL on legacy action patterns.

- [ ] **Step 2: Migrate commands and preserve semantic surfaces**

Do not turn clickable preview cards, diagram tiles, tabs, filter chips, or checkboxes into command buttons. Their interactive roots retain current semantics and receive 40px minimum target/focus styling in their own CSS. Actual commands use shared primitives and semantic icon sizes.

- [ ] **Step 3: Run focused tests and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/desktop-actions-workflow.test.ts lib/persona-social-routing.test.ts lib/scoped-action-policy.test.ts lib/icon-registry.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/workspaces/[id]/brain apps/web/app/workspaces/[id]/learning apps/web/app/workspaces/[id]/resolver apps/web/app/workspaces/[id]/lists apps/web/app/workspaces/[id]/crm apps/web/app/workspaces/[id]/evidence apps/web/app/workspaces/[id]/cadence apps/web/app/workspaces/[id]/sandbox apps/web/src/components/show-more.tsx apps/web/src/components/ui/diagram-kit.tsx apps/web/src/components/ui/preview-card.tsx apps/web/lib/desktop-actions-workflow.test.ts
git commit -m "refactor(web): normalize workflow actions"
```

### Task 35: Migrate shell, settings, and onboarding actions; remove compatibility aliases

**Files:**
- Modify: `apps/web/app/workspaces/[id]/layout.tsx`
- Modify: `apps/web/app/workspaces/[id]/connectors/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/automation/action-policy.tsx`
- Modify: `apps/web/app/workspaces/[id]/automation/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/notifications/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/team/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/billing/page.tsx`
- Modify: `apps/web/app/login/page.tsx`
- Modify: `apps/web/app/login/google/callback/page.tsx`
- Modify: `apps/web/app/invites/[token]/page.tsx`
- Modify: `apps/web/app/onboarding/page.tsx`
- Modify: `apps/web/app/onboarding/_components/brain-panel.tsx`
- Modify: `apps/web/app/onboarding/_components/campaign-panel.tsx`
- Modify: `apps/web/app/onboarding/_components/connect-panel.tsx`
- Modify: `apps/web/app/onboarding/_components/draft-panel.tsx`
- Modify: `apps/web/app/onboarding/_components/verify-panel.tsx`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/src/components/top-bar.tsx`
- Modify: `apps/web/src/components/connect-prompt.tsx`
- Modify: `apps/web/src/components/ui/settings-modal.tsx`
- Modify: `apps/web/src/components/ui/tabs.tsx`
- Modify: `apps/web/src/components/ui/icon.tsx`
- Modify: `apps/web/src/components/ui/brand-icons.ts`
- Create: `apps/web/lib/desktop-actions-foundation.test.ts`

**Interfaces:**
- Completes the UI-wide audit and removes legacy `sm|md|lg` icon-size and `sm|md` button-size aliases.
- Leaves semantic tabs as tabs and logout as a standard tertiary command.

- [ ] **Step 1: Write the failing repository-wide audit**

Scan `apps/web/app` and `apps/web/src` and assert: no legacy button class strings; no direct `button.module.css` imports outside `button.tsx`; no command raw buttons outside a documented semantic allowlist; no page-level `lucide-react`; no legacy icon/button size literals; every `IconButton` has a non-empty `label`.

- [ ] **Step 2: Run and confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/desktop-actions-foundation.test.ts lib/button-system.test.ts lib/icon-registry.test.ts`  
Expected: FAIL until remaining shell/setup callers migrate.

- [ ] **Step 3: Migrate remaining callers and delete aliases**

Preserve login, callback, invite, onboarding, settings, connector, policy, logout, and root-navigation behavior exactly. Once the repository audit is green, narrow the exported size types to the approved semantic vocabulary and delete the private legacy mapper.

- [ ] **Step 4: Run web regression and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/desktop-actions-foundation.test.ts lib/button-system.test.ts lib/icon-registry.test.ts lib/onboarding-setup-skip-contract.test.ts`  
Run: `npm test -w packages/contracts -- nav-icons.test.ts nav-visibility.test.ts onboarding-progress.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app apps/web/src apps/web/lib/desktop-actions-foundation.test.ts
git commit -m "refactor(web): complete desktop action migration"
```

### Task 36: Add deterministic four-width desktop visual acceptance

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `playwright.config.ts`
- Create: `tests/desktop/fixtures.ts`
- Create: `tests/desktop/platform-completion.spec.ts`
- Create: `tests/desktop/README.md`
- Create: `docs/ui-ux/desktop-platform-completion-acceptance.md`

**Interfaces:**
- Adds `npm run test:desktop` using `@playwright/test` Chromium only.
- Uses deterministic API/database fixture setup and authenticated storage state.
- Captures 1024, 1280, 1440, and 1728px desktop evidence for Home, Review batch partial results, Meta mutation, sender setup, email delivery, and each policy editor.

- [ ] **Step 1: Add the failing Playwright smoke specification**

```ts
for (const width of [1024, 1280, 1440, 1728]) {
  test(`desktop platform completion at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByRole("heading", { name: "Needs you now" })).toBeVisible();
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  });
}
```

- [ ] **Step 2: Install the explicit test dependency and confirm RED**

Run: `npm install -D @playwright/test@1.61.1`  
Run: `npx playwright test tests/desktop/platform-completion.spec.ts --project=chromium`  
Expected: FAIL because fixture setup and expected screenshots do not exist.

- [ ] **Step 3: Build the deterministic desktop fixture and evidence suite**

Seed representative actions, partial batch items, Meta before/after state, verified/unverified sender state, delivered/bounced email, persona/connection/lane policies, all four Home priority sources, and exact recovery links. Assert visible text, accessible roles, 36/40/44px control bounds, one filled primary per decision region, loading width stability, keyboard focus order, no clipped dialogs/tables, and no horizontal page overflow. Store screenshots under Playwright's normal test-results artifact path; do not commit platform-dependent golden PNGs.

- [ ] **Step 4: Run desktop acceptance and build**

Run: `npm run test:desktop`  
Expected: 4 widths × all named representative surfaces PASS in Chromium.  
Run: `npm run build -w apps/web`  
Expected: exit 0.

- [ ] **Step 5: Record evidence and commit**

Document the command, browser version, viewport matrix, scenarios, and artifact location in the acceptance file.

```bash
git add package.json package-lock.json playwright.config.ts tests/desktop docs/ui-ux/desktop-platform-completion-acceptance.md
git commit -m "test(web): verify desktop platform completion"
```

### Task 37: Run final acceptance and update the capability record

**Files:**
- Modify: `docs/ui-ux/capability-registry.md`
- Modify: `docs/ui-ux/desktop-platform-completion-acceptance.md`
- Modify: `docs/superpowers/progress/2026-07-15-desktop-platform-completion.md`

**Interfaces:**
- Records delivered contracts, migrations 0046/0047, provider adapters, routes, surfaces, visual evidence, test counts, and explicit deferrals.
- Marks only evidence-backed capabilities complete.

- [ ] **Step 1: Audit scope and working tree**

Run: `git status --short`  
Run: `git log --oneline 8c71381..HEAD`  
Run: `rg -n "Google Ads|SMTP|mobile|distributed queue|broader targeting" docs/ui-ux/capability-registry.md docs/ui-ux/desktop-platform-completion-acceptance.md`  
Expected: only intentional plan outputs and explicit deferrals.

- [ ] **Step 2: Run fresh unpiped final gates**

Run: `npm test`  
Expected: exit 0; record exact files/tests.  
Run: `npm run typecheck`  
Expected: exit 0 for every workspace.  
Run: `npm run build -w apps/web`  
Expected: exit 0.  
Run: `npm run test:desktop`  
Expected: exit 0 at 1024/1280/1440/1728.

- [ ] **Step 3: Verify migrations from empty and populated databases**

Run the repository migration test/command against a fresh database and a copy of the pre-0046 fixture. Confirm no prior external actions, leads, media contacts, launches, or connections change meaning; new permission is `unknown`, new batch/delivery tables are empty, and no sender is treated as verified.

- [ ] **Step 4: Update acceptance, registry, and progress record**

Include exact routes/tables/adapters/surfaces and exact verification counts. Keep Google Ads mutation, Meta dimensions beyond country/age, SMTP/additional providers, mobile QA, batch content approval, and distributed queue infrastructure marked deferred.

- [ ] **Step 5: Commit and push only after the tree is clean**

```bash
git add docs/ui-ux/capability-registry.md docs/ui-ux/desktop-platform-completion-acceptance.md docs/superpowers/progress/2026-07-15-desktop-platform-completion.md
git commit -m "docs: record desktop platform completion"
git status --short
git push -u origin ui-revamp/desktop-platform-completion
```

## Provider References

- Resend idempotency keys: <https://resend.com/docs/dashboard/emails/idempotency-keys>
- Resend webhook signature verification: <https://resend.com/docs/webhooks/verify-webhooks-requests>
- Resend domain creation: <https://resend.com/docs/api-reference/domains/create-domain>
- Resend domain verification: <https://resend.com/docs/api-reference/domains/verify-domain>

## Progress Log Template

Append one row after every task. Never rewrite earlier evidence.

| Task | Commit | RED evidence | GREEN evidence | Typecheck | Notes/deferrals |
|---:|---|---|---|---|---|
| 1 |  |  |  |  |  |

## Plan Self-Review Checklist

- [x] Every design requirement maps to at least one task and one acceptance assertion.
- [x] Every task is independently resumable from its listed inputs and produces one reviewable commit.
- [x] Contracts precede API and UI consumers; migrations precede services that query new tables.
- [x] Persona/connection/lane policy choices remain tightening-only.
- [x] Meta mutations revalidate provider state and never blind-patch.
- [x] Batch confirmation snapshots bounded actions and reports partial outcomes honestly.
- [x] Governed email remains separate from transactional mail and accepted is never called delivered.
- [x] Public email endpoints are signed/signature-verified and do not change login/session behavior.
- [x] Button/icon aliases are removed only after all callers migrate.
- [x] Visual QA is desktop-only at exactly 1024, 1280, 1440, and 1728px.
- [x] Final gates are unpiped and evidence is recorded before capability claims.
