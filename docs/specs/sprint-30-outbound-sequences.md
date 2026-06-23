# Sprint 30 — Multi-step outbound sequences (follow-up chains)

> Roadmap: `docs/plans/sprint-guide-21-onward.md` → Phase C, Sprint 30 (C3 follow-on).
> Size: L. One vertical slice. Written spec-first; tests before/with implementation; founder accepts + merges.

## Branch & merge order

- **Branch:** `sprint-30-outbound-sequences`, cut from **`sprint-29-engagement-reply-inbox`** (commit `e75c532`).
  Sprint 30 "Builds on" S26 (targeted launch), S27 (cadence/scheduler), S29 (reply inbox). The S29
  branch already chains `…→26→27→28→29`, so it is the only base that carries all three predecessors.
- **Required merge order into `main`:** S25 → S26, S27, S28, S29, **then S30**. (Same chain as S29 plus this.)

## Goal

Turn a launch's single first-touch (Sprint 26) into a real **multi-step outreach sequence**: an ordered
chain of follow-ups per recipient, paced by delays, that **auto-advances on the Sprint 27 scheduler**,
**stops automatically when an X-DM recipient replies** (via the Sprint 29 inbox), and **gates every step**
through the approval flow. The control level is a per-launch setting spanning the full spectrum
(manual ↔ review-each-step ↔ fully-auto). Works for **email and X DM** — the personalized channels.

## Founder decisions (locked 2026-06-23)

1. **Automation level is per-launch and flexible**, reusing `AUTOMATION_MODES`
   (`manual` / `human_in_the_loop` / `scheduled_auto`). Default `manual`. The full spectrum is always
   available; we never hardcode one mode. (Standing principle — memory `build-full-spectrum-configurable`.)
2. **Email auto-stop-on-reply: manual now, automatic later.** X DM auto-stops on reply automatically
   (S29 already polls DM replies and links each to the exact recipient). Email has **no inbound-reply
   feed** (outbound email leaves Tuezday as a CSV into Smartlead/Instantly — we never see replies), so an
   email chain is stopped by a **manual action** (stop a recipient, stop a launch, or paste a suppression
   list of emails). Automatic inbound-email detection is logged as the next upgrade in
   `docs/deferred-improvements.md` (a future inbound-mail integration). **Nothing is faked** — we do not
   invent an email reply signal we cannot observe.
3. **Per-step content = optional instruction.** Each step carries an optional founder-written angle
   (e.g. step 2 = "bump, add the case study"; step 3 = "breakup note"). Blank → the brain auto-generates a
   natural follow-up; filled → the brain steers that step to the angle. Either way the step is
   brain-resolved and **personalized per recipient**, and the follow-up is told the prior messages so it
   doesn't repeat itself.

## Scope

- A **sequence** = an ordered list of `sequence_steps` attached to a launch, **per personalized channel**
  (`email` and/or `x`). Step 1 of a channel is the first-touch; steps 2..N are follow-ups. Each step has a
  `delayHours` (delay measured **from the moment the previous step was actually sent** to that recipient)
  and an optional `instruction`. Broadcast channels (`linkedin`, `instagram`) are **never sequenced** —
  they stay single-shot exactly as in Sprint 26.
- **Per-recipient sequence state** (`sequence_recipients`): one row per (launch × channel × recipient),
  tracking `currentStep`, `status` (`active` / `replied` / `stopped` / `completed` / `failed`),
  `nextDueAt`, `lastSentAt`. This is the engine's source of truth for "who is where in the chain."
- **The engine** (`runSequences`, exposed as a worker tick + a "Run now" endpoint) advances every active
  recipient: generate the due step's per-recipient message (gated), then — per the launch's automation
  mode — auto-approve + dispatch (`scheduled_auto`), wait at the gate then auto-dispatch once approved
  (`human_in_the_loop`), or do nothing until the founder acts (`manual`). It schedules the next step only
  after the current step's message reaches `sent`.
- **Stop-on-reply.** For **X DM**: before generating a recipient's next step, the engine checks the S29
  `inbox_items` for an inbound DM from that recipient since their last send; if found → `status=replied`,
  the chain stops. For **email**: a manual stop endpoint marks recipients `stopped` (reason `manual`) or
  `replied`.
- **Reuse, don't rebuild.** Email send = the existing `OutboundExporter` CSV (export marks `sent`,
  which starts the next step's delay clock — so email is paced by the founder's real export cadence and
  the engine never gets ahead of actual sends). X DM = the existing `XAdapter.sendDm`. Generation =
  the existing resolver + gateway + approval gate. Scheduling = the Sprint 27 worker-tick pattern.
  Guardrails for auto X-DM = the Sprint 28 workspace kill switch + per-connection daily cap.

## Boundary / non-negotiables

- Never build deliverability/warmup infra. Email's terminal hop stays the CSV export; X DM stays the
  official API. No scraping, no inbound-mail integration in this sprint (logged as deferred).
- **Every step is approval-gated.** `scheduled_auto` performs a real, logged `system` approval (the
  Sprint 28/29 pattern) — it replaces the human, it does not bypass the gate.
- All prior tests (S1–S29) stay green; typecheck clean. A launch with **no sequence steps** behaves
  byte-identically to Sprint 26 (the new engine only touches launches that have steps).
- Enum vocabularies live once in `packages/contracts`. No new `TASK_TYPES` — follow-up email reuses
  `outbound_email`, follow-up DM reuses `x_dm`; the follow-up framing rides on the resolver's
  `taskInstruction` override (the Sprint 15/16 pattern).

## Data model (migration `0023_*`)

New tables + additive alters. Generate with `npm run db:generate -w apps/api`; hand-fix `ON DELETE` on
ALTER ADD COLUMN if drizzle-kit drops it (the Sprint 27 gotcha).

### `sequence_steps` (new) — the chain template
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspace_id` | text NN → workspaces(id) cascade | |
| `launch_id` | text NN → launches(id) cascade | |
| `channel` | text NN | a personalized `LaunchChannel`: `email` or `x` |
| `step_number` | integer NN | 1-based, **per channel**; unique `(launch_id, channel, step_number)` |
| `instruction` | text NN default `''` | founder angle; `''` = auto follow-up |
| `delay_hours` | integer NN default 0 | delay after previous step's send; step 1 ignored (treated 0) |
| `created_at` / `updated_at` | integer NN | |

### `sequence_recipients` (new) — per-recipient enrollment state
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspace_id` | text NN → workspaces(id) cascade | |
| `launch_id` | text NN → launches(id) cascade | |
| `channel` | text NN | `email` or `x` |
| `recipient_type` | text NN | `AUDIENCE_MEMBER_TYPES`: `lead` / `contact` |
| `recipient_id` | text NN | polymorphic; no FK (matches `launch_messages`) |
| `recipient_name` / `recipient_email` | text NN default `''` | snapshot |
| `recipient_handle` | text | X handle snapshot; null for email |
| `current_step` | integer NN default 0 | highest step started for this recipient; 0 = not started |
| `status` | text NN default `active` | `SEQUENCE_RECIPIENT_STATUSES` |
| `next_due_at` | integer | when the next step may fire; null when waiting/terminal |
| `last_sent_at` | integer | when the current step's message reached `sent` |
| `stopped_reason` | text | `replied` / `manual` / null |
| `created_at` / `updated_at` | integer NN | unique `(launch_id, channel, recipient_type, recipient_id)` |

### `launches` (alter)
- `automation_mode` text NN default `'manual'` (`AUTOMATION_MODES`).
- `stop_on_reply` integer NN default 1 (boolean).
- `x_connection_id` text → connections(id) set null — the connection auto X-DM dispatch uses; null until set.

### `launch_messages` (alter)
- `step_number` integer NN default 1 — which step produced this message (S26 first-touch rows = 1).
- `sequence_recipient_id` text → sequence_recipients(id) set null — links a step message to its enrollment.
- `connection_id` text → connections(id) set null — connection an X DM was dispatched on (guardrail counting).

A launch with zero `sequence_steps` rows ⇒ unchanged Sprint 26 behaviour (no `sequence_recipients`, no engine).

## Contracts (`packages/contracts/src/index.ts`)

- `SEQUENCE_RECIPIENT_STATUSES = ["active","replied","stopped","completed","failed"]` + type.
- `SEQUENCE_CHANNELS = ["email","x"]` (the subset of `LAUNCH_CHANNELS` that can be sequenced) + type.
- `sequenceStepSchema`, `sequenceStepInputSchema` (channel ∈ SEQUENCE_CHANNELS, stepNumber int ≥1,
  instruction ≤ 1000, delayHours int 0..8760), `setSequenceInputSchema` = `{ steps: sequenceStepInputSchema[] }`
  with a superRefine: per channel, step numbers are `1..N` contiguous & unique; ≤ 10 steps/channel; step 1
  may have delayHours 0.
- `sequenceRecipientSchema`.
- Extend `launchSchema` + `createLaunchInputSchema`: add `automationMode` (`AUTOMATION_MODES`, default
  `manual`) and `stopOnReply` (boolean, default true). Add a focused `updateLaunchSequenceConfigInputSchema`
  (`{ automationMode?, stopOnReply?, xConnectionId? }`) — config never resets on a name edit (S28 pattern).
- `stopSequenceInputSchema = { channel?: SEQUENCE_CHANNELS, recipients?: {type,id}[], emails?: string[],
  all?: boolean, reason?: enum("manual","replied") default "manual" }` (at least one selector required).
- `sequenceRunResultSchema = { enrolled, generated, autoApproved, sent, stopped, completed, ranAt }`.
- Extend `launchDetailSchema` to include `steps: sequenceStepSchema[]` and
  `sequenceRecipients: sequenceRecipientSchema[]` (and keep `messages`).
- Update the pinned contracts fixture/tests for the changed launch shapes.

## Services

### `services/launch-sequences.ts` (new — the engine)
- `setSequence(db, ws, launchId, input)` — replace the launch's step template (validates channels ⊆
  launch.channels ∩ SEQUENCE_CHANNELS).
- `getSequence(db, ws, launchId)` — steps + recipients for the detail view.
- `startSequence(db, …deps, ws, launchId, nowMs)` — resolve the audience (reuse
  `resolveAudienceMembers`), enroll each eligible recipient per sequenced channel (email: has email;
  x: has xHandle) into `sequence_recipients` (`currentStep=0`, `status=active`, `nextDueAt=nowMs`),
  idempotent on the unique key; then run one tick. Sets launch `status` → `ready`.
- `runSequences(db, …deps, ws, nowMs)` — the tick. For each active recipient:
  1. Resolve the recipient's current step message (the `launch_message` at `current_step`, if any).
  2. **Stop-on-reply (X):** if `launch.stopOnReply` and channel `x`, call `hasInboundReply(db, ws,
     recipientHandle, sinceMs=lastSentAt ?? enrolledAt)` against `inbox_items` (kind `dm`, authorHandle =
     handle); if true → `status=replied`, `stoppedReason=replied`, continue.
  3. **Advance / dispatch by mode** (see state machine below).
  Returns counts. Per-recipient errors are caught and counted (never abort the run) — mirrors `runAutomation`.
- `stopSequence(db, ws, launchId, input)` — mark matching active recipients `stopped`/`replied`
  (email manual-stop, or a manual stop on any channel). Resolves `emails[]` against enrolled recipients.
- `hasInboundReply(db, ws, handle, sinceMs)` — query `inbox_items` for an inbound DM from `handle` after
  `sinceMs`. (X handle match; the S29 poller already linked these via `launchMessageId`/`recipientHandle`.)
- Guardrail counting for auto X-DM: `countConnectionDmsForDay(db, connectionId, dayMs)` over sent
  `launch_messages` with `channel='x'` + `connection_id` set (reuse `utcDayBounds`). Auto X-DM send checks
  workspace `killSwitch` + `perConnectionDailyCap` (reuse `getSocialAutomationSettings`).

### State machine (`runSequences`, per active recipient)
Let `cur` = current step's message; `step k = current_step`; `next = k+1` (if a step `k+1` exists for the channel).
- **`cur` missing (k=0, first run):** generate step 1 (gated). `scheduled_auto` → auto-approve; set
  `current_step=1`. (Dispatch handled next bullet on this or a later tick.)
- **`cur` is `pending_review`/`draft`:** `human_in_the_loop`/`manual` → wait (founder approves;
  `manual` founder also triggers). `scheduled_auto` → shouldn't happen (auto-approves at generation);
  if it does, attempt approve.
- **`cur` is `approved` but not `sent`:**
  - `x`: `scheduled_auto`/`human_in_the_loop` → dispatch the DM now (guardrails for auto), set `sent`,
    `sentAt`, `lastSentAt`, store `connection_id`. `manual` → wait for founder dispatch.
  - `email`: dispatch = CSV export, which is the founder's manual hop in **every** mode (deliverability
    boundary). So: wait for export. When `exportLaunchEmail` marks the message `sent`, `lastSentAt` is set.
- **`cur` is `sent`:** compute `nextDueAt = lastSentAt + nextStep.delayHours*3600_000`.
  - If no `next` → `status=completed`.
  - If `now ≥ nextDueAt`: re-check stop-on-reply (X), then generate step `next` (gated, follow-up framing
    + prior bodies); `scheduled_auto` → auto-approve; set `current_step=next`.
  - Else → wait.
- **`cur` is `failed`/`skipped`:** `x` with no handle → `skipped` at enrollment (no chain). A failed
  dispatch leaves `cur` failed; the engine retries dispatch on the next tick (bounded by guardrails);
  surfaced in the detail view.

### Per-recipient generation (shared helper)
Factor the inner "resolve context → `llm.generate` → `storeGeneration` → `submitDraft` → insert
`launch_message`" out of Sprint 26's `generateLaunch` into `generateLaunchMessage(db, …deps, launch,
channel, recipient, { stepNumber, sequenceRecipientId, priorBodies, instruction })`. `generateLaunch`
(no-sequence launches) calls it with `stepNumber=1` and no follow-up framing — keeping S26 output
identical. For `stepNumber>1` or a non-empty `instruction`, the resolver gets a `taskInstruction` from a
new `composeFollowupInstruction(stepNumber, channel, instruction, priorBodies)` in `packages/brain`
(mirrors `composeAdCreativeInstruction`/`composePrPitchInstruction`): frames it as message #N of an
outbound follow-up to the same person, injects the founder angle (or a sensible default), and lists prior
message bodies with "do not repeat." Task type stays `outbound_email` / `x_dm`.

### Email export & X dispatch reuse
- `exportLaunchEmail` (S26) already exports **all approved, unsent** email `launch_messages` and marks
  them `sent`. With sequences, that naturally batches whatever steps are currently approved — no change to
  the export shape. Setting `sentAt` is the signal the engine watches to schedule the next email step.
- X DM dispatch reuses the S26 `dispatchChannel('x')` path (and the engine calls the same send for auto
  mode), now stamping `connection_id` + `step_number` on the message.

## Routes (`routes/launches.ts` extensions; `routes/sequences.ts` for the worker tick)

- `PUT  /workspaces/:id/launches/:launchId/sequence` — set the step template (`setSequenceInputSchema`).
- `GET  /workspaces/:id/launches/:launchId` — extend the existing detail to include `steps` +
  `sequenceRecipients`.
- `PATCH /workspaces/:id/launches/:launchId/sequence-config` — `automationMode` / `stopOnReply` /
  `xConnectionId`.
- `POST /workspaces/:id/launches/:launchId/sequence/start` — enroll + first tick.
- `POST /workspaces/:id/launches/:launchId/sequence/stop` — manual stop (`stopSequenceInputSchema`).
- `POST /workspaces/:id/launches/:launchId/sequence/run` — run the engine for this launch now (founder
  "Run now" + deterministic tests).
- `POST /workspaces/:id/sequences/run` — **worker entry**: run the engine for all launches in the
  workspace; returns a `sequenceRunResultSchema`. (Mirrors `/cadences/run`, `/inbox/run`.)
- Error codes: `launch_not_found` 404, `no_sequence` 409 (start/run with zero steps),
  `channel_not_in_launch` 400, `invalid_input` 400, `not_a_sequence_channel` 400.

## Worker (`apps/worker/src/index.ts`)
- Add `sequenceTick` → `POST /workspaces/:id/sequences/run` for every workspace, gated by
  `SEQUENCE_INTERVAL_MIN` (default 5). **Ordered after `inboxTick`** so a reply detected this cycle stops
  the chain *before* the next step generates: `automation → cadence fill → publish → inbox → sequences`.
  System-actor auth (`TUEZDAY_WORKER_TOKEN`), per-workspace error isolation.

## Web (`apps/web`)
On the launch detail page (under the existing Launch surface):
- **Sequence editor:** ordered steps per channel (add/remove/reorder), each with delay (hours/days) +
  optional instruction textarea; channel limited to the launch's personalized channels.
- **Automation control:** mode select (manual / review-each-step / fully-auto) + stop-on-reply toggle +
  X connection select (when X is sequenced and auto). Reuse the S28 automation copy.
- **Start / Run now** buttons; **manual stop** control (per-recipient checkboxes + a "paste emails to
  suppress" box + "stop whole launch").
- **Per-recipient progress table:** recipient, channel, current step / total, status badge
  (active/replied/stopped/completed/failed), next-due time. Email rows note "stop is manual" with a tooltip.
- An **export reminder** when approved email steps are waiting (links to the existing CSV export).

## Tests (`apps/api/test/launch-sequences.test.ts`, + contract assertions)
Deterministic time via `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime` (the S27 pattern).
Fake LLM + fake fabric (reuse the S26/S29 X-DM fake). Cover:
1. **Contracts vocab** — `SEQUENCE_RECIPIENT_STATUSES`, `SEQUENCE_CHANNELS`, launch shape gains
   `automationMode`/`stopOnReply`, `setSequenceInputSchema` superRefine (gaps/dupes/over-limit rejected).
2. **No-sequence launch unchanged** — a S26-style launch with no steps generates/exports/dispatches
   exactly as before (guards the no-regression promise).
3. **Set sequence** — PUT steps; reject a channel not in the launch; reject non-`email`/`x` channel.
4. **Email chain, scheduled_auto** — 3 email steps; start → step 1 auto-approved; export step 1
   (marks sent, sets clock); advance time < delay → no step 2; advance ≥ delay → run → step 2 generated
   + auto-approved; export; advance → step 3. (The acceptance flow, email side.)
5. **Email manual stop** — after step 1, POST stop with the recipient's email → status `stopped`;
   run after the delay → no step 2 for that recipient (others continue).
6. **X DM chain + auto stop-on-reply** — 2 X steps, scheduled_auto, stopOnReply on; start → DM 1 sent;
   inject an inbound DM into `inbox_items` (or via the fake fabric + `/inbox/run`) from that handle;
   run → recipient `replied`, **no** DM 2; a non-replying recipient still gets DM 2 on schedule.
7. **human_in_the_loop** — due step generates but parks at the gate (`pending_review`); approving it →
   next run dispatches (X) / export available (email) and schedules the following step.
8. **manual** — engine never auto-generates/sends; founder-triggered run + explicit approve/dispatch.
9. **Guardrails** — workspace kill switch blocks auto X-DM send (chain pauses, not errors);
   per-connection daily cap bounds auto DMs.
10. **completed** — last step sent + no next → `completed`.

## Deferred improvements (append to `docs/deferred-improvements.md`)
- **Automatic email stop-on-reply** — needs an inbound-mail feed (Smartlead/Instantly reply webhook or
  IMAP). Shipped: manual stop. Trigger: real email sequences running + reply volume making manual stop
  painful. (Upgrades S29 deferred #16.)
- **Email steps still require a manual CSV export per batch** — even in `scheduled_auto`, the export→upload
  hop is manual (the deliverability boundary; ties to deferred #1 one-click API push). The engine
  auto-generates + auto-approves; the founder exports.
- **Sequence engine tick is synchronous + bounded by the worker interval** (the S27/S28 pattern) — fine
  for modest audiences; revisit with a dedicated scheduler for large fan-out / sub-minute precision.
- **delayHours granularity is whole hours**, evaluated on the worker tick (≈5 min). Sub-hour cadences not
  supported. Trigger: a customer needs minute-level follow-ups.

## Founder acceptance (append to `docs/founder-acceptance-tests.md`)
1. Create a launch at a segment; define a **3-step email sequence** (delays + optional angles); set mode
   `fully-auto`. Start → step 1 drafts appear approved; export the CSV. Advance time past step-2 delay →
   step 2 generates + auto-approves; export. No reply → step 3 fires on schedule.
2. **Stop the chain:** paste a recipient's email into the suppression box (or click Stop on their row) →
   that recipient shows `stopped` and gets no further steps; others continue.
3. **X DM auto-stop:** define a 2-step X DM sequence (fully-auto); start → DM 1 sends; the recipient
   replies (visible in the Inbox) → that recipient shows `replied` and **no** DM 2 is sent; a
   non-replying recipient still receives DM 2 on schedule.
4. **Review-each-step:** set a launch to `review-each-step` → each due step parks at the approval gate;
   approving it lets the chain continue; nothing sends without approval.

## Step plan
1. Contracts: vocab + schemas + launch shape extension + fixture updates. (tests: contract assertions)
2. `packages/brain`: `composeFollowupInstruction` + resolver wiring (reuse `taskInstruction`).
3. Schema + migration `0023_*` (3 tables-worth of changes); regenerate; hand-fix ON DELETE.
4. Services: factor `generateLaunchMessage` out of `generateLaunch`; build `launch-sequences.ts` (engine,
   start, stop, hasInboundReply, guardrail counts).
5. Routes: extend launches detail + new sequence endpoints + worker `/sequences/run`.
6. Worker: `sequenceTick` after `inboxTick`.
7. Web: sequence editor + automation control + progress table + stop control.
8. Tests: `launch-sequences.test.ts` (the 10 cases) + contract test updates; full `npm test` green; typecheck.
9. Docs: deferred-improvements entries; founder-acceptance section; this spec's Progress log.
10. Commit to `sprint-30-outbound-sequences`, push `-u origin`. Do NOT merge.

## Progress log
- 2026-06-23 — Spec written. Founder decisions locked (3 forks: email manual-stop+defer inbound;
  optional per-step instruction; flexible per-launch automation mode). Branch `sprint-30-outbound-sequences`
  cut from `sprint-29-engagement-reply-inbox`. Baseline `npm test` confirmed before implementation.
- 2026-06-23 — **Built.** Contracts (`SEQUENCE_CHANNELS`, `SEQUENCE_RECIPIENT_STATUSES`, step/recipient
  schemas, `setSequenceInputSchema` superRefine, launch shape `automationMode`/`stopOnReply`/`xConnectionId`,
  `stepNumber` on `launchMessageSchema`); brain `composeFollowupInstruction` (rides the `taskInstruction`
  override); migration `0023_lucky_harry_osborn` (`sequence_steps`, `sequence_recipients`, launch +
  launch_messages alters; ON DELETE hand-fixed on the ALTERs); engine `services/launch-sequences.ts`
  (`setSequence`/`startSequence`/`runSequences`/`runLaunchSequence`/`stopSequence`/`hasInboundReply`,
  per-recipient state machine, X-DM auto-send with kill-switch + per-connection-cap guardrails);
  `services/launches.ts` extended (mapper/create/detail/config, `/generate` guarded against sequences);
  routes (`PUT /sequence`, `PATCH /sequence-config`, `POST /sequence/{start,run,stop}`, worker
  `POST /sequences/run`); worker `sequenceTick` after `inboxTick`; web sequence editor + per-recipient
  progress + manual-stop on the Launches page. **Decisions during build:** step 1 is owned by the engine
  for sequence launches (the S26 `/generate` path is refused for them); the worker auto-advances only
  HITL + scheduled_auto launches (manual launches advance on an explicit run only); dispatching an
  approved X step happens in every mode (mode governs auto-approve + guardrails, not whether an approved
  step sends); email's send hop (CSV export) is manual in every mode and is what starts the next step's
  delay clock. Tests `apps/api/test/launch-sequences.test.ts` (10): contracts vocab + superRefine,
  /generate-vs-sequence guards, channel-not-in-launch, email scheduled_auto 3-step chain → completed,
  email manual stop, X DM auto stop-on-reply, HITL gate, manual worker-skip, kill-switch hold.
  **Full `npm test` = 619 green (37 files); typecheck clean across all 6 workspaces.** Deferred
  #16 upgraded + #18–21 added; founder-acceptance Sprint 30 section appended. **Not merged — founder
  reviews/merges.**
