# Spec: Sprint 41, Part 4 — Carousel pipeline: content -> slides -> render -> approval -> Instagram publish

- **Status:** implemented — tests green (see Progress log).
- **Umbrella:** `docs/specs/sprint-41-design-layer-carousel-pipeline.md` (Decisions 3, 6, 7, 10). Self-contained; umbrella is context only.
- **Branch:** `sprint-41-design-layer-carousel-pipeline` (commit this part before starting Part 5).
- **Depends on:** Part 2 (`resolveDesignSystem()`) and Part 3 (`DesignProvider`, `AssetStorage`, `getOrAuthorTemplate`, `renderSlide`) already committed on this branch.
- **Size:** M/L.

> **For agentic workers:** strict TDD. Tests use fakes for `DesignProvider`/`AssetStorage`/`LlmGateway` and `app.inject()` — no network, no real browser needed beyond what Part 3's render tests already cover. `npm test` and `npm run typecheck` green before committing.

## Goal

The founder-visible loop: take an approved content draft, generate a branded Instagram carousel from it, review the slides inside the existing approval gate, and publish a real multi-image carousel through the existing Instagram connector. Generation spends the subscriber's included plan allowance (Sprint 37 entitlements) — **no user API key anywhere**; hitting the limit shows the standard upgrade prompt.

## Data model

`drafts` (extend, don't replace) + migration:

```ts
media: text("media_json"), // nullable; LaunchMedia[]-shaped JSON: { url, type: "image" }[]
```

Contracts: extend `draftSchema` with optional `media` (reuse the existing `LaunchMedia` shape — do not invent a new one); add the carousel task type to the existing task-type vocabulary in `packages/contracts` (single source of enums; import, never redeclare). The approval state machine (`transitionTo`/`canTransition`) is untouched.

## Service (`apps/api/src/services/carousels.ts`)

`generateCarousel(deps, { workspaceId, draftId, actor })`:

1. **Entitlement gate (umbrella Decision 10):** `assertWithinLimit(db, workspaceId, "monthlyGenerations", getUsage(db, workspaceId).monthlyGenerations)` — the exact seam `routes/generations.ts:48` uses. On success, record a row in the `generations` table (so `countGenerationsSince` picks it up and the run appears in usage) — one carousel generation = one unit of the plan's included credits. Limit reached -> `EntitlementError` -> the standard upgrade-prompt error path, never an "add API key" prompt.
2. **Slide breakdown:** split the source draft's `content` into N slides (title + body per slide; 2-10 to satisfy Instagram's carousel bounds). Plain text logic first; use the injected `LlmGateway` only if a smarter split proves worth the token cost (that call rides the same Part 1 gateway with fallback).
3. **Design resolution:** `resolveDesignSystem(db, workspaceId, { channel: "instagram", personaId?, campaignId? })` from the source draft's campaign/persona context.
4. **Template:** `getOrAuthorTemplate(...)` per distinct slide shape (cache hit on the hot path; authoring only on first use/brand change — Part 3 guarantees).
5. **Render + store:** `renderSlide()` per slide at 1080x1080 -> `AssetStorage.put()` -> public URLs. Any render/upload failure fails the whole request — never create a draft with partial/broken media.
6. **Draft creation:** new `drafts` row — carousel task type, `content` = per-slide copy (what a reviewer reads), `media` = the N slide image URLs (what a reviewer sees), state `draft` entering the normal approval gate (`draft -> pending_review -> approved/rejected/edited`), linked to the source draft/campaign the same way existing derived drafts are.

## Route (`apps/api/src/routes/carousels.ts`)

- `POST /workspaces/:id/drafts/:draftId/carousel` — triggers `generateCarousel`, returns the created draft. Thin route: zod-validate, call service. Register in `app.ts` passing `db, llm, design, assetStorage`.
- Errors: `EntitlementError` -> the same status/shape the generation routes use; `DesignProviderError` -> "design service unavailable, try again" (does not affect text-only flows); render/storage failure -> request fails with the underlying error.

## Publish wiring

`InstagramAdapter.publishPost` (`apps/api/src/connectors/social/instagram.ts`) already implements the 2-10 item Graph API carousel flow and accepts `media: PublishMedia[]` — **no interface change**. At the existing publish route/service: when an approved draft has `media`, pass it through as `PublishMedia[]`. That is the whole wiring.

## UI

- **Content/campaign view:** "Generate carousel" action on an approved content draft.
- **Approval UI:** when a draft has `media`, show a slide preview (simple swiper/strip of the images) alongside the text content already displayed. Approve/reject/edit works unchanged.
- **Limit state:** entitlement error surfaces the existing upgrade prompt component (same as text generations).

## Out of scope (this part)

- Meta Ads image creative (Part 5). LinkedIn/X/Twitter publishing. Editing individual slides visually. Regeneration UX beyond re-running the action. Background jobs (generation is a synchronous request in v1; Playwright render of ≤10 slides is acceptable latency).

## Automated verification (`apps/api/test/carousels.test.ts` + extensions)

- Integration: fake `DesignProvider` (canned template), fake `AssetStorage` (canned URLs), fake `LlmGateway` -> `POST .../carousel` creates a draft with correct `media` shape (validated against contracts), correct per-slide `content`, and it moves `draft -> pending_review -> approved` via the existing endpoints.
- Entitlement gating (with `TEST_BILLING_GATING` set, Sprint 37 test convention): free-plan workspace at its generation limit -> error; successful generation increments `getUsage().monthlyGenerations` by one.
- Slide bounds: content that would split into 1 or >10 slides is clamped/merged into the 2-10 range.
- Failure atomicity: fake storage that throws mid-upload -> no draft row created.
- Instagram publish test extended: approved carousel draft's `media` reaches `publishPost` unchanged.

## Founder acceptance

- [ ] Approve a post -> "Generate carousel" -> per-slide previews appear in the approval UI -> approve -> publish -> the Instagram post is a real multi-image carousel.
- [ ] Second carousel for the same design system/slide shapes: logs/timing confirm no Open Design/Gemini authoring call — deterministic render only.
- [ ] Edit the Design tab, generate again: a new template is authored (fingerprint change), and the new look shows in the slides.
- [ ] Campaign with a design overlay: its carousel reflects the override; one outside the campaign doesn't.
- [ ] On a plain subscribed workspace with no API key connected anywhere: generation works and draws down the plan's generation allowance; at the limit, the standard upgrade prompt appears.

## Progress log

- 2026-07-09 — Implemented: `drafts.media_json` (migration 0039) + `draftSchema.media` (LaunchMedia[] — `launchMediaSchema` moved above `draftSchema` in contracts to avoid TDZ); `instagram_carousel` task type added to `TASK_TYPES` (+ `TASK_INSTRUCTIONS`/`DEFAULT_TASK_DOC_MATRIX` entries to keep the exhaustive records whole, + web label maps). `services/carousels.ts`: `splitIntoSlides` (pure text logic, no LLM — hook → body/list_item → CTA archetypes with `SLIDE_WORD_BUDGETS` enforced at write time, explicit `---` break override, 2–10 clamp), template per distinct archetype via `getOrAuthorTemplate`, render+upload all slides before any draft write (failure atomicity, and the generation is metered only after success so a failed render never burns a credit), generation recorded with an inspectable design-trace section (`provider: "design-pipeline"`), derived draft submitted into the approval gate with media. Route `POST /drafts/:draftId/carousel` (402 upgrade shape identical to text generations; 503 design_unavailable; 502 asset_storage_failed; 409 source_not_approved). `buildApp` gains injectable `render` (defaults to the Playwright renderer). Publish wiring: the publications route passes `draft.media` into `createPublication` — `InstagramAdapter.publishPost` untouched. Approval UI: slide preview strip + "Generate carousel" on approved drafts (apiFetch's global 402 handler shows the standard upgrade modal). 13 tests in `test/carousels.test.ts`, including an end-to-end fake-Graph-API assertion that the rendered slide URLs reach the carousel child containers unchanged. Full suite 1080 + typecheck green.
- Deviation: the derived draft enters the gate at `pending_review` (via `submitDraft`, decision logged), not bare `draft` — matching how every existing derived draft lands in the approval queue.
