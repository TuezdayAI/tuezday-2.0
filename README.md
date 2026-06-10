# Tuezday

AI-powered GTM orchestration platform. The product is GTM that remembers: one shared brain (`soul`, `icp`, `voice`, `history`, `now`) that every campaign, channel, and module resolves context from.

Planning docs: `product-strategy-and-positioning.md`, `greenfield-rebuild-plan.md`, `oss-integration-recommendations.md`, `docs/plans/sprint-plan.md`.

## Getting started

```bash
npm install
npm run dev      # API on http://localhost:3001, web on http://localhost:3000
npm test         # run all tests
npm run typecheck
```

## Layout

```
apps/
  web/        # Next.js dashboard (port 3000)
  api/        # Fastify API + services + Drizzle/SQLite (port 3001)
  worker/     # background jobs (stub until Sprint 9)
packages/
  contracts/  # shared zod schemas and types
  testing/    # shared test fixtures
docs/
  plans/ specs/
```

The API stores data in `apps/api/tuezday.db` (SQLite, gitignored). Tests run against in-memory databases with the same checked-in migrations.
