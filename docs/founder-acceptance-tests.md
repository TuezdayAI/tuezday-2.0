# Founder Acceptance Tests — All Sprints

> One consolidated checklist of every manual test suggested at the end of each sprint.
> Source of truth per slice: `docs/specs/sprint-*.md`. Check items off as you verify them.
>
> **Prerequisites:** `npm install`, then `npm run dev` (web :3000, api :3001).
> For Sprint 9 tests: Docker Desktop running + `npm run r2r:up` (R2R on :7272).
> For Sprint 12 tests: `npm run nango:up` (Nango on :3050).
> Your dev workspace: "tuezday".

---

## Sprint 1 — Foundation + Workspace (M0)

- [ ] `npm install` then `npm run dev` works from a clean checkout.
- [ ] http://localhost:3000 loads the dashboard shell.
- [ ] http://localhost:3001/health returns `{"status":"ok","db":"ok"}`.
- [ ] Create a workspace in the UI; restart the dev server; it is still there.
- [ ] `npm test` output is readable and green.

**Gate:** setup is repeatable.

## Sprint 2 — Central Brain v0 (M1)

- [ ] Open a workspace → five docs (soul, icp, voice, history, now) exist, completeness 0%.
- [ ] Fill all five docs → completeness rises to 100%.
- [ ] Edit one doc twice → version history shows both saves, newest first; restoring an old version works.
- [ ] Export the brain → one coherent markdown document.

**Gate:** does the exported brain read as a document you'd trust an AI to work from?

## Sprint 3 — Context Resolver (M2)

- [ ] Create a "CEO" persona and a "Company page" persona with different overlays.
- [ ] Resolve the same task/channel with each → bundles differ only in the persona section.
- [ ] Read the bundle top to bottom — it reads like the briefing you'd hand a new hire.
- [ ] Every section's reason makes sense; set a tiny token budget and watch `history` get dropped with an explicit reason.

**Gate:** context is inspectable and sensible.

## Sprint 4 — Generation Sandbox (M3 — quality checkpoint)

- [ ] ICP/Voice/Now docs have at least draft content so generation has real context.
- [ ] Sandbox: preview context → generate a LinkedIn post as CEO → read it.
- [ ] Rate it; rate another generation differently; both appear in the training log.
- [ ] Temporarily remove `GEMINI_API_KEY` from `.env` and restart → generate shows a clear error, app keeps working (restore the key after).

**Gate (the big one):** outputs sound like *us*, not like generic AI. If not, fix brain docs/overlays before anything downstream.

## Sprint 5 — Approval Gate (M4)

- [ ] Generate in the sandbox → "Send to approval queue".
- [ ] In the queue: edit the draft (state becomes `edited`), then approve — final content is your edited version.
- [ ] Reject a second draft.
- [ ] Open both decision histories — every step is there with timestamps and prior states.
- [ ] Try to edit an approved draft — the UI doesn't offer it; the API refuses (409).

**Gate:** is the decision log reliable enough to trust as the record of what shipped?

## Sprint 6 — Content Slice v1 (M5 — first full loop)

- [ ] Paste a real Reddit/X/LinkedIn signal you'd actually want to respond to (Content page).
- [ ] Draft a response as CEO for LinkedIn — the draft reads like *your* take on *that* signal.
- [ ] Edit/approve it in the queue.
- [ ] Copy or download the approved content; (optionally) actually post it.
- [ ] The signal inbox shows the signal → draft → approved chain at a glance.

**Gate:** the first loop works end to end with a real example.

## Sprint 7 — Signal Discovery (M8 in plan numbering)

- [ ] Add one RSS feed and one Google News query; add a Reddit source (subreddit).
- [ ] "✨ Suggest sources" — proposals visibly derive from your personas/brain.
- [ ] "▶ Run discovery now" → triage inbox fills with scored, persona-tagged real-world items.
- [ ] Accept the best item → it appears as a signal in Content → draft as CEO → approve → export.
- [ ] Add an X source → it shows "needs API key" and does nothing until a key exists.

**Gate:** signal quality is acceptable; persona routing makes sense; ideas come from the outside world.

## Sprint 8 — Campaigns (M6)

- [ ] Create a campaign with a real objective, pillars, and a now-overlay.
- [ ] Resolve the same task with and without the campaign — the bundle visibly changes and the trace says why.
- [ ] Generate + approve a draft under the campaign; draft a signal response under it too.
- [ ] Open the campaign → both drafts are there, counted by state.
- [ ] Archive it → it leaves the pickers but its history stays readable (and unarchive works).

**Gate:** the campaign visibly and sensibly changes output behavior.

## Sprint 9 — RAG Corpus / Evidence (M7)

- [ ] `npm run r2r:up`, wait until the Evidence page shows the store healthy.
- [ ] Upload your website copy + 2–3 past posts as evidence documents.
- [ ] Resolve a task — the evidence section shows relevant cited chunks (`[1]`, `[2]`…) with a sources list, and the trace explains the retrieval query.
- [ ] Generate something that needs proof — the output leans on the evidence; the stored trace shows exactly which chunks the model saw.
- [ ] `npm run r2r:down` → the app keeps working; the evidence section says why it's excluded. (`npm run r2r:up` again after.)
- [ ] Delete a document → it stops appearing in retrieval.

**Gate:** retrieved context is relevant, and you can always tell which source was used.

## Sprint 10 — Learning Loop (M9)

- [ ] Open Learning → your past ratings and approve/reject/edit decisions appear as training examples (edited ones show original vs final).
- [ ] Record real metrics on an approved post you actually shipped.
- [ ] "✨ Synthesize learnings" → read the proposal and rationale.
- [ ] Accept it → `now` gains a dated `## Learnings` block (check the brain editor + version history).
- [ ] Resolve any task → the learnings appear in the context bundle.

> ⚠ Outstanding: a real synthesis proposal is already sitting in `proposed` status on your Learning page — review it. Your `now` doc is empty until you accept something there (or write it by hand).

**Gate:** do you trust the learning loop's output enough to put it into your brain?

## Sprint 11 — Outbound Slice (M10)

- [ ] Import ~5 real-ish leads via CSV paste (Outbound page; notes column matters most).
- [ ] Select them → draft as CEO under a campaign.
- [ ] Read the drafts: personalization comes **only** from the lead data — no invented meetings or flattery.
- [ ] Edit one, approve a few, reject one — same queue as everything else.
- [ ] "↓ Export approved CSV" and open it — ready for any sender.

> The two smoke-test leads (Asha/Ben) and their drafts are in your workspace — keep or delete.

**Gate:** the second module proves brain reuse.

## Sprint 12 — Connector Fabric

- [ ] `npm run nango:up`; the Connectors page shows the fabric healthy.
- [ ] Connect the **Custom API (no auth)** provider to any service (e.g. base URL `http://host.docker.internal:3001`, test path `/health`) → status `connected`.
- [ ] **Test** → a real request goes through Nango's proxy and returns 200.
- [ ] Disconnect → Reconnect works.
- [ ] (If you have a Smartlead or Instantly key: connect it for real and Test.)
- [ ] Add a webhook — easiest is a fresh URL from https://webhook.site — for `draft.approved`, with a secret.
- [ ] Approve any draft → the signed event arrives at the endpoint; the event log shows the delivery with its status.
- [ ] Ping the webhook; disable it; confirm a new approval delivers nothing.

**Gate:** one external provider connects, status is stored, a test request works through the connector, and disconnect/reconnect works.

---

## Cross-cutting things worth re-checking occasionally

- [ ] `npm test` (288 tests) and `npm run typecheck` stay green.
- [ ] Every generation's prompt trace is readable *before* and *after* the LLM call (sandbox → "show prompt trace").
- [ ] Stopping any external service (R2R, Nango) degrades gracefully — the app never breaks, traces/banners say why.
- [ ] Gemini occasionally returns 503 "high demand" — a retry succeeds; it surfaces as a clean error, never a crash.
