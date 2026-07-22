# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository State

This is the greenfield rebuild of Tuezday, an AI-powered GTM (go-to-market) orchestration platform. The foundation and most core modules are built: brain + context resolver, generation + approval gate, campaigns, discovery, evidence/RAG, learning loop, outbound, the connector fabric, and the CRM/Ads/PR/social slices, plus users/teams/auth. Sprints 1–20 are on `main`; Sprints 21+ are delivered one branch at a time (see Sprint Delivery Workflow). The `apps/api/drizzle` migration list and `git log` are the source of truth for exactly how far the schema has progressed.

The planning documents define what gets built and in what order — read the relevant sections before scaffolding or implementing anything:

- `product-strategy-and-positioning.md` — what Tuezday is and is not
- `greenfield-rebuild-plan.md` — phased build order, feature gate protocol, milestones
- `oss-integration-recommendations.md` — build-native vs integrate-OSS decisions per layer
- `docs/plans/sprint-plan.md` — Sprints 1–20 execution plan
- `docs/plans/sprint-guide-21-onward.md` — post-Sprint-20 roadmap (current sequencing source of truth)
- `docs/specs/` — one written spec per slice, created before implementation

## Commands

- `npm install` — install all workspaces (npm workspaces monorepo; Node ≥ 20)
- `npm run dev` — run API (Fastify, http://localhost:3001) and web (Next.js, http://localhost:3000) together
- `npm test` — run all Vitest suites (api + contracts + brain). API tests use in-memory SQLite with the checked-in Drizzle migrations
- `npm test -- <substring>` — run only test files whose path matches (e.g. `npm test -- brain`); add `-t "<name>"` to filter by test name
- `npm run typecheck` — `tsc --noEmit` across all workspaces (there is no lint step)
- `npm run db:generate -w apps/api` — generate a Drizzle migration after editing `apps/api/src/db/schema.ts` (commit the generated SQL under `apps/api/drizzle/`)
- `npm run nango:up` / `nango:down` — bring the Nango connector backend up/down via Docker Compose (`infra/`). Not needed for tests, which inject fakes.
- `npm run evidence:migrate` — one-time R2R → native evidence-store migration (Sprint 47); `npm run evidence:parity -- <workspace-id>` compares retrieval quality against a still-running R2R.
- `npm run test:watch` — run Vitest in watch mode (alias: `vitest`)

## Environment

Copy `.env.example` to `.env` at the repo root (dev server loads it via dotenv). Required vars:

- `GEMINI_API_KEY` — Gemini 2.5 Flash (default LLM). `GEMINI_MODEL` overrides the model name.
- `TUEZDAY_WORKER_TOKEN` — system actor token used by the worker to call the API across workspaces. Generate with: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
- `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` — social publishing connector (Sprint 17).
- `LINKEDIN_CLIENT_ID/SECRET`, `TWITTER_CLIENT_ID/SECRET`, `INSTAGRAM_CLIENT_ID/SECRET` — social trio (Sprint 25+). Leave blank until those connectors are wired.

CI (`.github/workflows/ci.yml`) runs `npm run typecheck && npm test` on Node 22 for every push and PR — keep it green before pushing sprint branches.

## Stack (locked at Sprint 1)

TypeScript everywhere, ESM (`"type": "module"`), run directly with `tsx` (no build step in dev). Next.js App Router (`apps/web`), Fastify (`apps/api`, routes → services → db), Drizzle ORM on better-sqlite3 (Postgres swap planned — keep the schema portable, keep all DB access inside `apps/api/src/db` and services). The default LLM is Gemini 2.5 Flash via a provider-agnostic gateway. Shared zod contracts live in `packages/contracts` and are the **only** place enum vocabularies (brain doc types, approval states, output ratings, task types, channels, roles) are defined — import them, never redeclare.

## Core Product Concept

Tuezday's moat is the **Central Brain**: five human-readable, editable brain documents per workspace — `soul`, `icp`, `voice`, `history`, `now` — layered with overlays (org → channel → campaign → persona) that a **Context Resolver** (`packages/brain`) turns into a deterministic, inspectable context bundle before any LLM call. Every module (Content, Outbound, Ads, PR) must resolve context through this same brain contract. Generated outputs flow through an **Approval Gate** (draft → pending_review → edited/approved/rejected), and approval decisions feed a learning loop back into the `now` doc.

## How the API is wired (read this before touching `apps/api`)

`apps/api/src/app.ts` exports `buildApp(options)` — the single composition root. It takes injectable dependencies and registers every route group:

```
buildApp({ db, llm?, fetcher?, evidence?, connectors?, workerToken? })
```

- Real runtime (`server.ts`) supplies the live `GeminiGateway`, `DbEvidenceStore` (native, shares the gateway for embeddings), `NangoFabric`, and global `fetch`.
- Tests supply an in-memory db and fake gateways/fabrics. **Every new external dependency must be an injectable option with a real default**, so tests never hit the network.
- Each route group is `registerXRoutes(app, db, ...deps)`. Routes are thin — they validate with a contracts zod schema, then call a service in `apps/api/src/services/`. Business logic and all DB access live in services, not routes.

Key seams (integrations live behind these interfaces — never let provider code leak into services):

- **LLM** — `llm/gateway.ts` defines `LlmGateway` / `GenerateParams` / `GenerateResult` and `GatewayError`. `gemini.ts` is the only implementation. Services depend on the interface only.
- **Evidence/RAG** — `evidence/store.ts` (`EvidenceStore`) with `evidence/db-store.ts` (`DbEvidenceStore`, native SQLite FTS5 + sqlite-vec) as the impl since Sprint 47 — no external service.
- **Connectors** — `connectors/fabric.ts` (`ConnectorFabric`) with `connectors/nango.ts`; concrete providers under `connectors/{ads,crm,social}` (Meta ads, Freshsales CRM, Reddit social).
- **Discovery** — `discovery/adapters.ts` takes an injected `Fetcher` so tests feed fixtures instead of real HTTP.
- **Mailer** — `mail/mailer.ts` (`Mailer`) with a Resend-backed impl; console fallback in dev/tests.
- **OutboundExporter** — `outbound/exporter.ts` (`OutboundExporter`) produces export files for Smartlead/Instantly; CSV by default.

## Auth model

`auth/guard.ts` installs one global `preHandler` (`registerAuthGuard`, registered before all routes). Every route outside the `PUBLIC_ROUTES` allowlist (`/auth/register`, `/auth/login`, `/health`) needs a bearer token. A request resolves to an `Actor`:

- a signed-in user (session token → `sessionUser`), or
- the **system** actor when the token equals `TUEZDAY_WORKER_TOKEN` (how the worker calls the API across all workspaces).

Any `/workspaces/:id/...` route additionally requires membership in that workspace (system bypasses). Services attribute writes via `actorOf(request)` for version history / decision logs.

## Database

`db/index.ts` → `createDb(file)` opens better-sqlite3 (WAL, `foreign_keys = ON`) and runs the checked-in migrations from `apps/api/drizzle/`. Pass `":memory:"` for tests. The dev DB is `apps/api/tuezday.db` (gitignored). Schema is one file: `apps/api/src/db/schema.ts` — edit it, then `db:generate` to produce a migration; do not hand-write migration SQL.

## Testing patterns

Vitest is configured per-workspace (`vitest.config.ts` `projects`). API tests (`apps/api/test/`) use `test/helpers.ts`:

- `createTestDb()` — fresh in-memory DB with all migrations.
- `buildAuthedApp(options)` — builds the app and registers a default "founder" user; every `app.inject()` carries their bearer token, so the auth layer stays real (no bypass flag).
- `asUser(app, token)` / `registerUser(app, ...)` for multi-user scenarios.

Tests drive the app with `app.inject(...)` (no live server) and assert against the contracts zod schemas. Follow the existing one-file-per-slice convention.

## Sprint Delivery Workflow (Sprints 21+)

Sprints 1–20 are already on `main`. Deliver each subsequent sprint as follows (founder decision, 2026-06-17):

1. **One branch per sprint.** Branch from `main`, named `sprint-NN-<slug>` (e.g. `sprint-21-runtime-editable-guidance`).
2. **Dependency caveat.** If a sprint's "Builds on" includes an earlier **21+** sprint not yet merged into `main`, branch off that predecessor's branch instead and state the required merge order at the top of the sprint's spec. (Phase A — 21/22/23 — only depends on already-merged sprints, so each is independent off `main`.)
3. **Detailed spec first.** Write a self-contained `docs/specs/sprint-NN-*.md` (spec + step-by-step plan + Progress log) before implementing, and ask the founder any clarifying questions first. The founder resets the session between sprints, so the spec must stand alone.
4. **Tests before/with implementation; verify green.** `npm test` and `npm run typecheck` must pass.
5. **Commit to the sprint branch, then push it to GitHub** (`git push -u origin sprint-NN-<slug>`). End commit messages with the `Co-Authored-By: Claude Opus 4.8` trailer.
6. **Do NOT merge into `main`.** The founder reviews, accepts, and merges each branch himself, one at a time, when he has time. Roadmap/planning docs and this file live on `main`; per-sprint specs travel on their sprint branch.
7. One sprint at a time; do not start the next until asked.

## Non-Negotiable Build Rules

1. **Brain first.** Build order is: Foundation → Central Brain → Context Resolver → Generation Sandbox → Approval Gate → Manual Content Slice → Campaigns → RAG → Discovery → Learning Loop → Outbound → Connector Fabric → CRM/Ads/Lifecycle. Do not skip ahead (e.g., no scrapers before manual signal input works, no sending infra before content proves the brain).
2. **One vertical slice at a time.** Each slice: written spec → automated tests before implementation → build → automated verification → founder manually tests → accepted → frozen with tests. No new slice until the previous is accepted.
3. **No module may depend on a fake brain contract**, and no integration gets added until the native boundary it plugs into exists.
4. Every slice must produce something a human can see and test.

## Build-Native vs Integrate Boundaries

Native (must own — these encode Tuezday's GTM intelligence): brain ontology and docs, overlay/context resolution, prompt packing, campaign model, approval gate, GTM dashboard, social scheduling, core workflows.

Integrate behind service/API boundaries (never fork into core):

| Capability | Primary | Notes |
|---|---|---|
| RAG/evidence corpus | Native since Sprint 47 (SQLite FTS5 + sqlite-vec) | R2R retired; RAGFlow only if heavy PDF parsing becomes core |
| OAuth/connectors | Nango | Elastic license — deploy as separate service, never mix code into Tuezday |
| Workflow automation | Activepieces | external automations only, never core generation/approval logic |
| Data sync | Airbyte | Tuezday owns the metric model |
| CRM | Customer's HubSpot/Salesforce/Pipedrive | Twenty as OSS demo fallback; Tuezday is not a CRM |
| Lifecycle messaging | Dittofeed | later scope |
| Analytics | PostHog (product/web), Superset (internal BI) | customer dashboard stays native |
| Outbound sending | Smartlead/Instantly | never build deliverability/warmup infra |

Defer: Graphiti (temporal graph) and Mem0 — only after RAG is useful. Avoid as core: Dify, n8n, Postiz (reference only, AGPL).

## Conventions From the Plans

- Enum vocabularies are defined once in `packages/contracts` — approval states (`draft`, `pending_review`, `approved`, `rejected`, `edited`), output ratings (`accepted` / `needs_edit` / `rejected`), brain doc types, task types, channels, workspace roles. Import them; do not redeclare.
- Approval state transitions must use `transitionTo()` / `canTransition()` from `packages/contracts` — the canonical state machine. Same for `adLaunchTransitionTo()`. Never roll your own transition logic.
- Resolver input: workspace, task type, channel, persona, optional campaign → output: ordered context bundle with a trace explaining why each section was included. Context must be readable before any LLM call.
- Output ratings are stored as training signals that feed the learning loop back into the `now` doc.
- A prior Tuezday codebase exists elsewhere; salvage concepts (prompt layering, approval statuses, draft state machine, training examples, webhook/event shape) but do not port code wholesale.
- `apps/worker` is still a thin stub; background polling/sync that needs cross-workspace access calls the API as the system actor with `TUEZDAY_WORKER_TOKEN`.
