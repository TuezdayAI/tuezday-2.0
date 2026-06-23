# Deferred Improvements

> The running backlog of deliberate "good enough for now" choices — the simpler version we shipped to
> keep a sprint scoped, paired with the no-compromise version we'll build later and the trigger to
> revisit. Founder rule (2026-06-21): we never *lose* a compromise; we log it here and upgrade it once
> we hit scale / have users. Add an entry every time the simpler path is chosen.

Each entry: **what we shipped** · **the better version** · **trigger to revisit** · **origin sprint**.

---

## Open

### 1. Email send = CSV export, not a live API push
- **What we shipped (Sprint 26):** Approved per-recipient email messages are exported as a
  Smartlead/Instantly-ready CSV (personalized body as a custom variable). The founder uploads the CSV
  into Smartlead/Instantly to actually send. This sits behind an `OutboundExporter` interface so the
  launch domain never learns how email leaves Tuezday.
- **The better version:** A real API push — using the already-registered `smartlead` / `instantly`
  outbound providers, create the sending campaign and upload the leads + personalized fields via API,
  one click, no manual CSV step. A second `OutboundExporter` implementation; the launch domain is
  untouched.
- **Trigger to revisit:** When manual CSV upload becomes the bottleneck — i.e., real users running
  launches regularly, or a paying customer asks for one-click send.
- **Origin:** Sprint 26 (Targeted campaign launch). Boundary held: we still never build
  deliverability/warmup infra ourselves.

### 2. Launch generation is synchronous (one LLM call per recipient, inline)
- **What we shipped (Sprint 26):** `generateLaunch` loops the audience and calls the LLM once per
  recipient (email + X DM) plus once per broadcast channel, all inside the request — the same shape
  the Sprint 11 outbound drafter uses. Fine for modest segments; a large audience makes the
  `/generate` call slow.
- **The better version:** Enqueue generation on `apps/worker` (the system actor already calls the API
  cross-workspace) and stream/poll progress; the launch sits in `generating` until done.
- **Trigger to revisit:** When a real launch targets more than a few dozen recipients, or `/generate`
  starts timing out.
- **Origin:** Sprint 26.

### 3. Instagram video/reel finalize uses a bounded in-request poll, not async worker finalize
- **What we shipped (Sprint 26):** `InstagramAdapter` publishes images and carousels synchronously;
  for a video/reel it polls the container `status_code` a bounded number of times, then errors with
  "still processing — retry" (the existing publication **retry** route finishes it). No fake success.
- **The better version:** A worker-driven async finalize — create the container, return immediately,
  and let the worker poll + publish when the reel is ready (the same scheduled-publication machinery).
- **Trigger to revisit:** When founders publish reels regularly and the retry step becomes annoying.
- **Origin:** Sprint 26.

### 4. Cadence fill is synchronous on a worker tick
- **What we shipped (Sprint 27):** Each fill creates scheduled `publication` rows inline (one round
  trip per draft), bounded to a 14-day horizon and run every few minutes by the worker. Fine for modest
  volumes.
- **The better version:** Run fill on a dedicated scheduler with sub-minute precision and back-pressure
  for large fan-out.
- **Trigger to revisit:** Large cadence fan-out or a need for sub-minute precision.
- **Origin:** Sprint 27.

### 5. DST-gap wall-clock times resolve to the adjacent valid instant
- **What we shipped (Sprint 27):** The slot math handles normal DST transitions, but the ~1 hour per
  year that *doesn't exist* locally (spring-forward gap) is mapped to the nearest valid instant rather
  than skipped or flagged. Acceptable for a posting scheduler.
- **The better version:** A library-backed implementation that surfaces the ambiguity.
- **Trigger to revisit:** If a customer reports a mis-fired post around a DST boundary.
- **Origin:** Sprint 27.

### 6. Cadence doesn't pre-validate posts at fill time
- **What we shipped (Sprint 27):** Fill derives a title from the draft's first line (covers Reddit's
  title requirement) but doesn't run `validateSocialPost` before scheduling — an invalid post fails its
  receipt at fire time with the platform error (the existing failed-receipt + retry path).
- **The better version:** A pre-flight check that warns before the slot fires.
- **Trigger to revisit:** When fire-time failures on auto-slotted posts become noisy.
- **Origin:** Sprint 27.

### 7. Mailer is fire-and-log behind the interface
- **What we shipped (Sprint 27):** `Mailer` (Resend impl + Console default) has no delivery-tracking
  table, retries, bounce/open webhooks, or templating engine. Invite emails are best-effort (a failure
  never blocks invite creation).
- **The better version:** Delivery tracking + retries + a real template layer.
- **Trigger to revisit:** Arrives with the email-approvals (S39) and billing (S37) sprints that also
  depend on this seam.
- **Origin:** Sprint 27.

### 8. Automation runs synchronously on a worker tick
- **What we shipped (Sprint 28):** `runAutomation` loops each active automated campaign × channel ×
  new signal and calls the LLM inline (one generation per draft), bounded by new-signal volume and run
  every few minutes by the worker. Fine for modest volumes.
- **The better version:** Enqueue generation on a worker queue with back-pressure and progress, so a
  burst of signals across many campaigns doesn't block a single request.
- **Trigger to revisit:** When automated campaigns × channels × signal volume makes a run slow.
- **Origin:** Sprint 28.

### 9. Auto-post guardrail caps are per UTC day
- **What we shipped (Sprint 28):** The per-connection and per-campaign daily caps count posts in the
  UTC calendar day of each candidate slot, ignoring the cadence's own timezone.
- **The better version:** A timezone-aware (per-account-local) daily window.
- **Trigger to revisit:** If a customer's posting day spans a UTC boundary in a way that surprises them.
- **Origin:** Sprint 28.

### 10. Kill switch clears pending auto-posts on the next cadence tick, not instantly
- **What we shipped (Sprint 28):** Turning the kill switch on stops new auto-posting and cancels a
  cadence's pending `scheduled` auto-posts the next time that cadence is filled (≤ the fill interval).
- **The better version:** A check at the publish-fire path so a flipped kill switch halts a due
  auto-post immediately, regardless of the fill cadence.
- **Trigger to revisit:** If the few-minute lag between flipping the switch and a due post matters.
- **Origin:** Sprint 28.

### 11. No relevance triage — every signal fans out to every automated campaign's channels
- **What we shipped (Sprint 28):** A new signal generates a draft for each channel of every active
  automated campaign, with no scoring of which signal actually fits which campaign/persona.
- **The better version:** Score signal↔campaign/persona fit and route only relevant signals (extends
  `suggestedPersonaId` / `scoreReason`).
- **Trigger to revisit:** **Sprint 31** owns this (discovery source expansion + auto-mapping); the
  post-2026-06-21 reorg moved discovery expansion to S31 (Sprint 29 became the reply inbox).
- **Origin:** Sprint 28.

### 12. Inbox polls synchronously on a worker tick
- **What we shipped (Sprint 29):** `pollInbox` fetches replies + engagement per published post/DM
  inline on the inbox tick, one platform call at a time, with no per-post cursors.
- **The better version:** A queue with per-post cursors so high comment/DM volume doesn't serialize
  behind one slow account, and reads resume from the last-seen id instead of re-scanning.
- **Trigger to revisit:** When a workspace has enough published posts / inbound volume that a tick
  takes too long or brushes platform rate limits.
- **Origin:** Sprint 29.

### 13. LinkedIn / X / Instagram read + reply methods are verified-when-creds
- **What we shipped (Sprint 29):** Reddit's `fetchReplies` / `fetchEngagement` / `postReply` are
  tested end to end. LinkedIn, X (DM), and Instagram are written to each platform's real API shape
  but are **untested** without live OAuth apps and elevated access (LinkedIn `r_member_social`, IG
  Business + App Review, X elevated DM access).
- **The better version:** Live-credential verification of each platform's inbound + reply path, with
  fixtures captured from real responses.
- **Trigger to revisit:** When each platform's app + scopes exist (mirrors the S26/S28 social pattern).
- **Origin:** Sprint 29.

### 14. Engagement metrics captured once at the 24h and 7d marks
- **What we shipped (Sprint 29):** `refreshEngagement` upserts one `publication_metrics` row per
  window when its mark passes — a coarse snapshot, not a live curve.
- **The better version:** A polling window that tracks the engagement curve over time (early velocity,
  decay) rather than two point samples.
- **Trigger to revisit:** When the engagement *trend* (not just the 24h/7d totals) drives a decision.
- **Origin:** Sprint 29.

### 15. Auto-reply is per-workspace × per-campaign-mode only
- **What we shipped (Sprint 29):** Auto-reply fires when the workspace master switch is on **and** the
  originating campaign is `scheduled_auto`, within the kill switch + per-connection cap. There is no
  per-channel, per-item-type, or per-sentiment control.
- **The better version:** Finer-grained gating (e.g. auto-reply on LinkedIn comments but never DMs, or
  only on positive-sentiment items).
- **Trigger to revisit:** When a customer wants different auto-reply behavior across channels/sentiment.
- **Origin:** Sprint 29.

### 16. Email reply detection is out of scope (email sequences stop manually)
- **What we shipped (Sprint 29 + 30):** The inbox covers social comments + X DMs. Outbound email is
  CSV-exported to Smartlead/Instantly — there is no inbound-mail channel, so email replies aren't
  detected. Sprint 30's stop-on-reply is therefore **automatic for X DMs** (via the inbox) and
  **manual for email** (a Stop button per recipient / per launch / paste a suppression list of emails).
  Nothing is faked — we never invent an email reply signal we cannot observe.
- **The better version:** An inbound-mail integration (Smartlead/Instantly reply webhook or IMAP) so
  email replies land in the same inbox and stop the chain automatically, like X DMs do.
- **Trigger to revisit:** When real email sequences run at volume and clicking Stop per replied
  recipient becomes painful — build inbound-mail ingest as its own slice, then flip email stop-on-reply
  to automatic.
- **Origin:** Sprint 29 (gap); Sprint 30 (manual stop shipped on top of it).

### 17. Per-connection reply cap counts replies + publications together per UTC day
- **What we shipped (Sprint 29):** The per-connection daily cap on auto-replies counts posted replies
  **plus** publications on that connection in the UTC calendar day — a coarse account-level safety net.
- **The better version:** A timezone-aware budget that distinguishes action types (posts vs replies).
- **Trigger to revisit:** If replies and posts need separate budgets, or the UTC boundary surprises a
  customer (see also #9).
- **Origin:** Sprint 29.

### 18. Email sequence steps still require a manual CSV export per batch
- **What we shipped (Sprint 30):** Even in `scheduled_auto`, the engine auto-generates + auto-approves
  each email step, but the **send** is the founder's manual CSV export → upload to Smartlead/Instantly
  (the deliverability boundary we never cross — ties to #1). The next step's delay clock starts at the
  export (real send) moment, so the engine never gets ahead of actual sends.
- **The better version:** The one-click API push from #1 — approved email steps post straight into the
  Smartlead/Instantly campaign, no manual CSV per batch; the engine learns the send time from the API.
- **Trigger to revisit:** Same as #1 — when manual CSV upload per step becomes the bottleneck.
- **Origin:** Sprint 30.

### 19. The sequence engine advances synchronously on the worker tick
- **What we shipped (Sprint 30):** `runSequences` walks every active recipient inline on each
  worker tick (`SEQUENCE_INTERVAL_MIN`, default 5), generating due steps one per tick per recipient —
  the same synchronous shape as cadence fill (#4) and the inbox poll (#12). Fine for modest audiences.
- **The better version:** A dedicated scheduler with back-pressure for large fan-out and sub-minute
  precision.
- **Trigger to revisit:** Large audiences, many concurrent sequences, or a need for tighter timing.
- **Origin:** Sprint 30.

### 20. Step delays are whole hours, evaluated on the tick
- **What we shipped (Sprint 30):** `delayHours` is a whole-hour integer, and a step fires on the first
  worker tick after `previousStepSentAt + delayHours`. So effective precision is the tick interval
  (≈5 min), and sub-hour cadences aren't expressible.
- **The better version:** Minute-granular delays (and/or send-time-of-day windows) with tick precision
  to match.
- **Trigger to revisit:** A customer needs minute-level or business-hours-aware follow-up timing.
- **Origin:** Sprint 30.

### 21. Sequences cover only the personalized channels (email + X DM)
- **What we shipped (Sprint 30):** A launch's follow-up chain runs on `email` and `x` only. Broadcast
  channels (LinkedIn/Instagram) on the same launch are **not** sequenced — they stay the Sprint 26
  single-shot post. X DM auto-send guardrails reuse the workspace kill switch + per-connection daily
  cap (counting sent DMs), but there's no per-launch DM cadence cap beyond that.
- **The better version:** Multi-channel sequences (e.g. email → LinkedIn touch → email) and richer
  per-step conditions (opened/clicked) once those signals exist.
- **Trigger to revisit:** Demand for cross-channel cadences, or once open/click tracking lands.
- **Origin:** Sprint 30.

---

## Done (upgraded)

_(none yet)_
