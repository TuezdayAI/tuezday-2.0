# Tuezday

AI-powered GTM orchestration platform. The product is GTM that remembers: one shared brain (`soul`, `icp`, `voice`, `history`, `now`) that every campaign, channel, and module resolves context from.

Planning docs: `product-strategy-and-positioning.md`, `greenfield-rebuild-plan.md`, `oss-integration-recommendations.md`, `docs/plans/sprint-plan.md`.

## Getting started

```bash
npm install
npm run dev      # API :3001, web :3000, and the required background worker
npm run dev:app  # API + web only (no automatic background processing)
npm test         # run all tests
npm run typecheck
```

Copy `.env.example` to `.env` and set `TUEZDAY_WORKER_TOKEN` before starting
the complete stack. The API and worker are both required production processes:
the worker wakes validated, non-overlapping loops; the API owns scheduler
leases, database access, and discovery/automation task identity.

## Layout

```
apps/
  web/        # Next.js dashboard (port 3000)
  api/        # Fastify API + services + Drizzle/SQLite (port 3001)
  worker/     # validated, non-overlapping background task loops
packages/
  contracts/  # shared zod schemas and types
  testing/    # shared test fixtures
docs/
  plans/ specs/
```

The API stores data in `apps/api/tuezday.db` (SQLite, gitignored). Tests run against in-memory databases with the same checked-in migrations.

Worker traffic uses `TUEZDAY_INTERNAL_API_URL` (HTTPS outside loopback) and
never uses the browser/MCP `TUEZDAY_API_URL`. Discovery and automation call
worker-only `/internal/*` endpoints; the remaining maintenance routes use a
small explicit allowlist. See `.env.example` for interval defaults and bounds.
