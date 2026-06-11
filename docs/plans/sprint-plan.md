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
| 13+ | CRM → Lifecycle → Ads reporting → Ad creative → PR | Phase 12 | — |

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

## Sprint 13+ — Integration Expansion (strict order)

1. CRM read/write (customer's HubSpot/Salesforce/Pipedrive; Twenty as demo fallback). *In build: Freshsales first (founder's CRM, api_key auth) behind a provider-agnostic CrmAdapter — see `docs/specs/sprint-13-crm-read-write.md`.*
2. Lifecycle messaging (Dittofeed).
3. Ads reporting read-only (Airbyte for sync; Tuezday owns the metric model).
4. Ad creative generation.
5. PR/media outreach.
6. Ads execution — much later.

PostHog event capture can be spiked any time after Sprint 6 without gating anything.

---

## Standing Risks

- **Quality gate at Sprint 4:** if sandbox output is generic, do not proceed to Sprint 5 — iterate on brain docs and resolver ordering until outputs are directionally useful.
- **SQLite → Postgres swap (Sprint 8):** keep schema portable; all DB access stays inside `apps/api/src/db`.
- **License boundaries:** Nango (Elastic) and Postiz (AGPL, reference-only) never enter the Tuezday codebase.
- **Scope gravity:** every "can we just add a scheduler/scraper/automation" request gets tested against the loop: does it help the system know more, act better, or learn faster *now*?
