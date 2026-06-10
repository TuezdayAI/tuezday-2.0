# Spec: Sprint 1 — Foundation + Workspace

> Status: in build
> Covers rebuild-plan tickets 1–3 (repo skeleton + CI, migrations + test DB, workspace model/API/UI).

## What this slice does

A founder can clone the repo, run one install and one dev command, open a dashboard, create a workspace, and see it persist. Tests run with one command and visibly pass.

## Out of scope

Brain documents, personas, resolver, generation, approval, integrations, auth (single-tenant local for now), worker jobs.

## Behavior

### API (`apps/api`, port 3001)

| Endpoint | Behavior |
|---|---|
| `GET /health` | `200 {"status":"ok"}` — also reports DB connectivity |
| `POST /workspaces` | body `{name: string (1–100 chars after trim)}` → `201` created workspace. `400` on missing/empty/too-long name. |
| `GET /workspaces` | `200` list, newest first |
| `GET /workspaces/:id` | `200` workspace or `404 {"error":"workspace_not_found"}` |

Workspace shape: `{ id: uuid, name: string, createdAt: epoch-ms, updatedAt: epoch-ms }`.

### Web (`apps/web`, port 3000)

- Dashboard shell with Tuezday header.
- Workspace list (empty state included) + create form calling the API.
- Created workspace appears without manual refresh.

### Data

- SQLite via Drizzle ORM; migrations checked in under `apps/api/drizzle/`.
- Tests run against an in-memory SQLite DB with the same migrations applied.

## Automated verification

- `npm test` — contracts validation tests + API tests (health, create/list/get workspace, validation errors, 404).
- `npm run typecheck` — all packages compile.

## Founder acceptance checklist

1. `npm install` then `npm run dev` works from a clean checkout.
2. http://localhost:3000 loads the dashboard shell.
3. http://localhost:3001/health returns ok.
4. Create a workspace in the UI; restart dev server; it is still there.
5. `npm test` output is readable and green.
