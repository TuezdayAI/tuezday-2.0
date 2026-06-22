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

---

## Done (upgraded)

_(none yet)_
