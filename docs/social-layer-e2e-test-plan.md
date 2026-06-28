# Social Layer End-to-End Test Plan

> Draft date: 2026-06-27
>
> Scope: current `sprint-30-outbound-sequences` branch. This plan tests the social layer as a real founder/operator would use it, then expands into the broader platform trust checks that social depends on.

---

## 1. Why we are testing this

The social layer is where Tuezday stops being a smart drafting tool and starts touching the outside world. That means the test cannot only ask, "Did the button work?"

It needs to answer:

- Can a real user connect accounts, create campaign context, generate work, approve it, and ship it without guessing what happened?
- Does every automated action still respect the approval gate, kill switch, caps, platform constraints, and account state?
- When something fails, does Tuezday explain the failure plainly enough that the user can recover?
- Does the platform feel like one GTM system with memory, or like several disconnected tools sitting in the same sidebar?

The test should produce a clear founder-facing report: what works, what breaks, what is confusing, what is risky, and what should be fixed before broader testing.

---

## 2. Platform Areas Covered

### Primary social layer

- Social account connections: Reddit, LinkedIn, X, Instagram.
- Manual social publishing from approved drafts.
- Targeted launches to audiences and segments.
- LinkedIn and Instagram broadcast publishing.
- X per-recipient DMs.
- Email CSV export as the non-social outbound handoff.
- Cadence and calendar scheduling.
- Campaign automation modes: manual, human-in-the-loop, scheduled-auto.
- Automation guardrails: kill switch, per-connection caps, per-campaign caps.
- Engagement and reply inbox.
- AI-drafted, approval-gated replies.
- Auto-reply behavior.
- Multi-step outbound sequences for email and X DM.
- Stop-on-reply for X DMs and manual stop for email.

### Broader platform checks around social

- Auth, workspace access, and team identity.
- Brain docs, personas, campaign context, and resolver traces.
- Approval gate and decision history.
- Discovery signal intake.
- Evidence and context quality where available.
- Learning loop touchpoints.
- Event logs, publication receipts, and persistence after reload/restart.
- Failure handling when Nango, platform APIs, Gemini, R2R, or the worker are unavailable.

---

## 3. Test Mindset

Run this like an impatient founder preparing a real campaign.

Do not only click happy paths. Pause where a founder would pause:

- "Do I know what this will post and where?"
- "Can I tell which account this will use?"
- "Can I stop automation before it does something dumb?"
- "Did the draft use my brain, campaign, persona, and audience context?"
- "If this fails, do I know whether it is a Tuezday issue, an OAuth issue, a platform limit, or my own setup?"

Capture both product bugs and trust problems. A flow can technically pass and still be a poor user experience.

---

## 4. Success Criteria

The social layer passes this E2E round when:

- A new or returning user can complete a full flow from context setup to published social output.
- A targeted launch can generate, approve, and dispatch email, LinkedIn, Instagram, and X outputs with correct per-channel behavior.
- A cadence can schedule approved drafts and the calendar reflects what is going out.
- Campaign automation can generate drafts from discovery signals in the correct mode.
- Scheduled-auto can auto-approve and publish only inside guardrails.
- The inbox can pull a real reply, draft a reply, approve it, and post it back.
- A multi-step sequence can progress, stop one recipient, and stop an X recipient automatically after reply detection.
- Every generated or posted artifact has a traceable path back to brain, campaign, persona, audience, approval state, and platform receipt.
- Blocking failures are visible, recoverable, and do not corrupt state.

---

## 5. Prerequisites

### Local services

- Run `npm install` from a clean checkout if needed.
- Run `npm run dev` for API and web.
- In a second terminal, run `npm run start -w apps/worker` when testing scheduled posts, cadence fill, automation, inbox polling, or sequences.
- Confirm web loads at `http://localhost:3000`.
- Confirm API health at `http://localhost:3001/health`.
- Set `TUEZDAY_WORKER_TOKEN` in `.env`.
- Run Nango with `npm run nango:up`.
- Run R2R with `npm run r2r:up` if testing evidence retrieval.

### Required credentials

Use real test accounts. Do not use personal or production accounts unless explicitly intended.

- `GEMINI_API_KEY` for generation.
- `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` if testing Reddit.
- `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` if testing LinkedIn.
- `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET` if testing X.
- `INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET` for the Facebook app backing Instagram Graph API.
- Optional: `RESEND_API_KEY`, `MAIL_FROM`, and `APP_BASE_URL` for real invite/test emails.

### Platform caveats to check before blaming Tuezday

- Instagram publishing needs an Instagram Business or Creator account linked to a Facebook Page, with the required publishing permission.
- X DMs depend on app access, scopes, recipient DM settings, and rate limits.
- LinkedIn personal feed posting and comment APIs may need the right member social scopes.
- Reddit is the most practical end-to-end live platform for local testing.
- Email sending is not native. Tuezday exports CSV for Smartlead/Instantly-style sending.
- Email reply detection is not native yet. Email sequences stop by manual action.

---

## 6. Test Workspace Setup

Create or reuse a workspace named `tuezday`.

Minimum useful setup:

- Brain docs: fill `soul`, `icp`, `voice`, `history`, and `now` with enough real context that generated drafts can be judged.
- Personas: create at least two personas:
  - Founder / CEO voice.
  - Company page voice.
- Campaign: create one active campaign with objective, audience, channels, messaging pillars, and a now-overlay.
- Audience: create one static list or dynamic segment with 5 to 8 people.
- Leads:
  - At least 5 email-ready leads.
  - At least 3 leads with valid X handles.
  - At least 1 lead with no X handle.
  - At least 1 lead with a bad or closed X handle if testing error behavior.
- Discovery signal: add or paste at least one realistic signal that could produce a social response.
- Approved draft seed: create at least one approved draft under the campaign for cadence testing.

Recommended live test accounts:

- One social account connected to Tuezday for publishing.
- A second account on the same platform to comment or reply as an outside person.

---

## 7. Evidence To Capture

For each test step, record:

- Feature area.
- Exact user action.
- Expected result.
- Actual result.
- State after reload.
- External platform result, if any.
- Error copy or missing feedback.
- Severity: blocker, high, medium, low, polish.
- Screenshot or screen recording link when useful.
- API/log snippet only when it explains the issue better than the UI.

Use this simple status scale:

- Works: completes as expected with no meaningful confusion.
- Works with friction: completes, but the user has to guess, retry, or understand internals.
- Broken: expected action fails or state is wrong.
- Risky: could post, send, approve, or automate something the user did not clearly intend.
- Not testable: blocked by credentials, platform access, or missing setup.

---

## 8. Recommended Test Sequence

### Phase 0 - Smoke test the base platform

Goal: prove the local environment, auth, and workspace state are usable before testing social.

Steps:

1. Start Nango, web/API with `npm run dev`, and the worker with `npm run start -w apps/worker`.
2. Register or log in.
3. Open the workspace.
4. Confirm the sidebar navigation loads: Home, Brain, Discover, Create, Review, Campaigns, Calendar, Audience, Integrations, Team.
5. Confirm API health returns OK.
6. Reload the workspace and verify the same state appears.
7. Log out and log back in.

Pass criteria:

- No blank pages.
- Auth persists correctly.
- Workspace data remains after reload.
- Errors mention the right missing service when something is down.

Watch for:

- Broken local setup instructions.
- Login loops.
- 403s for valid workspace members.
- UI labels that expose internal words where the user needs plain language.

---

### Phase 1 - Brain, context, campaign, and approval trust

Goal: confirm social outputs will have the right source of truth.

Steps:

1. Fill or review all five brain docs.
2. Create or review the CEO and company page personas.
3. Create a campaign with at least LinkedIn, Instagram, X, and email as channels.
4. Open the context inspector and resolve a LinkedIn post with the campaign and CEO persona.
5. Resolve the same task with the company page persona.
6. Generate a draft in Create or Playground.
7. Send it to Review.
8. Edit it, approve it, reject a second draft, and inspect decision history.

Pass criteria:

- Context bundle changes when persona or campaign changes.
- Trace explains why each context section is included.
- Draft reaches Review in the correct state.
- Approval history shows submit, edit, approve, reject, actor, and timestamps.

Watch for:

- Generic output that ignores the brain.
- Hidden prompt behavior.
- Missing actor names.
- State transitions that allow editing approved content.

---

### Phase 2 - Social account connections

Goal: confirm accounts can connect, test, disconnect, and recover.

Steps:

1. Open Integrations.
2. With missing OAuth env vars, confirm each provider shows a clear setup hint.
3. Add credentials and restart API.
4. Connect Reddit, LinkedIn, X, and Instagram where credentials are available.
5. Complete OAuth popup.
6. Confirm each card shows connected.
7. Click Test on each connected card.
8. Disconnect one provider.
9. Reconnect it.
10. Open another browser session and confirm the same workspace sees the connection state.

Pass criteria:

- Providers only become connectable when credentials exist.
- OAuth popup completes without requiring copied tokens in the UI.
- Test result reflects platform identity or health.
- Disconnect/reconnect does not create confusing duplicates.
- Tokens and secrets are never shown in Tuezday.

Watch for:

- OAuth popup blocked or lost.
- Provider stuck in connected when test fails.
- Instagram account connected but unable to publish because the account type is wrong.
- Multiple connected accounts with no clear account picker later.

Persona routing extension:

1. Connect at least two accounts for the same social provider, preferably LinkedIn and Instagram.
2. Confirm Integrations shows separate account rows, statuses, test results, and a clear "Connect another account" action.
3. In Context Inspector, create CEO and Company Page personas.
4. Assign different LinkedIn and Instagram accounts as primary for each persona/channel.
5. Create a CEO LinkedIn cadence and confirm the account picker only shows CEO-assigned accounts once the persona is selected.
6. Create a Company Page launch with LinkedIn and Instagram and confirm readiness only turns on after those primary assignments exist.
7. Dispatch the launch and confirm final publication records use the Company Page connection IDs, not the CEO accounts.

Persona routing pass criteria:

- Multiple accounts for one provider do not overwrite each other.
- Every persona/channel has at most one visible primary account.
- Persona-scoped cadence and launch flows use assigned accounts and block missing primary accounts before platform calls.
- User-facing account labels are specific enough to tell accounts apart.

---

### Phase 3 - Manual social publishing from an approved draft

Goal: close the simple loop: brain-resolved draft to live social post.

Steps:

1. Create or choose an approved content draft.
2. Open Create or the Published panel.
3. Click Publish.
4. Pick a connected account.
5. For Reddit, choose `r/test` or another safe test target.
6. Post now.
7. Confirm the external post exists.
8. Confirm Tuezday shows published status, link, target, and receipt.
9. Schedule a second approved draft two minutes out.
10. Let the worker publish it.
11. Publish to a bad target and confirm failed status.
12. Retry after fixing the target.

Pass criteria:

- Only approved drafts are publishable.
- Platform constraints are checked before posting where possible.
- Scheduled posts move from scheduled to published.
- Failure keeps a receipt and supports retry.
- Duplicate live publication is blocked.

Watch for:

- No clear account/target confirmation before posting.
- Published externally but Tuezday remains scheduled.
- Tuezday says published but platform has no post.
- Retry creates duplicate posts.

---

### Phase 4 - Audience and targeted launch

Goal: test the first real campaign motion across audience, email, LinkedIn, Instagram, and X.

Steps:

1. Open Audience -> Lists & segments.
2. Create or confirm a segment/list with mixed leads and contacts.
3. Ensure some leads have X handles and some do not.
4. Open Audience -> Launches.
5. Create a launch with the audience, campaign, persona, and all available channels.
6. Generate.
7. Inspect the messages:
   - Email: one personalized message per recipient.
   - X: one DM per recipient with handle.
   - X missing handles: skipped with a reason.
   - LinkedIn: one broadcast post.
   - Instagram: one broadcast caption.
8. Approve selected messages inline or in Review.
9. Download email CSV.
10. Publish LinkedIn.
11. Publish Instagram with one image URL.
12. Publish Instagram with 2 to 3 image URLs for carousel if available.
13. Send X DMs.
14. Confirm per-recipient sent, failed, skipped states.

Pass criteria:

- Launch cannot run without an audience.
- Channels without connections are disabled or clearly blocked.
- Generated content is personalized only from known lead/contact data.
- Missing X handles are skipped before the LLM call.
- Instagram without media is refused.
- One bad X recipient does not fail the whole batch.
- Email CSV contains usable recipient columns and personalized body.

Watch for:

- Invented personalization.
- Contacts duplicated as both contact and lead.
- No way to see which messages are approved.
- Instagram media errors that do not tell the user what to change.
- X DM failures hidden at batch level.

---

### Phase 5 - Cadence and calendar

Goal: prove approved drafts can be slotted and published on a recurring schedule.

Steps:

1. Open Calendar -> Cadence.
2. Create a cadence tied to the campaign, channel, connected social account, target, days, time, and timezone.
3. Confirm queued approved draft count.
4. Click Fill now.
5. Open Calendar.
6. Confirm scheduled entries appear on the expected dates and times.
7. Confirm open slots appear where no approved draft is available.
8. Let one scheduled post become due.
9. Run worker or publish run.
10. Confirm the calendar entry flips to published and has a working link.
11. Pause the cadence and confirm no new slots fill.
12. Resume it and fill again.
13. Delete it and confirm scheduled future posts are canceled, while already-published history remains readable.

Pass criteria:

- Cadence only slots approved matching campaign/channel drafts.
- Calendar times match selected timezone.
- Publish worker uses the same publication receipt pipeline.
- Pause, resume, and delete behavior is predictable.

Watch for:

- Timezone drift.
- Slot duplication after repeated Fill now.
- Wrong campaign/channel drafts getting slotted.
- Deleted cadence leaving future posts queued.

---

### Phase 6 - Campaign automation modes

Goal: confirm campaign mode controls how discovery signals become social output.

Steps:

1. Open Campaigns.
2. Set campaign automation to Manual.
3. Add or accept a discovery signal.
4. Run automation now.
5. Confirm no automatic drafts are created.
6. Set campaign automation to Human-in-the-loop.
7. Add a new signal.
8. Run automation.
9. Confirm one pending-review draft per campaign channel.
10. Approve one draft and confirm cadence can slot it.
11. Set campaign automation to Scheduled-auto.
12. Add another new signal.
13. Run automation.
14. Confirm drafts are auto-approved with `system` in decision history.
15. Confirm cadence slots and publishes them.
16. Turn kill switch on.
17. Run automation and cadence.
18. Confirm no new auto-posts go out and pending auto-slots clear.
19. Lower per-campaign and per-connection daily caps.
20. Confirm auto-posting stops at the cap, while manual publishing still works.

Pass criteria:

- Manual mode is truly quiet.
- Human-in-the-loop waits at Review.
- Scheduled-auto uses a real approval transition by system.
- Kill switch is respected.
- Caps stop auto-posting without blocking manual action.

Watch for:

- Auto mode posting without a visible approval record.
- Kill switch allowing already-scheduled auto posts to go out unexpectedly.
- Caps applied to manual publishing.
- New signals fanning out too broadly without enough user warning.

---

### Phase 7 - Engagement and reply inbox

Goal: prove the inbound loop works after posting.

Steps:

1. Publish a post from Tuezday.
2. From a second platform account, comment or reply to that post.
3. Open Review -> Inbox.
4. Run inbox now.
5. Confirm the inbound item appears as unread with author, content, platform, and link to the original post.
6. Click Draft reply.
7. Confirm a reply draft appears inline and in Review as `engagement_reply`.
8. Approve and post the reply.
9. Confirm the reply appears on the platform.
10. Confirm inbox item flips to replied with a working reply link.
11. Mark another item read.
12. Dismiss another item.
13. After the 24h window, run inbox and confirm post metrics appear.
14. After the 7d window, confirm the 7d metric snapshot appears.

Pass criteria:

- Polling is idempotent.
- Reply drafts use brain, campaign, persona, and conversation context.
- Replies do not post before approval unless auto-reply is explicitly enabled.
- Posted reply cannot be posted twice.
- Read/dismiss/replied states persist after reload.
- Metrics attach to the publication.

Watch for:

- Inbound item linked to the wrong post.
- Replies drafted in the wrong channel voice.
- Auto-reply enabled by surprise.
- Metrics missing because platform APIs do not expose them.
- User cannot tell whether Run inbox now worked.

---

### Phase 8 - Auto-reply guardrails

Goal: make sure automatic replies are intentional and bounded.

Steps:

1. Set campaign to Scheduled-auto.
2. Ensure it owns the post receiving replies.
3. Keep Auto-reply off.
4. Run inbox after a new comment.
5. Confirm no auto reply is drafted or posted.
6. Turn Auto-reply on.
7. Add a new comment.
8. Run inbox.
9. Confirm reply is drafted, system-approved, and posted automatically.
10. Inspect decision history.
11. Turn kill switch on.
12. Add another comment and run inbox.
13. Confirm no auto reply posts.
14. Set per-connection cap low and confirm cap blocks auto-reply.
15. Manually draft, approve, and post a reply while auto guardrails are blocking, if intended by product rules.

Pass criteria:

- Auto-reply requires both workspace switch and scheduled-auto campaign.
- Kill switch blocks auto replies.
- Caps block auto replies.
- Manual reply remains possible when automation is stopped.

Watch for:

- Auto replies on manual or human-in-the-loop campaigns.
- Reply cap counting unclear or inconsistent with publication cap.
- No visible explanation when auto-reply is blocked.

---

### Phase 9 - Multi-step outbound sequences

Goal: test the current deepest social/outbound flow.

Steps:

1. Open an existing launch with email and X selected.
2. Define a 3-step email sequence:
   - Step 1: first touch.
   - Step 2: delay 24h, optional case-study angle.
   - Step 3: delay 24h, optional breakup angle.
3. Set launch mode to Fully automated.
4. Start sequence.
5. Confirm step 1 drafts are generated and approved.
6. Download/export email CSV.
7. Confirm export marks step 1 sent and starts the delay clock.
8. Advance time past step 2 delay or wait.
9. Run sequence.
10. Confirm step 2 generates and approves.
11. Export again.
12. Stop one email recipient manually by pasted email.
13. Confirm that recipient receives no later steps.
14. Let another recipient continue to step 3 and complete.
15. Define a 2-step X DM sequence.
16. Start it with stop-on-reply on.
17. Confirm DM 1 sends.
18. Reply from one recipient's X account.
19. Run inbox, then run sequence.
20. Confirm that recipient is marked replied and does not receive DM 2.
21. Confirm another non-replying recipient receives DM 2 on schedule.
22. Switch to Review each step.
23. Confirm due steps generate but wait in Review.
24. Switch to Manual.
25. Confirm worker does not auto-advance manual launches.

Pass criteria:

- Sequence launch refuses the old one-shot generate path when sequence steps exist.
- Each step is approval-gated.
- Scheduled-auto system-approves, it does not bypass Review history.
- Email progression waits for CSV export, because export is the send handoff.
- X stop-on-reply depends on real inbox item detection.
- Manual stop works for email.
- Kill switch and per-connection caps pause auto X DMs.

Watch for:

- Email steps advancing before CSV export.
- X replies not associated with the correct recipient.
- Duplicate DMs after retry.
- Step instructions ignored or repeated content across steps.
- Manual mode behaving like automated mode.

---

### Phase 10 - Cross-cutting failure and recovery pass

Goal: find trust breaks when dependencies fail.

Run these after at least one happy path works.

Tests:

1. Stop Nango. Open Integrations, Launches, Cadence, Inbox. Confirm the app explains connector/fabric failure.
2. Remove or break a social credential. Confirm provider becomes unconnectable or test fails clearly.
3. Use an expired/revoked connection. Confirm Test catches it and publishing blocks.
4. Remove `GEMINI_API_KEY` and attempt generation. Confirm clear error, no broken draft state.
5. Stop R2R and resolve/generate with evidence enabled. Confirm evidence is excluded with explanation.
6. Force a platform error:
   - bad subreddit,
   - invalid Instagram media URL,
   - bad X handle,
   - missing Instagram media,
   - rate-limit-like fake response if possible.
7. Reload after each failed action.
8. Restart the dev server and confirm stored state is still readable.
9. Try the same action as a non-member. Confirm 403 and no data exposure.
10. Invite a teammate, accept invite, approve a draft as the teammate, and inspect actor history.

Pass criteria:

- Failures do not leave invisible half-posted states.
- Receipts and errors survive reload.
- Recovery action is obvious.
- Access control holds.
- Actor identity is correct.

---

## 9. Feature Matrix

| Area | Happy Path | Challenge Path | Pass Signal |
|---|---|---|---|
| Integrations | OAuth connect, test, disconnect | Missing creds, expired token, reconnect | User knows account state and recovery path |
| Manual publishing | Approved draft posts now/scheduled | Bad target, duplicate, retry | Receipt matches external platform |
| Launches | Segment -> generate -> approve -> dispatch | Missing X handle, bad X handle, IG no media | Per-message status is accurate |
| Email CSV | Approved emails export | No approved rows, repeated export | CSV is usable and sent state is honest |
| Cadence | Approved drafts fill future slots | Pause, resume, delete, timezone | Calendar matches what will post |
| Automation | Signal -> draft per channel | Manual/HITL/auto modes, caps | Mode behavior is predictable |
| Kill switch | Stops auto-posting | Pending auto slots already exist | Auto output stops, manual still works |
| Inbox | New comment appears | Duplicate poll, wrong link, dismiss | Item threads to correct post |
| Reply drafting | Draft -> approve -> post | Post before approval, duplicate post | Gate and platform state agree |
| Auto-reply | Auto only when enabled | Kill switch/cap/manual campaign | No surprise replies |
| Sequences | Step chain advances | Stop one recipient, reply stop, retries | Recipient state explains next action |
| Auth/team | Teammate actions attributed | Non-member access | History names the real actor |

---

## 10. Current Constraints To Call Out In The Report

These are not automatically bugs, but they matter when judging the experience:

- Reddit is the easiest platform to test end to end locally.
- LinkedIn, X, and Instagram depend heavily on live app permissions and platform review.
- Instagram media is supplied by the user. Tuezday does not generate creative assets yet.
- Email sending is CSV export only. Tuezday does not control deliverability.
- Email reply detection is manual for now.
- Discovery-to-campaign automation currently fans out by explicit campaign mode, not smart relevance mapping.
- Engagement metrics are captured at 24h and 7d snapshots, not continuously.
- Some worker-driven actions happen on ticks, so "instant" may mean "next worker run" unless using Run now.
- Large segment generation is synchronous and may feel slow.

These should appear in the final QA report so product decisions are not confused with broken behavior.

---

## 11. UX Questions To Answer While Testing

Ask these after each major flow:

- Did I know what Tuezday was about to do before it touched the external platform?
- Did the UI show the exact account, channel, campaign, target, and audience?
- Did the button label match the consequence of the action?
- Could I inspect the generated context before trusting the output?
- Could I recover from an error without opening logs?
- Was automation clearly off, waiting for review, or allowed to run?
- Did I understand why a recipient was skipped, stopped, failed, or completed?
- Did the platform use founder-friendly language, or did it leak implementation details?

---

## 12. Suggested Multi-Day Run

### Day 0 - Setup and credentials

- Confirm local environment.
- Connect available social accounts.
- Create workspace, brain, personas, campaign, audience, test leads.
- Produce one approved draft.

### Day 1 - Manual social and launch flows

- Test manual publishing.
- Test targeted launch generation and dispatch.
- Capture all platform-specific failures.

### Day 2 - Scheduling and automation

- Test cadence and calendar.
- Test automation modes.
- Test kill switch and caps.

### Day 3 - Inbox and replies

- Create live replies from a second account.
- Run inbox.
- Draft, approve, and post replies.
- Test auto-reply guardrails.

### Day 4 - Sequences and regression

- Test email sequence.
- Test X DM sequence with stop-on-reply.
- Re-run high-risk failure cases.
- Summarize blockers and product friction.

---

## 13. Final QA Report Template

Use this structure after the run.

### Executive summary

- Overall status: Ready / usable with fixes / blocked.
- Biggest thing that worked.
- Biggest blocker.
- Biggest trust concern.

### Flow results

| Flow | Status | Notes |
|---|---|---|
| Account connection |  |  |
| Manual publish |  |  |
| Targeted launch |  |  |
| Cadence/calendar |  |  |
| Automation modes |  |  |
| Inbox/replies |  |  |
| Auto-reply |  |  |
| Multi-step sequences |  |  |
| Auth/team/history |  |  |

### Blockers

For each blocker:

- Title.
- Repro steps.
- Expected.
- Actual.
- Impact.
- Suggested fix or product decision.

### UX friction

For each friction point:

- Where it happened.
- Why it slowed or confused the user.
- Whether copy, layout, state, or flow caused it.
- Suggested improvement.

### Working well

List things that felt solid. Especially note:

- Clear recovery states.
- Good traceability.
- Useful defaults.
- Strong guardrail behavior.
- Output quality that actually reflected the brain.

### Risk register

| Risk | Severity | Owner | Recommendation |
|---|---|---|---|
|  |  |  |  |

### Recommended next fixes

Rank fixes in this order:

1. Prevent wrong external actions.
2. Fix broken core paths.
3. Improve recovery from external failures.
4. Reduce user confusion in high-frequency flows.
5. Polish lower-risk copy and layout.

---

## 14. Final Acceptance Gate

Do not call the social layer founder-ready until these five runs pass:

1. Brain -> approved draft -> manual social publish -> external receipt.
2. Segment -> launch -> approve -> email CSV + LinkedIn/Instagram publish + X DM statuses.
3. Approved draft -> cadence -> calendar -> scheduled publish -> receipt.
4. Published post -> inbound reply -> AI draft -> approve -> posted reply.
5. Multi-step launch -> step 1 sent -> follow-up generated -> one recipient stopped -> one X recipient stopped by reply.

If any of these fail, the report should name the exact failure and whether it is a code bug, platform credential issue, product decision, or local setup issue.
