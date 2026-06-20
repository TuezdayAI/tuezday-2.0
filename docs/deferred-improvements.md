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

---

## Done (upgraded)

_(none yet)_
