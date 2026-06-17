# Tuezday Sprint Guide — Sprints 21+ (Post-Sprint-20 Roadmap)

> Created 2026-06-17. Companion to `docs/plans/sprint-plan.md` (the source of truth for Sprints 1–20).
> This guide sequences the next wave of work: the features carried forward from the audit of the
> previous Tuezday codebase (`Desktop/tuezday-platform`) **plus** the founder's update list.
> It keeps every operating rule from the original plan: one vertical slice at a time, written spec →
> tests-before-implementation → build → automated verification → founder manual acceptance → frozen.

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
   Sprint 18 already did a redesign pass. Treat U4 (Sprint 31 below) as a *v2* informed by the new
   surfaces this roadmap introduces (calendar, inbox, insights) and by `docs/research/ui-audit.md` —
   not a restart.
3. **Note the shared dependency: a transactional mailer.** Several items need one (email approvals,
   onboarding, invites — flagged missing in the Sprint 19 spec — billing receipts). It's introduced
   as shared infra in **Sprint 26** (Resend, behind an interface). Pull it earlier if email approvals
   or billing jump the queue.

---

## Phase A — Quick wins & quality foundations

Small, high-leverage slices that sharpen every downstream module and clear the founder's CRM friction.

### Sprint 21 — Runtime-editable channel/platform guidance  *(A4)*
- **Goal:** Stop shipping channel guidance as hardcoded source. Make it editable per scope, with zero deploy — the pattern the old repo had (`pipeline_config`) and the new repo regressed on.
- **Builds on:** Sprint 2 (brain), Sprint 3 (resolver).
- **Scope:** Move `CHANNEL_GUIDANCE` out of `packages/brain/src/resolver.ts` into a `guidance` config (scoped global → workspace → channel) read at resolve time; built-in defaults stay in `packages/contracts` as the fallback. Brain/settings UI to edit. Resolver trace shows the text **and its source** (default vs workspace override).
- **Boundary:** Defaults remain in contracts; DB holds overrides only.
- **Founder acceptance:** Edit LinkedIn guidance → next generation reflects it with no redeploy; the context trace shows the edited text labelled "workspace override."
- **Size:** S.

### Sprint 22 — Generation quality: angle-first + dual-LLM pre-review  *(A2)*
- **Goal:** Raise output quality *before* a human looks, across all modules — the biggest quality lever from the audit.
- **Builds on:** Sprint 4 (sandbox + gateway), Sprint 5 (approval gate).
- **Scope:** (1) Optional **angle step** — generate N distinct angles, pick/auto-pick one, then draft. (2) **Automated review** — a brand-voice check and a channel-fit check (two gateway calls) producing scores + specific issues, stored on the generation/draft and shown in the approval UI. Both toggleable per workspace; all calls traced. Reviewer prompts assembled through the resolver (never hardcoded).
- **Boundary:** Provider-agnostic via the LLM gateway; prompts are brain-resolved like everything else.
- **Founder acceptance:** Generate a LinkedIn post → see angles + brand/fit scores + issues; weak drafts flagged before review; founder override still works.
- **Size:** M.

### Sprint 23 — CRM contact management: discard + filtered sync  *(C1, C2)*
- **Goal:** Founder controls which CRM contacts live in Tuezday (the two CRM friction points).
- **Builds on:** Sprint 13 (CRM read/write).
- **Scope:** (1) **Discard/delete** synced `crm_contacts` locally with a tombstone so a re-sync doesn't resurrect them. (2) **Filtered sync** per connection (by CRM list/segment, owner, updated-since, or property — whatever the adapter supports), configured on the connection.
- **Boundary:** CRM stays system of record; local discard never deletes in the CRM unless explicitly chosen.
- **Founder acceptance:** Import → delete some → re-sync doesn't bring them back; set a filter → only matching contacts sync.
- **Size:** S–M.

---

## Phase B — Leads, segments & targeted campaigns

### Sprint 24 — Lead lists & segments  *(C3, part 1)*
- **Goal:** Group leads/contacts into reusable, targetable lists — the missing primitive for targeted campaigns.
- **Builds on:** `leads`, `crm_contacts`, `campaigns`.
- **Scope:** Static lists + simple rule-based segments over lead/contact fields; membership; attach a list/segment to a campaign as its audience.
- **Founder acceptance:** Create segment "VPs at fintech" → see members → attach to a campaign.
- **Size:** M.

### Sprint 25 — Targeted campaign launch: outbound & social DM  *(C3, part 2)*
- **Goal:** Launch a personalized sequence/post at a segment.
- **Builds on:** Sprint 11 (outbound), Sprint 17 (social publishing), Sprint 24 (segments).
- **Scope:** Launch an outbound email sequence or social-DM campaign at a segment; each message brain-resolved + approval-gated + per-lead personalized; email send exports to Smartlead/Instantly (locked boundary); DMs via connector where the platform API allows (note + respect platform DM limits).
- **Boundary:** Never build sending/deliverability infra; reuse the approval gate per message.
- **Founder acceptance:** Pick a segment → generate personalized first-touch per lead → approve → send/export.
- **Size:** L (split if needed: outbound first, social DM second).

---

## Phase C — Distribution automation & the engagement loop

### Sprint 26 — Recurring cadence, campaign calendar + transactional mailer  *(A6 scheduling; shared mailer)*
- **Goal:** Scheduled posting cadence and a calendar; introduce the mailer that several later sprints need.
- **Builds on:** Sprint 17 (publications), Sprint 7 (campaigns).
- **Scope:** Recurring posting slots (day/time/tz) per campaign/persona (old `posting_queues` pattern); **calendar view** (research Tier-2 #4, HubSpot/Hootsuite parity); **Resend mailer** behind an interface (unblocks invites, email approvals, onboarding, billing).
- **Founder acceptance:** Define a weekly cadence → drafts auto-slot → appear on a calendar → publishing fires on schedule; a test transactional email sends.
- **Size:** M–L.

### Sprint 27 — Campaign-configured social automation: LinkedIn / X / Meta  *(U10)*
- **Goal:** Connect LinkedIn, X, and Meta and drive **automated / human-in-the-loop / scheduled** posting configured at the campaign level.
- **Builds on:** Sprint 12 (connector fabric / Nango OAuth), Sprint 17 (publish contract), Sprint 26 (cadence), Sprint 8 (campaigns), Sprint 9 (discovery).
- **Scope:** Connect the three apps via Nango; a per-campaign **automation mode** (manual / human-in-the-loop / scheduled-auto); map discovered signals + generated content into the campaign's channels; gate enforced in human-in-the-loop; scheduled-auto posts with the same guardrails as ads (rate caps, kill switch).
- **Boundary:** Official APIs via Nango only; reuse publish receipts; no scraping for posting.
- **Founder acceptance:** Connect LinkedIn → set a campaign to scheduled-auto on a cadence → approved content posts automatically; flip to human-in-the-loop → posts wait at the gate.
- **Size:** L.

### Sprint 28 — Unified engagement & reply inbox  *(A3; research Tier-2 #2)*
- **Goal:** One surface for replies/comments/DMs across published + outbound, with AI-drafted, brain-resolved, approval-gated responses — and engagement metrics on posts.
- **Builds on:** Sprint 27 (social), Sprint 11 (outbound), Sprint 25.
- **Scope:** Poll replies/comments/DMs per connection into an **inbox**; engagement metrics (likes/comments/etc. at 24h/7d) on published posts; draft a reply through the gate; read/dismiss.
- **Founder acceptance:** A reply to a posted comment appears in the inbox → AI drafts a reply → approve → it posts; engagement numbers show on the post.
- **Size:** L.

---

## Phase D — Discovery scale & context management

### Sprint 29 — Discovery source expansion + auto-mapping to campaigns/personas  *(U9)*
- **Goal:** More signal sources, and route relevant content into the right campaign + persona automatically.
- **Builds on:** Sprint 9 (discovery), Sprint 8 (campaigns), personas.
- **Scope:** New adapters behind the existing signal contract (Hacker News, YouTube, podcasts, G2/Capterra reviews, Google Trends, and intent signals — job changes / funding / hiring, per research Tier-2 #3); a **mapping/triage** step scoring each discovered item to candidate campaign(s) + persona(s) with a reason (extends the existing `suggestedPersonaId` / `scoreReason`); founder triage → draft path.
- **Boundary:** Buy signal data via provider APIs; don't scrape. Every adapter follows the signal contract — no special-casing.
- **Founder acceptance:** Enable HN + a funding-signal source → items appear scored and mapped to a campaign/persona → accept → draft.
- **Size:** M–L (adapters can land incrementally on the continuous track).

### Sprint 30 — RAG hardening for scale  *(U7)*
- **Goal:** Keep context sharp as signal/evidence volume grows.
- **Builds on:** Sprint 9 (RAG / R2R), Sprint 10 (learning loop).
- **Scope:** Auto-ingest accepted signals / published content / evidence into the corpus; retrieval-policy tuning (recency, source weighting, dedupe); citations QA; per-workspace collection; budget-aware retrieval into the resolver.
- **Founder acceptance:** Corpus grows from signals automatically; generations cite fresher, more relevant evidence; the trace shows the retrieval query + chosen chunks.
- **Size:** M.

---

## Phase E — UX, insights, growth & commercialization

### Sprint 31 — Dashboard UX redesign v2  *(U4)*
- **Goal:** Cohesive information architecture incorporating the new calendar / inbox / insights surfaces; act on `ui-audit.md`; cut clutter (the research's "UX failure, not feature gap" point).
- **Builds on:** Sprint 18 (redesign), `docs/research/ui-audit.md`. **Best sequenced after** the surfaces it must house (26, 28, 32) exist — or do it iteratively.
- **Founder acceptance:** Walkthrough of the redesigned nav/home; key flows take fewer clicks.
- **Size:** M–L.

### Sprint 32 — Native GTM insights & reports dashboard  *(U2, A6 analytics surface)*
- **Goal:** Customer-facing insights across campaigns / channels / brain — built **native** (locked decision; PostHog/Superset are for product/internal, not this).
- **Builds on:** ads metrics (14), engagement metrics (28), approval + learning data, publications.
- **Scope:** Campaign-level rollup (spend + results + engagement + approval rate + output ratings, all on the campaign object — research's HubSpot bar), channel performance, brain completeness/usage; export.
- **Founder acceptance:** Open a campaign → one view of paid + organic + outbound performance.
- **Size:** M–L.

### Sprint 33 — Product/behavior analytics instrumentation  *(U3)*
- **Goal:** Track how users actually use the platform, to inform product.
- **Builds on:** web + api.
- **Scope:** **PostHog** event capture (key funnels: onboarding, generate, approve, publish, connect) behind a thin analytics interface; privacy/opt-out; dashboards live in PostHog (internal).
- **Boundary:** PostHog = product/web analytics; the customer GTM dashboard stays native (Sprint 32).
- **Founder acceptance:** Events flow to PostHog; the generate→approve→publish funnel is visible.
- **Size:** S–M.

### Sprint 34 — Google Auth login  *(U6)*
- **Goal:** Google OAuth sign-in alongside email/password.
- **Builds on:** Sprint 19 (auth: scrypt + opaque session tokens).
- **Scope:** Google OAuth (via Nango or direct); link by verified email; reuse existing session issuance.
- **Founder acceptance:** Sign in with Google → land in workspaces; an existing email account links cleanly.
- **Size:** S–M.

### Sprint 35 — Pricing plans & feature gating  *(U5, A6 billing)*
- **Goal:** Plans + entitlement enforcement + billing — the commercialization gate.
- **Builds on:** Sprint 19 (teams/workspaces), Sprint 26 (mailer for receipts/dunning).
- **Scope:** Plan/tier model + **entitlements** (seats, connectors, generations, ad-spend cap, etc.); feature-gate middleware at the service boundary; Stripe subscriptions + metering + webhooks; billing UI.
- **Boundary:** Gate via entitlements, not scattered hardcoded tier checks.
- **Founder acceptance:** A free workspace hits a gated feature → upgrade prompt → subscribe via Stripe → entitlement unlocks.
- **Size:** L.

### Sprint 36 — Onboarding flow  *(U1 — LOW priority; schedule once nuances are defined)*
- **Goal:** Guided first run: create workspace → seed brain (templates) → connect first app → first generation → first approval.
- **Builds on:** brain, connectors, **brain-doc templates** (revive the old repo's `brand_voice_templates` idea).
- **Founder acceptance:** A new user reaches their first approved output guided, no docs.
- **Size:** M. *(Explicitly deferred until the founder defines the flow's nuances.)*

---

## Phase F — Advanced surfaces

### Sprint 37 — Notifications & mobile approvals: Telegram + email  *(A1)*
- **Goal:** Approve/edit/reject from Telegram and one-click email links — the audit's top UX win for keeping the gate actually used.
- **Builds on:** Sprint 5 (approval gate), Sprint 26 (mailer).
- **Scope:** `notification_channels` (Telegram bot + email); approve/reject deep links + Telegram inline callbacks; per-workspace config.
- **Founder acceptance:** Draft hits the gate → Telegram message with approve/reject → tap approve → state changes; the email link works once.
- **Size:** M.

### Sprint 38 — MCP server + scoped public API  *(A5)*
- **Goal:** Let external agents/tools drive Tuezday — and build the **action surface** the chat interface will reuse.
- **Builds on:** stable `packages/contracts`, Sprint 19 (auth).
- **Scope:** Scoped API keys (e.g. `ideas:write`, `drafts:read/write`, `analytics:read`); a public REST surface; an MCP server exposing submit-idea / list+approve-drafts / fetch-insights / launch-campaign.
- **Founder acceptance:** An MCP client submits an idea and approves a draft using a scoped key.
- **Size:** M.

### Sprint 39 — Design layer: automated carousel/image pipeline  *(U11)*
- **Goal:** On-brand visual creative (carousels first) attached to content and ads.
- **Builds on:** Sprint 6 (content), Sprint 15 (ad creative), brain (voice + visual guidelines).
- **Scope:** Integrate a design layer behind a `DesignProvider` boundary (founder named **Open Design**; Canva is also available as an MCP integration — pick one in the spec); carousel pipeline: content → slide breakdown → templated render → preview → approval; store asset refs.
- **Boundary:** Integrate, don't build a DAM; generation runs through the provider boundary.
- **Founder acceptance:** Approve a LinkedIn post → generate a branded carousel → preview → attach → publish.
- **Size:** L.

### Sprint 40 — Chat / command interface  *(U12 — deliberately last, per the rebuild plan)*
- **Goal:** A copilot that answers from the brain + evidence + campaign data **and executes actions** ("draft a post about the launch", "launch campaign X at segment Y") across the platform and integrated apps.
- **Builds on:** everything — brain, resolver, evidence, campaigns, connectors, the approval gate, and crucially the **action surface from Sprint 38**.
- **Scope:** Chat UI; intent → tool/action routing that reuses the MCP/public-API action layer; answers grounded in brain + evidence; **every state-changing action still routes through the approval gate**.
- **Boundary:** Chat is a presentation/orchestration layer over existing services — no new business logic lives in the chat.
- **Founder acceptance:** "Draft a LinkedIn post about our funding and queue it to the Launch campaign" → produces an approval-gated draft attached to that campaign.
- **Size:** XL (split: query/answer first, then action execution).

---

## Continuous tracks (run alongside, founder-prioritized — not numbered sprints)

- **Integration expansion**  *(U8)* — extends Sprints 12–13: more CRM adapters behind `CrmAdapter` (HubSpot, Pipedrive, Salesforce), more ad platforms behind the Sprint 14 metric model, more social behind the Sprint 17 publish contract, plus a **lead-enrichment provider** behind a `LeadEnricher` boundary (research Tier-2 #7). Each is a uniform add, no special-casing.
- **Discovery adapter expansion**  *(part of U9)* — keep adding signal adapters on the Sprint 9 contract as a steady drip rather than one big sprint.
- **Content Remix** (research Tier-2 #1) — one approved asset → per-channel variants; nearly free given the resolver already varies output per channel. Can ride along with Sprint 27/39.

---

## Traceability matrix

| Request | Source | Sprint(s) |
|---|---|---|
| Onboarding flow | U1 | 36 (low priority) |
| Insights & reports dashboard | U2 | 32 |
| Product/behavior analytics | U3 | 33 (PostHog) |
| Dashboard UI/UX redesign | U4 | 31 (v2 on Sprint 18) |
| Pricing plans + feature gating | U5 | 35 |
| Google Auth login | U6 | 34 |
| RAG for better context at scale | U7 | 30 (hardens Sprint 9) |
| More tools/app integrations | U8 | Continuous track |
| More discovery sources + map to campaigns/personas | U9 | 29 + continuous |
| LinkedIn/X/Meta automated/HITL/scheduled posting at campaign level | U10 | 27 |
| Design layer / automated carousels | U11 | 39 |
| Chat interface to launch/execute campaigns | U12 | 40 |
| Discard/delete synced CRM contacts | C1 | 23 |
| Filtered CRM contact sync | C2 | 23 |
| Lead lists/segments → targeted campaigns | C3 | 24 + 25 |
| Telegram/email approval channels | A1 | 37 |
| Dual-LLM pre-review + angle-first generation | A2 | 22 |
| Engagement + reply-inbox loop | A3 | 28 |
| DB-editable channel/platform guidance | A4 | 21 |
| MCP server + scoped public API | A5 | 38 |
| Billing/tiers | A6 | 35 |
| Analytics surface (native) | A6 | 32 |
| Account-health monitoring | A6 | folded into 27/28 (connection health) |
| Recurring-cadence scheduling + calendar | A6 | 26 |

---

## Open decisions for the founder

1. **Accept Sprints 14–20 first?** (Recommended — required by your own operating rule.)
2. **Commercialization timing:** is pricing/billing (35) urgent enough to pull ahead of the
   distribution/inbox work (27–28)? Right now it's sequenced after the product loop is complete.
3. **Design tool for Sprint 39:** Open Design (your call) vs Canva (already wired as an MCP
   integration here). Decide in the spec.
4. **Email approvals urgency:** Sprint 37 depends on the mailer (Sprint 26). If "approve from your
   phone" is a near-term must-have, pull the mailer + Sprint 37 forward into Phase A/B.
