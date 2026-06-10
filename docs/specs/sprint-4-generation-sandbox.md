# Spec: Sprint 4 — Generation Sandbox

> Status: in build
> Covers rebuild-plan tickets 9–10 (LLM gateway with trace logging, generation sandbox with accept/edit/reject rating). Phase 3 of the rebuild plan, milestone M3. Completes **Brain Spine v0**.

## What this slice does

The founder picks a task, channel, and persona; sees the exact resolved context bundle; generates one output through the LLM gateway; and rates it `accepted` / `needs_edit` / `rejected`. Every generation is stored with its full prompt, resolved-section trace, model, and timing — and every rating is stored as a training signal. This is the quality checkpoint for the whole product: if outputs are generic here, we fix the brain before building any pipeline.

## Out of scope

Approval gate states/queue (Sprint 5 — rating ≠ approval), content items/export (Sprint 6), campaigns, RAG, streaming, multi-variant generation, prompt editing in the UI.

## Decisions

- **Provider: Google Gemini** (founder decision — Gemini API key available now). The gateway interface is provider-agnostic; Gemini is an implementation detail behind it. The sprint plan's earlier "Anthropic" note is superseded; switching or adding providers later must not touch routes, services, or UI.
- Gateway calls Gemini's `generateContent` REST API directly (no SDK dependency). Model from `GEMINI_MODEL` env (default `gemini-2.5-flash`), key from `GEMINI_API_KEY` env. The API loads a root `.env` file at startup (gitignored).
- Tests run against a deterministic fake gateway injected into `buildApp` — no network, no key needed.

## Behavior

### LLM gateway (`apps/api/src/llm/`)

`LlmGateway.generate({ prompt, maxOutputTokens? })` → `{ text, model, provider, durationMs }`. Errors surface as typed failures (`missing_api_key`, `provider_error` with status/detail), never crash the API.

### Data

`generations` table: id, workspaceId, taskType, channel, personaId (nullable), prompt (assembled text sent to the model), sectionsJson (full resolved-section trace), output, model, provider, durationMs, rating (nullable, one of `accepted`/`needs_edit`/`rejected`), ratedAt (nullable), createdAt. Cascade-deletes with workspace.

### API

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/generate` | body = same shape as resolve (`taskType`, `channel`, `personaId?`, `tokenBudget?`). Resolves context, calls the gateway, stores and returns the generation (with parsed sections). `502 generation_failed` (with detail) if the provider errors; nothing stored on failure. `400`/`404` as in resolve. |
| `GET /workspaces/:id/generations` | `200` list newest first — the training signal log. |
| `POST /workspaces/:id/generations/:generationId/rating` | body `{rating}` → `200` updated generation with `ratedAt` set. Re-rating overwrites. `400` invalid rating, `404` unknown generation. |

### Web (`/workspaces/[id]/sandbox`)

1. Controls: task type, channel, persona, token budget.
2. **Preview context** — shows the resolved bundle (same section cards as the resolver page) before any generation. Generate is enabled only after a preview, so the founder always sees what the model will see.
3. **Generate** — calls the API, shows the output with model + duration, and an expandable prompt trace.
4. Rating buttons: Accept / Needs edit / Reject — stored immediately, shown on the generation.
5. Training signal log: past generations with task, persona, rating, output preview, expandable detail.
6. Clear, actionable error if `GEMINI_API_KEY` is missing.

## Automated verification

- Contracts: generation schema, rating input validation.
- API (fake gateway): generate stores prompt/sections/output and returns them; prompt contains brain content and task instruction; persona flows through; provider failure → 502 and nothing stored; rating happy path + overwrite + validation + 404s; log ordering.

## Founder acceptance checklist (M3 gate)

1. Fill ICP/Voice/Now docs (at least drafts) so generation has real context.
2. Sandbox: preview context → generate a LinkedIn post as CEO → read it.
3. Rate it; rate another generation differently; see both in the training log.
4. Kill the API key temporarily → generate shows a clear error, app keeps working.
5. **The real gate: are outputs directionally useful — do they sound like the company, not like generic AI?** If not, iterate on brain docs/overlays before Sprint 5.
