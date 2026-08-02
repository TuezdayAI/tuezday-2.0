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

## Two send identities

Much of what follows depends on *which* identity sends, so the split comes first. A workspace can
have both; they are independent.

**1. A verified Resend sender domain** (`services/email-senders.ts`, table `workspace_email_senders`
— one row per workspace, keyed on workspace id). The domain is registered with the transport
provider, the DNS challenge records are surfaced in the UI, and the sender is marked `verified` only
when the provider reports the domain verified *and* sending enabled (`statusFromDomain`). With no
verified sender the send action is blocked as `sender_unverified`. Tuezday does not send from a
shared Tuezday domain. This is the transactional identity — one-off launch, outbound, and PR sends.

**2. A connected Gmail mailbox** (`routes/mailboxes.ts`, `services/mailboxes.ts`,
`outbound-email/gmail.ts`, table `mailboxes`). It rides a `gmail` connector connection — OAuth
tokens live in Nango, never in Tuezday — and the address is read from the Gmail profile at connect
time, never hand-typed. Each mailbox carries its own display name, reply-to, signature, daily cap
(default 50, `MAILBOX_DEFAULT_DAILY_CAP`) and sending window (days / hours / timezone). This is the
outreach identity: **outreach sequences send only from mailboxes**, and it is the only path with a
reply loop. Deleting a mailbox is a soft delete — it stops sending and polling, and its send history
stays attributable.

Both paths run through the same external-action gate, the same recipient-safety check, and the same
`email_deliveries` snapshot. They differ in what the outgoing body carries and in what the provider
tells us afterwards; both differences are stated below.

---

## What Tuezday does

**Explicit recipient permission.** Every recipient carries a per-workspace permission state
(`email_recipient_permissions`). The default is `unknown`, and **`unknown` is blocking** — a send
requires an explicit `allowed`. There is no "assume yes until they complain" mode
(`services/email-recipient-safety.ts` → `checkEmailRecipientSafety`).

**Durable suppression lists.** `email_suppressions` holds one active suppression per recipient per
workspace, with the reason recorded: `bounce`, `complaint`, `unsubscribe`, `founder`, or `import`.
Bounces and spam complaints suppress the address automatically when the verified Resend event
arrives (`services/email-deliveries.ts`); on the Gmail path a reply classified `bounce` suppresses
the same way (`services/outreach-engine.ts`). A founder can suppress anyone by hand, or paste a
bulk block list (`importSuppressions`). Suppression is checked before every send, and re-importing
an address never clears it. Only a founder-reason suppression is reversible — by explicitly
re-permitting the recipient; a bounce, complaint, unsubscribe, or imported block is not undone that
way.

**Kill switch and daily caps.** Each workspace has a master send kill switch and a workspace-wide
daily send cap (default 100), counting accepted + delivered messages in the UTC day across both send
paths. On a workspace with a configured Resend sender the kill switch **defaults to on (sending
disabled)**. A workspace with no sender row is treated as disabled too, unless it has a connected
mailbox — connecting a Gmail mailbox is itself the explicit opt-in (`getEmailSafetySettings`).
Mailboxes add a second, narrower brake: a per-mailbox daily cap and a per-mailbox sending window,
enforced at outreach dispatch (`mailboxSendableNow` in `services/outreach-engine.ts`) and, for the
cap, again in the send guard (`mailbox_cap_reached`). A capped or out-of-window mailbox defers the
message to the next tick; it never spills onto another identity mid-thread.

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

**An unsubscribe link on every mailbox send.** Unsubscribe tokens are HMAC-SHA256 signed over the
workspace + normalized recipient and verified in constant time (`outbound-email/unsubscribe.ts`).
Every Gmail send mints one and appends a footer carrying the link — plain text always, and in the
HTML alternative when the send is tracked (`composeGmailBody` in `services/external-action-email.ts`).
This is a founder decision, in force from send #1: if `EMAIL_UNSUBSCRIBE_SECRET` is unset the send is
**hard-blocked** as `unsubscribe_unconfigured` rather than going out without a link. The footer is
deterministic, so an idempotent retry recomposes a byte-identical body. The public `GET|POST /u/:token`
endpoints render a confirm page and, on confirmation, set the recipient to `suppressed` and write an
`unsubscribe` suppression (`routes/email-recipient-safety.ts`). Tokens are unguessable and carry no
session. *(Resend-path sends do not carry this footer — see Gaps.)*

**A CAN-SPAM postal address, enforced.** A workspace must set its business mailing address before an
outreach sequence can activate (`compliance_address_missing`, `services/outreach-sequences.ts`), and
the address is appended to the footer of every mailbox send (`services/compliance.ts`).

**Opt-in open/click tracking.** Tracking exists and is **off by default** — `track_opens` and
`track_clicks` are per-sequence flags defaulting to 0 (`outreach_sequences`), and only outreach-step
sends can be tracked; every other origin resolves to no tracking (`resolveTrackingConfig`). An
untracked send stays plain text, byte-identical to the authorized body. A tracked send becomes a
multipart/alternative message (`buildRfc2822` in `outbound-email/gmail.ts`): the plain-text part is
still the authorized body, and the HTML part carries http(s) links rewritten through a signed
click-redirect and, for opens, a 1×1 pixel. Tokens are HMAC-signed and deterministic — no nonce, so
retries stay byte-identical — and **the redirect target lives inside the signed token, never as a
query parameter**, so it cannot be tampered into an open redirect (`outbound-email/tracking.ts`).
The public `/t/o/:token` and `/t/c/:token` endpoints record nothing on a bad token
(`routes/tracking.ts`); hits bump counters on `email_deliveries` and append to the append-only
`outreach_tracking_events` (`services/tracking.ts`).

**Signature-verified delivery webhooks (Resend path).** Resend delivery events are accepted only
through a svix-verified signature (`outbound-email/webhook.ts`, `POST /webhooks/resend`). Verified
events are appended to `email_delivery_events` — append-only, deduplicated on the provider event id,
payload size-bounded — and drive the delivery status through a guarded state machine
(`canTransitionEmailDelivery`). An unverified or replayed event changes nothing.

**Inbound reply detection and reply-driven stops (Gmail path).** A worker tick polls each connected
mailbox (`services/mailbox-inbox.ts`). The privacy invariant is an allowlist: **only threads Tuezday
itself started are ever read** — inbound messages are matched against the Gmail thread ids on our own
`email_deliveries` rows, so unrelated mail in the connected account is never ingested. Replies are
classified, and the outreach engine acts on the label rather than treating every reply as a blunt
stop (`services/outreach-engine.ts`): an out-of-office pauses and reschedules the enrollment (parsing
a stated return date when there is one), an unsubscribe request unsubscribes and suppresses, a bounce
suppresses and fails the enrollment, a positive reply stops the chain and fires a founder
notification plus a CRM follow-up task, and anything else simply stops the chain. `stop_on_reply` is
on by default.

---

## What Tuezday explicitly does NOT do

Owning the send path is not the same as owning deliverability as a product. Tuezday does not build,
and does not intend to build:

- **Domain or mailbox warmup.** There is no ramp schedule, no seed-list traffic, and no artificial
  volume anywhere in the codebase. Caps are static and founder-set; nothing raises them over time.
- **IP-pool or shared-pool management.** Tuezday does not run mail infrastructure or allocate IPs.
  On the Resend path the transport provider owns that; on the Gmail path it is the customer's own
  Google account.
- **Sender-reputation arbitrage.** No routing around blocklists, and no rotating identities to escape
  a damaged reputation. A suppressed recipient stays suppressed on every identity in the workspace —
  suppression is per-workspace, not per-sender.
- **Inbox rotation as a deliverability trick.** Stated precisely, because a mailbox pool does exist:
  a sequence can be attached to several connected mailboxes (`outreach_sequence_mailboxes`), and at
  enrollment the engine picks the pooled mailbox with the fewest sends today (`leastLoadedMailbox`).
  What that is: load-spreading across identities the customer owns and connected themselves. What it
  is not: Tuezday does not create or supply mailboxes, the chosen mailbox is pinned to the enrollment
  for the whole thread rather than rotating per message, and a mailbox at its cap or outside its
  window defers the send instead of handing it to another identity. The pool spreads volume across
  real identities; it does not manufacture them or evade a cap.
- **Bounce-rate gaming.** Bounces suppress the address. They are not filtered, hidden, or retried
  into looking better than they are.

A customer who wants those things should run a dedicated cold-email tool. That remains supported:
approved messages can be downloaded via the **optional CSV export** and loaded into Smartlead,
Instantly, or anything else. The export is a data export — it is not a send path, it is never
presented as how you send, and no dispatch path invokes it (`outbound/exporter.ts` is reachable only
from the explicit export route in `routes/launches.ts`).

---

## Gaps (distinct from out of scope)

Stated so the list above is not read as more than it is. These are gaps to close, not policy:

- **The Resend path carries no unsubscribe footer and no postal address.** The footer, the signed
  token, and the `unsubscribe_unconfigured` hard guard are on the Gmail/mailbox path only
  (`gmailBlocker`, `composeGmailBody`). A Resend send transmits exactly the action-authorized body,
  so for launch, outbound, and PR sends the unsubscribe link must be in the copy. The public
  unsubscribe endpoint works for those recipients — nothing automatically puts the link in front of
  them.
- **No `List-Unsubscribe` header on either path.** The link, where present, is body-only.
- **Gmail sends have no delivery webhook.** Their status stops at `accepted`: Google reports no
  delivered/bounced/complained event back to us, and `email_delivery_events` is Resend-only. Bounce
  detection on the mailbox path is the reply classifier, which is a weaker signal than a provider
  event.
- **The sending window is enforced at outreach dispatch, not in the send guard.** A mailbox send
  proposed outside the outreach engine is bounded by the mailbox cap but not by the window.

---

## What this means for the customer

**You bring an identity you control.** Either you verify a domain you own — you add the DNS records
and Tuezday checks them with the provider — or you connect your own Gmail account. Sending is off
until you do one of those. Nothing goes out from a generic Tuezday address, so mail your prospects
receive is unambiguously from you.

**Your sender reputation is yours.** Because you send as your own domain or your own mailbox, the
reputation you build is your asset and your responsibility. Tuezday's job is to make it hard to
damage it carelessly: sending is off by default, an unknown recipient is a blocked recipient, a
bounce or a complaint or an unsubscribe suppresses that address permanently, workspace and per-mailbox
caps bound the blast radius, sequence email always carries an unsubscribe link and your postal
address, tracking is off unless you turn it on, a reply stops the chain, and every send is an
authorized, recorded action you can audit.

**If you want volume tactics, use a volume tool.** Warmup, pools, and rotation are a different
product with a different risk profile. Export the CSV and run them there. Tuezday will keep owning
the part that needs the brain — who is worth writing to, what to say, and whether it is allowed to go
out.
