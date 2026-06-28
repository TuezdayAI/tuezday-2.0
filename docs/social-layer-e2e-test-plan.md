# Overall Platform End-to-End Test Plan - Social Focus

> Draft date: 2026-06-27
>
> Scope: current workspace after the newer merged/implemented surfaces. This plan tests the full Tuezday platform end to end, with the social layer as the main stress test because it is where drafts, approvals, integrations, scheduling, automation, inbox, and external platform state all meet.

---

## 1. Why we are testing this

Tuezday now has enough connected surface area that a feature-by-feature click test will miss the real risk.

The product needs to be tested as one GTM system: workspace setup, onboarding, brain, context, generation, approvals, evidence, discovery, campaigns, CRM, ads, PR, outbound, social publishing, automation, replies, insights, billing, and team access. The social layer remains the deepest path because it is where Tuezday stops being a smart drafting tool and starts touching the outside world.

That means the test cannot only ask, "Did the button work?"

It needs to answer:

- Can a real user connect accounts, create campaign context, generate work, approve it, and ship it without guessing what happened?
- Does every automated action still respect the approval gate, kill switch, caps, platform constraints, and account state?
- When something fails, does Tuezday explain the failure plainly enough that the user can recover?
- Does the platform feel like one GTM system with memory, or like several disconnected tools sitting in the same sidebar?
- Do the new global surfaces - onboarding, guidance, generation settings, insights, analytics, Google login, and billing - behave like part of the same system?

The test should produce a clear founder-facing report: what works, what breaks, what is confusing, what is risky, what is not testable because of external credentials, and what should be fixed before broader testing.

---

## 2. Platform Areas Covered

### Full platform baseline

- Email/password auth and Google sign-in.
- Workspace creation, membership, invites, owner/member permissions, and actor attribution.
- New onboarding checklist and brain templates.
- Dashboard v2 navigation, capability-gated nav, home attention cards, and upgrade modal behavior.
- Billing, plans, usage, entitlement limits, Stripe checkout, and Stripe webhook handling.
- Product analytics: PostHog/no-op behavior, opt-out, and non-blocking event capture.

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

- Brain docs, personas, campaign context, and resolver traces.
- Runtime-editable channel guidance.
- Generation quality settings: angle step, pre-review, score threshold, and review traces.
- Approval gate and decision history.
- Discovery signal intake.
- Evidence library, evidence candidates, RAG collection health, retrieval policy, citations, and graceful R2R degradation.
- Learning loop touchpoints.
- Outbound, CRM, ads reporting, ad creative generation, native ad launch, and PR/media outreach.
- Native insights: workspace insights, campaign insights, channel rollups, and CSV export.
- Event logs, publication receipts, and persistence after reload/restart.
- Failure handling when Nango, platform APIs, Gemini, R2R, or the worker are unavailable.

### Planned or not part of this run

- Notifications/mobile approvals and MCP/public API have specs, but no corresponding app/API surfaces were visible in this workspace scan. Treat them as planned unless code is present in the run branch.

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

The platform passes this E2E round when:

- A new user can register or sign in with Google, create/open a workspace, understand the home screen, and complete the onboarding checklist without reading engineering docs.
- Brain docs, templates, personas, channel guidance, generation settings, evidence, campaigns, and resolver traces all visibly shape output.
- The approval gate works across every module, not just social.
- The user can move through content, outbound, PR, CRM, ads, insights, and billing without losing workspace context or actor attribution.
- A new or returning user can complete a full flow from context setup to published social output.
- A targeted launch can generate, approve, and dispatch email, LinkedIn, Instagram, and X outputs with correct per-channel behavior.
- A cadence can schedule approved drafts and the calendar reflects what is going out.
- Campaign automation can generate drafts from discovery signals in the correct mode.
- Scheduled-auto can auto-approve and publish only inside guardrails.
- The inbox can pull a real reply, draft a reply, approve it, and post it back.
- A multi-step sequence can progress, stop one recipient, and stop an X recipient automatically after reply detection.
- Every generated, approved, sent, published, or reported artifact has a traceable path back to brain, campaign, persona, audience, evidence, approval state, platform receipt, and actor.
- Insights and billing reflect real workspace state, not stale or fake numbers.
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
- Google OAuth credentials if testing "Continue with Google": `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.
- `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` if testing Reddit.
- `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` if testing LinkedIn.
- `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET` if testing X.
- `INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET` for the Facebook app backing Instagram Graph API.
- Optional: `RESEND_API_KEY`, `MAIL_FROM`, and `APP_BASE_URL` for real invite/test emails.
- Optional: PostHog keys if testing real product analytics delivery. With keys absent, analytics should be a no-op and must not break the product.
- Optional: Stripe keys, price IDs, and webhook signing secret if testing live billing checkout/webhooks. Without them, billing should still show plan/usage and checkout should fail clearly.

### Platform caveats to check before blaming Tuezday

- Instagram publishing needs an Instagram Business or Creator account linked to a Facebook Page, with the required publishing permission.
- X DMs depend on app access, scopes, recipient DM settings, and rate limits.
- LinkedIn personal feed posting and comment APIs may need the right member social scopes.
- Reddit is the most practical end-to-end live platform for local testing.
- Email sending is not native. Tuezday exports CSV for Smartlead/Instantly-style sending.
- Email reply detection is not native yet. Email sequences stop by manual action.
- Billing enforcement may be disabled by env. The test should record whether limits are actually enforced in the current run.
- Analytics is best-effort by design. A dead analytics endpoint must never block auth, generation, approval, publish, or connect flows.

---

## 6. Test Workspace Setup

Create or reuse a workspace named `tuezday`.

Minimum useful setup:

- User accounts: one owner account, one invited teammate account, and one outsider/non-member account.
- Auth paths: one email/password account and one Google-login account if Google OAuth is configured.
- Brain docs: fill `soul`, `icp`, `voice`, `history`, and `now` with enough real context that generated drafts can be judged.
- Brain templates: leave at least one new/empty workspace available to test template application and onboarding.
- Channel guidance: prepare one obvious LinkedIn or email override so you can see whether generation changes after saving it.
- Generation settings: plan one run with automated review on, one with angle step on, and one with both off.
- Evidence: upload at least two manual evidence docs; create or publish at least one item that can become an evidence candidate.
- Personas: create at least two personas:
  - Founder / CEO voice.
  - Company page voice.
- Campaign: create one active campaign with objective, audience, channels, messaging pillars, and a now-overlay.
- CRM: have a Freshsales or demo connector path ready if CRM read/write is in scope for the run.
- Ads: have a Meta Ads read-only connection or CSV metrics ready if ads reporting is in scope.
- PR: prepare 3 to 5 media contacts in CSV form.
- Audience: create one static list or dynamic segment with 5 to 8 people.
- Leads:
  - At least 5 email-ready leads.
  - At least 3 leads with valid X handles.
  - At least 1 lead with no X handle.
  - At least 1 lead with a bad or closed X handle if testing error behavior.
- Discovery signal: add or paste at least one realistic signal that could produce a social response.
- Approved draft seed: create at least one approved draft under the campaign for cadence testing.
- Billing: know the expected starting plan, whether `BILLING_ENFORCED` is active, and whether Stripe checkout is configured.
- Insights: seed at least some real activity - draft decisions, publications, launch messages, ad metrics, and engagement metrics - so insights has something to aggregate.

Recommended live test accounts:

- One social account connected to Tuezday for publishing.
- A second account on the same platform to comment or reply as an outside person.
- One payment-test path, if Stripe is configured.
- One PostHog project or a no-key/no-op analytics run, depending on what you want to verify.

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

Run the whole platform first, then spend the most time on social. The existing social phases below are intentionally detailed because they are the hardest to trust: they touch external accounts, approvals, automation, schedules, replies, and reporting.

Recommended order:

1. Environment, auth, navigation, capabilities, and workspace access.
2. Onboarding, brain templates, team identity, and Google auth.
3. Brain, channel guidance, generation quality settings, evidence/RAG, and resolver traces.
4. Core generation, approval, learning, and analytics.
5. Discovery, campaigns, audiences, CRM, outbound, PR, ads, and insights.
6. Billing, entitlements, upgrade modal, and Stripe webhooks.
7. Social connections, publishing, launches, cadence, automation, inbox, auto-replies, and sequences.
8. Cross-cutting failure/recovery.

### Phase A - New platform-wide surfaces

Goal: include the newer implemented features that sit outside the social layer but affect the whole product.

Steps:

1. Create a fresh workspace and confirm Home shows the onboarding checklist.
2. Apply a brain template to an empty brain doc.
3. Complete enough onboarding actions for checklist progress to update, then dismiss onboarding and reload.
4. Invite a teammate; accept the invite in another browser; confirm the teammate appears in Team.
5. If Google OAuth is configured, test Continue with Google for:
   - a new verified Google email,
   - an existing email/password account with the same verified Google email,
   - an unverified Google email or misconfigured OAuth app.
6. Confirm the sidebar shows capability-allowed nav items, including Insights and Billing when available.
7. Open Billing and confirm plan, usage, and entitlements.
8. Trigger one entitlement limit if possible: connector limit, generation limit, or seat limit.
9. Confirm `upgrade_required` opens the upgrade modal and routes to Billing.
10. If Stripe is configured, complete a test checkout and verify the webhook updates the plan; send one bad-signature webhook and confirm it is rejected.
11. If PostHog is configured, confirm events fire for register, generate, approve, publish, and connect. Then toggle analytics opt-out and confirm events stop.
12. With PostHog keys missing or endpoint unreachable, confirm auth/generation/approval/publish/connect still work.

Pass criteria:

- Onboarding progress is tied to real workspace actions.
- Brain templates create editable saved content.
- Team/member access and actor attribution are correct.
- Google auth links by verified email and rejects unsafe identities.
- Billing shows accurate plan/usage and gates only the intended actions.
- Analytics is best-effort, opt-out aware, and never blocks product actions.

Watch for:

- Capability-gated navigation hiding live features or showing dead ones.
- Checkout redirect pointing to the wrong billing URL.
- Upgrade modal without enough context.
- Analytics sending draft content or other sensitive text.
- Member users reaching owner-only billing actions.

---

### Phase B - Brain, guidance, generation quality, evidence, and resolver trust

Goal: prove that every downstream module is working from the same memory and quality settings.

Steps:

1. Fill all five brain docs, edit them twice, restore an older version, and export the brain.
2. Create CEO and company page personas.
3. Edit LinkedIn channel guidance with an obvious instruction.
4. Resolve/generate a LinkedIn task and confirm the trace uses the workspace guidance override.
5. Reset guidance and confirm the trace returns to the default source.
6. In Playground, turn automated pre-review on and generate; confirm brand/channel scores and issues appear.
7. Turn angle step on, suggest angles, choose one, and generate from it.
8. Turn both settings off and confirm new generations carry no angle or review output.
9. Upload manual evidence documents.
10. Sweep evidence candidates after signals or published posts exist.
11. Accept one candidate into the corpus and dismiss another.
12. Resolve with evidence enabled and confirm query, ranked chunks, citations, and trace reasons.
13. Stop R2R and confirm evidence is excluded with a clear reason while generation still works.

Pass criteria:

- Guidance source is visible as Default or Workspace override.
- Generation settings affect the next generation without deploys.
- Automated review is advisory and does not block approval.
- Evidence candidates are founder-gated.
- RAG failure degrades clearly instead of breaking the task.

Watch for:

- Hidden prompt changes.
- Evidence being ingested without acceptance.
- Generic output after strong brain/guidance changes.
- Review flags that prevent founder override.

---

### Phase C - Core GTM modules outside social

Goal: test the rest of the platform so the social run has real context and data.

Steps:

1. Add discovery sources and run discovery.
2. Accept a discovered or pasted signal into a draft.
3. Create a campaign with channels, objective, pillars, persona, audience, and automation mode.
4. Create one static list and one dynamic segment.
5. Import leads and draft outbound emails; approve/reject a few; export approved CSV.
6. If CRM is configured, sync contacts, discard some, set a filter, import one as a lead, and log an approved draft back to CRM.
7. Import PR contacts, draft pitches, generate a press kit, approve one, and export/open email client.
8. If ads reporting is configured, sync/import ad metrics and compare against the source platform or CSV.
9. Generate Meta and Google RSA ad creative variants; test character limits; approve and export.
10. If Meta ads execution is configured, test ad launch approval, budget cap, pause/resume, and kill switch.
11. Open Insights and Campaign insights.
12. Export workspace and campaign insights CSV.

Pass criteria:

- Signals can become drafts.
- Campaign context changes output.
- Audiences are usable by launches and campaigns.
- CRM, ads, and PR flows preserve their source-of-truth boundaries.
- Insights reflect actual drafts, approvals, publications, launch messages, ads, brain completeness, and channel activity.

Watch for:

- CRM contacts duplicated as leads.
- Ads spend controls bypassing approval.
- Insights showing stale or fake-looking numbers.
- CSV exports that are not usable without manual cleanup.

---

### Phase D - Social-heavy smoke and workspace readiness

Goal: prove the local environment, auth, nav, and workspace state are usable before the social-heavy pass.

Steps:

1. Start Nango, web/API with `npm run dev`, and the worker with `npm run start -w apps/worker`.
2. Register or log in.
3. Open the workspace.
4. Confirm the sidebar navigation loads the expected capability-allowed items: Home, Insights, Brain, Discover, Create, Review, Campaigns, Calendar, Audience, Integrations, Team, Billing.
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
- Live implemented pages hidden by a stale capability response.

---

### Phase E - Brain, context, campaign, and approval trust

Goal: confirm social and non-social outputs have the right source of truth.

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

### Phase F - Social account connections

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

### Phase G - Manual social publishing from an approved draft

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

### Phase H - Audience and targeted launch

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

### Phase I - Cadence and calendar

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

### Phase J - Campaign automation modes

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

### Phase K - Engagement and reply inbox

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

### Phase L - Auto-reply guardrails

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

### Phase M - Multi-step outbound sequences

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

### Phase N - Cross-cutting failure and recovery pass

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
| Auth | Email/password and Google sign-in work | Unverified Google email, misconfigured OAuth, logout/login | User lands in correct workspace with no duplicate account |
| Onboarding | Checklist progresses and templates apply | Dismiss/reload, empty workspace, teammate account | First-run guidance reflects real state |
| Team/access | Invite and teammate acceptance | Non-member access, member vs owner billing | Actions are attributed and scoped correctly |
| Brain | Edit, version, restore, export | Empty docs, conflicting edits | Brain is inspectable and durable |
| Guidance | Override/reset channel guidance | Invalid channel, empty guidance | Resolver trace shows source and content |
| Generation quality | Angle step and pre-review affect drafts | Settings off, low score, gateway failure | Quality tools are visible, advisory, and non-blocking |
| Evidence/RAG | Upload, retrieve, candidate accept | R2R down, candidate dismiss, delete doc | Evidence helps when available and degrades clearly |
| Discovery | Sources run and signals become drafts | Source error, low-quality source, duplicate signal | Signals are scored, explainable, and actionable |
| Campaigns | Campaign context shapes output | Archive/unarchive, wrong persona/channel | Campaign is visible in draft and insights context |
| Audiences | Lists/segments target leads/contacts | Dedupe, deleted leads, dynamic rule edits | Audience membership is accurate |
| Outbound | Leads -> drafts -> approvals -> CSV | Missing fields, invented personalization | CSV is usable and honest |
| CRM | Sync, discard, filter, log back | Re-sync discarded contacts, CRM unavailable | CRM stays source of record |
| PR | Contacts -> pitches -> press kit -> export | Duplicate CSV rows, reactive signal pitch | Pitches reference real contact/story context |
| Ads reporting | Sync/import metrics and link campaign | Meta unavailable, CSV mismatch | Numbers match source for closed period |
| Ad creatives | Generate/approve/export Meta/RSA | Character limit violations | Export is paste-ready |
| Ad launches | Approve and launch/pause/resume | Budget cap, kill switch, Meta error | Spend controls are enforced before platform call |
| Insights | Workspace/campaign rollups and CSV | Empty data, mismatched counts | Numbers map back to records |
| Billing | Plan, usage, checkout, webhook | Limit reached, bad signature, member checkout | Entitlements gate intended actions only |
| Analytics | Events fire when enabled | Opt-out, no keys, PostHog down | Analytics never blocks product flow |
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
- Google sign-in depends on direct Google OAuth configuration, not Nango.
- Billing can be present without live Stripe checkout; record whether Stripe env vars and webhook signing secret are configured.
- Billing enforcement may be disabled by env; record whether gates are enforced in the run.
- Product analytics should be treated as internal telemetry, not the customer insights dashboard.
- Product analytics is allowed to be a no-op when keys are missing, but it must not block any request.
- Native Insights depends on seeded workspace activity; empty insights are not a bug if the workspace has no drafts, publications, launch messages, metrics, or approvals.
- Evidence candidates come from signals and published posts but should not enter the corpus until accepted.
- Notifications/mobile approvals and MCP/public API are planned/spec'd but were not visible as active app surfaces in this workspace scan.

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
- Did onboarding tell me what to do next without getting in my way?
- Did Billing explain plan limits and upgrade paths before blocking me?
- Did Insights tell me where each number came from?
- Did guidance, generation settings, and evidence changes show up in traces?
- Did the platform use founder-friendly language, or did it leak implementation details?

---

## 12. Suggested Multi-Day Run

### Day 0 - Setup, credentials, and first-run path

- Confirm local environment.
- Configure available credentials: Gemini, Nango/social, R2R, Google, Stripe, PostHog, Resend.
- Test register/login/Google login.
- Create a fresh workspace.
- Walk onboarding and brain templates.
- Invite a teammate and confirm permissions.

### Day 1 - Brain, quality, evidence, and core GTM modules

- Fill brain docs, personas, guidance, generation settings.
- Upload evidence and test evidence candidates.
- Generate, review, approve/reject, and synthesize learning.
- Test discovery, campaigns, audiences, outbound, PR, CRM, ads, and ad creative where configured.

### Day 2 - Insights, billing, analytics, and non-social regression

- Open workspace and campaign insights.
- Export insights CSVs.
- Test billing/usage/entitlements/upgrade modal/checkout where configured.
- Confirm analytics enabled, opt-out, no-key/no-op, and failure behavior.
- Re-run key auth/team/access-control checks.

### Day 3 - Manual social and launch flows

- Test social OAuth connections.
- Test manual publishing.
- Test targeted launch generation and dispatch.
- Capture all platform-specific failures.

### Day 4 - Scheduling and automation

- Test cadence and calendar.
- Test automation modes.
- Test kill switch and caps.

### Day 5 - Inbox and replies

- Create live replies from a second account.
- Run inbox.
- Draft, approve, and post replies.
- Test auto-reply guardrails.

### Day 6 - Sequences and full regression

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
| Auth and Google login |  |  |
| Onboarding and templates |  |  |
| Team and access control |  |  |
| Brain, guidance, resolver |  |  |
| Generation quality settings |  |  |
| Evidence/RAG |  |  |
| Core approval and learning |  |  |
| Discovery and campaigns |  |  |
| Audiences and outbound |  |  |
| CRM |  |  |
| PR |  |  |
| Ads reporting/creative/launch |  |  |
| Insights |  |  |
| Billing and entitlements |  |  |
| Product analytics |  |  |
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
2. Fix auth/access/billing paths that can block the whole product.
3. Fix broken core paths.
4. Improve recovery from external failures.
5. Reduce user confusion in high-frequency flows.
6. Polish lower-risk copy and layout.

---

## 14. Final Acceptance Gate

Do not call the platform founder-ready until these runs pass:

1. Fresh user -> onboarding -> brain template -> first complete brain setup.
2. Email/password or Google login -> workspace -> invite teammate -> teammate action attributed correctly.
3. Brain/guidance/evidence/settings -> resolve context -> generate -> pre-review/angle behavior visible -> approve/reject -> learning proposal accepted.
4. Discovery/campaign/audience -> draft output -> outbound/PR/ads workflows produce usable exports or platform receipts.
5. Billing/entitlement limit -> upgrade modal -> Billing page -> checkout/webhook path tested or clearly marked not configured.
6. Insights -> workspace/campaign rollups -> CSV export -> numbers traced back to records.
7. Brain -> approved draft -> manual social publish -> external receipt.
8. Segment -> launch -> approve -> email CSV + LinkedIn/Instagram publish + X DM statuses.
9. Approved draft -> cadence -> calendar -> scheduled publish -> receipt.
10. Published post -> inbound reply -> AI draft -> approve -> posted reply.
11. Multi-step launch -> step 1 sent -> follow-up generated -> one recipient stopped -> one X recipient stopped by reply.

If any of these fail, the report should name the exact failure and whether it is a code bug, platform credential issue, product decision, or local setup issue.
