# Spec: Sprint 7 — Signal Discovery

> Status: in build
> Pulls Phase 8 of the rebuild plan forward (founder decision, 2026-06-11): discovery infrastructure must exist before campaigns/RAG so that ideas originate from the outside world, not from the brain prompting itself. Campaigns become Sprint 8, RAG Sprint 9.

## Why (founder framing)

Today, generation ideas come from the brain via the LLM — the system is talking to itself. Discovery inverts this: **signals come from the outer world** (RSS, Google News, Reddit; X/LinkedIn when API keys exist), and the **brain's job is judgment and routing** — scoring each discovered item for relevance and suggesting which persona/pipeline it belongs to. The brain inspires the sourcing (suggested queries/subreddits derived from personas + brain docs) and judges the catch; it does not invent the signals.

## What this slice does

The founder registers discovery sources (or accepts brain-suggested ones). Tuezday fetches items from those sources, dedupes them, scores each against the workspace's brain + personas (relevance 0–100, suggested persona, one-line reason), and queues them in a triage inbox sorted by relevance. Accepting an item creates a Sprint 6 signal (closed loop into draft → approval → export); skipping dismisses it. Source types without credentials yet (X, LinkedIn) are registered in the same infrastructure with status `needs_api_key` and flip live later without schema changes.

## Out of scope

X/LinkedIn live fetching (infrastructure + status only), campaign assignment (Sprint 8), auto-drafting without human triage, engagement-based re-ranking (learning loop sprint), webhooks/streaming, OAuth flows (Nango arrives with the connector fabric sprint).

## Behavior

### Source types (contracts)

`rss`, `google_news`, `reddit` (live now) · `x`, `linkedin` (registered, `needs_api_key`).

- `rss`: config `{feedUrl}` — fetches and parses the feed (RSS 2.0/Atom).
- `google_news`: config `{query}` — built as a Google News RSS search feed, same parser.
- `reddit`: config `{subreddit?, query}` — Reddit's public JSON search (no key, low volume, proper User-Agent). Official-API switch later only touches the adapter.
- `x`/`linkedin`: config `{query}` — adapter refuses with `needs_api_key`; source row shows that status.

Signal sources gain `rss` and `news` so accepted items keep honest provenance.

### Data

- `discovery_sources`: id, workspaceId, type, name, configJson, enabled, status (`active` | `needs_api_key` | `error`), lastError (nullable), lastFetchedAt (nullable), createdAt.
- `discovered_items`: id, workspaceId, sourceId, externalId (unique per source — dedupe key), title, url, summary, publishedAt (nullable), score (nullable until scored), suggestedPersonaId (nullable), scoreReason (nullable), status (`new` | `accepted` | `skipped`), signalId (nullable, set on accept), createdAt.

### Pipeline

`run` (manual button now, worker poll on an interval too):
1. For each enabled, non-`needs_api_key` source: adapter fetches items (injectable fetcher — tests use fixtures, no network). Adapter errors mark the source `error` + `lastError` without failing the run.
2. New items (per-source `externalId` dedupe) are inserted as `new`.
3. Unscored items are scored in batches through the LLM gateway with a compact brain digest (soul/icp/now, truncated) + persona list → strict JSON `{score 0-100, personaId|null, reason}` per item. Parse failures leave items unscored but still triagable — scoring assists judgment, never gates it.

Triage: accept → creates a signal (source mapped: reddit→reddit, google_news→news, rss→rss, content = title + summary, sourceUrl = url), links it, status `accepted`. Skip → `skipped`.

Brain-suggested sources: `POST /discovery/suggest` asks the gateway (brain + personas in context) for 3–6 concrete source proposals (Google News queries, subreddits) with rationales; founder picks which to add. Proposals are never auto-registered.

### API

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/discovery/sources` | create source (validated per-type config) |
| `GET /workspaces/:id/discovery/sources` | list with status |
| `PATCH /workspaces/:id/discovery/sources/:sourceId` | enable/disable, rename, reconfigure |
| `DELETE /workspaces/:id/discovery/sources/:sourceId` | remove (items cascade) |
| `POST /workspaces/:id/discovery/run` | run the pipeline; returns per-source results `{fetched, new, errors}` + `scored` count |
| `GET /workspaces/:id/discovery/items?status=` | triage list, score desc then newest |
| `POST /workspaces/:id/discovery/items/:itemId/accept` | → signal, returns `{item, signal}`; 409 if not `new` |
| `POST /workspaces/:id/discovery/items/:itemId/skip` | → skipped; 409 if not `new` |
| `POST /workspaces/:id/discovery/suggest` | brain-proposed sources (not persisted) |

### Worker (`apps/worker` — first real job)

Polls `GET /workspaces` then `POST .../discovery/run` for each, every `DISCOVERY_INTERVAL_MIN` (default 30) minutes against `TUEZDAY_API_URL` (default localhost:3001). Runs alongside `npm run dev`; failures log and retry next tick. The API stays the only owner of DB access.

### Web (`/workspaces/[id]/discovery`)

1. Sources panel: add form (type-aware fields), status badges (active / needs API key / error with message), enable/disable toggle, delete, **Run discovery now**, **Suggest sources** (brain proposals with one-click add).
2. Triage inbox: items sorted by score, each showing score badge, suggested persona, reason, source, title linking out, summary; **Accept → signal** / **Skip**. Accepted items link to the Content page.
3. Nav links from the other workspace pages.

## Automated verification

- Adapters: RSS/Atom fixture parsing (titles, links, GUIDs, dates), Google News URL construction, Reddit JSON fixture parsing, x/linkedin refusal.
- Pipeline: run with fake fetcher + fake gateway — inserts, dedupes on second run, scores in batch, marks failing source `error` while others proceed, skips disabled and `needs_api_key` sources.
- Scoring: JSON parsing, clamping, malformed-response tolerance.
- Triage: accept creates a correctly-mapped signal and links it; double-accept 409; skip; filters.
- Sources: CRUD + per-type config validation + 404s.

## Founder acceptance checklist

1. Add one RSS feed and one Google News query; add a Reddit source for a relevant subreddit.
2. Click "Suggest sources" — proposals visibly derive from your personas/brain.
3. Run discovery → triage inbox fills with scored, persona-tagged real-world items.
4. Accept the best item → it appears as a signal in Content → draft as CEO → approve → export. **The loop now starts in the outside world.**
5. Add an X source → it shows "needs API key" and does nothing until a key exists.
