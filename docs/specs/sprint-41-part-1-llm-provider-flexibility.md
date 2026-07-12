# Spec: Sprint 41, Part 1 — LLM provider flexibility (OpenRouter, configurable primary, automatic fallback)

- **Status:** implemented — tests green (see Progress log).
- **Umbrella:** `docs/specs/sprint-41-design-layer-carousel-pipeline.md` (Decision 11). This part is self-contained; read the umbrella for sprint-wide context only.
- **Branch:** `sprint-41-design-layer-carousel-pipeline` (all Sprint 41 parts ship on this one branch; commit this part before starting Part 2).
- **Depends on:** nothing — first part, independent of the design layer.
- **Size:** S/M.

> **For agentic workers:** strict TDD — write the failing tests first. `npm test` and `npm run typecheck` green before committing.

## Goal

Stop hard-depending on Gemini. Add an **OpenRouter**-backed implementation of the existing `LlmGateway` interface, make the **primary provider configurable at deploy level**, and wrap both in an **automatic fallback** so a Gemini outage degrades to OpenRouter (and vice versa) instead of failing the user's generation. Zero changes to routes/services — they already depend only on `LlmGateway` (`apps/api/src/llm/gateway.ts`).

Explicitly NOT in scope: per-workspace provider choice, user-supplied API keys (subscribers spend plan credits per Decision 10 of the umbrella — provider credentials are always Tuezday's own), streaming, multi-model routing policies.

## Grounding (current state)

- `apps/api/src/llm/gateway.ts` — `LlmGateway { generate(params): Promise<GenerateResult> }`, `GenerateParams { prompt, maxOutputTokens? }`, `GenerateResult { text, model, provider, durationMs }`, `GatewayError(code: "missing_api_key" | "provider_error")`.
- `apps/api/src/llm/gemini.ts` — `GeminiGateway`, the only impl. No SDK; one `fetch` to `generateContent`. Reads `GEMINI_API_KEY`/`GEMINI_MODEL` env with blank-value fallback to defaults.
- `apps/api/src/app.ts:86` — `buildApp({ llm = new GeminiGateway() })` is the single composition point; ~15 route groups receive `llm`. Tests always inject fakes.
- OpenRouter: OpenAI-compatible `POST https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer <OPENROUTER_API_KEY>`, body `{ model, messages: [{ role: "user", content }], max_tokens }`; response `choices[0].message.content`. No SDK needed — same "one endpoint, one body shape" posture as `gemini.ts`.

## Design

New files in `apps/api/src/llm/`:

### `openrouter.ts` — `OpenRouterGateway implements LlmGateway`

- Constructor `(apiKey?, model?, fetcher: typeof fetch = fetch)` — mirrors `GeminiGateway`'s env fallback pattern (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, blank values fall back to defaults). Default model: `google/gemini-2.5-flash` (same model family as the primary today, just via a different pipe — revisit default at implementation time if pricing/latency argues otherwise). The injectable `fetcher` (with real default) is an improvement over `gemini.ts`'s global fetch and follows the repo's "every external dependency injectable with a real default" rule.
- `generate()`: no key -> `GatewayError("missing_api_key", ...)`. Network failure / non-2xx / empty content -> `GatewayError("provider_error", ...)` with status + provider message, exactly mirroring `gemini.ts`'s error text posture. Success -> `{ text, model, provider: "openrouter", durationMs }`.
- Send OpenRouter's recommended attribution headers (`HTTP-Referer`, `X-Title: "Tuezday"`) — cheap, avoids anonymous-traffic throttling.

### `fallback.ts` — `FallbackGateway implements LlmGateway`

```ts
constructor(private primary: LlmGateway, private secondary: LlmGateway) {}
```

- Try `primary.generate(params)`. On **any** `GatewayError` (both `missing_api_key` and `provider_error` — a missing primary key should degrade, not hard-fail), try `secondary.generate(params)`.
- Non-`GatewayError` exceptions rethrow immediately (programmer errors must not be swallowed).
- If both fail, throw a `GatewayError("provider_error", ...)` whose message names both providers and both underlying messages — operators must be able to see the whole story from one error.
- The successful result passes through untouched — `result.provider` already tells callers/logs who actually served the call.

### `index.ts` (or extend `gateway.ts`) — `createLlmGatewayFromEnv(): LlmGateway`

- `LLM_PROVIDER` env: `"gemini"` (default when unset/blank) or `"openrouter"` — picks the primary.
- If the *other* provider's API key is present in env, wrap primary+secondary in `FallbackGateway`; otherwise return the primary alone (single-provider deploys keep working with no new env vars).
- Unknown `LLM_PROVIDER` value -> throw at startup (fail fast, not at first request).

### Wiring

- `apps/api/src/app.ts`: change the default from `llm = new GeminiGateway()` to `llm = createLlmGatewayFromEnv()`. Nothing else in app.ts or any route/service changes. Tests that inject a fake `llm` are unaffected (the factory only runs when the option is omitted — and tests never omit it; keep it that way).
- `.env.example`: new block:

```
# LLM provider flexibility (Sprint 41 Part 1)
# Primary provider: gemini (default) | openrouter. The other becomes automatic fallback if its key is set.
LLM_PROVIDER=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
```

## Automated verification

All tests live in `apps/api/test/llm.test.ts` (new file, one-file-per-slice convention), no network — `OpenRouterGateway` gets an injected fake `fetcher`; `FallbackGateway` gets inline fake gateways typed as `LlmGateway`.

- `OpenRouterGateway`: missing key -> `GatewayError("missing_api_key")`; 200 with content -> correct `GenerateResult` (text/model/`provider: "openrouter"`); non-2xx -> `provider_error` including status; empty `choices`/content -> `provider_error`; fetch rejection -> `provider_error`; `maxOutputTokens` forwarded as `max_tokens`; blank env values fall back to defaults.
- `FallbackGateway`: primary success -> secondary never called; primary `GatewayError` -> secondary result returned; both fail -> single `GatewayError` naming both; non-`GatewayError` from primary rethrown without calling secondary.
- `createLlmGatewayFromEnv`: default -> Gemini primary; `LLM_PROVIDER=openrouter` -> OpenRouter primary; other key present -> `FallbackGateway`; absent -> bare gateway; invalid value -> throws. (Use env stubbing per test, restore after.)

## Founder acceptance

- [ ] With both keys set and `LLM_PROVIDER` unset: generations work as today (Gemini serves; `provider` field in generation traces says `gemini`).
- [ ] Break the Gemini key (or set an invalid one) and generate: the call succeeds and the trace shows `provider: openrouter` — no user-facing failure.
- [ ] Set `LLM_PROVIDER=openrouter` and generate: OpenRouter serves first.
- [ ] Nothing anywhere in the product asks a subscriber for an API key.

## Progress log

- 2026-07-09 — Implemented as specced: `apps/api/src/llm/openrouter.ts` (`OpenRouterGateway`, injectable fetcher, attribution headers), `fallback.ts` (`FallbackGateway`, GatewayError-only fallback, combined both-failed error), `index.ts` (`createLlmGatewayFromEnv`, fail-fast on unknown `LLM_PROVIDER`). `app.ts` default swapped to the factory (`server.ts` omits `llm`, so production picks it up). `.env.example` block added. 18 tests in `apps/api/test/llm.test.ts`; full suite 1036 passed + typecheck green. One deviation worth noting: `GenerateResult.model` prefers the model name echoed back in OpenRouter's response over the requested one (OpenRouter may route/alias models; traces should record what actually served).
