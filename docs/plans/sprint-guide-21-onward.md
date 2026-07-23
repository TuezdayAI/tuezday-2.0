# Tuezday Sprint Guide — Sprints 21+ (Post-Sprint-20 Roadmap)

> Created 2026-06-17. Companion to `docs/plans/sprint-plan.md` (the source of truth for Sprints 1–20).
> This guide sequences the next wave of work: the features carried forward from the audit of the
> previous Tuezday codebase (`Desktop/tuezday-platform`) **plus** the founder's update list.
> It keeps every operating rule from the original plan: one vertical slice at a time, written spec →
> tests-before-implementation → build → automated verification → founder manual acceptance → frozen.
>
> **Reorganised 2026-06-21 (founder, "no-compromise" rule):** when a sprint needs a prerequisite
> that isn't built, we split that prerequisite into its own correctly-ordered sprint rather than
> faking/half-building it, and slide the later **unbuilt** sprints down. This pass inserted
> **Sprint 25 (Connect LinkedIn / X / Instagram)** before the targeted-launch sprint, and
> **Sprint 30 (Multi-step outbound sequences)** after the cadence + reply-inbox sprints it depends on.
> Built/accepted sprints (21–24) keep their numbers; everything from the old 25 onward shifted.

---

## How to read this

- **Numbering continues from 20.** Each entry is at the same altitude as a `sprint-plan.md` sprint
  (Goal / Builds on / Scope / Boundary / Founder acceptance / Size). Each still gets its own
  `docs/specs/sprint-NN-*.md` before implementation.
- **Sizes:** S ≈ a few days, M ≈ ~1 week, L ≈ 1–2 weeks, XL ≈ multi-week (split on build).
- **Phases group by theme and dependency, not by calendar.** Within the stated dependencies you can
  resequence to taste; the "Builds on" line tells you what must exist first.
- Items map back to the founder's list (U1–U12, C1–C3) and the audit shortlist (A1–A6) in the
  **Traceability matrix** at the bottom.

---

## Preconditions (do these before opening Sprint 21)

1. **Run founder acceptance on Sprints 14–20.** The non-negotiable rule is "no new slice until the
   previous is accepted." Seven sprints (14–20) are built but awaiting acceptance. Accept (or fix +
   accept) them first; otherwise new work stacks on unverified foundations.
2. **Reconcile Sprint 18 (Dashboard Redesign) with the founder's "UI/UX redesign" ask (U4).**
   Sprint 18 already did a redesign pass. Treat U4 (Sprint 33 below) as a *v2* informed by the new
   surfaces this roadmap introduces (calendar, inbox, insights) and by `docs/research/ui-audit.md` —
   not a restart.
3. **Note the shared dependency: a transactional mailer.** Several items need one (email approvals,
   onboarding, invites — flagged missing in the Sprint 19 spec — billing receipts). It's introduced
   as shared infra in **Sprint 27** (Resend, behind an interface). Pull it earlier if email approvals
   or billing jump the queue.

---

## Phase A — Quick wins & quality foundations

Small, high-leverage slices that sharpen every downstream module and clear the founder's CRM friction.

### Sprint 21 — Runtime-editable channel/platform guidance  *(A4)*  — built (branch `sprint-21-runtime-editable-guidance`)
- **Goal:** Stop shipping channel guidance as hardcoded source. Make it editable per scope, with zero deploy — the pattern the old repo had (`pipeline_config`) and the new repo regressed on.
- **Builds on:** Sprint 2 (brain), Sprint 3 (resolver).
- **Scope:** Move `CHANNEL_GUIDANCE` out of `packages/brain/src/resolver.ts` into a `guidance` config (scoped global → workspace → channel) read at resolve time; built-in defaults stay in `packages/contracts` as the fallback. Brain/settings UI to edit. Resolver trace shows the text **and its source** (default vs workspace override).
- **Boundary:** Defaults remain in contracts; DB holds overrides only.
- **Founder acceptance:** Edit LinkedIn guidance → next generation reflects it with no redeploy; the context trace shows the edited text labelled "workspace override."
- **Size:** S.

### Sprint 22 — Generation quality: angle-first + dual-LLM pre-review  *(A2)*  — built (branch `sprint-22-generation-quality`)
- **Goal:** Raise output quality *before* a human looks, across all modules — the biggest quality lever from the audit.
- **Builds on:** Sprint 4 (sandbox + gateway), Sprint 5 (approval gate).
- **Scope:** (1) Optional **angle step** — generate N distinct angles, pick/auto-pick one, then draft. (2) **Automated review** — a brand-voice check and a channel-fit check (two gateway calls) producing scores + specific issues, stored on the generation/draft and shown in the approval UI. Both toggleable per workspace; all calls traced. Reviewer prompts assembled through the resolver (never hardcoded).
- **Boundary:** Provider-agnostic via the LLM gateway; prompts are brain-resolved like everything else.
- **Founder acceptance:** Generate a LinkedIn post → see angles + brand/fit scores + issues; weak drafts flagged before review; founder override still works.
- **Size:** M.

### Sprint 23 — CRM contact management: discard + filtered sync  *(C1, C2)*  — built (branch `sprint-23-crm-discard-filtered-sync`)
- **Goal:** Founder controls which CRM contacts live in Tuezday (the two CRM friction points).
- **Builds on:** Sprint 13 (CRM read/write).
- **Scope:** (1) **Discard/delete** synced `crm_contacts` locally with a tombstone so a re-sync doesn't resurrect them. (2) **Filtered sync** per connection (by CRM list/segment, owner, updated-since, or property — whatever the adapter supports), configured on the connection.
- **Boundary:** CRM stays system of record; local discard never deletes in the CRM unless explicitly chosen.
- **Founder acceptance:** Import → delete some → re-sync doesn't bring them back; set a filter → only matching contacts sync.
- **Size:** S–M.

---

## Phase B — Leads, segments & targeted campaigns

### Sprint 24 — Lead lists & segments  *(C3, part 1)*  — built (branch `sprint-24-lead-lists-segments`)
- **Goal:** Group leads/contacts into reusable, targetable lists — the missing primitive for targeted campaigns.
- **Builds on:** `leads`, `crm_contacts`, `campaigns`.
- **Scope:** Static lists + simple rule-based segments over lead/contact fields; membership; attach a list/segment to a campaign as its audience.
- **Founder acceptance:** Create segment "VPs at fintech" → see members → attach to a campaign.
- **Size:** M.

### Sprint 25 — Connect LinkedIn / X / Instagram  *(U10 prerequisite — pulled forward 2026-06-21)*
- **Goal:** Real, authenticated connections to **LinkedIn, X (Twitter), and Instagram** via Nango OAuth, so the targeted-launch sprint can publish/DM through them — no "assume connected" shortcut. (Founder decision 2026-06-21: build the connection flow as its own slice *before* launching at a segment. Reddit is parked until its OAuth key arrives, so it leaves the near-term path.)
- **Builds on:** Sprint 12 (connector fabric / Nango OAuth popup), Sprint 17 (social adapter + OAuth-app pattern — how Reddit was wired).
- **Scope:** Add `linkedin`, `twitter`, `instagram` as `social` providers in `CONNECTOR_PROVIDERS` (each with `nangoProvider`, `oauthScopes` that already include the posting/DM scopes Sprint 26 needs, and an identity `baseUrl` + `testPath` for the health check); `OAUTH_ENV` entries mapping each to its `.env` client id/secret; the Nango integration config in `infra/`. Reuse the existing `/connectors/:key/oauth/session` → popup → `/oauth/complete` → `testConnection` flow unchanged; the Integrations page already renders the provider registry, so the three appear and become connectable once their `.env` creds exist. Connection health = an identity call per platform (LinkedIn `userinfo`, X `users/me`, Instagram `me`).
- **Boundary:** Official OAuth via Nango only; no scraping. Tokens/secrets live in `.env`/Nango, never in Tuezday's DB, never in logs. **No posting or DM logic here** — connect + identity-verify only (that lands in Sprint 26). No new send infra.
- **Founder acceptance:** Click "Connect LinkedIn" → OAuth popup → returns **connected** showing the account identity; same for X and Instagram; disconnect + reconnect works; Reddit shows as parked/unavailable.
- **Size:** S–M.

### Sprint 26 — Targeted campaign launch at a segment  *(C3, part 2)*
- **Goal:** Launch a personalized first-touch at a segment, across email + social.
- **Builds on:** Sprint 24 (audiences/segments), Sprint 25 (social connections), Sprint 11 (outbound), Sprint 17 (social publishing).
- **Scope:** A **launch** targeting an audience (+ campaign, persona); one brain-resolved, approval-gated, **per-recipient personalized** first-touch per member of the people pool (leads **and** unlinked contacts). Channel split (founder decisions 2026-06-21): **email** → each personalized message exported as a Smartlead/Instantly-ready CSV behind an `OutboundExporter` seam; **LinkedIn + Instagram** → one approval-gated **broadcast post** per platform (their APIs don't permit cold per-person DMs); **X** → a per-recipient **DM** (needs an X handle stored on each person — new field — and respects X's DM permissions/rate limits). Single first-touch only.
- **Boundary:** Never build sending/deliverability infra; reuse the approval gate per message; CSV export now, real Smartlead/Instantly API push deferred (logged in `docs/deferred-improvements.md`). Multi-step follow-ups are Sprint 30.
- **Founder acceptance:** Pick a segment → generate a personalized first-touch per recipient → approve → export the email CSV / publish the LinkedIn + Instagram post / send the X DMs.
- **Size:** L.

---

## Phase C — Distribution automation & the engagement loop

### Sprint 27 — Recurring cadence, campaign calendar + transactional mailer  *(A6 scheduling; shared mailer)*
- **Goal:** Scheduled posting cadence and a calendar; introduce the mailer that several later sprints need.
- **Builds on:** Sprint 17 (publications), Sprint 7 (campaigns).
- **Scope:** Recurring posting slots (day/time/tz) per campaign/persona (old `posting_queues` pattern); **calendar view** (research Tier-2 #4, HubSpot/Hootsuite parity); **Resend mailer** behind an interface (unblocks invites, email approvals, onboarding, billing).
- **Founder acceptance:** Define a weekly cadence → drafts auto-slot → appear on a calendar → publishing fires on schedule; a test transactional email sends.
- **Size:** M–L.

### Sprint 28 — Campaign-configured social automation modes: LinkedIn / X / Meta  *(U10)*
- **Goal:** Drive **automated / human-in-the-loop / scheduled** posting configured at the campaign level. (The connections themselves now land in Sprint 25, so this sprint is the automation layer on top of them.)
- **Builds on:** Sprint 25 (social connections), Sprint 17 (publish contract), Sprint 27 (cadence), Sprint 8 (campaigns), Sprint 9 (discovery).
- **Scope:** A per-campaign **automation mode** (manual / human-in-the-loop / scheduled-auto); map discovered signals + generated content into the campaign's channels; gate enforced in human-in-the-loop; scheduled-auto posts with the same guardrails as ads (rate caps, kill switch).
- **Boundary:** Official APIs via Nango only; reuse publish receipts; no scraping for posting.
- **Founder acceptance:** Set a connected campaign to scheduled-auto on a cadence → approved content posts automatically; flip to human-in-the-loop → posts wait at the gate.
- **Size:** M–L. *(Was Sprint 27 — the connect step moved out to Sprint 25.)*

### Sprint 29 — Unified engagement & reply inbox  *(A3; research Tier-2 #2)*
- **Goal:** One surface for replies/comments/DMs across published + outbound, with AI-drafted, brain-resolved, approval-gated responses — and engagement metrics on posts.
- **Builds on:** Sprint 28 (social automation), Sprint 11 (outbound), Sprint 26 (targeted launch).
- **Scope:** Poll replies/comments/DMs per connection into an **inbox**; engagement metrics (likes/comments/etc. at 24h/7d) on published posts; draft a reply through the gate; read/dismiss.
- **Founder acceptance:** A reply to a posted comment appears in the inbox → AI drafts a reply → approve → it posts; engagement numbers show on the post.
- **Size:** L.

### Sprint 30 — Multi-step outbound sequences (follow-up chains)  *(C3 follow-on — outreach core; inserted 2026-06-21)*
- **Goal:** Turn a single first-touch into a real **multi-step outreach sequence** — the table-stakes outbound feature the founder will not compromise on. Placed here because it genuinely needs both the scheduler and reply detection to exist first (the no-compromise rule: build the prerequisites, don't fake them).
- **Builds on:** Sprint 26 (targeted launch), Sprint 27 (cadence/scheduler), Sprint 29 (reply inbox / reply detection).
- **Scope:** A **sequence** of steps 1..N per launch (each with a delay and an optional condition); steps auto-advance via the Sprint 27 scheduler; **stop-on-reply** via the Sprint 29 inbox; every step brain-resolved + approval-gated + per-recipient personalized; works for email and X DM. Per-recipient sequence state (current step, paused/stopped/replied/done).
- **Boundary:** Reuse the scheduler + inbox; never rebuild deliverability; gate every step.
- **Founder acceptance:** Define a 3-step email sequence at a segment → step 1 sends → no reply → step 2 fires on schedule → a reply stops the rest of the chain.
- **Size:** L.

---

## Phase D — Discovery scale & context management

### Sprint 31 — Discovery source expansion + auto-mapping to campaigns/personas  *(U9)*
- **Goal:** More signal sources, and route relevant content into the right campaign + persona automatically.
- **Builds on:** Sprint 9 (discovery), Sprint 8 (campaigns), personas.
- **Scope:** New adapters behind the existing signal contract (Hacker News, YouTube, podcasts, G2/Capterra reviews, Google Trends, and intent signals — job changes / funding / hiring, per research Tier-2 #3); a **mapping/triage** step scoring each discovered item to candidate campaign(s) + persona(s) with a reason (extends the existing `suggestedPersonaId` / `scoreReason`); founder triage → draft path.
- **Boundary:** Buy signal data via provider APIs; don't scrape. Every adapter follows the signal contract — no special-casing.
- **Founder acceptance:** Enable HN + a funding-signal source → items appear scored and mapped to a campaign/persona → accept → draft.
- **Size:** M–L (adapters can land incrementally on the continuous track).

### Sprint 32 — RAG hardening for scale  *(U7)*
- **Goal:** Keep context sharp as signal/evidence volume grows.
- **Builds on:** Sprint 9 (RAG / R2R), Sprint 10 (learning loop).
- **Scope:** Auto-ingest accepted signals / published content / evidence into the corpus; retrieval-policy tuning (recency, source weighting, dedupe); citations QA; per-workspace collection; budget-aware retrieval into the resolver.
- **Founder acceptance:** Corpus grows from signals automatically; generations cite fresher, more relevant evidence; the trace shows the retrieval query + chosen chunks.
- **Size:** M.

---

## Phase E — UX, insights, growth & commercialization

### Sprint 33 — Dashboard UX redesign v2  *(U4)*
- **Goal:** Cohesive information architecture incorporating the new calendar / inbox / insights surfaces; act on `ui-audit.md`; cut clutter (the research's "UX failure, not feature gap" point).
- **Builds on:** Sprint 18 (redesign), `docs/research/ui-audit.md`. **Best sequenced after** the surfaces it must house (27, 29, 34) exist — or do it iteratively.
- **Founder acceptance:** Walkthrough of the redesigned nav/home; key flows take fewer clicks.
- **Size:** M–L.

### Sprint 34 — Native GTM insights & reports dashboard  *(U2, A6 analytics surface)*
- **Goal:** Customer-facing insights across campaigns / channels / brain — built **native** (locked decision; PostHog/Superset are for product/internal, not this).
- **Builds on:** ads metrics (14), engagement metrics (29), approval + learning data, publications.
- **Scope:** Campaign-level rollup (spend + results + engagement + approval rate + output ratings, all on the campaign object — research's HubSpot bar), channel performance, brain completeness/usage; export.
- **Founder acceptance:** Open a campaign → one view of paid + organic + outbound performance.
- **Size:** M–L.

### Sprint 35 — Product/behavior analytics instrumentation  *(U3)*
- **Goal:** Track how users actually use the platform, to inform product.
- **Builds on:** web + api.
- **Scope:** **PostHog** event capture (key funnels: onboarding, generate, approve, publish, connect) behind a thin analytics interface; privacy/opt-out; dashboards live in PostHog (internal).
- **Boundary:** PostHog = product/web analytics; the customer GTM dashboard stays native (Sprint 34).
- **Founder acceptance:** Events flow to PostHog; the generate→approve→publish funnel is visible.
- **Size:** S–M.

### Sprint 36 — Google Auth login  *(U6)*
- **Goal:** Google OAuth sign-in alongside email/password.
- **Builds on:** Sprint 19 (auth: scrypt + opaque session tokens).
- **Scope:** Google OAuth (via Nango or direct); link by verified email; reuse existing session issuance.
- **Founder acceptance:** Sign in with Google → land in workspaces; an existing email account links cleanly.
- **Size:** S–M.

### Sprint 37 — Pricing plans & feature gating  *(U5, A6 billing)*
- **Goal:** Plans + entitlement enforcement + billing — the commercialization gate.
- **Builds on:** Sprint 19 (teams/workspaces), Sprint 27 (mailer for receipts/dunning).
- **Scope:** Plan/tier model + **entitlements** (seats, connectors, generations, ad-spend cap, etc.); feature-gate middleware at the service boundary; Stripe subscriptions + metering + webhooks; billing UI.
- **Boundary:** Gate via entitlements, not scattered hardcoded tier checks.
- **Founder acceptance:** A free workspace hits a gated feature → upgrade prompt → subscribe via Stripe → entitlement unlocks.
- **Size:** L.

### Sprint 38 — Onboarding flow  *(U1 — LOW priority; schedule once nuances are defined)*
- **Goal:** Guided first run: create workspace → seed brain (templates) → connect first app → first generation → first approval.
- **Builds on:** brain, connectors, **brain-doc templates** (revive the old repo's `brand_voice_templates` idea).
- **Founder acceptance:** A new user reaches their first approved output guided, no docs.
- **Size:** M. *(Explicitly deferred until the founder defines the flow's nuances.)*

---

## Phase F — Advanced surfaces

### Sprint 39 — Notifications & mobile approvals: Telegram + email  *(A1)*
- **Goal:** Approve/edit/reject from Telegram and one-click email links — the audit's top UX win for keeping the gate actually used.
- **Builds on:** Sprint 5 (approval gate), Sprint 27 (mailer).
- **Scope:** `notification_channels` (Telegram bot + email); approve/reject deep links + Telegram inline callbacks; per-workspace config.
- **Founder acceptance:** Draft hits the gate → Telegram message with approve/reject → tap approve → state changes; the email link works once.
- **Size:** M.

### Sprint 40 — MCP server + scoped public API  *(A5)*
- **Goal:** Let external agents/tools drive Tuezday — and build the **action surface** the chat interface will reuse.
- **Builds on:** stable `packages/contracts`, Sprint 19 (auth).
- **Scope:** Scoped API keys (e.g. `ideas:write`, `drafts:read/write`, `analytics:read`); a public REST surface; an MCP server exposing submit-idea / list+approve-drafts / fetch-insights / launch-campaign.
- **Founder acceptance:** An MCP client submits an idea and approves a draft using a scoped key.
- **Size:** M.

### Sprint 41 — Design layer: automated carousel/image pipeline  *(U11)*
- **Goal:** On-brand visual creative (carousels first) attached to content and ads.
- **Builds on:** Sprint 6 (content), Sprint 15 (ad creative), brain (voice + visual guidelines).
- **Scope:** Integrate a design layer behind a `DesignProvider` boundary (founder named **Open Design**; Canva is also available as an MCP integration — pick one in the spec); carousel pipeline: content → slide breakdown → templated render → preview → approval; store asset refs.
- **Boundary:** Integrate, don't build a DAM; generation runs through the provider boundary.
- **Founder acceptance:** Approve a LinkedIn post → generate a branded carousel → preview → attach → publish.
- **Size:** L.

### Sprint 42 — Chat / command interface  *(U12 — deliberately last, per the rebuild plan)*
- **Goal:** A copilot that answers from the brain + evidence + campaign data **and executes actions** ("draft a post about the launch", "launch campaign X at segment Y") across the platform and integrated apps.
- **Builds on:** everything — brain, resolver, evidence, campaigns, connectors, the approval gate, and crucially the **action surface from Sprint 40**.
- **Scope:** Chat UI; intent → tool/action routing that reuses the MCP/public-API action layer; answers grounded in brain + evidence; **every state-changing action still routes through the approval gate**.
- **Boundary:** Chat is a presentation/orchestration layer over existing services — no new business logic lives in the chat.
- **Founder acceptance:** "Draft a LinkedIn post about our funding and queue it to the Launch campaign" → produces an approval-gated draft attached to that campaign.
- **Size:** XL (split: query/answer first, then action execution).

---

## Phase G — Context depth & discovery routing  *(inserted 2026-07-02, from `docs/plans/context-discovery-gap-assessment.md`)*

> Numbering note: 41/42 were already reserved by Phase F, so these are 43–47. Sprint number ≠
> execution order — Phase G addresses the verified context/discovery gaps and can run before 41/42.
> Internal order: 43 → 44 → 45 → 46; 47 is independent (schedule on the R2R exit triggers).

### Sprint 43 — Resolver v2: tiered selective context  *(Gap 1)*  — built (branch `sprint-43-resolver-v2-selective-context`)
- **Goal:** Stop shipping the whole brain in every prompt — selective, deterministic, fully traced context per task.
- **Builds on:** Sprints 2–4 (brain/resolver), 21 (guidance), 22 (angle-first).
- **Scope:** H2/H3 section parser (stable IDs) + save-time outline summaries (LLM with deterministic fallback); three tiers — constitutional docs always full, an editable taskType×{icp,history} matrix (contracts defaults + workspace overrides), BM25 map-then-zoom against a composed query (no embeddings, no new infra); angle-first wired as the brief; stable-prefix ordering; real budget enforcement (demote-to-outline ladder); matrix editor + outline preview + tier/zoom trace in the UI.
- **Founder acceptance:** `docs/founder-acceptance-tests.md` § Sprint 43.
- **Size:** L.

### Sprint 44 — Scoped guidance & persona topics  *(Gap 2)*  — built (branch `sprint-44-scoped-guidance-persona-topics`, off sprint-43; merge order: main ← 43 ← 44)
- **Goal:** Configuration depth — guidance and topics that live where the founder thinks about them.
- **Builds on:** Sprint 21 (guidance table), Sprint 43 (tier-1 keyed lookups).
- **Scope:** Guidance scoped workspace × channel × optional persona × optional campaign (most-specific-wins, with trace); persona topics/themes + structured drafting fields; per-connection content profile injected at draft time as a tier-1 `account` section (publish-time routing reused at draft time; engagement replies use the inbox item's own connection). Prerequisite for 45; feeds discovery matching.
- **Founder acceptance:** `docs/founder-acceptance-tests.md` § Sprint 44.
- **Size:** M.

### Sprint 45 — Discovery routing that honors the match  *(Gap 3)*  — built 2026-07-03 (branch `sprint-45-discovery-routing`, off sprint-44; merge order: main ← 43 ← 44 ← 45)
- **Goal:** Stop throwing away the campaign/persona match discovery already computes.
- **Builds on:** Sprint 31 (auto-mapping), Sprint 44 (topics to match against).
- **Scope:** Multi-candidate scoring (an item can clear threshold for several persona×campaign×channel pipelines); `runAutomation` consumes the mapping (kills deferred #11) and passes persona; re-score on config change; per-pipeline uniqueness + cross-source dedup (URL/content hash).
- **Size:** M.

### Sprint 46 — Connected-account & competitor sourcing
- **Goal:** Discovery reads through the workspace's own OAuth connections instead of keyless feeds only.
- **Builds on:** Sprint 25 (social OAuth), Sprint 45 (routing).
- **Scope:** `discovery_sources.connectionId` (X, LinkedIn, authenticated Reddit via Nango); competitor-handle tracking; Instagram; queue/back-pressure (deferred #8).
- **Size:** M–L.

### Sprint 47 — Own the evidence store  *(R2R exit)*  — built 2026-07-11 (branch `sprint-47-own-evidence-store`)
- **Goal:** Replace the R2R Docker stack with a native store behind the existing `EvidenceStore` seam.
- **Builds on:** Sprint 9 (evidence), Sprint 32 (RAG hardening). Independent of 43–46.
- **Scope:** `DbEvidenceStore` (FTS5 + sqlite-vec + RRF); gateway `embed()`; golden-query parity vs R2R; cutover + retire the Docker dependency. Also unlocks hybrid zoom ranking (deferred #22).
- **Size:** L.

---

## Continuous tracks (run alongside, founder-prioritized — not numbered sprints)

- **Integration expansion**  *(U8)* — extends Sprints 12–13: more CRM adapters behind `CrmAdapter` (HubSpot, Pipedrive, Salesforce), more ad platforms behind the Sprint 14 metric model, more social behind the Sprint 17 publish contract, plus a **lead-enrichment provider** behind a `LeadEnricher` boundary (research Tier-2 #7). Each is a uniform add, no special-casing.
- **Discovery adapter expansion**  *(part of U9)* — keep adding signal adapters on the Sprint 9 contract as a steady drip rather than one big sprint.
- **Content Remix** (research Tier-2 #1) — one approved asset → per-channel variants; nearly free given the resolver already varies output per channel. Can ride along with Sprint 28/41.

---

## Traceability matrix

| Request | Source | Sprint(s) |
|---|---|---|
| Onboarding flow | U1 | 38 (low priority) |
| Insights & reports dashboard | U2 | 34 |
| Product/behavior analytics | U3 | 35 (PostHog) |
| Dashboard UI/UX redesign | U4 | 33 (v2 on Sprint 18) |
| Pricing plans + feature gating | U5 | 37 |
| Google Auth login | U6 | 36 |
| RAG for better context at scale | U7 | 32 (hardens Sprint 9) |
| More tools/app integrations | U8 | Continuous track |
| More discovery sources + map to campaigns/personas | U9 | 31 + continuous |
| Connect LinkedIn/X/Instagram (social OAuth) | U10 (prereq) | 25 |
| LinkedIn/X/Meta automated/HITL/scheduled posting at campaign level | U10 | 28 |
| Design layer / automated carousels | U11 | 41 |
| Chat interface to launch/execute campaigns | U12 | 42 |
| Discard/delete synced CRM contacts | C1 | 23 |
| Filtered CRM contact sync | C2 | 23 |
| Lead lists/segments → targeted campaigns | C3 | 24 + 26 |
| Multi-step outbound sequences (follow-up chains) | C3 follow-on | 30 |
| Telegram/email approval channels | A1 | 39 |
| Dual-LLM pre-review + angle-first generation | A2 | 22 |
| Engagement + reply-inbox loop | A3 | 29 |
| DB-editable channel/platform guidance | A4 | 21 |
| MCP server + scoped public API | A5 | 40 |
| Billing/tiers | A6 | 37 |
| Analytics surface (native) | A6 | 34 |
| Account-health monitoring | A6 | folded into 28/29 (connection health) |
| Recurring-cadence scheduling + calendar | A6 | 27 |
| Selective brain context (Brain Index) | Gap assessment 2026-07-02, Gap 1 | 43 |
| Persona/campaign/channel config depth | Gap assessment 2026-07-02, Gap 2 | 44 |
| Discovery routing honors the match | Gap assessment 2026-07-02, Gap 3 | 45 + 46 |
| R2R exit (own the evidence store) | Gap assessment 2026-07-02 | 47 |

---

## Open decisions for the founder

1. **Accept Sprints 14–20 first?** (Recommended — required by your own operating rule.)
2. **Commercialization timing:** is pricing/billing (37) urgent enough to pull ahead of the
   distribution/inbox work (28–29)? Right now it's sequenced after the product loop is complete.
3. **Design tool for Sprint 41:** Open Design (your call) vs Canva (already wired as an MCP
   integration here). Decide in the spec.
4. **Email approvals urgency:** Sprint 39 depends on the mailer (Sprint 27). If "approve from your
   phone" is a near-term must-have, pull the mailer + Sprint 39 forward into Phase A/B.
