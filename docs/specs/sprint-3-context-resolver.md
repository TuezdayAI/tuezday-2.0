# Spec: Sprint 3 — Context Resolver

> Status: in build
> Covers rebuild-plan tickets 7–8 (persona model + overlay, context resolver service + preview UI). Phase 2 of the rebuild plan, milestone M2.

## What this slice does

The founder can create personas (e.g. "CEO voice", "Company page") and resolve the brain into a deterministic, ordered, inspectable context bundle for a given task type, channel, and persona — **before any LLM call exists**. Every section in the bundle carries a reason explaining why it was included, excluded, or dropped. The same brain resolves differently for different personas, and the founder can read exactly how.

## Out of scope

Generation/LLM calls (Sprint 4), campaign objects (Sprint 7 — the campaign layer resolves as an explicit empty slot), RAG/evidence (Sprint 8), channel overlay editing (channel guidance ships as built-in defaults this sprint).

## Behavior

### Vocabulary (contracts)

- Task types (shared with the Sprint 4 sandbox): `linkedin_post`, `cold_email_opener`, `ad_copy_variant`, `landing_page_hero`.
- Channels: `linkedin`, `x`, `email`, `ads`, `web`.

### Personas (DB + API)

Persona: `{ id, workspaceId, name (1–100), description (≤500, who is speaking), overlay (markdown ≤10,000 — voice/POV adjustments layered on top of the org brain), createdAt, updatedAt }`.

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/personas` | `201` persona. `400` invalid input, `404` unknown workspace. |
| `GET /workspaces/:id/personas` | `200` list, newest first. |
| `PUT /workspaces/:id/personas/:personaId` | full replace, `200`. `404` unknown persona. |
| `DELETE /workspaces/:id/personas/:personaId` | `204`. `404` unknown persona. |

### Resolver (`packages/brain`, pure + deterministic)

`resolveContext(input)` takes workspace name, the five doc contents, task type, channel, optional persona, optional campaign overlay (always absent this sprint), and an optional token budget (default 8,000; tokens estimated as ceil(chars/4)).

Output: an ordered list of sections — **org layer first (soul, icp, voice, history, now), then channel, then campaign, then persona, then task instruction** — where every section has `{ key, layer, title, content, included, reason, tokens }`:

- Empty brain docs appear with `included: false`, reason "doc is empty".
- Channel section uses built-in default guidance per channel, reason says so.
- Campaign section is always `included: false` this sprint, reason "no campaign overlay yet (campaigns arrive in a later slice)".
- No persona selected → persona section excluded with reason "no persona selected; org voice applies".
- Task instruction (built-in per task type) is always last and always included.
- **Token budget:** if included sections exceed the budget, whole sections are dropped in a fixed sacrifice order — `history` first, then `channel` — each marked excluded with a "dropped to fit token budget" reason. If it still exceeds the budget, the bundle is flagged `overBudget: true` (nothing else is silently cut).

Also returns `prompt` — the assembled text of included sections — plus `includedTokens`, `tokenBudget`, `overBudget`. Same input ⇒ same output, always.

### Resolve API

`POST /workspaces/:id/resolve` body `{ taskType, channel, personaId?, tokenBudget? }` → `200` resolved bundle. `400` invalid task/channel/budget, `404` unknown workspace or persona.

### Web

- `/workspaces/[id]/resolver`: persona manager (create, edit, delete) + resolve controls (task type, channel, persona, token budget) + bundle view: sections in order with layer badge, included/excluded state, reason, token count, and expandable content; totals + over-budget warning at the top.
- Brain page links to the resolver and back.

## Automated verification

- Brain package: section ordering; empty-doc exclusions; persona in/out; campaign empty slot; budget drop order and reasons; over-budget flag; token estimation; determinism (same input twice ⇒ deep-equal output).
- API: persona CRUD + validation + 404s; resolve happy path; resolve with persona changes the bundle; unknown persona 404; invalid task type 400.

## Founder acceptance checklist (M2 gate)

1. Create a "CEO" persona and a "Company page" persona with different overlays.
2. Resolve the same task/channel with each → bundles differ only in the persona section.
3. Read the bundle top to bottom — it should read like the briefing you'd hand a new hire.
4. Every section's reason makes sense; set a tiny token budget and watch `history` get dropped with an explicit reason.
