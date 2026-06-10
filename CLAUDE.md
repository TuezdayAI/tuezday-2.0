# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository State

This is the greenfield rebuild of Tuezday, an AI-powered GTM (go-to-market) orchestration platform. Phase 0 (foundation + workspace slice) is built. The planning documents define what gets built and in what order:

- `product-strategy-and-positioning.md` — what Tuezday is and is not
- `greenfield-rebuild-plan.md` — phased build order, feature gate protocol, milestones
- `oss-integration-recommendations.md` — build-native vs integrate-OSS decisions per layer
- `docs/plans/sprint-plan.md` — sprint-by-sprint execution plan (current source of truth for sequencing)
- `docs/specs/` — one written spec per slice, created before implementation

Any code written here must follow these documents. Read the relevant sections before scaffolding or implementing anything.

## Commands

- `npm install` — install all workspaces (npm workspaces monorepo)
- `npm run dev` — run API (Fastify, http://localhost:3001) and web (Next.js, http://localhost:3000) together
- `npm test` — run all Vitest suites (contracts + api); API tests use in-memory SQLite with the checked-in Drizzle migrations
- `npm run typecheck` — `tsc --noEmit` across all workspaces
- `npm run db:generate -w apps/api` — generate a Drizzle migration after editing `apps/api/src/db/schema.ts`

## Stack (locked at Sprint 1)

TypeScript everywhere. Next.js App Router (`apps/web`), Fastify (`apps/api`, routes → services → db), Drizzle ORM on better-sqlite3 (Postgres swap planned ~Sprint 8 — keep the schema portable, keep all DB access inside `apps/api/src/db` and services). Shared zod contracts live in `packages/contracts` and are the only place enum vocabularies (brain doc types, approval states, output ratings) are defined.

## Core Product Concept

Tuezday's moat is the **Central Brain**: five human-readable, editable brain documents per workspace — `soul`, `icp`, `voice`, `history`, `now` — layered with overlays (org → channel → campaign → persona) that a **Context Resolver** turns into a deterministic, inspectable context bundle before any LLM call. Every module (Content, Outbound, Ads, PR) must resolve context through this same brain contract. Generated outputs flow through an **Approval Gate** (draft → pending_review → edited/approved/rejected), and approval decisions feed a learning loop back into the `now` doc.

## Non-Negotiable Build Rules

1. **Brain first.** Build order is: Foundation → Central Brain → Context Resolver → Generation Sandbox → Approval Gate → Manual Content Slice → Campaigns → RAG → Discovery → Learning Loop → Outbound → Connector Fabric → CRM/Ads/Lifecycle. Do not skip ahead (e.g., no scrapers before manual signal input works, no sending infra before content proves the brain).
2. **One vertical slice at a time.** Each slice: written spec → automated tests before implementation → build → automated verification → founder manually tests → accepted → frozen with tests. No new slice until the previous is accepted.
3. **No module may depend on a fake brain contract**, and no integration gets added until the native boundary it plugs into exists.
4. Every slice must produce something a human can see and test.

## Architecture (planned)

Monorepo layout:

```
apps/
  web/        # Next.js dashboard
  api/        # HTTP API, application services, DB access
  worker/     # background jobs, polling/sync
packages/
  contracts/  # shared types/contracts
  brain/      # brain docs, overlays, context resolution
  modules/    # content, outbound, ads, PR module runtime
  integrations/
  testing/    # test fixtures
docs/
  strategy/ specs/ plans/
```

Flow: UI → API routes → services → (DB | brain | modules); worker jobs call services; polling lives in integrations.

## Build-Native vs Integrate Boundaries

Native (must own — these encode Tuezday's GTM intelligence): brain ontology and docs, overlay/context resolution, prompt packing, campaign model, approval gate, GTM dashboard, social scheduling, core workflows.

Integrate behind service/API boundaries (never fork into core):

| Capability | Primary | Notes |
|---|---|---|
| RAG/evidence corpus | R2R | RAGFlow backup; Tuezday owns retrieval policy and citations UI |
| OAuth/connectors | Nango | Elastic license — deploy as separate service, never mix code into Tuezday |
| Workflow automation | Activepieces | external automations only, never core generation/approval logic |
| Data sync | Airbyte | Tuezday owns the metric model |
| CRM | Customer's HubSpot/Salesforce/Pipedrive | Twenty as OSS demo fallback; Tuezday is not a CRM |
| Lifecycle messaging | Dittofeed | later scope |
| Analytics | PostHog (product/web), Superset (internal BI) | customer dashboard stays native |
| Outbound sending | Smartlead/Instantly | never build deliverability/warmup infra |

Defer: Graphiti (temporal graph) and Mem0 — only after RAG is useful. Avoid as core: Dify, n8n, Postiz (reference only, AGPL).

## First Slice: "Brain Spine v0"

If starting implementation, the first feature is: workspace creation + five brain docs + brain editor + persona overlay + context resolver + resolved context preview + one generation sandbox action with accept/edit/reject rating. It explicitly excludes RAG, scraping, posting, outbound, CRM, chat copilot, and analytics.

First 10 tickets are enumerated at the end of `greenfield-rebuild-plan.md` — follow them in order, each tested and accepted before the next.

## Conventions From the Plans

- Approval states: `draft`, `pending_review`, `approved`, `rejected`, `edited`.
- Resolver input: workspace, task type, channel, persona, optional campaign → output: ordered context bundle with a trace explaining why each section was included. Context must be readable before any LLM call.
- Output ratings (`accepted` / `needs edit` / `rejected`) are stored as training signals.
- A prior Tuezday codebase exists elsewhere; salvage concepts (prompt layering, approval statuses, draft state machine, training examples, webhook/event shape) but do not port code wholesale.
- Update this file with actual build/test/dev commands once the monorepo skeleton (Phase 0) exists.
