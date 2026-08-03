# Sprint 51 — Outbound Strategy Convergence

> **Phase:** I (Architectural Convergence) · **Workstream:** W2
> **Closes:** Atlas conflict #1 (🔴), deferred improvements #1 and #18
> **Branch:** `sprint-51-outbound-strategy-convergence` (off `main` @ `cb18bf1`)
> **Size:** M · **Risk:** Low (mostly reframing + deletion of a manual detour)
> **Source:** `prd-agentic-platform.md` §4, Sprint 51

---

## 1. Founder decisions recorded

| ID | Decision | Answer |
|---|---|---|
| **D1** | Own the native email/DM stack, or revert to Smartlead/Instantly? | **Own the native stack.** The founder's stated driver: *"the founder has to download the file and upload that file in smartlead for sending — this breaks one part of the outbound infra."* Reverting to Smartlead would **preserve** that manual dance; owning native is the only answer that removes it. |
| **CSV disposition** | Delete the CSV exporter, or keep it? | **Keep as an export-only affordance**, exactly as the PRD prescribes: *"Deprecate `CsvOutboundExporter` behind an export-only affordance (customers who want to run Smartlead can export; the platform does not route through it)."* Not a send path, not a routing choice — a data export. |

---

## 2. The problem, precisely

Two contradictory outbound strategies are live at once.

**The documented rule** (`CLAUDE.md:131`, `oss-integration-recommendations.md`): *never build
deliverability/warmup infra — use Smartlead/Instantly.* The implementation of that rule is
`CsvOutboundExporter` (`apps/api/src/outbound/exporter.ts`): approved messages are exported to CSV,
and **the founder manually uploads that CSV into Smartlead to actually send.**

**The shipped reality** (Sprints 27, 47–50): Tuezday built the full native email stack anyway —
sender-domain verification, suppression lists, recipient permission states, unsubscribe and
open/click tokens, and signature-verified delivery webhooks. That is precisely the
"deliverability controls" and "unsubscribe/compliance mechanics" the docs forbid.

### 2.1 The key finding — the manual step is already redundant

Native sending is **not missing**. It exists, is governed, and is already wired:

- `apps/api/src/services/launches.ts:610` — `dispatchChannel`'s `email` branch proposes a durable
  `send` external action per recipient via `prepareEmailAction`, with idempotency keys and
  re-propose-on-stale. This is native launch email sending, on `main`, today.
- `apps/api/src/routes/outbound.ts` — `POST /workspaces/:id/outbound/drafts/:draftId/send` is the
  native per-draft send path, gated by `checkEmailRecipientSafety`.
- `apps/web/app/workspaces/[id]/outbound/page.tsx:329` — a **"Send selected from Tuezday"** button
  already calls it.

The CSV download sits *directly beside* that button (`page.tsx:337`) as a co-equal alternative, and
the page copy (`page.tsx:457`) contradicts itself in a single sentence: *"Send approved sequences
from your own sender … and exports approved sequences to Smartlead or Instantly."*

**So the defect is not a missing capability. It is a UI/product framing that presents a manual,
off-platform detour as a first-class way to send, when the governed native path already covers it.**

`/workspaces/:id/outbound/export.csv` already skips drafts that were sent natively (it filters on
`emailDeliveries.origin = "outbound_draft"`), which confirms the intended direction: native is the
send path; CSV is a leftover.

### 2.2 The one genuine gap

Native send requires a **sender identity**, and on the true baseline there are **two**: a verified
Resend sender domain (`workspaceEmailSenders`, status `verified`) **or** a connected Gmail mailbox
(`mailboxes`, Sprint 47). With neither, `prepareEmailAction` fails `sender_unverified`
(`external-action-email.ts`), and CSV→Smartlead was the only escape hatch.

> Readiness is therefore the **union** of the two identities. Treating it as "verified domain only"
> is a real defect — it tells a mailbox-connected workspace to set up sending when it can already
> send. See the baseline-correction entries in §6.

The real hole is therefore: **when sending is not configured, the product routes the founder into
another tool instead of helping them turn sending on.** Fixing that — not deleting a button — is the
substance of this sprint.

---

## 3. Target state

1. **One send path per channel.** Email → native (Resend sender, governed external action).
   X DM → native multi-step sequences with caps + stop-on-reply. No second *send* implementation.
2. **CSV is export-only.** It remains available for founders who want to run Smartlead themselves,
   but it is never presented as "how you send", never wired into send/dispatch execution, and is
   visually secondary.
3. **Sending readiness is a first-class UI state.** When neither native identity exists, the email
   channel offers **"Set up sending"** (→ verify a sender domain, or connect a mailbox), not a CSV
   download.
4. **Docs tell the truth.** The OSS boundary rule is retired for email, with the reasoning recorded,
   and a deliverability-posture doc states plainly what Tuezday does and does not do.

**Non-goal:** no changes to the external-action governance model, the approval gate, suppression,
permission states, or webhook verification. This sprint reframes and converges; it does not
re-engineer sending. `outreach-engine.ts` (standalone outreach sequences) is on the true baseline and
was checked for CSV/Smartlead send framing — it has none, and its logic is left untouched.

---

## 4. Implementation plan

### Workstream A — API (`apps/api`)
- **A1.** Reframe the exporter as export-only: `app.ts:94` comment ("defaults to a
  Smartlead/Instantly CSV") and `outbound/exporter.ts` header comments state it is a **manual data
  export**, not a send or routing path.
- **A2.** Remove the misleading "keeps CSV as recovery only" framing in `launch-sequences.ts`
  (~:687–692) — native email is the path; CSV is not a recovery send route.
- **A3.** Tests: (i) a launch email dispatches end-to-end natively with the exporter **never
  invoked**; (ii) the CSV endpoints still return a valid export (export-only preserved);
  (iii) a guard test asserting no send/dispatch path references the exporter.
- **A4.** Ensure sending readiness is queryable by the web app (reuse the existing
  `email-senders` route/status; add nothing new if it already answers "is there a verified sender").

### Workstream B — Web (`apps/web`)
- **B1.** Make **"Send from Tuezday"** the single primary email action; demote the CSV download to a
  clearly-labeled secondary "Export copy (optional)".
- **B2.** Rewrite the self-contradictory copy at `page.tsx:457` — native sending from your own
  verified sender; CSV is an optional export, not the send route.
- **B3.** **Gap fix:** when neither a verified sender domain nor a connected mailbox exists, show a
  "Set up sending" prompt linking to sender setup instead of steering the founder to Smartlead.

### Workstream C — Docs
- **C1.** `CLAUDE.md` — update the `OutboundExporter` seam description (~:70) and the OSS boundary
  table row (~:131): email/X DM sending is **native-owned**; Smartlead/Instantly is an optional
  manual export, not a routing path.
- **C2.** `oss-integration-recommendations.md` — retire the "never build deliverability" rule for
  email; record the reasoning and the date.
- **C3.** New `docs/deliverability-posture.md` — what Tuezday does (verified sender domains,
  suppression, recipient permission, caps, unsubscribe, verified webhooks) and explicitly does
  **not** do (no domain warmup, no IP-pool management, no reputation arbitrage).
- **C4.** `docs/deferred-improvements.md` — close #1 and #18, resolved by native sending.

---

## 5. Acceptance criteria

- [ ] A founder can send an approved outbound email **entirely inside Tuezday** — no download, no
      upload — and the decision is recorded as a governed external action.
- [ ] With neither native identity configured, the UI offers "Set up sending"; a workspace that has
      either a verified domain **or** a connected mailbox is treated as ready. It never implies
      Smartlead is required.
- [ ] CSV export still works, is labeled optional, and is invoked by **no** send/dispatch path.
- [ ] `CLAUDE.md` and `oss-integration-recommendations.md` no longer contradict the shipped code.
- [ ] `docs/deliverability-posture.md` exists and is linked from the OSS doc.
- [ ] `npm test` and `npm run typecheck` pass.

---

## 6. Progress log

- **2026-08-02** — Branch created off `main` @ `cb18bf1`. Spec written. Code recon complete and
  verified against `main`: native launch email dispatch (`launches.ts:610`), native draft send
  (`/outbound/drafts/:id/send`), "Send selected from Tuezday" button (`page.tsx:329`), CSV download
  (`page.tsx:337`), contradictory copy (`page.tsx:457`). D1 resolved as **own the native stack**.

- **2026-08-02 — BASELINE CORRECTION.** The local `main` used as the branch point (`cb18bf1`) is
  **74 commits behind `origin/main`** (`1a657c7`). Local `main` is a strict ancestor — no divergence,
  a clean fast-forward — so the branch must be rebased onto `origin/main` before it can merge.

  This is not merely a stale checkout; the true baseline changes the sprint's substance:

  | Present on `origin/main`, absent from `cb18bf1` | Consequence for Sprint 51 |
  |---|---|
  | `apps/api/src/routes/mailboxes.ts`, Gmail send path | **A second native sender identity.** Sending is ready when there is a verified Resend sender **or** a connected Gmail mailbox. §2.2's readiness rule and the B3 gap fix must account for both, or the UI will tell mailbox-only workspaces to "set up sending" when they can already send. |
  | `apps/api/src/outbound-email/tracking.ts` | Open/click tracking **does** exist on the true baseline. The deliverability-posture doc (written against the stale tree) currently states it does not. |
  | `apps/api/src/services/outreach-engine.ts` | A third native send surface (standalone outreach sequences). Declared out of scope in §3 on the stale tree; must be re-checked for CSV/Smartlead framing. |

  Corroborating staleness signals found independently: `app.ts` still defaults `evidence` to
  `R2REvidenceStore` though `CLAUDE.md` records `DbEvidenceStore` as the impl since Sprint 47; and a
  stale Next.js artifact references an `outreach` page that exists only on `origin/main`.

  **Remediation:** rebase onto `origin/main`, then re-verify all three workstreams against the true
  baseline — in particular the B3 readiness rule (mailbox OR verified sender) and the
  deliverability-posture doc's tracking claim.

- **2026-08-02 — BASELINE CORRECTION APPLIED.** Branch rebased onto `origin/main` (`1a657c7`); the
  branch is now exactly one commit ahead of the true `main`. Only the two web files conflicted
  (`outbound/page.tsx`, `connectors/page.tsx`); API and docs merged cleanly. Resolutions:

  - **Readiness is now the union of both native send identities.** `senderReady` was
    `sender?.status === "verified"`, which would have told every Gmail-mailbox workspace to
    "set up sending" when it could already send. It is now
    `domainVerified || mailboxReady` (`page.tsx`), with the Sending card reporting which identity is
    live ("verified sender" / "mailbox connected") and the setup copy offering both routes.
  - The per-draft mailbox picker and "Send from mailbox" controls from `origin/main` are preserved
    alongside the new "Set up sending" CTA; they compose (the CTA only renders when neither identity
    exists, in which case there are no mailboxes to pick).
  - `PROVIDER_PROMISE` keeps `gmail` from `origin/main` and takes Sprint 51's export-only wording
    for `smartlead`/`instantly`.

  **Verified green on the true baseline:** `npm run typecheck` clean across all workspaces;
  `npm test` → **186 files, 1988 tests passing**. (The previously-reported web typecheck error was a
  stale gitignored `.next` artifact, not a real defect; it clears on a fresh build.)

- **Corrected on rebase — the two "capability gaps" were artifacts of the stale tree.** Both are in
  fact fully wired on the true baseline, and the deliverability-posture doc was rewritten to match:
  - **Unsubscribe is injected on every send** — `external-action-email.ts` mints a signed token and
    URL per send, appends plain-text and HTML footers, and hard-blocks with
    `unsubscribe_unconfigured` when `EMAIL_UNSUBSCRIBE_SECRET` is absent (recorded in-code as a
    founder decision, "from send #1").
  - **Open/click tracking exists** — `outbound-email/tracking.ts` with signed open/click tokens,
    link rewriting and an open pixel, opt-in per outreach sequence (`trackOpens`/`trackClicks`).

  This is the clearest argument for the baseline discipline: a doc written against a stale tree was
  accurate about that tree and wrong about the product.

- **2026-08-02 — compliance finding, raised by the posture re-verification. Needs a founder
  decision; deliberately NOT fixed in this sprint.**

  The unsubscribe footer, the postal address, and the `unsubscribe_unconfigured` hard guard are on
  the **Gmail/mailbox path only** (`gmailBlocker`, `composeGmailBody` in `external-action-email.ts`).
  The **Resend path transmits the action-authorized body verbatim** (`provider!.send({ text:
  payload.text })`, `html` always null) — so launch, outbound, and PR sends over Resend carry **no
  unsubscribe link and no postal address** unless the founder wrote them into the copy. Neither path
  sets a `List-Unsubscribe` header.

  This matters more now than it did last week: Sprint 51 makes native sending *the* path and removes
  the CSV detour, so the Resend path will carry more real volume. Cold email without an unsubscribe
  affordance is a CAN-SPAM exposure and a deliverability risk.

  Not fixed here because this sprint's remit is "reframe and converge, do not re-engineer sending" —
  adding footer composition to the Resend path changes send semantics and deserves its own tests.
  **Recommended follow-up sprint:** bring the Resend path to parity with the Gmail path (footer,
  postal address, `unsubscribe_unconfigured` guard) and add `List-Unsubscribe` to both.

  Other verified gaps recorded in `docs/deliverability-posture.md`: Gmail sends stop at `accepted`
  with no provider delivery/bounce event (bounce detection there is the LLM reply classifier); and
  the per-mailbox sending window is enforced at outreach dispatch, not in the send guard.
