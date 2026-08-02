# Tuezday Email Deliverability Posture

> Date: 2026-08-02 (Sprint 51)
>
> Purpose: Tuezday sends email itself. Owning the send path means stating plainly what we do about
> safety and deliverability — and what we deliberately do not do. This document is the answer to
> "are you a cold-email tool?" (no) and to "what happens to my domain?" (it stays yours).
>
> Boundary decision and reasoning: `oss-integration-recommendations.md` §11.
> Every claim below is grounded in shipped code; the implementing files are named inline.

---

## Why this document exists

Until Sprint 51 the documented rule was "never build deliverability infra — export a CSV and let
Smartlead send it." The product had already built a native, governed email stack, and the CSV detour
forced founders to download a file and manually upload it into another tool in the middle of the
outbound loop. Sprint 51 retired the rule for email and made native sending the single send path.

The moment a product sends on a customer's behalf, vagueness becomes a liability. So: an explicit
posture, kept honest.

---

## What Tuezday does

**Verified sender domains.** A workspace sends only from a domain it owns and has verified. The
domain is registered with the transport provider (Resend), the DNS challenge records are surfaced in
the UI, and the sender is marked `verified` only when the provider reports the domain verified *and*
sending enabled (`services/email-senders.ts`, table `workspace_email_senders` — one sender row per
workspace). With no verified sender, the send action is blocked as `sender_unverified`
(`services/external-action-email.ts`). Tuezday does not send from a shared Tuezday domain.

**Explicit recipient permission.** Every recipient carries a per-workspace permission state
(`email_recipient_permissions`). The default is `unknown`, and **`unknown` is blocking** — a send
requires an explicit `allowed`. There is no "assume yes until they complain" mode
(`services/email-recipient-safety.ts` → `checkEmailRecipientSafety`).

**Durable suppression lists.** `email_suppressions` holds one active suppression per recipient per
workspace, with the reason recorded: `bounce`, `complaint`, `unsubscribe`, or `founder`. Bounces and
spam complaints suppress the address automatically when the verified provider event arrives
(`services/email-deliveries.ts`); a founder can suppress anyone by hand. Suppression is checked
before every send and is not cleared by re-import.

**Kill switch and a daily cap.** Each workspace has a master send kill switch and a daily send cap
on its sender row. The kill switch **defaults to on (sending disabled)** — new and pre-existing
workspaces start safely off. The cap counts accepted + delivered messages in the UTC day and blocks
at the limit (`checkEmailRecipientSafety`, defaults: kill switch on, cap 100).

**Sends are governed external actions.** Email is not a side effect of generation. An approved
message is proposed as a durable `send` external action, revalidated against current state, guarded,
authorized, then executed exactly once against a stable idempotency key, with the decision recorded
(`services/external-action-coordinator.ts`, `services/external-action-email.ts`). The approval gate
still governs the content; the action gate governs the send.

**Immutable per-send snapshots.** Before the provider call, `email_deliveries` records the exact
authorized payload — recipient, sender, reply-to, subject, body — plus the idempotency key. Those
columns are the audit record and the retry-recovery source; only delivery-progress columns change
afterwards. Unique indexes on (workspace, idempotency key) and (provider, message id) make a
duplicate send impossible.

**Signature-verified delivery webhooks.** Provider delivery events are accepted only through a
svix-verified signature (`outbound-email/webhook.ts`, `POST /webhooks/resend`). Verified events are
appended to `email_delivery_events` — append-only, deduplicated on the provider event id, payload
size-bounded — and drive the delivery status through a guarded state machine
(`canTransitionEmailDelivery`). An unverified or replayed event changes nothing.

**Signed unsubscribe.** Unsubscribe tokens are HMAC-SHA256 signed over the workspace + normalized
recipient and verified in constant time (`outbound-email/unsubscribe.ts`). The public
`GET|POST /u/:token` endpoints render a confirm page and, on confirmation, set the recipient to
`suppressed` and write an `unsubscribe` suppression. Tokens are unguessable and carry no session.

---

## What Tuezday explicitly does NOT do

Owning the send path is not the same as owning deliverability as a product. Tuezday does not build,
and does not intend to build:

- **Domain or mailbox warmup.** No ramp schedules, no seed-list traffic, no artificial volume.
- **IP-pool or shared-pool management.** Tuezday does not run mail infrastructure or allocate IPs;
  the transport provider does.
- **Sender-reputation arbitrage.** No routing around blocklists, no rotating identities to escape a
  damaged reputation.
- **Inbox rotation as a deliverability product.** No fleets of secondary mailboxes spreading volume
  to dodge limits. (Tuezday's daily cap is a safety brake, not a throughput trick.)
- **Bounce-rate gaming.** Bounces suppress the address. They are not filtered, hidden, or retried
  into looking better than they are.

A customer who wants those things should run a dedicated cold-email tool. That remains supported:
approved messages can be downloaded via the **optional CSV export** and loaded into Smartlead,
Instantly, or anything else. The export is a data export — it is not a send path, it is never
presented as how you send, and no dispatch path invokes it.

---

## Not built yet (distinct from out of scope)

Stated so the list above is not read as more than it is:

- **Unsubscribe links are not auto-appended to outgoing bodies.** The signed token, the public
  unsubscribe page, and the suppression write all exist and work, but nothing currently injects the
  link (or a `List-Unsubscribe` header) into a sent message — today it must be in the copy. This is
  a gap to close, not a policy.
- **No open/click tracking.** There is no tracking pixel and no link rewriting anywhere in the
  codebase. Delivery status comes from verified provider webhooks only: sent, delivered, bounced,
  complained, failed.
- **No inbound email reply detection.** Email sequences stop manually (see
  `docs/deferred-improvements.md` #16); X DM sequences stop on reply automatically via the inbox.

---

## What this means for the customer

**You bring a domain you control, and you verify it.** Sending is off until you do — you add the DNS
records to your own domain and Tuezday checks them with the provider. Nothing goes out from a
generic Tuezday address, so mail your prospects receive is unambiguously from you.

**Your sender reputation is yours.** Because you send as your own domain, the reputation you build
is your asset and your responsibility. Tuezday's job is to make it hard to damage it carelessly:
sending is off by default, an unknown recipient is a blocked recipient, a bounce or a complaint or an
unsubscribe suppresses that address permanently, a daily cap bounds the blast radius, and every send
is an authorized, recorded action you can audit.

**If you want volume tactics, use a volume tool.** Warmup, pools, and rotation are a different
product with a different risk profile. Export the CSV and run them there. Tuezday will keep owning
the part that needs the brain — who is worth writing to, what to say, and whether it is allowed to go
out.
