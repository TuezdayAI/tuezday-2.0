# Sprint 38 — Onboarding flow

- **Status:** **planned — BLOCKED on founder nuance definition.** The roadmap explicitly defers this sprint "until the founder defines the flow's nuances," and CLAUDE.md's Sprint-21+ workflow requires asking clarifying questions before building. This spec is a complete draft with **recommended defaults**; resolve the "Open questions for the founder" section before cutting the branch.
- **Roadmap item:** U1 (LOW priority) — `docs/plans/sprint-guide-21-onward.md`, "Sprint 38"
- **Branch:** `sprint-38-onboarding-flow`, cut from `main`
- **Merge order:** none. "Builds on: brain, connectors, brain-doc templates" — brain (`apps/api/src/services/brain.ts`, `ensureBrainDocs`) and connectors (`services/connections.ts`, `CONNECTOR_PROVIDERS`) are on `main`; brain-doc **templates** are new (introduced here). `main` HEAD is Sprint 31; Sprints 34/35/36/37 are unmerged and not dependencies.
- **Size:** M.
- **Do NOT merge into `main`.** Push the branch; founder reviews/accepts/merges. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

> **For agentic workers:** do **not** start building until the Open Questions are answered. Once unblocked, implement task-by-task with strict TDD. REQUIRED SUB-SKILL: superpowers:executing-plans.

---

## Goal

Guide a brand-new user from empty workspace to their **first approved output** with no documentation:

> create workspace → seed brain (templates) → connect first app → first generation → first approval.

Founder acceptance (from the roadmap):

> A new user reaches their first approved output guided, no docs.

---

## Open questions for the founder (must resolve before build)

1. **Step set & order.** Is the canonical flow exactly the five steps above, or do we include "invite a teammate" / "set up a campaign"? (Recommended: the five above; teammate invite is optional/skippable.)
2. **Brain templates.** Which starter templates ship in v1 (e.g. "B2B SaaS founder voice," "Agency," "Dev-tool")? How many, and who authors the copy? (Recommended: 3 templates per the old repo's `brand_voice_templates`, founder-authored copy; I scaffold the structure + one placeholder set.)
3. **Skippable vs blocking.** Can a user skip steps and explore, or is onboarding modal/blocking until complete? (Recommended: non-blocking checklist that persists; nothing is forced.)
4. **Completion derivation.** Mark a step done from real data (a brain doc is non-empty, a connection exists, a generation exists, a draft is approved) vs. an explicit "I did this" flag? (Recommended: **derive from real data** — it can't drift and needs no extra writes.)
5. **Scope of "connect first app."** Which providers count (any connector, or a social/CRM specifically)? (Recommended: any connected provider counts.)

Defaults below assume the recommended answers; adjust before building if the founder differs.

---

## Decisions locked (recommended defaults — pending the above)

1. **Onboarding is a derived read-model, not a stored wizard state.** `GET /workspaces/:id/onboarding` computes each step's `done` from existing data (brain docs, connections, generations, drafts). No new "progress" table → it can never drift from reality (DRY). The only persisted onboarding state is an optional per-user **dismissed** flag (so a finished user can hide the checklist).
2. **Brain-doc templates live in `packages/contracts`** as structured constants (`BRAIN_DOC_TEMPLATES`) — the single vocabulary place — and are **applied** through the existing brain update path (no new write path). Applying a template fills empty docs; it never overwrites non-empty docs without confirm.
3. **The flow is a guided checklist surfaced on the dashboard home**, each item deep-linking to the page that completes it (brain editor, connectors, sandbox, approvals). Non-blocking and skippable.
4. **No new generation/approval logic** — onboarding orchestrates existing slices (Sprints 2/4/5/12). It "produces something a human can see" via the checklist + the real first-approved-output moment.

---

## Out of scope (YAGNI)
- Interactive product tours/tooltips/coachmarks (a checklist + deep links only).
- Email drip onboarding (that rides on Sprint 27 mailer separately).
- Template marketplace / user-authored templates.
- Forcing/branching flows per persona.
- Web test runner.

---

## Architecture & boundary

```
Web dashboard home
  └─ <OnboardingChecklist> ──GET /workspaces/:id/onboarding──► onboarding service (derives steps)
       each step → deep link (brain / connectors / sandbox / approvals)
  └─ "Use a template" in brain editor ──GET /brain/templates──► BRAIN_DOC_TEMPLATES
                                        ──PUT existing brain doc route── applies chosen template
  └─ dismiss ──PUT /workspaces/:id/onboarding/dismiss── per-user flag
```

### New files
- `apps/api/src/services/onboarding.ts` — `getOnboarding(db, workspaceId)` → ordered steps with `done`/`cta`.
- `apps/api/src/routes/onboarding.ts` — `GET /workspaces/:id/onboarding`, `PUT …/dismiss`, `GET /brain/templates`.
- `apps/web/app/workspaces/[id]/_components/onboarding-checklist.tsx` (or co-located on the home page).
- Tests: `apps/api/test/onboarding.test.ts`.

### Modified files
- `packages/contracts/src/index.ts` — `BRAIN_DOC_TEMPLATES`, `onboardingStepSchema`, `OnboardingStep`.
- `apps/api/src/db/schema.ts` — `onboarding_dismissals` (userId, workspaceId, dismissedAt) **or** an `onboardingDismissedAt` column on `workspace_members`. (Recommended: a column on `workspace_members` — it already keys (workspace,user).)
- `apps/api/drizzle/00NN_onboarding.sql` — generated (next after `0022` on `main`; renumber on collision).
- `apps/api/src/app.ts` — `registerOnboardingRoutes(app, db)`.
- `apps/web/app/workspaces/[id]/page.tsx` (or the dashboard home) — mount the checklist; brain editor page — "Use a template".

---

## Data model

```ts
// packages/contracts/src/index.ts — structured starter templates (copy is founder-authored; placeholders here)
export const BRAIN_DOC_TEMPLATES = [
  {
    id: "b2b-saas-founder",
    label: "B2B SaaS founder",
    docs: { soul: "…", icp: "…", voice: "…", history: "", now: "" }, // partial fills allowed
  },
  // + "agency", "dev-tool" (founder-authored copy — Q2)
] as const;

export const onboardingStepSchema = z.object({
  key: z.enum(["workspace", "brain", "connect", "generate", "approve"]),
  label: z.string(),
  done: z.boolean(),
  cta: z.string(),       // relative path to the page that completes it
});
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;
```

Step completion derivation (in `onboarding.ts`):
- `workspace` → always true once the row exists.
- `brain` → at least one of the five brain docs is non-empty (reuse the brain completeness helper).
- `connect` → `listConnections(db, ws).length > 0`.
- `generate` → at least one generation row exists for the workspace.
- `approve` → at least one draft is in state `approved`.

---

## Implementation plan (TDD, bite-sized)

> Baseline: branch from `main` after the Open Questions are resolved.

### Task 1: Templates + onboarding contracts
- [ ] **Test** (`packages/contracts/test/onboarding.test.ts`): `BRAIN_DOC_TEMPLATES` has ≥1 entry with the five doc keys present; `onboardingStepSchema` validates a step.
- [ ] **Implement** `BRAIN_DOC_TEMPLATES` + `onboardingStepSchema`. **Commit:** `feat(contracts): brain-doc templates + onboarding step`.

### Task 2: Dismissal column + onboarding service
- [ ] **Schema:** add `onboardingDismissedAt` (integer, nullable) to `workspace_members`; `npm run db:generate`.
- [ ] **Test** (`apps/api/test/onboarding.test.ts`): a fresh workspace returns steps `[workspace:done, brain:false, connect:false, generate:false, approve:false]`; after writing a brain doc / creating a generation / approving a draft, the matching step flips to `done`.
- [ ] **Run red** → implement `getOnboarding(db, workspaceId)` deriving each step as above; reuse `listConnections`, the brain completeness helper, and direct count queries on `generations`/`drafts`.
- [ ] **Run green. Commit:** `feat(api): derived onboarding read-model + dismissal`.

### Task 3: Routes
- [ ] **Test** (extend): `GET /workspaces/:id/onboarding` returns the steps for the authed member; `GET /brain/templates` returns the templates; `PUT /workspaces/:id/onboarding/dismiss` sets the flag (and a subsequent GET reflects `dismissed: true`).
- [ ] **Run red** → `registerOnboardingRoutes(app, db)` + add to `app.ts`. **Run green. Commit:** `feat(api): onboarding + templates routes`.

### Task 4: Web checklist + template apply
- [ ] Mount `<OnboardingChecklist>` on the workspace home: render steps, deep-link each `cta`, show a progress count, and a "Hide" that calls dismiss. Hide entirely once all done (or dismissed).
- [ ] In the brain editor, add "Use a template" → `GET /brain/templates` → on pick, PUT the chosen template content into **empty** docs (confirm before overwriting a non-empty doc).
- [ ] **Verify:** `npm run typecheck -w @tuezday/web && npm run build -w @tuezday/web`. **Commit:** `feat(web): onboarding checklist + brain templates`.

### Task 5: Verify + push
- [ ] `npm test && npm run typecheck` green. `git push -u origin sprint-38-onboarding-flow` (**do not merge**).

---

## Automated verification
- Contracts: templates shape + step schema.
- Service: each step derives correctly from real data; dismissal persists per (workspace,user).
- Routes: onboarding + templates + dismiss behave; auth/membership enforced by the global guard.
- Web: typecheck + build.

## Founder acceptance checklist
- [ ] A brand-new user lands on the dashboard and sees a 5-step checklist with only "workspace" done.
- [ ] Following the deep links (apply a template → connect an app → generate → approve), each step ticks off in real time, ending at a first **approved** output — no docs needed.
- [ ] "Hide" dismisses the checklist; it stays hidden for that user.

## Known limitations
- Completion is derived, so a step can "un-complete" if its underlying data is deleted (acceptable and arguably correct).
- Template copy quality depends on founder-authored content (Q2).
- No guided tour/tooltips; just a checklist + links.

## Progress log
- 2026-06-26 — Spec drafted against `main` (HEAD Sprint 31) and **marked BLOCKED** per the roadmap's explicit deferral + CLAUDE.md "ask clarifying questions first." Verified reuse points: `ensureBrainDocs`/brain completeness (`services/brain.ts`, used by `createWorkspace`), `listConnections` (`services/connections.ts`), `CONNECTOR_PROVIDERS`, drafts/generations tables. Open questions enumerated for the founder. Branch not to be cut until those are answered.
- 2026-06-27 — Re-saved after the untracked working-tree copy was lost during branch switches; content unchanged.
