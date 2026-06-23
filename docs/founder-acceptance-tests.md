# Founder Acceptance Tests — All Sprints

> One consolidated checklist of every manual test suggested at the end of each sprint.
> Source of truth per slice: `docs/specs/sprint-*.md`. Check items off as you verify them.
>
> **Prerequisites:** `npm install`, then `npm run dev` (web :3000, api :3001).
> For Sprint 9 tests: Docker Desktop running + `npm run r2r:up` (R2R on :7272).
> For Sprint 12 tests: `npm run nango:up` (Nango on :3050).
> For Sprint 14 tests: Meta Ads `ads_read` system-user token; `npm run nango:up`.
> For Sprint 17 tests: Reddit app credentials (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`) in `.env`; `npm run nango:up`.
> For Sprint 19 tests: two browsers (or one + incognito); `TUEZDAY_WORKER_TOKEN` in `.env`.
> For Sprint 20 tests: Meta Ads `ads_management` token; Sprint 14 + 15 acceptance done first; `TUEZDAY_WORKER_TOKEN` in `.env`.
> For Sprint 30 tests: Docker + `npm run r2r:up` (as Sprint 9); a few signals and at least one published post in the workspace; `TUEZDAY_WORKER_TOKEN` in `.env` for the worker sweep.
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

## Sprint 13 (slice 1) — CRM Read/Write (Freshsales)

- [ ] `npm run nango:up`; Connectors page → connect **Freshsales** with your bundle URL (`https://<yourcompany>.myfreshworks.com/crm/sales`) and API key (Freshsales → Settings → API) → status `connected`, **Test** passes through the proxy.
- [ ] CRM page → **Sync contacts** → your Freshsales contacts appear with name/email/company/role.
- [ ] **Import as lead** on one contact → it shows in the leads panel (and on the Outbound page) linked to the contact.
- [ ] Outbound: draft an email for that lead → approve it in the queue.
- [ ] CRM page → **Log to CRM** on the approved draft → the note (the email text) is visible on the contact in Freshsales.
- [ ] **Push to CRM** on a lead that did *not* come from the CRM → the contact appears in Freshsales; the Connectors event log shows `crm.contact.created` and `crm.note.logged`.

**Gate:** the CRM round trip works — contacts in, approved work back out, with the CRM staying the system of record.

## Sprint 14 — Ads Reporting (read-only)

- [ ] `npm run nango:up`; Connectors page → connect **Meta Ads** with an `ads_read` system-user token → status `connected`, **Test** passes (Graph `/me` through the proxy).
- [ ] Ads page → **Import ad accounts** → your Meta ad account appears with its currency.
- [ ] **Sync now** → per-campaign spend/impressions/clicks/conversions for the last 28 days appear.
- [ ] Open the same date range in Ads Manager and compare a closed day — numbers match.
- [ ] **Link** one ad campaign to an existing Tuezday campaign → the campaign page shows a "Paid performance" section with real numbers.
- [ ] CSV path: download the import template, fill 3–5 rows, import → they appear under the "CSV import" account in the same report view.
- [ ] Leave the worker running → metrics refresh on schedule without manual intervention; event log shows `ads.synced`.

**Gate:** the numbers in Tuezday match what the platform shows for the same closed day.

## Sprint 15 — Ad Creative Generation

- [ ] Ad creatives page → pick a campaign + **Meta** + a persona → **Generate** → 3 distinct variants appear, in the workspace voice, every field within its character-limit counter.
- [ ] Push a field over its limit in the editor → save is refused with the exact violation; fix it → resubmit → approve in the approval queue.
- [ ] Try to approve a variant that already violates a limit (without editing it) → Tuezday blocks with a clear message.
- [ ] Variants also appear in **Review & approve** alongside other drafts; approving from there works identically.
- [ ] **Export CSV** (approved only) → open it → paste the fields into Ads Manager with zero rework. Per-variant copy link also pastes cleanly.
- [ ] Generate a **Google RSA** set → 15 headlines ≤30 chars, 4 descriptions ≤90 → export CSV → columns match the RSA editor field structure.
- [ ] With Sprint 14's Meta ad campaign linked to the same Tuezday campaign → the creative set shows a "Paid performance" chip with real spend numbers.

**Gate:** a non-technical person could paste the export directly into the ad platform without reformatting anything.

## Sprint 16 — PR & Media Outreach

- [ ] PR page → paste a 5-contact CSV (mixed journalists/podcasts, some fields quoted) → all 5 appear with outlet and beat; re-importing the same file adds zero duplicates.
- [ ] Select all 5 → pitch type **announcement** + launch campaign + founder persona → **Draft pitches** → 5 drafts appear, each referencing the contact's actual beat, in the workspace voice, nothing invented.
- [ ] Open one pitch in **Review & approve** → edit a line → resubmit → approve; decision history shows the edit.
- [ ] Accept a discovered signal from the Discovery inbox → back in PR, pitch type **reactive** → the pitch responds to the actual story and reads timely.
- [ ] **Generate press kit** → one-liner, about paragraph, and key facts match the brain docs → edit → approve. Tweak the `now` doc → generate again → a new version appears, the previous remains in history.
- [ ] Export approved pitches as CSV → contact columns + pitch text intact. Click **Open in email client** → your mail app opens with subject and body pre-filled.

**Gate:** each pitch references something real about that contact and reads like the founder wrote it.

## Sprint 17 — Social Publishing (Reddit)

> Prereq: create a Reddit app at reddit.com/prefs/apps (type: **web app**, redirect `http://localhost:3050/oauth/callback`). Add `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` to `.env` and restart.

- [ ] `npm run nango:up`; Integrations page → Reddit → **Connect** → Reddit OAuth popup → authorize → card shows `connected`, **Test** passes (`/api/v1/me` through the proxy).
- [ ] Approve a content draft → **Publish…** → pick the Reddit account + subreddit `r/test` (or your own), keep the suggested title → **Post now** → the post is live on Reddit; Tuezday shows `published` + working link; event log shows `post.published`.
- [ ] Publish another approved draft **scheduled 2 minutes out** → status shows `scheduled`; the worker posts it on time; status flips to `published`.
- [ ] Publish to a nonexistent subreddit → row shows `failed` with Reddit's error message. Fix the subreddit → **Retry** → succeeds.
- [ ] **Disconnect** Reddit → reconnect via the popup → publishing works again.

**Gate:** approved content appears on an actual Reddit thread via Tuezday — the loop from brain to published post is closed end to end.

## Sprint 18 — Dashboard UX Redesign

- [ ] Open a workspace: the sidebar shows eight plain-language nav items; none of the internal words ("resolver", "connector", "sandbox") appear at the nav level.
- [ ] Every page has a serif h1 title and a one-line subtitle that explains what the page is for.
- [ ] A new empty workspace lands on **Home** with a four-step setup checklist (fill brain, add persona, generate a draft, make a decision); completing each step checks it off; the checklist hides once all four are done.
- [ ] Home attention cards update: drafts waiting for review, new signals, proposed brain updates, active campaign count — each links to the right page.
- [ ] Visual feel matches tavus.io: cream background (`#f7f4ef`), serif headings, coral accent (`#ff6183`) on primary actions, pill-shaped buttons, pastel chips on state labels.
- [ ] `npm run typecheck` and `npm test` pass.

**Gate:** someone who has never seen Tuezday can open the dashboard and describe what each section does without being told. You recognise the visual feel from the reference.

## Sprint 19 — Users, Teams & Auth

> Two browsers (or one browser + one incognito window) required.

- [ ] Register a new account (email + password) → log out → log back in.
- [ ] Pre-existing workspaces appear and open normally (the legacy claim silently makes you owner).
- [ ] Team page → invite a teammate's email → copy the invite link.
- [ ] In a second browser (incognito), register with that exact email → open the invite link → accept → the workspace appears; you are listed as a member.
- [ ] Teammate approves a pending draft → the decision log on that draft shows the teammate's name, not "founder".
- [ ] Edit a brain doc as each user → brain version history shows who wrote each version by name.
- [ ] A third account that was never invited visits the workspace URL → 403; the workspace never appears in their list.
- [ ] Worker continues polling normally with `TUEZDAY_WORKER_TOKEN` set.

**Gate:** every action in the decision log and brain history carries a real name; a non-member cannot see or touch the workspace.

## Sprint 20 — Native Ads Execution

> Prereqs: Sprint 14 Meta Ads connected; at least one approved Sprint 15 creative exists.

- [ ] Reconnect Meta Ads using an `ads_management` system-user token (a Page must be assigned to the system user).
- [ ] Ads settings → set a daily spend cap you're comfortable with (e.g. $10/day).
- [ ] Launch ads page → **New launch** → pick ad account + approved creative set, Traffic objective, Page ID + landing URL, small daily budget ($2), target countries → **Create** → launch appears as `draft`.
- [ ] **Submit** → `pending_review`; **Approve** (decision log records your name) → **Launch** → campaign appears in Ads Manager: correct name, PAUSED-then-ACTIVE history, correct budget and targeting; ad preview shows your approved copy.
- [ ] **Pause from Tuezday** → Ads Manager shows the campaign paused. **Resume** → it goes active again.
- [ ] Attempt a second launch whose daily budget would exceed the workspace cap → Tuezday blocks with a clear message before any API call is made.
- [ ] Flip the **kill switch** → the live campaign pauses immediately; launching or resuming anything is blocked until the switch is off.
- [ ] After the next sync (or **Sync now** on the Ads page) → spend from the launched campaign appears in the Sprint 14 report, attributed to the linked Tuezday campaign.

**Gate:** spend and control are fully bidirectional — you can start and stop real ad spend from inside Tuezday, every approval is logged with the approver's name, and the kill switch is instant.

## Sprint 30 — RAG Hardening for Scale

> Prereq: Docker + `npm run r2r:up` (R2R on :7272), as for Sprint 9. Have a workspace with a few signals and at least one published post (Sprint 17), plus 2–3 evidence documents already uploaded. `TUEZDAY_WORKER_TOKEN` in `.env` for the worker sweep.

**Slice A — Feed & isolate**

- [ ] `npm run r2r:up`; open Evidence → store healthy; existing documents still list, now tagged `Manual`.
- [ ] Resolve or generate a task → evidence still retrieves and cites correctly (boot backfill attached your old docs to the new per-workspace R2R collection).
- [ ] Run the worker (or `POST /workspaces/<id>/evidence/candidates/sweep`) → the Evidence page **Ingest candidates** section fills with your signals (`From signal`) and published posts (`From published`), each once.
- [ ] Sweep again → no duplicates appear.
- [ ] **Accept** a candidate → it moves into the Corpus tagged by origin and is retrievable; it leaves the queue.
- [ ] **Dismiss** a candidate → it leaves the queue and never returns on re-sweep.
- [ ] `npm run r2r:down`, try to accept a candidate → clear "store unavailable" message, candidate stays pending; `npm run r2r:up` → accept succeeds.

**Slice B — Sharpen & inspect**

- [ ] Sandbox → preview context for a task with evidence → expand sections → the Evidence section shows an **Evidence retrieval** panel: the query and each candidate chunk with sim / rec / src / final scores and Kept/Dropped.
- [ ] Have a fresh document and an older one on the same topic → the fresher / higher-origin-weight chunk ranks above the stale low-weight one.
- [ ] Two chunks from one long document → at most two appear; a near-duplicate paste is deduped.
- [ ] Set a small token budget in the sandbox → lower-ranked evidence chunks show **Dropped (budget)** while top chunks stay **Kept**; the brain docs (soul/icp/voice/now) are never dropped.
- [ ] Generate → "show prompt trace" → the same Evidence retrieval panel is reproduced from the stored generation.

**Gate:** the corpus grows from your own signals and posts under your control (nothing ingested without your accept), retrieval favours fresher and stronger sources, and you can always see exactly what was retrieved, how it scored, and what reached the prompt.

---

## Cross-cutting things worth re-checking occasionally

- [ ] `npm test` (321 tests) and `npm run typecheck` stay green.
- [ ] Every generation's prompt trace is readable *before* and *after* the LLM call (sandbox → "show prompt trace").
- [ ] Stopping any external service (R2R, Nango) degrades gracefully — the app never breaks, traces/banners say why.
- [ ] Gemini occasionally returns 503 "high demand" — a retry succeeds; it surfaces as a clean error, never a crash.
