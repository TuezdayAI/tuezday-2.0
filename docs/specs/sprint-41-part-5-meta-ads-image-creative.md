# Spec: Sprint 41, Part 5 — Meta Ads static image creative

- **Status:** spec — not started.
- **Umbrella:** `docs/specs/sprint-41-design-layer-carousel-pipeline.md` (Decisions 3, 7, 10). Self-contained; umbrella is context only.
- **Branch:** `sprint-41-design-layer-carousel-pipeline` (final part).
- **Depends on:** Parts 2 + 3 (resolver, templates, renderer, storage) and Part 4's gating/draft-media patterns, all committed on this branch.
- **Size:** M.

> **For agentic workers:** strict TDD against a fake Meta adapter/fetcher — no real Graph API calls. `npm test` and `npm run typecheck` green before committing.

## Goal

Approved ad copy gets a matching on-brand static image, and a Meta ad launch carries that image. Same pipeline as carousels (resolve design system -> cached template -> deterministic render -> hosted PNG), single slide, ad-sized; the image reaches Meta via its `adimages` upload and `image_hash` reference. Generation spends plan credits exactly like Part 4 — no user API key.

## Current state (grounding)

- `MetaAdsAdapter.createAdCreative` (`apps/api/src/connectors/ads/meta.ts`) is text-only today — no image/creative-asset parameter at all.
- `apps/api/src/services/ad-launches.ts` joins the creative draft via `creativeDraftId`; `adLaunchTransitionTo()` (contracts) governs launch states — untouched.
- Part 4 added `drafts.media` (`LaunchMedia[]` JSON) — reused here as-is.

## Data model

Extend the table backing the ad launch's creative object + migration:

```ts
metaImageHash: text("meta_image_hash"), // set after uploadAdImage succeeds, consumed by createAdCreative
```

## Connector changes (`apps/api/src/connectors/ads/meta.ts`, `ads/index.ts`)

- New `uploadAdImage(externalAccountId, image: { url } | { bytes })` -> `POST /act_{id}/adimages` -> returns `image_hash`. Errors surface through the existing ad connector error path.
- `createAdCreative(...)` accepts optional `{ imageHash }` and, when present, includes it as `object_story_spec.link_data.image_hash`.
- Update the `AdsAdapter` interface in `ads/index.ts` accordingly; fakes in tests implement the extended interface.

## Generation flow

1. Ad copy draft (existing `meta_ad_creative` task type) is approved.
2. Founder triggers "Generate ad image": same entitlement gate as Part 4 (`assertWithinLimit` on `monthlyGenerations` + a `generations` row — one unit of plan credits; limit -> standard upgrade prompt).
3. `resolveDesignSystem(db, workspaceId, { channel: "meta_ads", campaignId?, personaId? })` -> `getOrAuthorTemplate` with slide shape `"ad-1080x1080"` -> `renderSlide` -> `AssetStorage.put` -> set the creative draft's `media` to `[{ url, type: "image" }]`. Failure atomicity as in Part 4 (no partial media).
4. At launch time, `ad-launches.ts`: if the creative draft has `media[0].url`, call `uploadAdImage` first, persist `metaImageHash`, then pass `imageHash` into `createAdCreative`. Upload/creative failures surface through the existing ad-launch error path, unchanged.

## Route + UI

- `POST /workspaces/:id/ad-creatives/:draftId/image` (thin route -> service), registered in `app.ts`.
- Ad creative review view: "Generate ad image" action + image preview alongside the copy; approval flow unchanged.

## Out of scope

- Carousel ads, video ads, multiple image variants/A-B creative testing, non-Meta ad networks, any Instagram/social change (done in Part 4).

## Automated verification (`apps/api/test/ad-image.test.ts` + extensions)

- Generation: fakes for provider/storage -> creative draft gets `media` in the right shape; entitlement gate enforced (with `TEST_BILLING_GATING`); storage failure -> no media written.
- Launch wiring: fake ads adapter asserts `uploadAdImage` is called with the draft's `media[0].url`, `metaImageHash` is persisted, and `createAdCreative` receives that `imageHash` in the same launch; a creative with no media launches exactly as today (no upload call, no regression).
- `uploadAdImage` unit: correct endpoint/params via fake fetcher; Graph API error -> existing connector error type.

## Founder acceptance

- [ ] Approve ad copy -> "Generate ad image" -> preview shows a branded 1080x1080 image consistent with the Design tab.
- [ ] Launch on Meta -> the live ad has the generated image attached (visible in Ads Manager).
- [ ] A text-only ad launch still works unchanged.
- [ ] Generation drew down the plan's generation allowance; no API key was involved anywhere.

## Progress log

*(not started)*
