# Sprint 54 — One Governance Spine for Ads

> **Phase:** I (Architectural Convergence) · **Workstream:** W2
> **Closes:** Atlas conflict #5 (split ads governance)
> **PRD:** `prd-agentic-platform.md` §4, Sprint 54
> **Size:** L · **Risk:** Medium (touches live-spend paths; migration is deliberately conservative)
> **Status:** Delivered on `sprint-54-ads-governance-spine` — Tasks 1–7 complete. `npm test`
> (199 files / 2184 tests) and `npm run typecheck` green. Awaiting founder review and merge
> (after Sprints 52 and 53). **Decision D4a was amended during implementation** — see §3.0 for the
> evidence that forced it. See §7 for what actually happened, task by task.

---

## 0. Branch and merge order

**Branch `sprint-54-ads-governance-spine` off `sprint-53-campaign-strategy-signal-mapping`.
Required merge order: 52 → 53 → 54.**

Sprint 54 has no functional dependency on 52 or 53, but both are unmerged and claim migrations:
52 → `0060`/`0061`, 53 → `0062`. Branching off `main` would make drizzle-kit generate a colliding
number. Off Sprint 53, the next generated migration is `0063`.

> **Note:** Sprint 53 is currently incomplete — Tasks 1, 2 and 6 are committed; Tasks 3, 4, 5 and 7
> are not, and `apps/api/test/resolve.test.ts:41` is red pending Task 3. **Sprint 54 must not begin
> until Sprint 53's branch is green**, or Sprint 54 inherits a red baseline and its own test runs
> become unreadable.

---

## 1. Founder decisions recorded

| ID | Decision | Answer |
|---|---|---|
| **D4a** | The decision-log merge cannot be lossless. How is history handled? | **AMENDED during implementation — see D4a′ below.** Originally: freeze the archive and move new gate decisions into the external-action log. Implementation evidence showed that is not possible. |
| **D4a′** | *(Amended 2026-08-02, after Task 2 prototyping.)* | **Delete the false row; scope the rest honestly.** The two logs answer genuinely different questions and both should exist. Delete only the **synthetic `launch` row** written at `performLaunch:448` — a fabricated `approved → launched` transition with `human: false` that *looks* like it answers "who authorized this spend" when the real answer already lives in the external-action log. Keep `submit`/`approve`/`reject`/`revise` as an honestly re-scoped **setup-approval** trail. No new table, no migration, no fabricated data. |
| **D4b** | Where do spend guardrails enforce? | **At proposal time.** `proposed → blocked` is already a legal transition, so no lifecycle contract change. The founder learns about a cap breach immediately instead of after clicking authorize. `dispatch`'s existing guard stays as the backstop. |
| **D4c** | Are `resume` and the kill switch in scope? | **No — scope to initial launch.** Both remain ungoverned and are recorded as explicit deferred items. Keeps the sprint at L and avoids inventing a seventh action kind. |
| **D4d** | Enforce `Entitlements.adSpendCapCents`? | **No — leave dead, mark `reserved`.** Free tier is `0`; enforcing it would silently disable ad launching for every free workspace. That is a pricing decision, not a refactor. Marked reserved in contracts naming the sprint that will activate it, following Sprint 50's vocabulary-hygiene pattern. |

---

## 2. The problem — and how much of it is already solved

### 2.1 What the conflict actually is

The PRD describes two parallel paths to spend. **That is no longer true, and the plan must not
pretend otherwise.** Verified in code:

- `POST /workspaces/:id/ads/launches/:launchId/launch` (`routes/ad-launches.ts:311-338`) **only**
  calls `preparePaidLaunchAction` + `runtime.propose`. There is no bespoke launch path left.
- `performLaunch` (`services/ad-launches.ts`) is reached **solely** from
  `paidLaunchActionAdapter.execute` (`services/external-action-adapters.ts:1246-1307`).
- Already converged: `ad_launches.external_action_id` + index (migration `0045`),
  `AdLaunch.externalActionId` in contracts, the UI's external-action link-out, and the `paid_launch`
  policy default in `external-action-backfill.ts:21`.

**What genuinely remains split is two things:**

1. **A pre-condition gate.** `preparePaidLaunchAction` (`external-action-adapters.ts:1145-1177`)
   requires `status === "approved"` and rejects `launched`. The four gate verbs
   (`submit`/`approve`/`reject`/`revise`) run through `applyLaunchAction`
   (`services/ad-launches.ts:246-260`) — the **only** production caller of `adLaunchTransitionTo`.
2. **A second decision log.** `ad_launch_decisions` (`schema.ts:1797-1814`), written by
   `logLaunchDecision` from two sites: `applyLaunchAction:258` and `performLaunch:448` (the synthetic
   `approved → launched` row). Read by exactly one path: `listLaunchDecisions` → the launch detail
   route → the UI's "Decision log" toggle.

So "who authorized this spend?" has two answers today, and that is the defect worth fixing.

### 2.2 The bespoke rule that cannot fold in

`revise` (`pending_review|rejected|approved → draft`) is **not** a dispatch state — it is an
**editability** rule. `PATCH .../launches/:launchId` is rejected unless `status === "draft"`
(`routes/ad-launches.ts:254-259`). The external-action lifecycle has no "the subject is now editable"
concept; `stale` is a property of the *action*, not the subject.

**Therefore `AD_LAUNCH_STATUSES` does not fully disappear**, and the plan says so honestly rather
than discovering it mid-implementation. What survives is a minimal editability gate; what goes is the
duplicate decision log and the bespoke transition helper.

### 2.3 The guardrail hook the PRD assumes does not exist

`ExternalActionAdapter.guard` is invoked from exactly one place — `dispatch()`
(`external-action-coordinator.ts:322`) — i.e. **after** the status is already `authorized` and
**after** the `externalActionDecisions` row is written. So today the record says "X authorized this
spend", and only then does the cap check fire and flip the action to `blocked`.

`authorization_required → blocked` is **not** a legal edge
(`packages/contracts/src/index.ts:1892` allows only `authorized`, `stale`, `cancelled`). Per D4b we
therefore enforce at **proposal** time, where `proposed → blocked` **is** already legal (`:1891`) —
no lifecycle contract change, and the founder is told sooner.

---

## 3. Design

### 3.0 Why D4a was amended (implementation evidence)

Task 2 prototyped the preferred option — propose the `paid_launch` action at **submit** time, so gate
decisions hang off a real action — and it is **disqualifying**:

- `paid_launch` resolves to `autonomous` under `scheduled_auto`
  (`services/external-action-backfill.ts:21`), and `proposeWithLineage:546` dispatches immediately.
  **Proposing at submit would spend money at Submit, before anyone approves.**
- Avoiding that would require writing a decision row against a `proposed` action, which the
  coordinator explicitly forbids (`external-action-coordinator.ts:502-506`), or making Approve the
  moment money is spent.
- Independently, `EXTERNAL_ACTION_DECISIONS` is only `["authorize", "deny"]` — there is no
  vocabulary for `submit` or `revise`.

**The reframe.** The two logs answer different questions, in the same way Sprint 52 distinguished
"is this good?" from "may this leave the building?":

| Log | Question it answers |
|---|---|
| `ad_launch_decisions` (`submit`/`approve`/`reject`/`revise`) | **who approved this ad's setup?** |
| `external_action_decisions` (`authorize`/`deny`) | **who authorized this spend?** |

Those are not competing answers, and merging them would destroy a real distinction. The genuine
defect is the **synthetic `launch` row** — it fabricates a state transition and claims `human: false`
authorship, and it is the only thing that makes the two logs *look* like rival answers to the spend
question. Deleting it, and re-scoping the remainder in code and UI as setup approval, satisfies the
acceptance criterion honestly.

### 3.1 One decision log for spend, going forward (D4a′)

> ⚠️ **This section describes what SHIPPED.** An earlier draft instructed proposing the `paid_launch`
> action at **submit** time so gate decisions could hang off it. **Do not build that.** `paid_launch`
> resolves to `autonomous` under `scheduled_auto` (`services/external-action-backfill.ts:21`) and
> `proposeWithLineage` dispatches immediately, so it would create a live Meta campaign and start
> spending the moment a founder clicks *Submit for approval*, before anyone approves. §3.0 records
> the full evidence.

**Two logs, two different questions — both legitimate, and both kept:**

| Log | Question | Writers |
|---|---|---|
| `ad_launch_decisions` | *who approved this ad's **setup**?* | `recordSetupGateDecision`, on `submit`/`approve`/`reject`/`revise` |
| `external_action_decisions` | *who authorized this **spend**?* | the external-action coordinator, on `authorize`/`deny` |

**What changed is one row, not the architecture.** The synthetic `launch` row that `performLaunch`
used to write — a fabricated `approved → launched` transition claiming `human: false` authorship —
is deleted. It was the only thing that made the two logs look like rival answers to the spend
question, and it was a false claim in a spend record.

- `applyLaunchAction` **still writes** `ad_launch_decisions` for the four setup-gate verbs. That is
  correct: those decisions answer the setup question, and there is no external action to hang them
  off without spending early.
- `logLaunchDecision` / `listLaunchDecisions` were **renamed**, not deleted, to
  `recordSetupGateDecision` / `listSetupGateDecisions`, so the code reads as a setup trail rather
  than spend governance.
- `"launch"` stays in the **read** vocabulary (`AD_LAUNCH_DECISION_ACTIONS`): historical rows since
  Sprint 20 contain it and `adLaunchDecisionSchema` validates on read, so removing it would leave the
  contract unable to describe existing data. **Writers** are narrowed to `AD_LAUNCH_ACTIONS`.
- No migration, and nothing fabricates data.

### 3.2 Guardrails at proposal (D4b)

`checkSpendGuardrails` (`services/ad-launches.ts:325-345` — kill switch + workspace daily cap over
committed budgets of spending launches) runs when a `paid_launch` is **proposed**. A breach yields
`proposed → blocked` with the existing blocker vocabulary, before any authorization decision is
recorded. `dispatch`'s existing guard call stays as the backstop for a cap breached in between.

**Blocker vocabulary hygiene (atlas conflict #9's cousin):** `paid_launch` emits `kill_switch_on`
(`external-action-adapters.ts:1241`) while `budget_change`/`targeting_change` emit `kill_switch`
(`:1464`, `:1693`). Pick one, use it everywhere, update the UI/tests that read blocker codes.

### 3.3 Deliberately out of scope

- **`POST .../resume`** (`routes/ad-launches.ts:448`) restarts spend with a bare 409 and no decision
  row, and **`PUT /ads/settings { killSwitch: true }`** pauses spend workspace-wide, also with no
  decision row. Per D4c both stay ungoverned this sprint. **This means the PRD's acceptance criterion
  is only met for the initial launch** — stated plainly here and logged as a deferred item, not
  quietly claimed as done.
- **`Entitlements.adSpendCapCents`** stays unread and is marked `reserved` (D4d).
- **Reporting sync stays untouched** — verified read-only and correctly separate (`services/ads.ts`,
  `syncAdAccount` → `ad_campaign_metrics`). Its one coupling, `syncLaunchStatuses`, writes only
  `platformStatus`. Note that column feeds `isSpending` → `checkSpendGuardrails`, so the read-only
  sync is an **input** to the guardrail being moved — do not break it.

---

## 4. Implementation plan

> TDD throughout. Stage with explicit pathspecs (`git commit -- <paths>`), never `git add -A`.
> `npm test` and `npm run typecheck` green before each commit.

### Task 1 — Blocker vocabulary + reserved entitlement (small, unblocks clean tests)
**Files:** `packages/contracts/src/index.ts`; `services/external-action-adapters.ts`; any UI/test
reading blocker codes.
- [ ] Unify `kill_switch_on` / `kill_switch` on one spelling across all three ad kinds.
- [ ] Mark `Entitlements.adSpendCapCents` `reserved` with a comment naming the activating sprint
      (follow Sprint 50's pattern).
- [ ] Update tests asserting the old blocker string. Commit.

### Task 2 — Gate decisions move to the external-action log
**Files:** `services/ad-launches.ts` (`applyLaunchAction`, delete `logLaunchDecision`);
`services/external-action-coordinator.ts` or the adapter as needed; `apps/api/test/ads-execution.test.ts`.
- [ ] **First, prototype §3.1(a):** propose the `paid_launch` action at submit time. Verify against
      code whether it breaks (i) the idempotency key `paid_launch:<launchId>:<attempt>` derived from
      `countTerminalExternalActionsForSubject` (`external-actions.ts:395-414`), and (ii) the moment
      policy is resolved. If either breaks, fall back to §3.1(b) and **write the justification in the
      report**.
- [ ] Test: submit/approve/reject/revise each record a decision in the external-action log,
      attributed to the acting user.
- [ ] Test: no new rows appear in `ad_launch_decisions`.
- [ ] Test: `GET .../launches/:launchId` still returns historical decisions from the archive.
- [ ] Commit.

### Task 3 — Guardrails at proposal time
**Files:** `services/external-action-adapters.ts` (`preparePaidLaunchAction`) and/or
`external-action-coordinator.ts`; `apps/api/test/ads-execution.test.ts`,
`external-action-paid-launch.test.ts`.
- [ ] Test (kill switch): proposing a `paid_launch` under a kill switch yields `blocked` **at
      proposal**, with **no** authorization decision recorded.
- [ ] Test (daily cap): same for a cap breach, over committed budgets of spending launches, ignoring
      paused launches (mirror the existing assertion at `ads-execution.test.ts:721`).
- [ ] Test (backstop intact): a cap breached between proposal and dispatch is still caught by the
      existing `guard`.
- [ ] Verify `platformStatus` still feeds `isSpending` correctly — the guardrail's input.
- [ ] Commit.

### Task 4 — Retire the bespoke transition helper
**Files:** `packages/contracts/src/index.ts` (`adLaunchTransitionTo`, `AD_LAUNCH_TRANSITIONS`);
`services/ad-launches.ts`; `routes/ad-launches.ts`; `apps/api/test/ads-execution.test.ts:276-288`.
- [ ] Keep a **minimal editability gate** per §2.2 — `PATCH` must still be rejected once a launch has
      left the editable state. Decide between a reduced `status` and an explicit `editable`/`locked`
      flag, and justify it in the report.
- [ ] Remove `adLaunchTransitionTo` and its production caller. **Acceptance: `grep` finds no
      remaining callers** (the contract test at `ads-execution.test.ts:276-288` goes with it).
- [ ] Test: the editability rule still holds — `PATCH` succeeds while editable, 409s once not.
- [ ] Commit.

### Task 5 — Rewrite the test that encodes the conflict
**Files:** `apps/api/test/external-action-paid-launch.test.ts:278`.
- [ ] `"denies without touching the launch's approval history"` currently **asserts the two logs stay
      independent** — it encodes the defect. Rewrite it to assert the converged behavior: a denial is
      recorded once, in the external-action log, and the launch remains re-proposable.
- [ ] Treat this as a spec change, not a mechanical fixup: state in the report what the old test
      guaranteed and what the new one guarantees instead.
- [ ] Commit.

### Task 6 — UI: one decision log, history labelled
**Files:** `apps/web/app/workspaces/[id]/ad-launches/page.tsx` (decision log ~:1020-1034, gate
buttons ~:744-828); relevant `apps/web/lib` shell tests.
- [ ] The decision log shows external-action decisions as the live record, with archived
      `ad_launch_decisions` rows clearly labelled historical.
- [ ] Gate buttons reflect whatever Task 2 chose; copy must not promise governance that
      `resume`/kill-switch do not have.
- [ ] Commit.

### Task 7 — Verify, document, push
- [ ] Full `npm test` + `npm run typecheck` green.
- [ ] `docs/deferred-improvements.md`: record (i) `resume` and the kill switch remain ungoverned,
      (ii) `adSpendCapCents` reserved and unenforced, (iii) historical decisions not retro-merged.
- [ ] Progress log updated. Push. **Do not merge** — founder merges, after 52 and 53.

---

## 5. Acceptance criteria

- [x] **One record answers "who authorized this spend"** for the initial launch, going forward: the
      external-action decision log. Two caveats stated rather than hidden — (i) explicitly NOT for
      `resume` or the kill switch (D4c, deferred #40); (ii) under an **autonomous** policy there is no
      decision row at all, and the honest answer is `proposedBy` plus the policy snapshot. The UI says
      exactly that and never names a person.
- [x] `adLaunchTransitionTo` has no remaining callers (only explanatory comments).
- [x] **Nothing writes a `launch`/authorization row into `ad_launch_decisions`.** The four setup-gate
      verbs still write it — that is the setup trail, and it is correct. Historical `launch` rows
      remain readable and are labelled as historical, never as a spend authorization.
- [x] A kill switch or daily-cap breach blocks a `paid_launch` **at proposal**, with no authorization
      decision recorded.
- [x] The launch record is still uneditable once it has left the editable state.
- [x] Reporting sync is untouched and still feeds `isSpending`.
- [x] `npm test` (199 files / 2184 tests) and `npm run typecheck` pass.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **Meta-side desync on a live campaign.** `performLaunch` persists each external id as it lands and resumes rather than duplicating; a mid-chain launch is real Meta spend with no local terminal status. | Do not touch `performLaunch`'s resume-on-retry invariant. Two tests pin it (`ads-execution.test.ts:739`, `external-action-paid-launch.test.ts:311`) — they must keep passing unmodified. |
| **Idempotency counter corruption.** `paid_launch:<launchId>:<attempt>` derives from `countTerminalExternalActionsForSubject`. Proposing at submit time (§3.1a) changes when actions exist for a subject. | Task 2 prototypes and verifies this explicitly before committing to (a); documented fallback to (b). |
| **A test asserts the conflict.** `external-action-paid-launch.test.ts:278` guarantees the two logs stay separate. | Task 5 treats it as a spec change with a written before/after, not a fixup. |
| Error path change strands a live campaign. `performLaunch` persists `lastError` and rethrows; the adapter catches and returns `failed`; a thrown-and-uncaught error leaves the action `dispatching` by design. | Do not modify that path in this sprint. Any change requires its own test. |
| Guardrail input breaks. `platformStatus` (written by the read-only reporting sync) feeds `isSpending` → `checkSpendGuardrails`. | Task 3 verifies it explicitly. Reporting sync stays untouched. |
| Acceptance criterion overstated. | §3.3 and §5 both state the initial-launch scoping in writing. |
| Red baseline inherited from Sprint 53. | §0 — Sprint 54 does not start until Sprint 53's branch is green. |

---

## 7. Progress log

- **2026-08-02** — Recon complete against the Sprint 53 working tree. Key correction to the PRD's
  premise: there is no parallel launch path left; what remains split is a pre-condition gate and a
  duplicate decision log. Decisions D4a–D4d recorded. Plan written, awaiting founder approval.

- **2026-08-02 — Task 1** (`6ea315f`). Unified the blocker vocabulary on **`kill_switch_on`** — the
  spelling `checkSpendGuardrails` and eight other services already emit; `budget_change` /
  `targeting_change` were translating *away* from the codebase's own convention. No UI change needed:
  `apps/web` treats blocker codes as opaque. `Entitlements.adSpendCapCents` marked `reserved` per D4d.

- **2026-08-02 — Task 3** (`820a3dc`). New optional `ExternalActionAdapter.guardAtProposal`, called in
  `proposeWithLineage` after insert and **before both** the `human_required` branch and the autonomous
  dispatch → `proposed → blocked`. No lifecycle contract change, and **no authorization decision is
  ever written** for a refused launch. `dispatch`'s existing `guard` retained as the backstop.
  `platformStatus → isSpending → checkSpendGuardrails` verified end to end by the new cap test.

- **2026-08-02 — D4a AMENDED** (`615df42`). See §3.0. Task 2's prototype of the preferred design
  proved it disqualifying: `paid_launch` resolves to `autonomous` under `scheduled_auto` and
  `proposeWithLineage:546` dispatches immediately, so proposing at submit would **spend money at
  Submit, before approval**. Independently, `EXTERNAL_ACTION_DECISIONS` has no `submit`/`revise`
  vocabulary. Founder chose: delete the false row, scope the rest honestly.

- **2026-08-02 — Task 2** (`66c92da`). Deleted the synthetic `launch` decision row from
  `performLaunch`, and its now-dead `actor` parameter (signature only — the resume/error path is
  byte-identical), which removes the `human: false` fabrication at the call site.
  **`"launch"` was deliberately KEPT in the read vocabulary**: historical rows since Sprint 20
  contain it and `adLaunchDecisionSchema` validates on read, so dropping it would leave the contract
  unable to describe existing data. Writers are narrowed to `AD_LAUNCH_ACTIONS` instead.

- **2026-08-02 — Task 6** (`cc624d8`). Two records made legible and neither one lies about the other.
  The page **never** puts a person's name beside "authorized" — under an autonomous policy it names
  the policy and links out for authorship. Retired `launch` rows render annotated rather than as a
  spend authorization. D4c's limitation is stated in the UI verbatim. Also relabelled
  **"Approve spend" → "Approve setup"**; that button never authorized spend.

- **2026-08-02 — Task 4** (`efb8c8b`). `adLaunchTransitionTo` and `AD_LAUNCH_TRANSITIONS` deleted;
  grep finds no callers (three explanatory comments only). Chose a **reduced `status`** over an
  `editable` flag: `status` cannot go away regardless (`approved` gates `preparePaidLaunchAction`,
  `launched` feeds `isSpending`, DELETE refuses `launched`), so a flag would have been *additive* —
  a second, desyncable source of truth on a live-spend path, plus a backfill, retiring nothing.
  The surviving editability rule is one predicate, `isAdLaunchEditable`.

- **2026-08-02 — Task 5** (`ad1a1b5`). Rewrote the test that encoded the conflict. **Old guarantee:**
  a denial leaves the setup trail and status alone — i.e. merely that the two logs are independent,
  which read as the defect. **New guarantee:** the same separation stated positively from both sides —
  the refusal is recorded exactly once in the spend log (real action, `actorHuman`, reason persisted),
  the setup trail neither gains a row nor loses its approval, and reproposing creates a new action
  without erasing or duplicating the refusal. No production change was needed.
  Also found that the neighbouring kill-switch test had **silently lost its distinguishing power**
  after Task 3 — old and new code paths produced identical assertions — and gave it
  `authorizedAt === null`, which the old dispatch-time path would have failed.

- **2026-08-02 — Task 7.** `CLAUDE.md`'s instruction to use `adLaunchTransitionTo` corrected (it was
  stale the moment Task 4 landed). Deferred improvements #40–#42 recorded: resume and the kill switch
  still change spend with no decision row (D4c), `adSpendCapCents` reserved but unenforced (D4d), and
  spend authorship being two clicks from the launch. Verified: 199 files / 2184 tests, typecheck clean.
