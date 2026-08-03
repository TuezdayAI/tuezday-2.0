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
| **D2c** | Does approving from email / Telegram (a signed one-time link) collapse the gate? | **Yes — trust the token.** Raised by the Task 1–3 review: `actor.userId !== null` silently excluded the mobile and Telegram approve paths, so the feature would not have worked from a phone. The token is single-use, expiring, hash-stored, and delivered to a configured founder channel; the platform already trusts it to *approve* content, and the collapse grants no new power — it removes a redundant second click on a decision already made. **Accepted tradeoff:** someone with access to the founder's email or Telegram can cause a publish without an app login. The public-API actor (`label: "api"`) is a machine credential and stays excluded. |

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
when the approving actor is a human**. System and machine (public-API) approvals leave it `null`,
which is what enforces D2a.

**"Human" must be an explicit property of the actor, not inferred from `userId` or sniffed from the
label string.** Per D2c the humans are: a signed-in user, the email one-click approver, and the
Telegram approver. The non-humans are the system actor and the public-API actor. Label-string
matching is forbidden — it is fragile and would silently break when copy changes.

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

### 3.2.1 Deliberate exclusions from the collapse

Three cases look like they should collapse and must not:

- **Reproposals of a stale action.** An action goes `stale` because the subject, destination,
  timing, context, or effective policy changed. The approval fingerprint covers only content and
  media, so it is **structurally blind to whatever caused the staleness**. Before Sprint 52,
  `repropose` landed in `authorization_required` and the founder re-confirmed the change; collapsing
  it would make a button labelled "put it back in the queue" publish instead. Reproposals are
  excluded from the collapse.
- **Copilot `proposeForReview` (`forceReview`).** Sprint 42's guarantee is that a copilot-originated
  publish is always reviewed. The collapse honors it.
- **System and public-API approvals.** Per D2a/D2c — enforced by the absence of a fingerprint, not
  by a check that could be forgotten.

### 3.2.2 Accepted behavior change

A collapsed cadence action calls `dispatch()` at fill time, so `adapter.guard` (connection health,
already-published, daily caps) now runs **at fill time rather than hours later at the scheduled
slot**. A fill can therefore produce `blocked` where it previously produced `authorization_required`.
This is earlier and more honest failure reporting, and is accepted rather than worked around.

### 3.3 Two defects fixed in the same sprint

- **A dead-end 409 (not a 500 — this spec's original claim was wrong).** If a draft leaves `approved`
  after its publish action is proposed, `authorize()` → `currentFingerprint()` → `publishIntent()`
  throws `ExternalActionPreparationError`. Verified during implementation: that error carries its own
  `statusCode`, so Fastify already returned **409** — but as a bare
  `{"statusCode":409,"code":"draft_not_approved","error":"Conflict"}` with **no `action` body**, so
  the web client's `body?.error === "stale_action"` branch never fired. Worse, `authorize()` threw
  *before* any state change, leaving the action in `authorization_required` to fail identically on
  every click, with `repropose` unreachable (it requires `stale` or `blocked`). A permanent dead end,
  not a transient 500.

  **Reachability note:** `approved` is terminal in the approval state machine, so the literal
  "draft un-approved" scenario only occurs out-of-band. The fix earns its keep through the other
  preparation-error causes that *are* reachable in normal use — connection deleted, persona
  un-routed, draft deleted. The collapse increases traffic through this path.
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

- [x] Test: same content + same media → identical hash; different content → different hash;
      different `mediaJson` with identical content → **different** hash; `null` vs absent media → stable.
- [x] Run; confirm it fails (module missing).
- [x] Implement `draftApprovalFingerprint(draft: { id: string; content: string; mediaJson: string | null })`
      delegating to `canonicalActionFingerprint`.
- [x] Run; green. Commit.

### Task 2 — Persist the fingerprint at approval (human only)

**Files:** `apps/api/src/db/schema.ts` (add `contentFingerprint: text("content_fingerprint")` to
`approvalDecisions`); generated migration under `apps/api/drizzle/` via
`npm run db:generate -w apps/api`; `packages/contracts/src/index.ts`
(`approvalDecisionSchema` += `contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable()`);
`apps/api/src/services/drafts.ts` (`logDecision`, `applyDraftActionInTransaction`);
tests in `apps/api/test/drafts.test.ts`.

- [x] Test: a **human** approve writes a non-null `contentFingerprint` matching
      `draftApprovalFingerprint(draft)`; a **system** approve (actor `{userId: null}`, as used by
      `submitAutomaticDraft`, `drafts.ts:212-217`) writes `null`; `edit`/`reject`/`submit`/`resubmit`
      write `null`.
- [x] Run; confirm failure.
- [x] Add the column, generate the migration (**do not hand-write SQL** — CLAUDE.md), extend the
      contracts schema, and set the fingerprint in `logDecision` only when
      `action === "approve" && actor.human` (amended from `actor.userId !== null` by D2c — see §3.1).
- [x] Run; green. Commit.

### Task 3 — Lookup: "was this exact content approved by a human?"

**Files:** `apps/api/src/services/drafts.ts` (export
`latestHumanApprovalFingerprint(db, workspaceId, draftId): string | null`);
tests in `apps/api/test/drafts.test.ts`.

- [x] Test: returns the fingerprint after a human approve; `null` after a system approve; `null`
      when the draft is not currently `approved`; after approve → edit → re-approve, returns the
      **latest** fingerprint (ordered by `createdAt`, not insertion order).
- [x] Run; confirm failure.
- [x] Implement: newest `approve` row for the draft, scoped to `workspaceId`, returning its
      `contentFingerprint`. (Task 4 widened this to `humanApprovalCoveringDraft`, which also returns
      the approver's identity so the collapsed authorization can be attributed to them — §7.)
- [x] Run; green. Commit.

### Task 4 — The collapse at propose time (the core change)

**Files:** `apps/api/src/services/external-action-coordinator.ts` (the policy fork at `:288-295`);
tests in `apps/api/test/external-action-publication.test.ts`.

- [x] Test (the headline acceptance): workspace policy `human_required`; a human approves a draft;
      proposing the publish action returns status **`authorized`** (not `authorization_required`),
      an `externalActionDecisions` row exists with `decision: "authorize"`, the reason naming the
      collapse, and the actor being the **approving human** — and it dispatches.
- [x] Test (gate re-arms): approve → edit the draft → propose → **`authorization_required`**.
- [x] Test (media re-arms): approve → change `mediaJson` only → propose → **`authorization_required`**.
- [x] Test (D2a safety): a **system**-approved draft under `human_required` → **`authorization_required`**.
- [x] Test (D2c): a draft approved through the email one-click link collapses.
- [x] Test (cadence): human-approved draft proposed by the system actor via the cadence path →
      collapses and publishes with no second click (`cadences.test.ts`).
- [x] Test (regression, the five other kinds): under `human_required`, `send`, `reply`,
      `paid_launch`, `budget_change`, `targeting_change` still land in `authorization_required`.
      Extend the existing `external-action-{email,messaging,paid-launch,budget-change,targeting-change}.test.ts`.
- [x] Run; confirm failures.
- [x] Implement the branch. Keep the `autonomous` path untouched.
- [x] Run; green. Commit.

### Task 5 — Fix the dead-end 409 on a stale publish

> The task title originally said "500 → 409". That premise was wrong and §3.3 records the
> correction: the response was already a 409, but a **bare** one with no `action` body, and the
> action was left in `authorization_required` with `repropose` unreachable — a permanent dead end.

**Files:** `apps/api/src/services/external-action-coordinator.ts` (`authorize`, `currentFingerprint`,
`dispatch`, `repropose`, `run`); `apps/api/src/routes/external-actions.ts` (`externalActionError`);
tests in `apps/api/test/external-actions.test.ts`.

- [x] Test: propose a publish action, move the draft out of `approved`, call `authorize` → **409
      `stale_action`** carrying the action body, and the action is left `stale`.
- [x] Run; confirm it fails (bare Conflict, action still `authorization_required`).
- [x] Catch `ExternalActionPreparationError` during revalidation, mark the action `stale`, and raise
      `StaleExternalActionError` so the existing 409 mapping applies.
- [x] Run; green. Commit.

### Task 6 — Allow withdrawing a collapsed authorization

**Files:** `apps/api/src/routes/external-actions.ts` + coordinator (`cancel` for `authorized`,
pre-dispatch); `apps/web/app/workspaces/[id]/review/_components/authorizations-queue.tsx`;
tests in `apps/api/test/external-actions.test.ts` and the web shell tests.

- [x] Test: an `authorized` (collapsed, not yet dispatched) publish action can be cancelled, and a
      `succeeded` one cannot.
- [x] Run; confirm failure.
- [x] Implement using the existing legal `authorized → cancelled` transition; surface it in the UI.
- [x] Run; green. Commit.
- [x] **Final review, finding 1:** make the withdrawal *stick* on the cadence path — a cancelled
      publish action keeps its draft slotted, so the next fill cannot re-collapse and publish it
      (`services/cadences.ts`). See §7.

### Task 7 — Make the collapse visible (UI + copy)

**Files:** `apps/web/app/workspaces/[id]/automation/action-policy.tsx`;
`apps/web/app/workspaces/[id]/review/_components/approvals-queue.tsx`;
`apps/web/app/workspaces/[id]/review/page.tsx`; existing web shell tests.

- [x] Policy editor: for the `publish` row under `human_required`, state inline that approving a
      draft authorizes its publication, and that editing after approval re-arms the second gate.
      **A visible choice, not hidden behavior** (PRD requirement).
- [x] Approvals queue: the approve button communicates that, for publish, approving also authorizes.
- [x] Where an action *did* re-arm Gate 2, show the reason ("draft changed after approval").
- [x] Keep using the contracts helpers (`canTransition`) — no hand-rolled state logic.
- [x] Analytics: a collapsed authorization emits `review.action_authorized_collapsed`.
- [x] `npx vitest run --project @tuezday/web`; green. Commit.

### Task 8 — Verify, document, push

- [x] Full `npm test` + `npm run typecheck` green.
- [x] Update `docs/deferred-improvements.md` if anything was deliberately deferred (entries 31–36).
- [x] Progress log below updated with what actually happened.
- [x] Deploy-day notes recorded (§8).
- [ ] Push `sprint-52-collapse-double-gate`. **Do not merge to `main`** — founder merges.

---

## 5. Acceptance criteria (from the PRD)

- [x] Approving a LinkedIn draft publishes it on cadence with **no second click**.
- [x] Editing after approval **re-arms** the second gate, and the UI surfaces why.
- [x] Spend (`paid_launch`, `budget_change`, `targeting_change`) and messaging (`send`, `reply`)
      still require two decisions — proven by regression tests.
- [x] Both decisions remain recorded and attributed; "who authorized this publication" has a real
      human answer.
- [x] A system-approved draft does **not** collapse the gate (D2a).
- [x] The policy editor shows the collapsed default explicitly.
- [x] `npm test` and `npm run typecheck` pass.

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

- **2026-08-02 (post-review regression fix — the kill switch was left irreversible)** — Making a
  withdrawal stick (previous entry) counted *every* `cancelled` action toward `slottedDraftIds`, and
  the social-automation kill switch cancels through the same helper
  (`cancelScheduledPublicationsForCadence` → `cancelPendingActionsForCadence`). Flipping it on and
  off therefore orphaned every draft it had stopped: verified as auto campaign → `filled = 1` →
  kill switch on → cancel → kill switch off → re-fill `filled = 0`. The cadence was not starved
  (newly approved drafts still filled), but a reversible emergency stop had become partly permanent,
  and no test covered resume. **Fix: distinguish a human refusal from a system one at the point of
  cancellation.** `external_action_decisions` gains `actor_human` (`drizzle/0061`, existing rows
  default `true` — every decision predating the column came from the human-only routes, and "a human
  said no" is the safe reading of an ambiguous refusal); runtime entry points take
  `ExternalActionRuntimeActor` (`ExternalActionActor & { human }`), mirroring `DraftActor.human`.
  `slottedDraftIds` now counts a `cancelled` action only when `humanRefusedActionIds` finds a
  human `deny` decision on it. **Rejected discriminators:** the reason text (a founder types anything
  into `withdrawalReason`'s suffix) and `actorUserId !== null` (the email/Telegram approve links are
  humans with no user id — `routes/notifications.ts` — so identity presence is not humanity, which is
  exactly why `human` is an explicit property). Kill-switch and cadence-deletion cancellations now
  also write a decision row attributed to `system`, closing a gap where an action could end
  `cancelled` with no record of who refused it. Two tests guard the pair: kill-switch resume
  (`automation.test.ts`) and the unchanged withdrawal guard (`cadences.test.ts`), each verified to
  fail under the other's rule.
- **2026-08-02 (final whole-branch review — fixes)** — Two findings, both fixed.
  **(1, Important) A withdrawal did not stick on the cadence path.** `pendingCadenceActions`
  (`services/cadences.ts`) filtered out `cancelled` actions, so a withdrawn collapsed publish
  disappeared from `slottedDraftIds`. The draft was still `approved` and still human-fingerprinted,
  so the next fill re-slotted it, **re-collapsed it to `authorized`, and published it** — no second
  click, no new human decision. The idempotency key `cadence:<id>:<slot>:<draft>` only deduped the
  same slot; a different slot is a different key. This was a genuine regression: pre-Sprint-52 the
  re-slotted action landed in `authorization_required` and sat there unsent, and the UI promises
  "Withdrawn. Nothing was sent." **Founder decision: make the withdrawal stick.** `cancelled`
  actions now count toward `slottedDraftIds`, so the withdrawn draft does not return to that cadence
  unless it is re-queued (intended consequence). **Slot vs draft:** the *slot* is still freed
  (`takenSlots` unchanged) — the founder refused that post, not that airtime, so a different
  approved draft may take it, and the withdrawn draft cannot come back for it because it stays in
  `slottedDraftIds`. That keeps the cadence from freezing while still honoring the "no". `stale`
  stays excluded from both sets: a stale action is superseded by a `repropose`, not refused.
  **(2, Minor) `actorOf` failed open.** `human: !request.actor.system` inferred humanity from "not
  the worker"; it is now established affirmatively by a signed-in user identity, matching the
  fail-closed conversions in `copilot-actions.ts` and `external-action-adapters.ts`. Zero behavior
  change today (the guard sets exactly two actors), but a future service token or delegated
  integration identity arrives as non-human rather than silently collapsing the gate. The
  delegated-**human** paths (email/Telegram approve links) are unaffected — they bypass the guard
  and declare `human: true` at their own call sites.
- **2026-08-02 (Task 8)** — `npm test` 2101 passing across 194 files, `npm run typecheck` clean.
  Deferred items recorded in `docs/deferred-improvements.md` as entries **31–36**: the text-only
  withdrawal marker, the two body shapes for `ExternalActionPreparationError`, `run()` stranding not
  covering `dispatching` (no legal edge exists, so this is correct rather than missing), the
  in-memory `action` not refreshed after the collapsed-authorize transaction, `logDecision`'s two
  adjacent trailing optional positionals, and the collapse applying to a fresh `propose` with a
  different destination (by design — §3.2.1). Deploy-day notes in §8.
- **2026-08-02 (Tasks 5-6)** — **The spec's premise for Task 5 was wrong, and the truth was worse.**
  It was never a 500: `ExternalActionPreparationError` carries its own `statusCode`, so Fastify
  already returned **409** — but a bare `{"statusCode":409,"code":"draft_not_approved",
  "error":"Conflict"}` with **no `action` body**, so the web client's `body?.error === "stale_action"`
  branch never fired. And because `authorize()` threw *before* any state change, the action stayed
  in `authorization_required` and failed identically on every click, with `repropose` unreachable
  (it requires `stale` or `blocked`) — a permanent dead end, not a transient error. §3.3 records the
  correction. Implementation found a **fourth** revalidation site not in the plan (`repropose`), and
  the `run()` stranding path was real. Review confirmed there is no fifth site, that every
  preparation-error site is a pure DB check (so no transient failure gets mis-marked `stale`), that
  `succeeded` is genuinely non-cancellable, and that the dispatch/cancel race is safe in both
  directions. Fix round tightened audit-record accuracy: withdrawal-vs-denial wording, the
  blocked-action stale message, and a false default reason. A re-review traced all eight call sites
  of the now-shared `externalActionError` mapping and confirmed it cannot change any other route's
  response, and that `deny()`'s record is unchanged. Commits `2099820..887325a`, 2094 tests green.
- **2026-08-02 (Tasks 1-3)** — Foundation: `draftApprovalFingerprint` (content + `mediaJson`, via
  `canonicalActionFingerprint`), the `approval_decisions.content_fingerprint` column
  (migration `0060_hot_nekra.sql`) written only on a **human** approve, and the lookup that answers
  "was this exact content approved by a human?". Review found the sprint's one real design bug:
  gating the fingerprint on `actor.userId !== null` silently excluded the email one-click and
  Telegram approve paths, so the feature would not have worked from a phone — the single most likely
  place a founder approves a post. That produced founder decision **D2c** (trust the signed token)
  and the rule that **"human" is an explicit actor property**, never sniffed from the label string;
  §1 and §3.1 were amended and the gate became `actor.human`. Commits `2067325..7c4ca07`, 2069 tests
  green. Two carries into Task 4, both honored: `automation.test.ts`'s auto-approved-draft fixture
  was flipped to a `system` actor (it was `human: true` on an automation narrative, exercising the
  collapse where production would not), and because `ExternalActionActor` cannot express humanity,
  the collapsed authorization is attributed to the **approver read from the approval decision row**,
  not to the proposer.
- **2026-08-02 (Task 7)** — The collapse became legible. The policy editor states, inline on the
  `publish` row under `human_required`, that approving a draft also authorizes its publication and
  that an edit re-arms the gate — no third policy value, per D2b. The approvals queue carries a
  standing note rather than a per-card promise: a `Draft` carries neither the action kind nor the
  resolved policy, so promising "this will publish" on a specific card would be a guess (an email
  draft becomes a `send`, which never collapses). New helper `secondGateExplanation` in
  `apps/web/lib/external-actions.ts` explains a re-armed Gate 2 from the action alone. **What the
  API can prove:** `supersedesActionId` identifies a re-proposal, and `kind` identifies the five
  kinds that always keep the gate. **What it cannot:** for a first-time `publish` sitting in
  `authorization_required`, nothing on the action distinguishes "content changed after approval"
  from "system-approved" from "copilot `forceReview`" — the approval fingerprint, the approving
  actor, and the `forceReview` flag are all on records the authorizations surface does not read
  (and must not: its shell contract forbids `/drafts/`). The copy therefore names the three
  possible causes and asserts none of them. Analytics (7e): the collapsed path now emits a
  **distinct** `review.action_authorized_collapsed`, attributed to the approving human, rather than
  reusing `review.action_authorized` — that event keeps meaning "someone pressed Authorize", and
  total authorizations is the sum of the two. Known gap: the D2c approvers (`routes/notifications.ts`
  registers them `{ userId: null, human: true }`) collapse correctly and record their decision row,
  but carry no analytics `distinctId`, so phone/Telegram approvals are absent from the funnel —
  `authorize()` has the same constraint today. Also fixed the missing preposition in the withdrawal
  copy ("Already authorized on <date>").
- **2026-08-02 (Task 4)** — The collapse landed in `proposeWithLineage`. Task 3's
  `latestHumanApprovalFingerprint` became `humanApprovalCoveringDraft(db, workspaceId, draftId)`,
  which returns `{ fingerprint, actor, actorId }` — the approver's identity travels with the
  fingerprint so the collapsed authorize decision is attributed to the human who approved, and the
  fingerprint comparison stays next to the raw `media_json` read. Copilot proposals (`forceReview`)
  never collapse. Cadence suites were re-pointed: human-approved seeds now assert the collapsed
  path, and two tests seed a `system` approval to keep covering the still-armed second gate (D2a).
  `automation.test.ts`'s auto-campaign seed now approves as `system`, matching its narrative.
- **2026-08-02** — Recon complete against `origin/main` @ `7cf4e41` (Sprint 50 merged; baseline
  verified against `origin/main`, not local `main` — the Sprint 51 lesson). Decisions D2/D2a/D2b
  recorded. Plan written and awaiting founder approval. No code written yet.

---

## 8. Deploy-day notes

Nothing here is a code change; these are the things to know when this branch goes out.

- **`NOTIFY_SIGNING_SECRET` matters more now.** `apps/api/src/notifications/tokens.ts:12-13` falls
  back to `"dev-signing-secret-change-me"` when the env var is unset. Before this sprint, forging an
  approve token bought an **approval**; after D2c it buys a **publication**, because the email /
  Telegram approver is a human for collapse purposes. The variable is already in `.env.example` —
  this is an emphasis, not a new requirement: **confirm it is set to a real secret in the deployed
  environment before this branch ships.**
- **In-flight publish actions get a slightly wrong explanation, briefly.** Publish actions already
  sitting in `authorization_required` when this deploys predate the collapse, so
  `secondGateExplanation` (`apps/web/lib/external-actions.ts:143-152`) tells the founder the gate
  "re-armed" for one of three reasons when in fact it was simply never collapsed. **Deliberately not
  fixed:** it is self-clearing — the copy becomes accurate as soon as that queue drains, and adding
  a deploy-timestamp carve-out would outlive the problem it solves.
- **A withdrawn cadence post does not come back — but only a *human* withdrawal is final.**
  Cancelling a collapsed publish keeps that draft slotted against that cadence (final review,
  finding 1), so re-queuing it is an explicit act. Support answer: "withdraw" means "not on this
  cadence", not "not this time".

  A cancellation the **system** made says nothing about the draft and is fully reversible. The
  social-automation **kill switch** cancels a cadence's pending posts through the same path, and
  turning it back off returns every draft it stopped to the queue — the emergency stop stays an
  emergency stop, not a one-way door. Same for a cadence deletion, where the point is moot.

  What separates the two is `external_action_decisions.actor_human`, recorded on the decision at the
  moment of cancellation — not the free-text reason (a founder types anything there) and not the
  `cancelled` status (both paths produce it). Kill-switch and deletion cancellations now write a
  decision row attributed to `system`, which they previously did not write at all: before this, an
  action could end `cancelled` with no record of who refused it. Existing decision rows migrate to
  `actor_human = true` (`drizzle/0061`), which is correct — every decision written before the column
  existed came from the human-only authorize/deny/cancel routes.
