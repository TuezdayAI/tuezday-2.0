# Sprint 50 — Outreach tracking, funnel & attribution (Outreach module, part 4 of 4)

> Status: spec — build in progress.
> Size: M–L. One vertical slice. Spec-first; tests before/with implementation; founder accepts + merges.

## Branch & merge order

- **Branch:** `sprint-50-outreach-tracking`, cut from **`sprint-49-reply-actions-compliance`** (depends on the outreach engine, mailbox send, reply inbox).
- **Merge order into `main`:** S47 → S48 → S49 → **then S50**.
- **Migration:** base ends at 0050, so this sprint adds **0051**. (Note: the independent `sprint-47-own-evidence-store` branch also carries a 0051; whoever merges second renumbers — a known, handleable conflict.)

## Why this sprint (context for a fresh session)

Sprints 47–49 built the outreach loop: send from a Gmail mailbox, read + classify + act on replies. But nothing is captured between **sent** and **replied**, so the learning loop can't answer *"which sequence / step / persona / segment converts?"* for outreach. Sprint 50 adds open/click tracking, assembles the per-sequence funnel, attributes outcomes, and feeds the S34 campaign rollup + the `now`-doc synthesis. This completes the outreach module.

## Founder decisions (locked 2026-07-22)

1. **Meeting/won = a manual marker** on the enrollment (`none` / `meeting` / `won` / `lost`). No fabricated automation.
2. **Tracking is off by default, opt-in per sequence** (deliverability-first).
3. **Tracking served from a dedicated subdomain** (`TRACKING_BASE_URL`, falls back to `APP_BASE_URL`).
4. **HTML body only when tracking is on** — tracking-off sends stay plain-text.

## What this slice does (founder-visible)

Toggle tracking on a sequence → each send carries an invisible open pixel + rewritten click links (HTML part; plain-text fallback keeps real links) → the outreach detail page shows a live **funnel** (sent → opened → clicked → replied → positive → meeting) with rates, plus **attribution** (which step / persona / segment converts). Mark an enrollment meeting/won/lost by hand. Outcomes feed the campaign insights view and the weekly learning proposal.

## Out of scope / honest limits

- **"Delivered"** isn't observable on the Gmail path (no delivery webhook) → the funnel treats sent-minus-bounce as delivered and says so.
- **Opens are soft** — Apple Mail Privacy Protection inflates them (pre-fetches pixels). Opens are shown as a secondary metric; ranking + learning weight clicks + replies.
- No automated meeting detection (decision 1).
- The old `launches`/S30 outbound stays as-is in insights; we add an `outreach` block beside it, not replace it.

## Architecture decisions (grounded in recon)

1. **HTML only for tracked sends.** `composeGmailBody` returns `{ text, html }` (html non-null only when the sequence tracks). `buildRfc2822` (`gmail.ts:92`) gains a `multipart/alternative` branch when `GmailSendInput.html` is set (text part + html part, random boundary); the provider passes `html` through untouched. Non-outreach sends and tracking-off sequences are byte-identical to today.
2. **Signed, deterministic tokens.** New `outbound-email/tracking.ts` clones `unsubscribe.ts`: HMAC-SHA256 over `{ workspaceId, deliveryId, url? }`, base64url, `timingSafeEqual` verify. The click target URL is **inside the signed token** (not a query param) → no open-redirect, and deterministic so retries recompose an identical body (the S47 idempotency contract). Reuses `EMAIL_UNSUBSCRIBE_SECRET`.
3. **Delivery row is the anchor.** `email_deliveries.id` (minted in the Gmail execute path) is the token subject; a tracking hit does `UPDATE email_deliveries … WHERE id = deliveryId` and appends a detail event. Attribution rides the existing chain: `email_deliveries(origin='outreach_step', originId=outreach_messages.id) → enrollment → sequence(persona/campaign/audience)`; `message.stepNumber` = step key.
4. **Public tracking routes bypass auth** via `PUBLIC_ROUTES` (`auth/guard.ts`), exactly like `/u/:token`. Raise `maxParamLength` (click tokens embed a URL).
5. **Funnel computed on read** (like `publication_metrics` rollups) — no new worker.

## Data model (migration 0051)

- **`outreach_sequences`** (alter): `track_opens` int NN default 0, `track_clicks` int NN default 0.
- **`email_deliveries`** (alter): `opened_at` int, `open_count` int NN default 0, `first_click_at` int, `click_count` int NN default 0.
- **`outreach_tracking_events`** (new, append-only detail): `id` PK, `workspace_id` NN→workspaces cascade, `email_delivery_id`→email_deliveries set null, `type` NN (`open`/`click`), `target_url` text, `occurred_at` int NN, `created_at` int NN. Index `(email_delivery_id)`. Privacy-first: no IP/UA.
- **`outreach_enrollments`** (alter): `outcome` text NN default `'none'` (`OUTREACH_ENROLLMENT_OUTCOMES`).

## Contracts (`packages/contracts`)

`OUTREACH_ENROLLMENT_OUTCOMES = ["none","meeting","won","lost"]`; `TRACKING_EVENT_TYPES = ["open","click"]`. Extend `outreachSequenceSchema`/create/update with `trackOpens`, `trackClicks` (default false). `setEnrollmentOutcomeInputSchema` ({ outcome }). `outreachFunnelSchema` ({ sent, opened, clicked, replied, positive, meetings, won, lost, openRate, clickRate, replyRate, positiveRate } + `attribution: { byStep[], byPersona[], bySegment[] }` where each row = a label + the same counters). Add an `outreach` funnel block to `campaignInsightsSchema` (optional, so the S34 UI degrades gracefully). Extend the enrollment schema with `outcome`.

## Services

- **`outbound-email/tracking.ts`** (new): `createOpenToken(ws, deliveryId)`, `createClickToken(ws, deliveryId, url)`, `verifyTrackingToken(token)` → `{ ok, value:{ workspaceId, deliveryId, url? } }`.
- **`services/external-action-email.ts`**: `composeGmailBody` → `{ text, html }`; a `composeTrackedHtml` that escapes the text (reuse `escapeHtml`), appends signature + unsubscribe + postal address, appends the pixel `<img src="{trackingBase}/t/o/{openToken}" width="1" height="1">`, and rewrites `http(s)` links to `{trackingBase}/t/c/{clickToken}`. The Gmail `execute` branch resolves the sequence's track flags (only when `origin==='outreach_step'`: message→enrollment→sequence), and passes `html` to `sendEmail` when tracking is on. Plain-text `text` is unchanged and remains the authorized/stored body.
- **`outbound-email/gmail.ts`**: `GmailSendInput.html?`; `buildRfc2822` multipart branch.
- **`services/tracking.ts`** (new): `recordOpen(db, deliveryId, nowMs)` (increment `open_count`, set `opened_at` if null, insert event), `recordClick(db, deliveryId, url, nowMs)` (increment `click_count`, set `first_click_at` if null, insert event).
- **`services/outreach-funnel.ts`** (new): `getSequenceFunnel(db, ws, seqId)` — join the outreach chain, count sent/opened/clicked/replied/positive from `outreach_messages` + `email_deliveries` counters + `inbox_items.replyLabel` + `enrollments.outcome`; group for `byStep`/`byPersona`/`bySegment`. `getCampaignOutreachFunnel(db, campaignId)` for insights.
- **`services/outreach-sequences.ts`**: `setEnrollmentOutcome`.
- **`services/insights.ts`**: add the `outreach` block to `getCampaignInsights` (via `getCampaignOutreachFunnel`), extend the CSV.
- **`services/learning.ts`**: gather outreach outcomes (positive-reply rate by persona/step) and inject a prompt block in `synthesizeNow`, recorded in `basedOnJson`.

## Routes

- Public (in `PUBLIC_ROUTES`): `GET /t/o/:token` → verify → `recordOpen` → 1×1 transparent GIF (`image/gif`); `GET /t/c/:token` → verify → `recordClick` → `302` to the signed url. Register `routes/tracking.ts` after the auth guard; raise `maxParamLength` (~4096).
- `GET /workspaces/:id/outreach-sequences/:seqId/funnel` → funnel + attribution.
- `POST /workspaces/:id/outreach-sequences/:seqId/enrollments/:enrollmentId/outcome` `{ outcome }`.
- Env: `TRACKING_BASE_URL` (fallback `APP_BASE_URL`) in `.env.example`.

## Web (`apps/web`)

- Outreach detail: a **funnel widget** (stage counts + rates; opens flagged "soft signal — inflated by Apple MPP"), an **attribution table** (by step / persona / segment), a per-sequence **tracking toggle** in the builder, and a **meeting/won/lost** control on each enrollment row.
- S34 campaign insights: render the new `outreach` funnel block beside paid/organic (degrade gracefully if absent).

## Tests (`apps/api/test/outreach-tracking.test.ts` + insights/learning additions)

Tracking-on send is multipart with a pixel + rewritten links (fake Gmail provider asserts `html`); tracking-off send stays plain-text (byte-identical). Token round-trip + tamper rejection; click token can't be pointed at an unsigned URL (no open redirect). `/t/o` records an open (counter + event) and returns a GIF; `/t/c` records a click and redirects to the signed url; a bad token → 400/404, no DB change. Funnel counts sent/opened/clicked/replied/positive and groups by step/persona/segment; manual outcome flows into meetings/won. Determinism: recomposing a tracked body twice yields identical tokens. Insights exposes the outreach block; learning includes the outreach signal. REGRESSION: full suite green (S47–49 untouched; non-outreach email sends unchanged); typecheck clean.

## Founder acceptance checklist

1. Turn tracking on for a sequence; send yourself a step. Confirm it arrives as HTML, links work (redirect through `/t/c`), and opening it registers an open.
2. See the funnel populate (sent → opened → clicked → replied) with opens flagged soft.
3. Reply "interested" → positive shows; mark the enrollment "meeting" → the meeting stage increments.
4. Open a campaign's insights → the outreach funnel shows beside paid/organic.
5. Turn tracking off on another sequence → its sends are plain-text with no pixel.

## Progress log

- 2026-07-22 — Spec written from the approved draft plan after a 2-agent recon (Gmail send/token/route internals; S34 insights + learning-loop synthesis). Four decisions locked (all recommended). Implementation started.
