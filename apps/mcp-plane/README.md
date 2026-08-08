# @tuezday/mcp-plane

A stdio MCP server that wraps the [Plane](https://plane.so) REST API so Claude Code can
read and update the team's board (`app.plane.so/tuezday-ai`) while working in this repo.

This is **dev tooling, not product code** — it is not part of the shipped platform and has
no dependency on `apps/api`. The product-facing MCP server is `apps/mcp`.

## Setup

1. In Plane: **Workspace Settings → API Tokens → Add API token**. Copy the token.
2. Paste it into the repo-root `.env` (gitignored, same place as every other secret here):

   ```sh
   PLANE_API_KEY=plane_api_...
   ```

   The server reads `.env` itself, so no shell export is needed. A real environment
   variable of the same name still wins if you prefer to export one.
3. Restart Claude Code in this directory and approve the `plane` server when prompted
   (`/mcp` lists its status).

| Variable | Default | Purpose |
|---|---|---|
| `PLANE_API_KEY` | — | Required. Workspace API token. |
| `PLANE_WORKSPACE_SLUG` | `tuezday-ai` | Workspace slug from the Plane URL. |
| `PLANE_API_BASE_URL` | `https://api.plane.so/api/v1` | Override for self-hosted Plane. |

Run it standalone to check that it boots (deps are hoisted, so this works without a
fresh `npm install`; run `npm install` once if you want `npm start -w apps/mcp-plane`
to resolve too):

```sh
PLANE_API_KEY=... npx tsx apps/mcp-plane/src/index.ts
```

## Tools

Everything is read or create/update — **no tool in this server deletes anything**, and
`plane_raw_get` is GET-only by construction.

| Tool | What it does |
|---|---|
| `plane_list_projects` | All projects in the workspace |
| `plane_list_states` / `plane_list_labels` / `plane_list_members` | Project vocabulary |
| `plane_list_work_items` | Work items, filtered by state, priority, assignee, label, or title search |
| `plane_get_work_item` | One work item in full, description included |
| `plane_create_work_item` | Create a work item |
| `plane_update_work_item` | Partial update (title, description, state, priority, assignees, labels, dates) |
| `plane_list_comments` / `plane_add_comment` | Work item discussion |
| `plane_list_cycles` / `plane_get_cycle_work_items` / `plane_add_work_items_to_cycle` | Sprints |
| `plane_list_modules` / `plane_get_module_work_items` / `plane_add_work_items_to_module` | Feature groupings |
| `plane_raw_get` | Read-only escape hatch for endpoints not wrapped here |

### Names, not UUIDs

Plane's API speaks UUIDs; every tool argument here also accepts a human name, so you can
say `project: "Tuezday"`, `state: "In Progress"`, `assignee: "aditya"`, and reference work
items as `TUEZ-42` or a bare sequence number. Resolution is exact-match first, then a
unique case-insensitive substring match; an ambiguous or missing name returns an error
listing the valid options. Lookups are cached for 5 minutes and flushed after every write.

## Layout

- `src/client.ts` — HTTP client: auth header, trailing-slash paths, cursor pagination
- `src/resolve.ts` — name → UUID resolution and caching
- `src/format.ts` — compact projections (UUIDs swapped for names, HTML stripped)
- `src/index.ts` — server wiring and tool definitions

## Caveats

The Plane API surface here was written against the documented v1 shapes and verified by
typecheck, not against a live workspace — run `plane_list_projects` first after adding
your token to confirm the connection, and use `plane_raw_get` to inspect any endpoint
whose response shape differs. Membership and cycle/module-item rows are read
defensively (nested or flattened member objects both work) for that reason.
