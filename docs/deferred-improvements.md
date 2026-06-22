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

---

## Done (upgraded)

_(none yet)_
