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
> For Sprint 25 tests: LinkedIn / X / Instagram OAuth apps; their `*_CLIENT_ID` / `*_CLIENT_SECRET` in `.env`; `npm run nango:up`.
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

## Sprint 25 — Connect LinkedIn / X / Instagram

> Prereqs (one-time per platform, all using the Nango callback `http://localhost:3050/oauth/callback`):
> - **LinkedIn** app at linkedin.com/developers/apps with "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn"; set `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
> - **X** OAuth 2.0 app at developer.x.com with tweet/users/dm scopes; set `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` (the OAuth 2.0 client id/secret, not the API key/secret).
> - **Instagram** — a **Facebook** app at developers.facebook.com with the Instagram Graph API; publishing needs an Instagram **Business/Creator** account linked to a Facebook Page + `instagram_content_publish` via App Review; set `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` (the Facebook app id/secret).
> Restart the API after editing `.env`.

- [ ] `npm run nango:up`; Integrations page → LinkedIn / X / Instagram each show **Connect** (not "needs OAuth app") once their `.env` creds are set; with creds missing they show the per-platform setup hint instead.
- [ ] **Connect LinkedIn** → OAuth popup → authorize → card shows `connected`; **Test** passes (`/v2/userinfo` identity through the proxy).
- [ ] **Connect X** → OAuth popup → authorize → `connected`; **Test** passes (`/2/users/me`).
- [ ] **Connect Instagram** → Facebook OAuth popup → authorize → `connected`; **Test** passes (`/v23.0/me`). (If `instagram_content_publish` isn't approved yet, identity still verifies — publishing is gated until Sprint 26.)
- [ ] **Disconnect** one platform → **Reconnect** via the popup → it returns to `connected` (same row revived).
- [ ] **Reddit** still shows as parked / "needs OAuth app" (its key hasn't been issued) — confirm it wasn't removed.
- [ ] No posting/DM controls appear yet — that's Sprint 26.

**Gate:** all three social accounts reach a verified `connected` state through the OAuth popup, with the scopes needed for Sprint 26's posts and X DMs already granted — no reconnect required later.

---

## Sprint 21 — Runtime-editable channel/platform guidance

> Spec: `docs/specs/sprint-21-runtime-editable-guidance.md` (on the
> `sprint-21-runtime-editable-guidance` branch). Channel guidance defaults moved out of code
> into `packages/contracts`; per-workspace, per-channel overrides live in the DB and are read at
> resolve time. Editor lives on the **Brain** page.

- [ ] Brain page → **Channel guidance** → each of the six channels (LinkedIn, X, Email, Paid ads, Website, PR) shows its current text with a **Default** badge.
- [ ] Edit **LinkedIn** guidance (e.g. add "Always open with a contrarian one-liner.") → **Save** → the badge flips to **Workspace override**; no redeploy happened.
- [ ] Sandbox/Content → generate a **LinkedIn post** → the output reflects the edited guidance.
- [ ] Show the prompt trace for that generation → the **Channel: linkedin** section shows the edited text and its reason reads **"workspace override."** Generate for a different channel → its reason still reads **"built-in default."**
- [ ] **Reset to default** on LinkedIn → the badge returns to **Default**; the next generation uses the original guidance again.
- [ ] `npm run typecheck` and `npm test` pass.

**Gate:** channel guidance is editable per workspace with zero redeploy, and the resolved-context trace always tells you whether the model saw the built-in default or your workspace override.

---

## Sprint 22 — Generation quality: angle-first + dual-LLM pre-review

> Spec: `docs/specs/sprint-22-generation-quality.md` (on the `sprint-22-generation-quality` branch).
> Prereq: a working `GEMINI_API_KEY` — review adds ~2 gateway calls per generation. New-workspace
> defaults: **review ON, angle step OFF**, both per-workspace toggleable; flag threshold default 70.

- [ ] Sandbox → the **quality settings** card shows review **on** and the angle step **off** by default; turn the angle step on and set an angle count.
- [ ] **Suggest angles** → several distinct angles appear → pick one → generate a **LinkedIn post**.
- [ ] The generation shows a **brand-voice score** and a **channel-fit score** (0–100 each), each with specific issues.
- [ ] A draft that scores below the flag threshold shows a **"flagged"** badge *before* it reaches Review.
- [ ] Send it to **Review** → the same scores/issues appear on the draft, with a **Re-run review** button → Re-run re-checks the draft's *current* content.
- [ ] Approve / edit / reject still work exactly as before — flags are **advisory only and never block approval** (your override always wins).
- [ ] Confirm automated review also runs on an **outbound email**, a **PR pitch**, and a **signal-response** draft — but **not** on ad creatives.
- [ ] Turn **review off** in settings → a fresh generation carries no scores. Turn the **angle step off** → generation goes straight to a draft.
- [ ] Show the prompt trace → the angle and reviewer prompts are brain-resolved (soul/voice for brand, channel guidance for fit), not hardcoded; every extra call is traced.
- [ ] `npm run typecheck` and `npm test` pass.

**Gate:** weak drafts are scored and flagged before you spend attention on them, every reviewer/angle prompt is resolved through the brain and visible in the trace, and a flag never blocks your decision.

---

## Sprint 23 — CRM contact management: discard + filtered sync

> Spec: `docs/specs/sprint-23-crm-discard-filtered-sync.md` (on the
> `sprint-23-crm-discard-filtered-sync` branch). Both controls are **local working state** — the CRM
> stays the system of record; nothing here writes to or deletes from Freshsales.
> Prereq: Freshsales connected (see Sprint 13) and at least one Sync done.

- [ ] CRM page → **Sync** (Freshsales) → contacts appear.
- [ ] **Discard** two contacts → they leave the list and appear under **Discarded**.
- [ ] **Sync** again → the discarded two **do not** come back; everything else refreshes.
- [ ] **Restore** one → it returns to the contacts list; the next sync refreshes it.
- [ ] Set a **Sync filter**: choose a specific Freshsales view (and/or an "updated since" date) → **Save** → **Sync** → only matching contacts come in; the synced count reflects the smaller set.
- [ ] Confirm nothing changed in Freshsales itself (no contact deleted there); a lead you imported from a now-discarded contact still exists on the Outbound/Leads page.
- [ ] `npm run typecheck` and `npm test` pass.

**Gate:** you control which CRM contacts live in Tuezday — a discard stays gone across re-syncs, a filter scopes what comes in, and the CRM remains the system of record with nothing deleted on its side.

---

## Sprint 24 — Lead lists & segments

> Spec: `docs/specs/sprint-24-lead-lists-segments.md` (on the
> `sprint-24-lead-lists-segments` branch). Find it under **Audience → Lists &
> segments** in the sidebar.
> Prep: have a handful of leads in the workspace (Outbound page → import or add a
> few, ideally with varied `role`/`company`). A couple of synced CRM contacts
> (CRM page) make the unified leads+contacts behaviour visible but are optional.

- [ ] Lists & segments page → **New audience** → **Static list**, name it, create
      it → open its card → the people picker lists your leads **and** any CRM
      contacts not yet imported as a lead; tick a few → **Add** → they appear as
      members with a lead/contact badge; **remove** one and it leaves.
- [ ] A CRM contact you already imported as a lead shows **once** (as the lead),
      never twice, in the picker and in segments.
- [ ] **New audience → Dynamic segment** "VPs at fintech": rule = `role` *contains*
      `VP` **AND** a nested **ANY of (OR)** group [`company` *contains* `fintech`
      **OR** `email domain` *contains* `fintech`] → save → its members resolve
      live to exactly the people who match; the count matches.
- [ ] Edit the segment (broaden the rule, e.g. drop the fintech group) → reopen →
      membership has changed with no other action — it is computed live.
- [ ] Adding members by hand to a **dynamic** segment is not offered (segments are
      rule-driven); a static list offers no rule builder.
- [ ] Open a member's card → **Attach to campaign** → pick an active campaign →
      confirmation. Go to **Campaigns**, expand that campaign → an **Audiences**
      line lists the attached list/segment with its kind and member count.
- [ ] Attach a second audience to the same campaign → both show; detach is
      reflected on the campaign. (Sending to an audience arrives in Sprint 25.)
- [ ] Delete a lead that sits in a static list → it disappears from the list’s
      members.
- [ ] `npm run typecheck` and `npm test` pass.

**Gate:** you can carve your leads/contacts into a reusable list and a live
"VPs at fintech" segment, see exactly who is in each, and point a campaign at
them — the targeting primitive Sprint 26 sends through.

---

## Sprint 26 — Targeted campaign launch at a segment

> Branch `sprint-26-targeted-launch` (built on Sprint 24 + Sprint 25; merge order
> 24 → 25 → 26). Prereqs: LinkedIn / X / Instagram connected (Sprint 25) with
> their creds in `.env`; a segment/list with a few leads, some carrying an X
> handle. Instagram needs an IG **Business/Creator** account linked to a Page,
> via the Facebook app (`INSTAGRAM_CLIENT_ID/SECRET`), with `instagram_content_publish`.

- [ ] **Set X handles:** Audience → a lead → **+ X handle** (or edit) → save → the
      handle shows on the lead (the leading `@` is stripped). CSV import with an
      `x`/`twitter` column also fills it.
- [ ] **Create a launch:** Audience → **Launches** → **New launch** → name it, pick
      the segment, optionally a campaign + persona, tick **Email, LinkedIn,
      Instagram, X** (a channel whose account isn't connected is disabled with a
      hint) → Create.
- [ ] **Generate:** open the launch → **Generate** → it goes to `ready` showing:
      one **personalized email** + one **personalized X DM** per recipient (leads
      without a handle, and all contacts, show **skipped — no X handle**), plus one
      **LinkedIn** and one **Instagram** broadcast draft. Every draft is
      `pending_review`.
- [ ] **Review/approve:** approve the drafts (inline **approve**, or in Review).
- [ ] **Email:** Download CSV → open it → one row per approved recipient with the
      personalized body in `personalized_message` (ready for Smartlead/Instantly);
      those messages flip to `sent`.
- [ ] **LinkedIn:** **Publish** → the broadcast appears on the connected LinkedIn
      feed; the **view** link resolves; it also appears under Publications.
- [ ] **Instagram:** paste an image URL (try 2–3 for a carousel, a `.mp4` for a
      reel) → **Publish** → the post appears on the IG Business account. Publishing
      with no media is refused (`media_required`).
- [ ] **X:** **Send DMs** → recipients with a valid handle receive the DM; a
      bad/closed handle shows a clear per-recipient error without aborting the
      rest; skipped recipients are untouched.
- [ ] No social account connected for a channel → dispatch returns a clear
      "connect it first"; a channel the launch didn't select can't be dispatched.
- [ ] `npm run typecheck` and `npm test` pass.

**Gate:** you can point a launch at a segment and, in one place, ship a
per-person email + X DM and a LinkedIn + Instagram broadcast — each written in
your voice and cleared through Review — without leaving Tuezday.

## Sprint 27 — Recurring cadence, calendar + transactional mailer

> Branch `sprint-27-cadence-calendar-mailer` (off `main`). With Reddit connected (Sprint 17) and a
> campaign that has a few **approved** drafts. LinkedIn/X/Instagram cadences light up the same way once
> those adapters merge.

- [ ] **Cadence → New cadence:** name it, pick the campaign + channel, pick the connected Reddit account, target `test` (an `r/test`-style subreddit), check **Mon/Wed/Fri**, time `09:00`, your timezone → **Create** → it lists with the matching approved-draft count and the next slot time.
- [ ] **Fill now** → the matching approved drafts auto-slot. **Calendar** shows them on the right days/times as `scheduled`, with the remaining open slots marked `open`.
- [ ] Wait for (or force, via the worker / a near-future time) a slot to come due → the post publishes to Reddit; the calendar entry flips to `published` with a working link (the same receipt the Content page already shows).
- [ ] **Pause** the cadence → no new slots fill; **Resume** → filling continues. **Delete** a cadence → its still-scheduled posts are canceled (nothing unexpected goes out).
- [ ] **Team → Send a test email** to yourself → it arrives (or, without a `RESEND_API_KEY`, logs to the API console and reports as delivered).
- [ ] **Invite a teammate** → they receive the invite link by email (or it logs to the console); the copyable link still works as a backup.

**Gate:** approved content schedules itself onto a calendar and publishes on a recurring cadence with no manual publish step, and transactional email (invites + a test send) goes out through the mailer.

---

## Cross-cutting things worth re-checking occasionally

- [ ] `npm test` (537 tests) and `npm run typecheck` stay green.
- [ ] Every generation's prompt trace is readable *before* and *after* the LLM call (sandbox → "show prompt trace").
- [ ] Stopping any external service (R2R, Nango) degrades gracefully — the app never breaks, traces/banners say why.
- [ ] Gemini occasionally returns 503 "high demand" — a retry succeeds; it surfaces as a clean error, never a crash.
