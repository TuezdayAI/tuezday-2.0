# Sprint 49 — Reply-driven actions + compliance hardening (Outreach module, part 3 of 4)

> Status: spec — build in progress.
> Size: M–L. One vertical slice. Spec-first; tests before/with implementation; founder accepts + merges.

## Branch & merge order

- **Branch:** `sprint-49-reply-actions-compliance`, cut from **`sprint-48-outreach-sequences`** (depends on the outreach engine, email inbox, and reply classification).
- **Required merge order into `main`:** S47 → S48 → **then S49**.

## Why this sprint (context for a fresh session)

Sprints 47–48 built the owned email loop: send governed outreach from a Gmail mailbox pool to a live segment, poll inbound replies into the inbox, and **classify** each reply onto `inbox_items.replyLabel` (`positive` / `not_interested` / `out_of_office` / `unsubscribe_request` / `bounce` / `other`). Sprint 48 added **basic** stop-on-reply — *any* email reply halts the enrollment, which wrongly stops on an out-of-office autoreply and does nothing with the label.

Sprint 49 turns the labels into **actions** and hardens cold-email compliance.

## Founder decisions (locked 2026-07-21)

1. **Positive reply → follow-up task + notify.** CRM task if the connected CRM supports it, else a Tuezday-side follow-up; always notify.
2. **Notify via in-app inbox + email.**
3. **Out-of-office → pause + retry after a delay** (best-effort parse the return date, else a fixed default of 72h).
4. **Compliance physical mailing address is required to activate** a sequence, and is appended to every send.

## What this slice does (founder-visible)

Set a workspace postal address (required before a sequence can activate; it lands in every send's footer alongside the unsubscribe link). Then replies do the right thing automatically: an unsubscribe reply suppresses the address and stops the chain; a bounce suppresses + fails the enrollment; an out-of-office pauses and resumes later; a positive reply stops the chain, emails you, highlights in the inbox, and (if a CRM is connected) drops a follow-up task on the contact. Plus: paste a suppression list to block addresses up front.

## Out of scope (later / never)

- Open/click tracking, funnel, attribution, goal-driven pause → **Sprint 50**.
- A general Tuezday tasks system — the positive-reply "task" is the CRM task (when connected) + the in-app inbox item + email (no new tasks table).
- Changing S26/S30 launches or the S47/S48 send path shape — untouched and green.
- Inbound-address parsing beyond a best-effort OOO date; no NLP.

## Architecture decisions

1. **One label-aware branch.** The engine's `advanceEnrollment` (`services/outreach-engine.ts` ~line 471) is the single reply branch. Replace the boolean `hasInboundEmailReply` with `newestInboundEmailReply(db, ws, email, sinceMs) → { item, label } | null`, then branch by label into a `handleReplyOutcome(ctx, enrollment, item, label)` helper. Fires **once** (enrollment goes terminal, except OOO which advances a cursor). Reuses the engine's existing `isSuppressed`, `updateEnrollment`.
2. **OOO idempotency via a cursor.** New `outreach_enrollments.last_reply_handled_at`. The reply lookup uses `since = max(lastSentAt, lastReplyHandledAt)` so an OOO pause doesn't re-trigger and the chain resumes cleanly when no newer reply exists.
3. **Bad address = suppression, not a new field.** "Mark invalid" on bounce is an `emailSuppressions` insert (reason `bounce`), mirroring the Resend webhook rule (`email-deliveries.ts:85-96`). No lead/contact schema change.
4. **Compliance address in an always-present home.** New `workspace_compliance` table (not `workspaceEmailSenders`, which Gmail-only workspaces lack). Threaded into `composeGmailBody`.
5. **Best-effort side-effects.** Notify + CRM writes never abort the tick (swallow errors, like the existing notify/CRM code). Worker order (mailbox-inbox classify → outreach act) already guarantees labels are set before the engine reads them.

## Label → action

| Label | Enrollment | Side-effects |
|---|---|---|
| `out_of_office` | stays `active`, `nextDueAt = now + OOO retry`, `lastReplyHandledAt = item time` | — (parse return date from body if present, else `OUTREACH_OOO_RETRY_HOURS`=72) |
| `unsubscribe_request` | `stopped`, reason `unsubscribed` | `unsubscribeEmailRecipient` (suppress); emit `outreach.reply.unsubscribed` |
| `bounce` | `failed`, reason `bounced` | suppress reason `bounce`; emit `outreach.reply.bounced` |
| `positive` | `replied` | `notifyReplyOutcome` (email + event `outreach.reply.positive`); CRM `createTask` best-effort |
| `not_interested` / `other` / unclassified | `replied` (S48 default) | — |

## Data model (migration 0050)

- **`workspace_compliance`** (new): `workspace_id` text PK → workspaces cascade · `postal_address` text NN default `''` · `created_at`/`updated_at`.
- **`outreach_enrollments`** (alter): `last_reply_handled_at` integer — reply-check cursor (hand-fix nothing; it's an additive nullable column).

## Contracts (`packages/contracts`)

- `OUTREACH_OOO_RETRY_HOURS = 72`.
- Extend `EVENT_TYPES` with `outreach.reply.positive`, `outreach.reply.unsubscribed`, `outreach.reply.bounced`, `crm.task.created`.
- `workspaceComplianceSchema` + `updateComplianceInputSchema` ({ postalAddress ≤ 500 }).
- `importSuppressionsInputSchema` ({ emails: string[] (1..1000) }); `importSuppressionsResultSchema` ({ imported, skipped }).
- No change to `OUTREACH_ENROLLMENT_STATUSES` (OOO stays `active` with a future `nextDueAt`; stop reasons ride the free-form `stoppedReason`).

## Services

- **`services/outreach-engine.ts`** — `newestInboundEmailReply` (keeps `replyLabel`, resolves the `emailDeliveryId` for lead tracing); `handleReplyOutcome` (the table above); OOO date parse helper (`parseOooResumeAt(body, nowMs)`); the `advanceEnrollment` branch swap. Thread `mailer` + `fetcher` into `OutreachDeps` for notify (route already has them via buildApp).
- **`services/notifications.ts`** — `notifyReplyOutcome(db, mailer, fetcher, { workspaceId, recipientEmail, label, snippet, inboxItemId })`: `listChannels` fan-out to email (and telegram) channels; a "positive reply" summary + inbox deep link; best-effort. Sibling of `notifyDraftPending`.
- **`connectors/crm/index.ts` + `freshsales.ts`** — add `createTask(externalContactId, { title, description, dueAt? })` to `CrmAdapter`; Freshsales impl `POST /api/tasks` via `fabric.proxyJson`, following `createNote`.
- **`services/crm.ts`** — `logPositiveReplyTask(db, adapter, ws, connId, lead, snippet)`: resolve `getCrmContactByLead` → `adapter.createTask`; emit `crm.task.created`. Best-effort caller-side.
- **`services/email-recipient-safety.ts`** — `importSuppressions(db, ws, emails) → { imported, skipped }` (normalize, `onConflictDoNothing`, reason `import`); reuse `unsubscribeEmailRecipient` for the unsubscribe path.
- **`services/compliance.ts`** (new) — `getCompliance` / `updateCompliance` (upsert `workspace_compliance`).
- **`services/outreach-sequences.ts`** — `activateOutreachSequence` also requires a non-empty postal address (`compliance_address_missing`, 409).
- **`services/external-action-email.ts`** — `composeGmailBody` appends the workspace postal address (looked up by workspaceId) after the unsubscribe line.

## Routes

- `routes/compliance.ts` (new): `GET/PUT /workspaces/:id/compliance`.
- Extend `routes/email-recipient-safety.ts`: `POST /workspaces/:id/suppressions/import`; `GET /workspaces/:id/suppressions` (list).
- Register both in `app.ts`. No worker change (reuses the S48 `outreachTick`).

## Web (`apps/web`)

- Compliance settings section (postal address); activation surfaces `compliance_address_missing` inline on the outreach activate button.
- Suppression-list import (paste emails) in the same area; optional list view.
- Inbox: highlight/sort outreach email replies by label so positive replies stand out (label chips already exist from S47).

## Tests (`apps/api/test/outreach-replies.test.ts` + additions)

Each label drives the right action: OOO pauses (future `nextDueAt`, not stopped) and resumes when no newer reply; unsubscribe → suppression row + `stopped`; bounce → suppression + `failed`; positive → `replied` + notify called (fake mailer) + CRM `createTask` called (fake adapter) + `outreach.reply.positive` event; unclassified reply still stops. Compliance: activation blocked without an address (409), allowed once set; the Gmail send body contains the postal address + unsubscribe link. Suppression import inserts + dedupes; an imported address is blocked at send. REGRESSION: full suite (1555) stays green; S30/S47/S48 byte-identical; typecheck clean.

## Founder acceptance checklist

1. Try to activate an outreach sequence with no workspace postal address → blocked; set the address → activates.
2. Send yourself an outreach email; confirm the footer has both the unsubscribe link and the postal address.
3. Reply "unsubscribe" → you're suppressed and the chain stops; reply from another address with an out-of-office autoreply → that chain pauses (not stopped) and resumes later.
4. Reply "interested" → you get an email + the reply is highlighted in the inbox + (if a CRM is connected and the lead is linked) a task appears on the contact.
5. Paste a suppression list → those addresses never receive a send.

## Progress log

- 2026-07-21 — Spec written from the approved plan after a 3-agent recon (CRM writes, notifications + reply-action patterns, compliance/suppression). Founder decisions locked. Implementation started.
