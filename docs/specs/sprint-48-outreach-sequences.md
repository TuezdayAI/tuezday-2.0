# Sprint 48 — Outreach sequences + enrollment engine (Outreach module, part 2 of 4)

> Status: spec — build in progress.
> Size: L. One vertical slice. Spec-first; tests before/with implementation; founder accepts + merges.

## Branch & merge order

- **Branch:** `sprint-48-outreach-sequences`, cut from **`sprint-47-gmail-mailbox-email-loop`** (depends on the mailbox object, the Gmail send path, and email inbox items — none of which are on `main` yet).
- **Required merge order into `main`:** S47 → **then S48**.

## Why this sprint (context for a fresh session)

Sprint 47 delivered the mailbox: connect Gmail, send one governed email from it, read inbound replies back into the inbox with a classification label. Sprint 48 turns that single-send foundation into a **first-class, always-on outreach sequence**: point a sequence at a live segment and people auto-enroll, receive brain-resolved + approval-gated steps on a delay schedule, sent from a **mailbox pool**, with the chain **stopping when they reply**.

This is the ideation's decision 04 (Sequence = first-class object), 05 (mailbox pool, start with one), 06 (live segment auto-enroll), 07 (one active sequence per person, workspace-wide).

## Founder decisions (locked 2026-07-21)

1. **Stop-on-reply ships in this sprint** — a reply halts the chain immediately (basic). Rich reply-*actions* (CRM task, auto-suppress on unsubscribe-reply, OOO retry, bounce→invalid) stay in Sprint 49.
2. **`goal` is a label** — human-readable target on the sequence, no automated behavior. Goal-driven auto-pause waits for S50 outcome data.
3. **Leavers finish their chain** — a person who stops matching the segment mid-sequence runs to completion (they qualified at enroll). The enrollment engine only ever *adds* new matches; it never reconciles removals.
4. **Gmail-only workspaces can send** — add a workspace-level "email enabled" path independent of the Resend `workspaceEmailSenders` row, retiring the S47 kill-switch seam.

Engineering defaults chosen without founder (stated for the record): mailbox assignment = **least-loaded by today's send count**; new-sequence automation default = **manual**; a **pre-send reply re-check** guards the poll-window lag.

## What this slice does (founder-visible)

Create an outreach sequence (pick a campaign, persona, a segment/list, a mailbox pool, a goal label, an automation mode) → define ordered steps (each a delay + an optional angle) → activate it. People in the segment auto-enroll (respecting suppression, a global one-active-sequence lock, and a daily new-enrollment cap), get a personalized step-1 draft into the review queue, and — per the automation mode — the approved step sends from a pooled mailbox. Follow-ups fire on their delays, threaded into the same Gmail conversation, and the chain stops the moment the person replies.

## Out of scope (later sprints / never)

- Rich reply-driven actions + compliance hardening → **Sprint 49**.
- Open/click tracking, the outbound funnel, attribution, goal-driven auto-pause → **Sprint 50**.
- Any change to S26 launches or the S30 launch-bound sequence engine — they stay **frozen and byte-identical** (coexist decision). We build a *parallel* engine.
- New sender providers, warmup, deliverability infra (never ours), enrichment.

## Architecture decisions

1. **Parallel engine, not a fork of S30.** `launch-sequences.ts` is launch-bound and frozen. Sprint 48 builds `services/outreach-*.ts` that **borrows its proven state machine** (`advanceRecipient` / `startStep` / delay→nextDueAt / `proposeEmailSend`) but is standalone and **email-only** (the personalized channel we own end-to-end via S47).
2. **Five new tables**, mirroring the shape that already works for launches (`sequence_steps` + `sequence_recipients` + `launch_messages`), distinct so S30 is untouched: `outreach_sequences`, `outreach_sequence_mailboxes` (pool), `outreach_sequence_steps`, `outreach_enrollments`, `outreach_messages`.
3. **Global "one active sequence per person" lock = a partial unique index** on `outreach_enrollments (workspace_id, recipient_type, recipient_id) WHERE status='active'`. The DB enforces decision 07; concurrent enroll attempts simply fail the insert and are skipped. No app-level locking.
4. **Live segment = reuse `resolveAudienceMembers`** (S24). The enrollment tick diffs current members against enrolled and adds the new ones. Leavers are never removed (decision 3).
5. **Mailbox pinned per enrollment** (least-loaded at enroll) for **thread continuity** — every follow-up threads in the same Gmail conversation via the enrollment's `last_thread_id`. A capped/out-of-window mailbox **defers** the step, never switches mid-thread.
6. **Sending window enforced here** (S47 stored `sending_window_json`; S48 acts on it): a step dispatches only if `nowMs` is inside the mailbox's window (in its timezone) and under its daily cap; otherwise `nextDueAt` holds and the next tick retries.
7. **Send reuses the S47 governed action** with a new `origin: "outreach_step"` on `emailActionPayloadSchema`, plus an optional `threadId` threaded through to `GmailMailboxProvider.sendEmail` for follow-up threading. The whole coordinator (policy, idempotency, stale/retry, safety, decision log) is inherited.
8. **Stop-on-reply for email is now observable** (S47 lands `kind:"email"` inbox items): a new `hasInboundEmailReply(db, ws, recipientEmail, sinceMs)` mirrors S30's X-DM `hasInboundReply`. Checked before each step generates **and** re-checked immediately before dispatch (the poll-window guard).
9. **Gmail-only email-enabled (zero-migration):** `getEmailSafetySettings` returns `killSwitch: true` when no `workspaceEmailSenders` row exists — which blocks Gmail-only workspaces. Fix in one place: when there is no Resend sender row, default `killSwitch = listConnectedMailboxes(ws).length === 0` (no new column — the row is absent in exactly this case). Row present ⇒ its explicit kill switch, unchanged. This single change unblocks every send path (the safety fn is the shared pre-check for both the Resend `blocker` and the Gmail `gmailBlocker`). Per-recipient permission + suppression checks unchanged; the sequence must still be explicitly activated.

## Data model (migration 0049)

### `outreach_sequences` (new)
`id` PK · `workspace_id` NN→workspaces cascade · `campaign_id` NN→campaigns cascade · `name` NN · `goal` NN default `''` (label only) · `persona_id` NN→personas cascade · `audience_id` NN→audiences cascade · `automation_mode` NN default `'manual'` (AUTOMATION_MODES) · `status` NN default `'draft'` (OUTREACH_SEQUENCE_STATUSES) · `daily_enrollment_cap` int NN default 50 · `stop_on_reply` int NN default 1 · `created_at`/`updated_at`.

### `outreach_sequence_mailboxes` (new — the pool)
`sequence_id` NN→outreach_sequences cascade · `mailbox_id` NN→mailboxes cascade · unique `(sequence_id, mailbox_id)`.

### `outreach_sequence_steps` (new)
`id` PK · `workspace_id` NN · `sequence_id` NN→outreach_sequences cascade · `step_number` int NN · `instruction` NN default `''` (blank = model writes a natural follow-up) · `delay_hours` int NN default 0 (step 1 treated 0) · `created_at`/`updated_at` · unique `(sequence_id, step_number)`.

### `outreach_enrollments` (new)
`id` PK · `workspace_id` NN · `sequence_id` NN→outreach_sequences cascade · `recipient_type` NN (AUDIENCE_MEMBER_TYPES) · `recipient_id` NN (polymorphic, no FK — matches launch_messages) · `recipient_email` NN default `''` (snapshot) · `mailbox_id` NN→mailboxes set null (pinned at enroll) · `last_thread_id` (Gmail thread for follow-ups) · `current_step` int NN default 0 · `status` NN default `'active'` (OUTREACH_ENROLLMENT_STATUSES) · `next_due_at` int · `last_sent_at` int · `stopped_reason` · `enrolled_at` NN · `created_at`/`updated_at` · unique `(sequence_id, recipient_type, recipient_id)` · **partial unique** `(workspace_id, recipient_type, recipient_id) WHERE status='active'`.

### `outreach_messages` (new — per enrollment × step, mirrors launch_messages)
`id` PK · `workspace_id` NN · `enrollment_id` NN→outreach_enrollments cascade · `step_number` int NN · `draft_id`→drafts set null · `external_action_id`→externalActions set null · `provider_thread_id` (from the send, feeds the next step) · `status` NN default `'pending'` (pending/sent/failed/skipped) · `sent_at` · `last_error` · `created_at`/`updated_at` · unique `(enrollment_id, step_number)`.

### `email_deliveries` (already S47) — no change; `origin` now also carries `"outreach_step"`.
### `email_actions payload` — `origin` enum gains `"outreach_step"`; payload gains optional `threadId` (passed to Gmail send for follow-up threading).

## Contracts (`packages/contracts`)

`OUTREACH_SEQUENCE_STATUSES = ["draft","active","paused","completed"]`; `OUTREACH_ENROLLMENT_STATUSES = ["active","replied","stopped","completed","failed"]`. `outreachSequenceSchema` + `createOutreachSequenceInputSchema` (campaignId, personaId, audienceId, name, goal?, automationMode?, dailyEnrollmentCap? 1–1000, stopOnReply?) + `updateOutreachSequenceInputSchema` (focused, config never reset on rename — S28 pattern). `outreachSequenceStepInputSchema` (instruction ≤1000, delayHours 0–8760) + `setOutreachStepsInputSchema` (superRefine: steps 1..N contiguous, ≤10, step 1 delay 0). `setOutreachMailboxesInputSchema { mailboxIds: uuid[] ≥1 }`. `outreachEnrollmentSchema`. `stopOutreachInputSchema` (selectors: enrollmentIds / emails / all). `outreachRunResultSchema { enrolled, generated, dispatched, stopped, completed, ranAt }`. `outreachSequenceDetailSchema` (sequence + steps + mailboxes + enrollments). Add `"outreach_step"` to the email payload origin enum + optional `threadId`. No new TASK_TYPES — steps reuse `outbound_email` via the taskInstruction override.

## Services

- **`services/outreach-sequences.ts`** — CRUD; `setSteps` (replace-all, validated); `setMailboxes` (pool; each must be a connected workspace mailbox); `activate` (requires ≥1 step, ≥1 connected pooled mailbox, persona, audience → status `active`); `pause`; `getDetail`.
- **`services/outreach-enrollment.ts`** — `enrollDueSequences(db, ws, nowMs)`: per `active` sequence → `resolveAudienceMembers(audience)` → new = members with no enrollment here → per new member apply guardrails {suppression (reuse the safety suppression read), global active-lock (insert-or-skip on the partial unique index), per-sequence daily cap} → assign least-loaded pooled mailbox → insert enrollment (`current_step=0`, `status=active`, `next_due_at=nowMs`). Logs when the daily cap throttles (no silent truncation).
- **`services/outreach-engine.ts`** — `runOutreach(db, deps, ws, nowMs)`: enroll, then for each `active` enrollment with `next_due_at<=nowMs`: (1) **stop-on-reply** via `hasInboundEmailReply` → `replied`; (2) **window/cap gate** on the pinned mailbox → defer if closed; (3) generate the due step (`resolveContext` lead+persona+campaign+step instruction; follow-ups get prior bodies via `composeFollowupInstruction`) → `submitDraft` → gate; (4) dispatch per automation mode (borrow `proposeEmailSend`, `origin:"outreach_step"`, `threadId=last_thread_id`); on `sent` store `provider_thread_id`→`last_thread_id`, set `last_sent_at`, compute next `next_due_at` or `completed`. Per-enrollment errors caught + counted, never abort. Also `hasInboundEmailReply` (kind `email`, match recipient, `externalCreatedAt>sinceMs`), `stopOutreach`, `runOutreachForAllWorkspaces` entry.
- **`email-recipient-safety.ts`** — Gmail-only email-enabled fix (decision 4).

## Routes (`routes/outreach.ts`)
`POST/GET/PATCH /workspaces/:id/outreach-sequences(/:seqId)`; `GET /:seqId` detail; `PUT /:seqId/steps`; `PUT /:seqId/mailboxes`; `POST /:seqId/activate|pause`; `GET /:seqId/enrollments`; `POST /:seqId/stop`; `POST /workspaces/:id/outreach/run` (worker + Run now). Membership-guarded like siblings.

## Worker
`outreachTick` → `POST /outreach/run` per workspace, `OUTREACH_INTERVAL_MIN=5`, ordered **after `mailboxInboxTick`** (replies seen first) and after `sequenceTick`.

## Web (`apps/web`)
An Outreach surface: create/edit a sequence (campaign, persona, segment, mailbox pool, goal, automation mode), a step editor (delay + optional angle), activate/pause, and an enrollments table (recipient, step, status, next-due, mailbox) with manual stop. Steps appear in the existing review queue with outreach context.

## Tests (`apps/api/test/outreach.test.ts`)
Sequence CRUD + activation validation; enrollment adds new segment members; each guardrail blocks (suppressed / globally-locked via the partial index / daily cap); least-loaded mailbox assignment; step gen→gate→dispatch per automation mode; window + per-mailbox cap **defer** not drop; follow-up threads via `last_thread_id` + doesn't repeat prior bodies; stop-on-reply halts (incl. pre-send re-check); leaver finishes; manual stop; Gmail-only workspace can send (email-enabled fix); worker actor. REGRESSION: full suite green (S30 launches byte-identical), typecheck clean.

## Founder acceptance checklist
1. Create a dynamic segment; connect a Gmail mailbox (S47). Create an outreach sequence on it with 2 steps (step 2 delay short), automation `scheduled_auto`.
2. Activate → a segment member auto-enrolls → step-1 draft appears → it sends from your mailbox (Gmail-only, no Resend domain needed).
3. Add a new person to the segment → they auto-enroll next tick.
4. Let step 2 fire on its delay → arrives threaded in the same conversation.
5. Reply as a recipient → their chain stops (status `replied`), no further steps.
6. Confirm a suppressed/already-in-another-sequence person is not enrolled.

## Progress log
- 2026-07-21 — Spec written after founder locked the 4 decisions and a targeted recon (segments resolver, S30 engine borrow-points, email-enabled placement, brain step chain). Implementation started.
