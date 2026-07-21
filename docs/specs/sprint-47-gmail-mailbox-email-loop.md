# Sprint 47 — Gmail mailbox + owned email loop (Outreach module, part 1 of 4)

> Status: spec — awaiting founder answers to Open Questions, then build.
> Size: L. One vertical slice. Written spec-first; tests before/with implementation; founder accepts + merges.

## Branch & merge order

- **Branch:** `sprint-47-gmail-mailbox-email-loop`, cut from `main` (everything through sprint-46a is merged; migrations at 0047).
- **Merge order:** independent — first sprint of the outreach series. Sprints 48 (sequence object + enrollment engine), 49 (reply-driven flow + compliance), 50 (tracking + funnel) chain off this branch in order.

## Why this sprint exists (context for a fresh session)

The platform vision promises outbound with "replies, meetings, CRM outcomes" feeding the learning loop, but today **no inbound email is ever seen**: outbound email dispatches via Resend (domain send) or CSV recovery, replies land in the founder's real mailbox, and the learning loop is blind on email. Founder decisions (locked 2026-07-20, ideation session):

1. Outreach = fill gaps in the existing S11→S30 stack, not a rebuild.
2. Email replies via an **owned mailbox** (Gmail OAuth first) — reverses S30's "we never see email replies".
3. Bring-your-own lists; no enrichment yet.
4. Sequence becomes a **first-class object** (Sprint 48); S26/S30 launch sequences stay frozen and green.
5. Mailboxes are a **pool from day one**, one mailbox used initially.
6. Live segments auto-enroll (48). 7. One active sequence per person workspace-wide (48). 8. Replies + open/click tracking (50).
9. Outreach sequences **send from the connected Gmail mailbox** (real mailbox reputation; cold email through Resend would breach its ToS). Resend stays for transactional + broadcast.
10. Cadence: standard workflow — this sprint is built, pushed, and **stops for founder acceptance** before Sprint 48.

Sprint 47 delivers the foundation: connect a Gmail mailbox, send a governed email from it, poll its inbound replies into the existing inbox, classify them. No sequences yet.

## What this slice does (founder-visible)

Connect your Gmail via OAuth → it appears as a **mailbox** with a daily cap → send an approved outbound draft *from that mailbox* (full safety checks + unsubscribe footer) → when the recipient replies, the reply shows up **in the Tuezday inbox, threaded to the email you sent, with an AI label** (positive / not interested / out-of-office / unsubscribe request / bounce / other).

## Out of scope (later sprints or never)

- Sequence v2 / live segments / enrollment engine / global contact lock → **Sprint 48**.
- Acting on labels (stop chain, CRM task, auto-suppress on unsubscribe-reply, OOO retry), auto stop-on-reply for email sequences → **Sprint 49**. This sprint stores labels only.
- Open/click tracking, funnel, attribution → **Sprint 50**.
- Outlook/IMAP providers; mailbox warmup (never ours); deliverability infra (never ours); enrichment.
- Touching `workspaceEmailSenders` (Resend domain identity) — coexists untouched.
- Launch/sequence email switching to Gmail — S26/S30 flows keep their current Resend/CSV path this sprint.

## Architecture decisions (grounded in recon of main)

1. **Gmail is a connector via Nango, not a login extension.** Sprint-36 Google auth is login-only (`access_type=online`, no refresh token, nothing persisted — `apps/api/src/auth/google.ts`). Instead, add a `gmail` provider to `CONNECTOR_PROVIDERS` (`packages/contracts`), `authMode: "oauth"`, Nango provider `google-mail`, scopes `gmail.send gmail.readonly`, `testPath /gmail/v1/users/me/profile`. The existing OAuth popup flow (`POST .../connectors/:key/oauth/session` → `.../oauth/complete`, `apps/api/src/routes/connectors.ts:73-168`) is reused unchanged; Nango stores + auto-refreshes tokens; Tuezday's DB holds only `nangoConnectionId`. Env: `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` added to `OAUTH_ENV` (`services/connections.ts:118-125`) and `.env.example`.
2. **Gmail API calls ride `fabric.proxyJson`/`proxyGet`** with `baseUrlOverride: "https://gmail.googleapis.com"` — the same seam every social adapter uses. Tests inject a `fakeFabric` whose `proxyJson` pattern-matches Gmail paths (pattern: `apps/api/test/inbox.test.ts:61-117`). No googleapis SDK dependency.
3. **Send reuses the external-action `send` kind.** `emailActionPayloadSchema` (`services/external-action-email.ts:29`) gains an optional `mailboxId`; the send adapter branches: `mailboxId` present → Gmail path, absent → existing Resend path (`external-action-adapters.ts:1036-1044` selector pattern). The whole coordinator — policy, fingerprint, idempotency, stale/retry, decision log — is inherited.
4. **Delivery bookkeeping reuses `emailDeliveries`** (its `provider` column already exists, default `"resend"`): write the `queued` row before the provider call, set `provider: "gmail"`, store the Gmail message id in `providerMessageId` and the thread id in a new `providerThreadId` column; keep the short-circuit-on-`providerMessageId` recovery (`external-action-email.ts:253-317`).
5. **Safety is provider-agnostic and reused unchanged**: `checkEmailRecipientSafety` (kill switch → invalid → workspace daily cap → suppression → permission) runs in the Gmail adapter's `guard`, **plus** a per-mailbox daily-cap check (count today's `accepted` gmail deliveries for that mailbox).
6. **Inbound = poll, thread by Gmail `threadId`.** We only ingest messages whose `threadId` matches a thread this workspace's mailbox sent (privacy: Tuezday never reads unrelated mail — see Open Question 1). Poller lists recent inbox messages via one `users/me/messages.list` query per mailbox, filters to known thread ids, fetches matches, inserts `inbox_items` with `kind: "email"` deduped on the existing `(connectionId, externalId)` unique index (externalId = Gmail message id).
7. **Classification is best-effort LLM, labels only** — copy the discovery scoring shape (`services/discovery.ts:556-630`): prompt → `llm.generate` → parse JSON → on failure leave unlabeled, never abort the poll.
8. **Every new dependency is injectable with a real default**: `GmailMailboxProvider` seam on `BuildAppOptions` mirrors `outboundEmail` (`app.ts:82-140`); the real impl wraps the fabric; tests pass fakes.

## Data model (migration 0048)

### `mailboxes` (new)
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspace_id` | text NN → workspaces(id) cascade | |
| `connection_id` | text NN → connections(id) cascade | the Gmail connector row |
| `provider` | text NN default `'gmail'` | future: outlook, imap |
| `address` | text NN | the mailbox email; unique `(workspace_id, address)` |
| `display_name` | text NN default `''` | "from" name |
| `reply_to` | text | null = the address itself |
| `signature` | text NN default `''` | appended to sends |
| `daily_cap` | integer NN default 50 | per-mailbox; see Open Question 2 |
| `sending_window_json` | text NN default `'{}'` | `{days,startHour,endHour,timezone}`; **stored now, enforced by the Sprint 48 scheduler** |
| `default_persona_id` | text → personas(id) set null | sequence default (used in 48) |
| `status` | text NN default `'connected'` | `connected` / `error` / `disconnected` |
| `last_polled_at` | integer | inbound poll cursor anchor |
| `last_error` | text | |
| `created_at` / `updated_at` | integer NN | |

### `email_deliveries` (alter)
- `provider_thread_id` text — Gmail thread id; the inbound-matching key. (Hand-fix `ON DELETE` if drizzle-kit drops it on ALTER — the S30 gotcha.)
- `mailbox_id` text → mailboxes(id) set null — which mailbox sent it (null = Resend path).

### `inbox_items` (alter)
- `email_delivery_id` text → email_deliveries(id) set null — threads an email reply to the exact sent email (the email analog of `publicationId`/`launchMessageId`).
- `reply_label` text — `EMAIL_REPLY_LABELS` value; null = unclassified.
- `reply_labeled_at` integer.

## Contracts (`packages/contracts/src/index.ts`)

- `CONNECTOR_PROVIDERS` += `gmail` entry (categories `["email"]`, oauth scopes above).
- `INBOX_ITEM_KINDS` widens to `["comment","dm","email"]` (check every consumer/switch on kind).
- `EMAIL_REPLY_LABELS = ["positive","not_interested","out_of_office","unsubscribe_request","bounce","other"]` + type.
- `mailboxSchema`, `createMailboxInputSchema` (connectionId), `updateMailboxInputSchema` (displayName?, replyTo?, signature?, dailyCap 1–500?, sendingWindow?, defaultPersonaId?), `sendDraftFromMailboxInputSchema = { mailboxId }`.
- `emailActionPayloadSchema` += optional `mailboxId` (discriminates Gmail vs Resend dispatch).
- Inbox item schema += `emailDeliveryId?`, `replyLabel?`; update pinned fixtures.

## Services & seams

### `outbound-email/gmail.ts` (new) — `GmailMailboxProvider`
Interface: `sendEmail(connectionId, {from, to, subject, text, replyTo, threadId?}) → {messageId, threadId}`; `listInboundSince(connectionId, sinceMs, maxResults) → GmailMessageMeta[]`; `getMessage(connectionId, messageId) → {id, threadId, from, to, subject, bodyText, internalDateMs, headers}`; `getProfile(connectionId) → {emailAddress}`. Real impl builds RFC-2822 + base64url and calls Gmail REST via the fabric; `buildApp` option `gmail?: GmailMailboxProvider` with fabric-backed default; tests inject a `FakeGmailProvider` (in-memory threads, scripted replies).

### `services/mailboxes.ts` (new)
`createMailbox` (verify connection is `gmail` + owned by workspace; `getProfile` fills address; upsert-safe), `listMailboxes`, `updateMailbox`, `deleteMailbox` (soft: status `disconnected`), `mailboxDailySendCount` (accepted gmail deliveries for mailbox since UTC midnight).

### `services/external-action-email.ts` (extend)
`emailIntent` accepts `mailboxId`; Gmail branch in the adapter: guard = existing `checkEmailRecipientSafety` + mailbox exists/connected + `mailboxDailySendCount < dailyCap`; execute = delivery row (`provider:"gmail"`, `mailboxId`) → `gmail.sendEmail` (idempotency short-circuit intact) → store `providerMessageId` + `providerThreadId`. Body = draft content + signature + unsubscribe footer (`createUnsubscribeToken` — the existing HMAC flow; see Open Question 4).

### `services/mailbox-inbox.ts` (new)
`runMailboxInbox(db, llm, gmail, workspaceId, nowMs)`: per connected mailbox → `listInboundSince(lastPolledAt − 24h overlap)` → filter to `threadId ∈` workspace's gmail `email_deliveries.provider_thread_id` → skip our own address as sender → insert `inbox_items` `{kind:"email", connectionId, externalId: messageId, emailDeliveryId, authorHandle: fromAddress, content: bodyText, externalCreatedAt: internalDateMs}` (dedup via existing unique index) → classify new items (one LLM call per batch, discovery-scoring shape; label + labeledAt; failure ⇒ unlabeled) → advance `lastPolledAt`. Extend `draftBehindItem`/`replyContext` (`services/inbox.ts:219-249`) with the `emailDeliveryId` branch so "Draft reply" works on email items through the same gate.

## Routes

- `POST /workspaces/:id/mailboxes` · `GET /workspaces/:id/mailboxes` · `PATCH /workspaces/:id/mailboxes/:mailboxId` · `DELETE ...`
- `POST /workspaces/:id/outbound/drafts/:draftId/send` `{mailboxId}` — approved, email-channel, lead-linked drafts; proposes the governed send as the acting user (see Open Question 3).
- `POST /workspaces/:id/mailbox-inbox/run` — worker/manual tick entry.
- Worker (`apps/worker/src/index.ts`): `mailboxInboxTick`, `MAILBOX_INBOX_INTERVAL_MIN=5`, ordered **with inboxTick, before sequenceTick** (so a reply detected this cycle can stop a chain in 48/49).

## Web (`apps/web`)

1. **Connections surface**: `gmail` appears as a connectable provider (existing OAuth popup component); after connect, a "mailboxes" panel lists the mailbox with address, status, daily cap + remaining today, editable settings (display name, signature, reply-to, cap, default persona).
2. **Outbound page**: on approved lead-linked email drafts, a "Send from mailbox" control (mailbox picker when >1) + sent/failed status from the action.
3. **Inbox (review → inbox tab)**: email items render with an email icon, the original outbound subject/context, and the classification label as a colored chip; read/dismiss/draft-reply all work as they do for comments/DMs.

## Tests (before/with implementation)

- **Contracts:** gmail provider entry shape; widened kinds; label enum; mailbox schemas bounds; email payload with mailboxId; pinned-fixture updates.
- **API — mailboxes:** CRUD + membership guard; create pulls address from `getProfile`; cap bounds; delete = disconnected.
- **API — send:** approved-draft send via fake Gmail provider creates delivery (`provider:"gmail"`, `mailboxId`, thread id stored) and flips action `succeeded`; idempotency short-circuit; guard blocks: suppressed recipient, permission unknown, workspace kill switch, **per-mailbox cap reached**; unsubscribe footer present in sent body; non-approved / non-email drafts rejected.
- **API — inbound:** poll ingests only matching-thread messages (unrelated inbox mail never ingested — the privacy invariant, asserted explicitly); dedup on re-poll; own-address messages skipped; `emailDeliveryId` threading correct; classification labels stored via fake LLM; LLM failure ⇒ item kept, label null; `lastPolledAt` advances; draft-reply on an email item enters `pending_review`.
- **Worker route:** `/mailbox-inbox/run` as system actor spans workspaces.
- **Regression:** full suite green — S29 inbox (comment/dm) and S30 sequences byte-identical behavior; Resend sends unaffected when `mailboxId` absent.

## Founder acceptance checklist (manual)

1. `npm run nango:up`, set `GMAIL_CLIENT_ID/SECRET` (GCP OAuth app with Gmail scopes, Testing mode is fine), connect your Gmail from Connections.
2. See the mailbox appear with a 50/day cap; set a signature.
3. Import/select a lead (your own second email), draft an outbound email (S11 flow), approve it.
4. Send it from the mailbox — it arrives from your real Gmail, unsubscribe footer included.
5. Reply to it from the recipient account.
6. Within ~5 min (or "Run now"), the reply appears in the Tuezday inbox, threaded, with a sensible label.
7. Confirm a random unrelated email in your Gmail inbox does **not** appear in Tuezday.

## Founder decisions on open questions (locked 2026-07-20)

1. **Inbound privacy scope: replies to Tuezday-sent threads only.** Unrelated inbox mail is never ingested; a test asserts the invariant.
2. **Per-mailbox daily cap: customizable (1–500), default 50.**
3. **Send surface this sprint: approved lead-linked outbound drafts only.** Launches/sequences switch to Gmail in Sprint 48.
4. **Unsubscribe footer on every Gmail send from day one** (existing HMAC token flow).

## Progress log

- 2026-07-20 — Spec written after 3-agent recon of main (Gmail/OAuth+connections, inbox+sequence engines, external actions+email safety).
- 2026-07-20 — Founder answered all four open questions (all recommended options); spec finalized; implementation started.
- 2026-07-20 — Foundation committed (contracts, mailboxes table, migration 0048).
- 2026-07-20 — Implementation complete. `GmailMailboxProvider` (fabric-backed, injectable) + FabricGmailProvider; mailbox CRUD service/routes; Gmail branch in the governed send adapter (recipient safety reused + per-mailbox cap + signature + unsubscribe footer from send #1); inbound poller with the privacy invariant (only replies to Tuezday-sent threads; own-address skipped) + best-effort LLM classification; email as a 2nd inbox source with `emailDeliveryId` threading; worker `mailboxInboxTick` ordered inbox→mailbox→sequences; web surfaces (mailbox panel, send-from-mailbox, inbox email chips). New test `apps/api/test/mailboxes.test.ts` (20 tests). **Full suite 1540 green; typecheck clean across all workspaces.**
- 2026-07-20 — Known seam for Sprint 49: the workspace kill switch + daily cap live on the `workspaceEmailSenders` (Resend) row, and `getEmailSafetySettings` defaults `killSwitch` to `true` when that row is absent. A Gmail-only workspace therefore can't send until an email-sender row exists with the kill switch off. Sprint 49 (compliance hardening) should make the workspace email enable/kill-switch independent of the Resend sender.
