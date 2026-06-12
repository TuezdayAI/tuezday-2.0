# Tuezday Sprint Plan

> Date: 2026-06-10
>
> Purpose: Translate `greenfield-rebuild-plan.md` into a sprint-by-sprint execution plan. Each sprint is ~1 week of focused build and ends with a founder acceptance gate. No sprint starts until the previous sprint's slice is accepted and frozen with tests.
>
> The sequence is fixed by the rebuild plan. The calendar is illustrative — the gate matters more than the date.

---

## Operating Rules (apply to every sprint)

1. **Spec → tests → build → automated verification → founder manual test → accepted → frozen.** No exceptions.
2. Every sprint produces something a founder can open, click, and judge.
3. No module depends on a fake brain contract. No integration before its native boundary exists.
4. Approval states everywhere: `draft`, `pending_review`, `approved`, `rejected`, `edited`.
5. Output ratings (`accepted` / `needs edit` / `rejected`) are stored as training signals from day one of the sandbox.
6. Salvage concepts from the prior codebase (prompt layering, draft state machine, webhook shape) — never port code wholesale.

## Stack Decisions (locked at Sprint 1)

- **Language:** TypeScript everywhere (web, api, worker, contracts). The plan left TS/Python open; the architecture (Next.js dashboard, shared `contracts` package) makes a single TS monorepo the lowest-friction choice.
- **Monorepo:** npm workspaces (no extra tooling until it hurts).
- **Web:** Next.js (App Router) — `apps/web`, port 3000.
- **API:** Fastify — `apps/api`, port 3001. Routes → services → DB, matching the planned flow.
- **DB:** SQLite via Drizzle ORM for v0 (zero-setup local dev for founder testing). Drizzle migrations from day one; the schema is kept Postgres-portable and the swap to Postgres is contained inside `apps/api/src/db` (planned at Sprint 8 / RAG time, when infra grows anyway).
- **Validation/contracts:** Zod schemas in `packages/contracts`, shared by api and web.
- **Tests:** Vitest. API tested via Fastify `inject` (no network).
- **LLM:** Google Gemini behind a native, provider-agnostic LLM gateway with trace logging (Sprint 4; founder decision — Gemini key available now). Routes/services/UI depend only on the gateway interface, so adding or switching providers (e.g. Anthropic later) touches one file.

---

## Sprint Map

| Sprint | Theme | Rebuild plan phase | Milestone gate |
|---|---|---|---|
| 1 | Foundation + Workspace | Phase 0 + ticket 3 | M0 |
| 2 | Central Brain v0 | Phase 1 (tickets 4–6) | M1 |
| 3 | Context Resolver | Phase 2 (tickets 7–8) | M2 |
| 4 | Generation Sandbox (completes **Brain Spine v0**) | Phase 3 (tickets 9–10) | M3 |
| 5 | Approval Gate | Phase 4 | M4 |
| 6 | Content Slice v1 | Phase 5 | M5 |
| 7 | Signal Discovery (pulled forward — founder decision 2026-06-11: ideas must originate from the outside world before campaign/RAG buildout; brain judges and routes, it doesn't generate) | Phase 8 | M8 |
| 8 | Campaigns | Phase 6 | M6 |
| 9 | RAG Corpus (R2R) | Phase 7 | M7 |
| 10 | Learning Loop | Phase 9 | M9 |
| 11 | Outbound Slice | Phase 10 | M10 |
| 12 | Connector Fabric (Nango) | Phase 11 | — |
| 13 | CRM read/write (Freshsales) — **accepted 2026-06-11** | Phase 12 | — |
| 14 | Ads Reporting (read-only) | Phase 12 | — |
| 15 | Ad Creative Generation | Phase 12 | — |
| 16 | PR & Media Outreach | Phase 12 | — |
| 17 | Social Publishing (LinkedIn, X, Reddit, Instagram) | Phase 12 | — |
| 18 | Dashboard UX Redesign | — | — |
| 19 | Users, Teams & Auth | — | — |
| 20 | Native Ads Execution | Phase 12 ("much later" item) | — |

Sprints 1–4 together deliver **Brain Spine v0**, the first demoable proof of the moat.

---

## Sprint 1 — Foundation + Workspace (tickets 1–3)

**Goal:** a clean, boring base that runs, tests, and persists a workspace.

Build:
- Monorepo skeleton: `apps/web`, `apps/api`, `apps/worker` (stub), `packages/contracts`, `packages/testing`, `docs/`.
- Drizzle migrations + isolated test database setup.
- Vitest test runner wired at root (`npm test`).
- CI workflow (GitHub Actions): install → typecheck → test.
- Local dev command (`npm run dev` → web + api together).
- API health endpoint (`GET /health`).
- Dashboard shell in Next.js.
- Workspace model, API (`POST/GET /workspaces`, `GET /workspaces/:id`), and UI (list + create).

Explicitly out: content pipeline, RAG, integrations, chat, outbound, brain docs.

**Founder acceptance:** run one command, dashboard loads, health endpoint responds, tests pass visibly, can create and reopen a workspace.

---

## Sprint 2 — Central Brain v0 (tickets 4–6)

**Goal:** the brain is human-readable, editable, and versioned.

Build:
- `brain_documents` model: five docs per workspace — `soul`, `icp`, `voice`, `history`, `now` — auto-created with a workspace.
- Brain document API + tests (read, update; every save creates a version row).
- Brain editor UI (markdown editing per doc).
- `brain_document_versions` history + view of prior versions.
- Brain completeness score (per-doc and workspace-level).
- Full-brain markdown export.

**Founder acceptance:** open workspace → fill all five docs → edit one and see the saved version → export the whole brain and read it as one coherent document.

---

## Sprint 3 — Context Resolver (tickets 7–8)

**Goal:** deterministic, inspectable context bundles. This sprint matters more than generation.

Build:
- Persona model + persona overlay (e.g. CEO voice vs company page).
- Channel overlay defaults.
- Campaign overlay support with empty default state (campaign object itself comes in Sprint 7).
- Resolver service: input (workspace, task type, channel, persona, optional campaign) → output (ordered context bundle).
- Token budget controls.
- Trace explaining why each section was included, in resolution order org → channel → campaign → persona.
- Resolver preview UI: pick persona/channel/task, read the exact bundle before any LLM call.

**Founder acceptance:** create a CEO persona and a company-page persona; the same brain resolves differently for each; the bundle and trace are readable.

---

## Sprint 4 — Generation Sandbox (tickets 9–10) → Brain Spine v0 complete

**Goal:** test whether the brain produces useful output before building any pipeline.

Build:
- LLM gateway (Gemini first, provider-agnostic interface) with full prompt/response trace logging.
- "Generate with brain" sandbox for four task types: LinkedIn post, cold email opener, ad copy variant, landing page hero.
- Resolved context shown before generation (reuses Sprint 3 preview).
- Output rating: `accepted` / `needs edit` / `rejected`, stored as training signals.
- Training signal log view.

**Founder acceptance:** select task + persona → see resolved context → generate → rate → rating appears in the training log. **This is the M3 quality checkpoint: if outputs aren't directionally useful here, fix the brain/resolver before building anything downstream.**

---

## Sprint 5 — Approval Gate

**Goal:** the trust mechanism every future module reuses.

Build:
- Draft object + state machine: `draft → pending_review → (edited ⇄ pending_review) → approved | rejected`.
- Approval queue UI with edit-before-approve.
- Decision log (who, what, when, prior state).
- Sandbox outputs can be sent into the queue.

**Founder acceptance:** generate → queue → edit → approve/reject → decision recorded.

---

## Sprint 6 — Content Slice v1 (first full loop)

**Goal:** manual signal → brain-resolved draft → approval → export. No scrapers.

Build:
- Manual signal submission (paste a Reddit/X/LinkedIn signal).
- Brain-resolved content draft from the signal.
- Drafts flow through the approval queue.
- Copy/export; post to one platform only if credentials are trivially available.
- Content item status tracking.

**Founder acceptance:** paste a real signal → Tuezday drafts a response in the right voice → approve → copy/export it. First end-to-end loop works.

---

## Sprint 7 — Campaigns

**Goal:** GTM becomes goal-scoped instead of one-off.

Build:
- Campaign object: objective, KPI, timeframe, audience slice, messaging pillars, channels, personas.
- Campaign `now` overlay feeding the resolver (slot already exists from Sprint 3).
- Campaign-scoped drafts and basic campaign reporting view.

**Founder acceptance:** create a campaign → resolved context visibly changes → new drafts are tagged to the campaign.

---

## Sprint 8 — RAG Corpus (R2R)

**Goal:** long-tail evidence retrieval without replacing the five docs. First external service.

Build:
- R2R deployed behind the Brain Gateway boundary (Tuezday owns retrieval policy, prompt packing, citation UI).
- Evidence upload + ingestion.
- Retrieval query merged into the resolver bundle, with citations and a retrieval trace.
- Likely alongside: Postgres migration, since infra is being introduced anyway.

**Founder acceptance:** upload website copy/past posts → run a task that needs evidence → output cites sources → trace shows which chunk came from where. No Graphiti, no Mem0.

---

## Sprint 9 — Signal Discovery

**Goal:** discovery as shared infrastructure, not content-only scraping.

Build:
- Signal object + signal inbox.
- Source adapters: RSS first (worker app does its first real job here). Reddit next; X/LinkedIn later depending on API reliability.
- Relevance scoring, campaign assignment, manual triage (accept/skip).
- Accepted signal → content draft (reuses Sprint 6 path).

**Founder acceptance:** add one RSS source → signals appear → triage → accepted signal generates a draft.

---

## Sprint 10 — Learning Loop

**Goal:** outcomes improve the brain, with a human in the loop.

Build:
- Training examples assembled from approvals/rejections/edits.
- Engagement metric import (manual/CSV first).
- Weekly `now` synthesis proposal.
- Human review before anything writes to `now`.

**Founder acceptance:** after several approve/reject decisions, the system proposes a `now` update; founder reviews and accepts; resolver picks it up.

---

## Sprint 11 — Outbound Slice

**Goal:** prove the second module uses the same brain. No sending infrastructure.

Build:
- Lead/account input (CSV import).
- Outbound campaign type.
- Brain-personalized email drafts per lead.
- Approval queue reuse; CSV export (send via Smartlead/Instantly only after Sprint 12).

**Founder acceptance:** import 5 leads → personalized drafts → edit/approve → export.

---

## Sprint 12 — Connector Fabric

**Goal:** stop writing one-off integrations.

Build:
- Connector registry + connection object + health status.
- Nango deployed as a **separate service** (Elastic license — never mixed into Tuezday code).
- Webhook/event contract (salvage shape from prior codebase).
- One real provider connected end-to-end; disconnect/reconnect works.

---

## Sprint 13 — CRM Read/Write ✅ (accepted 2026-06-11)

Freshsales first (founder's CRM, api_key auth) behind a provider-agnostic CrmAdapter — see `docs/specs/sprint-13-crm-read-write.md`. HubSpot/Pipedrive/Salesforce adapters land later under the continuous integration-expansion track (below).

> **Sequencing change (founder decision 2026-06-11):** the rebuild plan's Phase 12 order put Lifecycle messaging (Dittofeed) second. Founder reprioritized: ads reporting → ad creative → PR → social publishing come first. **Lifecycle messaging is deferred**, not cancelled — it re-enters the queue when a founder decision pulls it back in.

---

## Sprint 14 — Ads Reporting (read-only)

> Built 2026-06-12, awaiting founder acceptance. First platform is **Meta Ads** (founder decision 2026-06-12 — live account); token-paste auth through the fabric, full OAuth popup deferred to integration expansion. Spec: `docs/specs/sprint-14-ads-reporting.md`.

**Goal:** Tuezday shows what paid spend is doing, in its own metric model. Read-only — no campaign mutation.

Build:
- Native ad metric model (`ad_account`, `ad_campaign_metric` daily grain: spend, impressions, clicks, conversions) — Tuezday owns this model regardless of source.
- One ad platform first (founder picks the one with a live account — Meta Ads or Google Ads), connected through the Sprint 12 connector fabric (Nango handles OAuth).
- Worker polling job pulls metrics on a schedule; manual "sync now" button.
- Ads reporting view: per-campaign spend/results, and where a Tuezday campaign is linked, metrics shown on the campaign reporting view (Sprint 7 surface).
- CSV import fallback so reporting works even with no connected account (mirrors Sprint 10's manual-first pattern).

Note: the OSS plan reserves Airbyte for sync. For one provider, a worker poll through the Nango proxy is less infra; bring Airbyte in only when a second/third ad source makes one-off polling painful. Revisit at that point — don't deploy Airbyte speculatively.

**Founder acceptance:** connect ad account (or import CSV) → sync → see spend and results per campaign in Tuezday → numbers match the platform's own reporting for the same range.

---

## Sprint 15 — Ad Creative Generation

> Built 2026-06-12, awaiting founder acceptance. Platforms by contract: **Meta** (founder's live account — ties into Sprint 14 reporting) and **Google RSA**. No new tables: a variant set = one generation + N drafts through the existing approval gate; format limits live in `packages/contracts` and are enforced at edit (400) and approve (409), so exported creative can never violate platform limits. Spec: `docs/specs/sprint-15-ad-creative-generation.md`.

**Goal:** the brain produces platform-ready ad creative through the same resolve → generate → approve loop. Copy first; no image generation this sprint (spike only, if time allows).

Build:
- Ad creative task types per platform with hard format constraints (e.g. Google RSA: 15 headlines ≤30 chars, 4 descriptions ≤90; Meta: primary text / headline / description), enforced by contracts in `packages/contracts`.
- Generation resolves context through the resolver (channel overlay = ad platform; campaign overlay drives the offer/angle); variants generated as a set, not one-offs.
- All variants flow through the approval queue; ratings stored as training signals as usual.
- Export approved creative in paste-ready / CSV form for the ad platform.
- Where Sprint 14 metrics exist, show performance next to the creative that ran — the first creative-level feedback surface for the learning loop.

**Founder acceptance:** pick campaign + platform → generate a variant set in the right voice that fits character limits → edit/approve → export and paste into the ad platform without rework.

---

## Sprint 16 — PR & Media Outreach

**Goal:** third proof that a new module is just the same brain + approval gate pointed at a new audience. Structurally a sibling of the Outbound slice (Sprint 11).

Build:
- Media contact model (journalist/publication/podcast: beat, outlet, past coverage notes) + CSV import — no media-database integration yet.
- PR campaign type (announcement, thought-leadership pitch, reactive comment on a discovered signal).
- Brain-personalized pitch drafts per contact (resolver: `history` for proof points, `now` for the news hook, persona = founder voice).
- Press boilerplate / press-kit section generated from brain docs, editable and versioned like any output.
- Approval queue reuse; export to CSV/email client. No sending infra (same rule as outbound).
- Signal-to-PR path: a discovered signal (Sprint 9 inbox) can be triaged into a reactive pitch.

**Founder acceptance:** import 5 media contacts → create a PR campaign → personalized pitches that reference each contact's beat → edit/approve → export.

---

## Sprint 17 — Social Publishing Connections

**Goal:** close the Sprint 6 loop — approved content posts to the actual platform instead of copy/export. Native scheduling, thin; Postiz stays reference-only (AGPL).

Build:
- Social account connection per workspace via the connector fabric (Nango OAuth), with health status in the connector registry.
- Publish action on an approved content draft: post now or schedule (worker job); published URL + status stored on the content item.
- Per-platform constraints (length, media rules) validated before publish.
- Platform order by API friction, one at a time, each accepted before the next:
  1. **Reddit** (easiest OAuth, free tier)
  2. **X** (straightforward API, paid tier — confirm plan/cost before building)
  3. **LinkedIn** (requires Marketing/Community Management API approval — apply at sprint start, build while waiting)
  4. **Instagram** (Meta app review + Business account requirement — longest lead time)
- Realistic exit: 2 platforms fully working in-sprint; LinkedIn/Instagram land when their app reviews clear.

**Founder acceptance:** connect an account → approve a draft → it appears on the platform → published status and link visible in Tuezday. Disconnect/reconnect works.

---

## Sprint 18 — Dashboard UX Redesign

**Goal:** a normal user with zero context can open Tuezday and understand what each screen is for. Internal vocabulary ("resolver", "signals", "overlays") gets translated into plain-language navigation; power detail stays one click deeper.

⛔ **Blocked on input:** founder is sending a reference website for design direction. Do not start visual work before it arrives. This sprint is otherwise independent — pull it earlier the moment the reference link lands.

Build:
- Information architecture pass first: name every nav item and page heading in user language (e.g. "Brain" → "Your company profile" framing, "Signals" → "What's happening in your market", "Approval queue" → "Review & approve") — exact words decided with the founder against the reference site.
- Shared layout system: consistent header, navigation, page titles, empty states that explain what a page is for and what to do first.
- Visual design per the founder's reference link (spacing, type, color, component styling).
- A first-run path: a new workspace lands somewhere that tells the user what Tuezday is and what to do next, instead of an empty dashboard.
- No backend changes; no route/API churn beyond renaming page-level copy.

**Founder acceptance:** someone who has never seen Tuezday opens the dashboard and can say what each section does without being told. Founder confirms it matches the reference's feel.

---

## Sprint 19 — Users, Teams & Auth

**Goal:** more than one human per workspace. Minimum viable identity — not an enterprise auth project.

Scope note (founder comment 2026-06-11: "individual user IDs, I don't think we need user IDs for this now"): team invites are impossible without *some* user identity — the invite has to land on an account, and the approval-gate decision log needs a real "who". The minimum is built here; anything beyond it (SSO, granular permissions, billing seats) is explicitly out.

Build:
- User account: email + password (or magic link), session handling. No SSO, no OAuth login providers yet.
- Workspace membership: a user belongs to one or more workspaces; roles kept to **owner** and **member** only.
- Invite flow: owner enters an email → invitee accepts → joins the workspace.
- Approval gate decision log and brain-doc version history record the acting user (replacing the current implicit single-founder identity).
- All existing API routes scoped to authenticated workspace membership.

Explicitly out: SSO/SAML, role matrices, per-module permissions, billing/plans (a "team plan" is a pricing construct — model it when billing exists).

**Founder acceptance:** founder invites a teammate by email → teammate logs in, sees the workspace → teammate approves a draft → decision log shows who did it. A non-member cannot access the workspace.

---

## Sprint 20 — Native Ads Execution

**Goal:** launch and manage ad campaigns from inside Tuezday. Kept last deliberately — the rebuild plan marks ads execution "much later", and spending real money requires the approval gate *and* real user identity (Sprint 19) to be in place first.

Build:
- One platform only to start (the same one connected in Sprint 14).
- Draft ad campaign object in Tuezday: objective, audience, budget, schedule, creative (from Sprint 15 approved variants).
- Launch flows through the approval gate like everything else — a campaign is `draft → pending_review → approved` *before* any API call that spends money; the decision log records who approved spend.
- Hard guardrails: per-campaign budget cap, workspace-level daily spend cap, pause-all kill switch.
- Status sync back from the platform (active/paused/rejected-by-platform) via the Sprint 14 polling job.

**Founder acceptance:** assemble a campaign from approved creative → approve → it launches on the platform with the set budget → pause from Tuezday works → spend appears in Sprint 14 reporting.

---

## Continuous Tracks (not sprints — ongoing, founder-prioritized)

These never "finish"; they run alongside sprints as capacity allows and never gate a sprint's acceptance.

1. **Discovery source expansion** (extends Sprint 9): keep adding signal adapters — Reddit/X/LinkedIn hardening, Hacker News, YouTube, podcasts, G2/Capterra reviews, Google Trends. Each new adapter follows the existing signal contract; no adapter gets special-cased.
2. **Integration expansion** (extends Sprints 12–13): more CRM adapters behind the existing CrmAdapter (HubSpot, Pipedrive, Salesforce), more ad platforms behind the Sprint 14 metric model, more social platforms behind the Sprint 17 publish contract.
3. **Competitive scan**: recurring look at adjacent platforms (e.g. HubSpot Marketing Hub, Jasper, Copy.ai, Clay, Smartlead/Instantly, Ocoya/Postiz-class schedulers) for feature gaps against the end-to-end GTM orchestration goal. Findings get tested against the standing-risk loop question (know more / act better / learn faster) before anything enters a sprint.

PostHog event capture can still be spiked any time without gating anything. Lifecycle messaging (Dittofeed) remains deferred until pulled back in by founder decision.

---

## Standing Risks

- **Quality gate at Sprint 4:** if sandbox output is generic, do not proceed to Sprint 5 — iterate on brain docs and resolver ordering until outputs are directionally useful.
- **SQLite → Postgres swap (Sprint 8):** keep schema portable; all DB access stays inside `apps/api/src/db`.
- **License boundaries:** Nango (Elastic) and Postiz (AGPL, reference-only) never enter the Tuezday codebase.
- **Scope gravity:** every "can we just add a scheduler/scraper/automation" request gets tested against the loop: does it help the system know more, act better, or learn faster *now*?
