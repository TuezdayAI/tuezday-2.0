# Sprint 52 — Collapse the Double Gate

> **Phase:** I (Architectural Convergence) · **Workstream:** W2
> **Closes:** Atlas conflict #2 (🟠) · **PRD:** `prd-agentic-platform.md` §4, Sprint 52
> **Branch:** `sprint-52-collapse-double-gate` (off `origin/main` @ `7cf4e41`, which includes Sprint 50)
> **Size:** M · **Risk:** Low–Medium (touches the authorization boundary; no new safety mechanism)
> **Status:** Plan awaiting founder approval — no code written yet.

---

## 1. Founder decisions recorded

| ID | Decision | Answer |
|---|---|---|
| **D2** | Does approving a draft auto-authorize its publication by default? | **Yes, for `publish` only.** `send`, `reply`, `paid_launch`, `budget_change`, `targeting_change` keep the second gate unconditionally. |
| **D2a** | Does a system/auto-approved draft (cadence `autoApprove`) satisfy the collapsed gate? | **No — humans only.** Only a human approval collapses Gate 2. Without this, enabling `autoApprove` would silently turn `human_required` into fully autonomous publishing. |
| **D2b** | How does the collapse appear in the policy editor? | **Built-in default for `publish`.** No new policy rule value. The existing `autonomous` / `human_required` vocabulary is unchanged; for `publish`, `human_required` means "approving the draft authorizes it". The editor states this inline. |

**Why D2b matters technically:** the effective policy is part of the existing action fingerprint
(`fingerprintExternalActionIntent`). Adding a third rule value would change the hash input for every
in-flight action and **mass-stale outstanding publish actions**. Keeping the vocabulary fixed avoids
that entirely.

---

## 2. The problem

A post under `human_required` needs two human decisions:

- **Gate 1 — "is this good?"** `POST /workspaces/:id/drafts/:draftId/approve` → `drafts.state = approved`,
  logged in `approvalDecisions` (`services/drafts.ts:293-322`).
- **Gate 2 — "may this leave the building?"** The publish external action lands in
  `authorization_required` and waits for `POST .../external-actions/:actionId/authorize`
  (`services/external-action-coordinator.ts:301-355`).

The questions are genuinely different, but nothing links "I just approved this" to "…and obviously
authorize its publication". The same post appears in **tab 1 (approvals)** and again in
**tab 3 (authorizations)** of `apps/web/app/workspaces/[id]/review/page.tsx`. A solo founder clicks
yes twice per post.

### 2.1 What already exists (most of the machinery)

1. **Policy is already resolved per action kind.** `resolveExternalActionPolicy`
   (`services/external-action-policy.ts:210-256`) keys on `actionKind`, so "collapse for `publish`
   only" is a branch on an existing dimension — no new policy plumbing.
2. **Exactly six action kinds** (`packages/contracts/src/index.ts:1026-1034`). We collapse one.
3. **Content-sensitive fingerprinting already exists** (`canonicalActionFingerprint`,
   `services/external-action-fingerprint.ts:17-19`) and is already re-verified at authorize and
   dispatch — this is the existing staleness system.
4. **The draft↔action link is durable**: `externalActions.draftId` FK (`schema.ts:1077`) plus
   `subjectKind="draft"` / `subjectId`.
5. **Publishing already refuses a non-approved draft** — `publishIntent`
   (`services/external-action-adapters.ts:104-198`) throws `draft_not_approved`, and because it is
   also the adapter's `revalidate`, this re-runs at propose, authorize **and** dispatch. Collapsing
   cannot smuggle an unapproved draft through.
6. **Autonomous mode already collapses both gates** (`external-action-coordinator.ts:288-295`),
   proving the plumbing.

### 2.2 The ordering problem (what shapes the design)

**Approving a draft creates nothing.** The approve route (`routes/drafts.ts:242-322`) takes an empty
body, flips state, and logs a decision. The external action does not exist yet — it is created later
by `POST /drafts/:draftId/publish` (`routes/publications.ts:41-89`) or, hours later, by the cadence
scheduler (`services/cadences.ts:318-383`).

So a literal "Approve & authorize" button has nothing to authorize at click time.

| Option | Verdict |
|---|---|
| (a) Approve endpoint proposes the publish action inline | **Rejected.** The approve endpoint has no destination (`connectionId`, target, timing) and this breaks the cadence path, where publishing happens at a scheduled slot much later. |
| (b) Record *what was approved* at Gate 1; auto-authorize at propose time when it still matches | **Chosen.** Fits the existing architecture and works for both the manual and cadence paths. |

**The existing intent fingerprint cannot be reused for this.** `fingerprintExternalActionIntent`
(`external-action-coordinator.ts:116-134`) hashes `context`, `requestedFor`, `subject.destination`
and the resolved `policy` — none of which exist at approval time. It would never match. We need a
**narrower, content-only approval fingerprint**.

---

## 3. Design

### 3.1 The approval fingerprint

A new, deliberately narrow hash over exactly what a human approved:

```
draftApprovalFingerprint(draft) = canonicalActionFingerprint({
  draftId: draft.id,
  content: draft.content,
  media:   draft.mediaJson ?? null,   // Sprint 41 visuals — a swapped image must re-arm the gate
})
```

Reuses `canonicalActionFingerprint` (key-sorted canonicalization + SHA-256). **`mediaJson` is
included deliberately**: approving text and then swapping the image must invalidate the collapse.

Stored on the approval decision row in a new nullable column `content_fingerprint`, written **only
when the approving actor is human** (`actor.userId !== null`). System approvals leave it `null`,
which is what enforces D2a.

### 3.2 The collapse, at propose time

In `proposeWithLineage`, at the existing policy fork (`external-action-coordinator.ts:288-295`):

```
if policy.effective === "human_required":
    if kind === "publish" and collapse applies:
        → transition proposed → authorized
        → insert externalActionDecision {
              decision: "authorize",
              actor:  the human who approved the draft,
              reason: "Collapsed from draft approval (Sprint 52)",
          }
        → dispatch()
    else:
        → authorization_required        # unchanged for all five other kinds
```

**"Collapse applies"** means all of:
1. `kind === "publish"`.
2. The draft is currently `approved`.
3. Its most recent `approve` decision has a non-null `content_fingerprint` (i.e. a **human** approved it).
4. That stored fingerprint equals `draftApprovalFingerprint(currentDraft)` — nothing changed since.

Otherwise the action goes to `authorization_required` exactly as today, and the UI says why.

**Attribution is preserved.** The authorize decision is attributed to the human who approved the
draft — not to `system` — so "who authorized this publication" still has a real answer. Two
decisions remain recorded: the `approvalDecisions` row (Gate 1) and the `externalActionDecisions`
row (Gate 2). **Governance is preserved, not weakened.**

**The cadence path is the point.** Cadence proposes as `{userId: null, label: "system"}`, but the
*authorization* derives from the earlier **human** approval fingerprint. That is exactly the PRD
acceptance test: approve a LinkedIn draft once, and it publishes on cadence with no second click.
If the draft was auto-approved by the system, no human fingerprint exists → no collapse → Gate 2.

### 3.3 Two defects fixed in the same sprint

- **500 that should be a 409.** If a draft leaves `approved` after its publish action is proposed,
  `authorize()` → `currentFingerprint()` → `publishIntent()` throws
  `ExternalActionPreparationError`. `authorize()` does not catch it and `externalActionError()`
  (`routes/external-actions.ts:35-49`) does not map it, so the founder gets a **500** instead of the
  intended `409 stale_action`. The collapse increases traffic through this path — fix it here.
- **No way to withdraw a collapsed authorization.** A collapsed action never appears in the
  authorization queue, so there is currently no UI to stop it before dispatch.
  `authorized → cancelled` is already legal (contracts `:2562`); expose it.

### 3.4 Out of scope

No changes to: the policy vocabulary, the five other action kinds, the ten-state lifecycle, batch
authorization semantics, the approval state machine, or dispatch. This sprint links two existing
gates; it does not redesign either.

---

## 4. Implementation plan

> TDD throughout: write the failing test, watch it fail, implement, watch it pass, commit.
> `npm test` and `npm run typecheck` must be green before each commit.

### Task 1 — Approval fingerprint helper (pure, no DB)

**Files:** create `apps/api/src/services/draft-approval-fingerprint.ts`;
test `apps/api/test/draft-approval-fingerprint.test.ts`.

- [ ] Test: same content + same media → identical hash; different content → different hash;
      different `mediaJson` with identical content → **different** hash; `null` vs absent media → stable.
- [ ] Run; confirm it fails (module missing).
- [ ] Implement `draftApprovalFingerprint(draft: { id: string; content: string; mediaJson: string | null })`
      delegating to `canonicalActionFingerprint`.
- [ ] Run; green. Commit.

### Task 2 — Persist the fingerprint at approval (human only)

**Files:** `apps/api/src/db/schema.ts` (add `contentFingerprint: text("content_fingerprint")` to
`approvalDecisions`); generated migration under `apps/api/drizzle/` via
`npm run db:generate -w apps/api`; `packages/contracts/src/index.ts`
(`approvalDecisionSchema` += `contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable()`);
`apps/api/src/services/drafts.ts` (`logDecision`, `applyDraftActionInTransaction`);
tests in `apps/api/test/drafts.test.ts`.

- [ ] Test: a **human** approve writes a non-null `contentFingerprint` matching
      `draftApprovalFingerprint(draft)`; a **system** approve (actor `{userId: null}`, as used by
      `submitAutomaticDraft`, `drafts.ts:212-217`) writes `null`; `edit`/`reject`/`submit`/`resubmit`
      write `null`.
- [ ] Run; confirm failure.
- [ ] Add the column, generate the migration (**do not hand-write SQL** — CLAUDE.md), extend the
      contracts schema, and set the fingerprint in `logDecision` only when
      `action === "approve" && actor.userId !== null`.
- [ ] Run; green. Commit.

### Task 3 — Lookup: "was this exact content approved by a human?"

**Files:** `apps/api/src/services/drafts.ts` (export
`latestHumanApprovalFingerprint(db, workspaceId, draftId): string | null`);
tests in `apps/api/test/drafts.test.ts`.

- [ ] Test: returns the fingerprint after a human approve; `null` after a system approve; `null`
      when the draft is not currently `approved`; after approve → edit → re-approve, returns the
      **latest** fingerprint (ordered by `createdAt`, not insertion order).
- [ ] Run; confirm failure.
- [ ] Implement: newest `approve` row for the draft, scoped to `workspaceId`, returning its
      `contentFingerprint`.
- [ ] Run; green. Commit.

### Task 4 — The collapse at propose time (the core change)

**Files:** `apps/api/src/services/external-action-coordinator.ts` (the policy fork at `:288-295`);
tests in `apps/api/test/external-action-publication.test.ts`.

- [ ] Test (the headline acceptance): workspace policy `human_required`; a human approves a draft;
      proposing the publish action returns status **`authorized`** (not `authorization_required`),
      an `externalActionDecisions` row exists with `decision: "authorize"`, the reason naming the
      collapse, and the actor being the **approving human** — and it dispatches.
- [ ] Test (gate re-arms): approve → edit the draft → propose → **`authorization_required`**.
- [ ] Test (media re-arms): approve → change `mediaJson` only → propose → **`authorization_required`**.
- [ ] Test (D2a safety): a **system**-approved draft under `human_required` → **`authorization_required`**.
- [ ] Test (cadence): human-approved draft proposed by the system actor via the cadence path →
      collapses and publishes with no second click.
- [ ] Test (regression, the five other kinds): under `human_required`, `send`, `reply`,
      `paid_launch`, `budget_change`, `targeting_change` still land in `authorization_required`.
      Extend the existing `external-action-{email,messaging,paid-launch,budget-change,targeting-change}.test.ts`.
- [ ] Run; confirm failures.
- [ ] Implement the branch. Keep the `autonomous` path untouched.
- [ ] Run; green. Commit.

### Task 5 — Fix the 500 → 409 on a stale publish

**Files:** `apps/api/src/services/external-action-coordinator.ts` (`authorize`, `currentFingerprint`,
`dispatch`); `apps/api/src/routes/external-actions.ts` (`externalActionError`);
tests in `apps/api/test/external-actions.test.ts`.

- [ ] Test: propose a publish action, move the draft out of `approved`, call `authorize` → **409
      `stale_action`** (today: 500), and the action is left `stale`.
- [ ] Run; confirm it fails with a 500.
- [ ] Catch `ExternalActionPreparationError` during revalidation, mark the action `stale`, and raise
      `StaleExternalActionError` so the existing 409 mapping applies.
- [ ] Run; green. Commit.

### Task 6 — Allow withdrawing a collapsed authorization

**Files:** `apps/api/src/routes/external-actions.ts` + coordinator (`cancel` for `authorized`,
pre-dispatch); `apps/web/app/workspaces/[id]/review/_components/authorizations-queue.tsx`;
tests in `apps/api/test/external-actions.test.ts` and the web shell tests.

- [ ] Test: an `authorized` (collapsed, not yet dispatched) publish action can be cancelled, and a
      `succeeded` one cannot.
- [ ] Run; confirm failure.
- [ ] Implement using the existing legal `authorized → cancelled` transition; surface it in the UI.
- [ ] Run; green. Commit.

### Task 7 — Make the collapse visible (UI + copy)

**Files:** `apps/web/app/workspaces/[id]/automation/action-policy.tsx`;
`apps/web/app/workspaces/[id]/review/_components/approvals-queue.tsx`;
`apps/web/app/workspaces/[id]/review/page.tsx`; existing web shell tests.

- [ ] Policy editor: for the `publish` row under `human_required`, state inline that approving a
      draft authorizes its publication, and that editing after approval re-arms the second gate.
      **A visible choice, not hidden behavior** (PRD requirement).
- [ ] Approvals queue: the approve button communicates that, for publish, approving also authorizes.
- [ ] Where an action *did* re-arm Gate 2, show the reason ("draft changed after approval").
- [ ] Keep using the contracts helpers (`canTransition`) — no hand-rolled state logic.
- [ ] `npx vitest run --project @tuezday/web`; green. Commit.

### Task 8 — Verify, document, push

- [ ] Full `npm test` + `npm run typecheck` green.
- [ ] Update `docs/deferred-improvements.md` if anything was deliberately deferred.
- [ ] Progress log below updated with what actually happened.
- [ ] Push `sprint-52-collapse-double-gate`. **Do not merge to `main`** — founder merges.

---

## 5. Acceptance criteria (from the PRD)

- [ ] Approving a LinkedIn draft publishes it on cadence with **no second click**.
- [ ] Editing after approval **re-arms** the second gate, and the UI surfaces why.
- [ ] Spend (`paid_launch`, `budget_change`, `targeting_change`) and messaging (`send`, `reply`)
      still require two decisions — proven by regression tests.
- [ ] Both decisions remain recorded and attributed; "who authorized this publication" has a real
      human answer.
- [ ] A system-approved draft does **not** collapse the gate (D2a).
- [ ] The policy editor shows the collapsed default explicitly.
- [ ] `npm test` and `npm run typecheck` pass.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Collapse silently weakens governance | Two decisions still recorded and attributed; `publishIntent` still refuses non-approved drafts at propose/authorize/dispatch; regression tests on all five other kinds. |
| `autoApprove` turns `human_required` into autonomous publishing | D2a: only a human approval writes a fingerprint. Directly tested. |
| Changing policy shape mass-stales in-flight actions | D2b: policy vocabulary untouched, so the intent fingerprint's inputs are unchanged. |
| Media swapped after approval | `mediaJson` is inside the approval fingerprint; explicitly tested. |
| A collapsed action can't be stopped | Task 6 exposes cancel before dispatch. |
| Batch authorization double-authorizes a collapsed action | Verify in Task 4; an already-`authorized` action is not in the `authorization_required` queue the batch path reads. |

---

## 7. Progress log

- **2026-08-02** — Recon complete against `origin/main` @ `7cf4e41` (Sprint 50 merged; baseline
  verified against `origin/main`, not local `main` — the Sprint 51 lesson). Decisions D2/D2a/D2b
  recorded. Plan written and awaiting founder approval. No code written yet.
