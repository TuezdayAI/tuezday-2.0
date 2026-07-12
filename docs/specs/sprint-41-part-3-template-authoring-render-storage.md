# Spec: Sprint 41, Part 3 — Template authoring (Open Design), deterministic renderer, asset storage

- **Status:** implemented — tests green (see Progress log).
- **Umbrella:** `docs/specs/sprint-41-design-layer-carousel-pipeline.md` (Decisions 1, 2, 3, 5, 8, 9, 11). Self-contained; umbrella is context only.
- **Branch:** `sprint-41-design-layer-carousel-pipeline` (commit this part before starting Part 4).
- **Depends on:** Part 2 (`resolveDesignSystem()` provides the design markdown that gets fingerprinted here) and Part 1 (provider selection for the authoring key). Both must already be committed on this branch.
- **Size:** M/L.

> **For agentic workers:** strict TDD. Tests never hit Open Design, any LLM, S3, or the network. `npm test` and `npm run typecheck` green before committing.

## Goal

Build the machinery that turns a resolved design system into **cached, reusable slide templates** and turns a template + real copy into a **hosted PNG** — with the expensive agentic step (Open Design) running only on cache misses, and the hot path being pure deterministic code. No product flows in this part (Part 4 wires it to content); this part ships the three boundaries + the cache table, fully tested against fakes, plus the self-hosted Open Design deployment.

Cost model (locked): Open Design authors a template **once** per `(workspace, skillId, designSystemFingerprint, slideShape)`. Every subsequent render is placeholder substitution + a Playwright screenshot — no LLM call, no Open Design call, no per-post spend. Template authoring runs on Tuezday's platform LLM credentials (never a user's key; subscribers only ever spend plan credits, and authoring isn't even billed to them — it's internal cache-fill cost).

## Files

```
apps/api/src/design/
  provider.ts      # DesignProvider interface + DesignProviderError
  open-design.ts   # OpenDesignProvider (self-hosted daemon client)
  storage.ts       # AssetStorage interface + S3-compatible impl + StorageError
  render.ts        # deterministic template -> PNG renderer (playwright)
  templates.ts     # getOrAuthorTemplate() cache logic over design_templates
```

## Data model (`apps/api/src/db/schema.ts` + `db:generate`)

```ts
// Cached, agent-authored HTML/CSS templates — authored ONCE per shape.
export const designTemplates = sqliteTable("design_templates", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  designSystemId: text("design_system_id").notNull().references(() => designSystems.id, { onDelete: "cascade" }),
  skillId: text("skill_id").notNull(),                         // e.g. "social-carousel"
  designSystemFingerprint: text("design_system_fingerprint").notNull(), // sha256 of *resolved* design markdown; invalidates on brand change
  slideShape: text("slide_shape").notNull(),                   // e.g. "title+body", "stat-card", "quote", "ad-1080x1080"
  html: text("html").notNull(),
  css: text("css").notNull(),
  placeholders: text("placeholders_json").notNull(),           // string[] of {{token}} names
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("design_templates_lookup").on(t.workspaceId, t.designSystemId, t.skillId, t.designSystemFingerprint, t.slideShape)]);
```

## `DesignProvider` boundary (`provider.ts`)

```ts
export interface DesignProvider {
  authorTemplate(input: {
    skillId: string;                // from the curated allowlist only — never the full Open Design catalog
    designSystemMarkdown: string;   // resolved content from resolveDesignSystem()
    slideShape: string;
    brief: string;                  // e.g. "a 1080x1080 carousel slide template: title, body, page indicator"
  }): Promise<{ html: string; css: string; placeholders: string[] }>;
}
export class DesignProviderError extends Error {}
```

### `OpenDesignProvider` (`open-design.ts`)

Constructor reads `OPEN_DESIGN_BASE_URL` / `OPEN_DESIGN_API_TOKEN` (same env-fallback pattern as `NangoFabric`/`R2REvidenceStore`), plus an injectable `fetcher: typeof fetch = fetch`. `authorTemplate`:

1. `POST /api/projects` on the self-hosted daemon, tagged `orchestratorWorkspace: { kind: "scratch", sourceLabel: "tuezday:design-template", writeback: "external" }` — one throwaway project per authoring call.
2. `POST /api/chat` with `agentId: "byok-opencode"`, the allowlisted `skillId`, the design-system markdown + brief, and `byokProvider` selected to match the platform's configured LLM primary (Part 1): `{ protocol: "google", apiKey: GEMINI_API_KEY }` (verified path) or the OpenAI-compatible protocol with the OpenRouter key **if** Open Design's byok runtime supports it — verify at implementation time; if unsupported, authoring pins to the Gemini key and this is recorded in Known limitations. `byokProvider` is run-scoped on the daemon and never persisted.
3. Read back the generated HTML/CSS artifact via the project's files API; extract the `{{placeholder}}` tokens the skill prompt instructs the agent to leave in place.
4. Any daemon/auth/timeout failure -> `DesignProviderError` (callers surface "design service unavailable, try again"; text-only flows are never blocked).

The daemon is deployed as its own Docker service (image per Open Design `deploy/README.md`) with the `opencode-cli` binary installed, bound to an internal network, bearer-authed — never exposed to browsers or customers, never given to a workspace.

## `AssetStorage` boundary (`storage.ts`)

```ts
export interface AssetStorage {
  put(bytes: Uint8Array, contentType: string): Promise<{ url: string }>; // publicly fetchable URL
}
export class StorageError extends Error {}
```

Real impl: S3-compatible `PUT` via signed request against any provider (R2/B2/S3 — pick cheapest at implementation time); env vars `ASSET_STORAGE_ENDPOINT`, `ASSET_STORAGE_BUCKET`, `ASSET_STORAGE_ACCESS_KEY`, `ASSET_STORAGE_SECRET_KEY`, `ASSET_STORAGE_PUBLIC_BASE_URL`. Keys are content-addressed (`design/<sha256>.png`) so re-renders of identical output dedupe naturally. Not a DAM: bytes in, public URL out, nothing else.

## Template cache (`templates.ts`)

`getOrAuthorTemplate(db, provider, { workspaceId, designSystemId, skillId, slideShape, resolvedDesignMarkdown, brief })`:

1. `fingerprint = sha256(resolvedDesignMarkdown)`.
2. Lookup `design_templates` by the unique key; hit -> return row (no provider call).
3. Miss -> `provider.authorTemplate(...)`, insert row, return it. A design-system edit changes the fingerprint, so the stale template is simply never matched again (no explicit invalidation pass).

## Deterministic renderer (`render.ts`)

`renderSlide({ template, values, width, height }): Promise<Uint8Array>` using **playwright** (new dependency of `apps/api`; chromium only):

1. Substitute `values` into the template's `{{placeholder}}` tokens (missing placeholder -> throw, never render half-filled art). HTML-escape substituted values.
2. Headless page, `page.setContent()` with the substituted HTML+CSS, viewport at target dimensions (1080x1080 default), `page.screenshot({ type: "png" })`.
3. Return PNG bytes; caller uploads via `AssetStorage`. No LLM, no Open Design, no network beyond localhost — this is the hot path.

Browser lifecycle: one lazily-launched shared browser instance per process, pages per render, closed on app shutdown.

## Wiring

- `apps/api/src/app.ts`: new `BuildAppOptions.design?: DesignProvider` (default `new OpenDesignProvider()`) and `assetStorage?: AssetStorage` (default the S3-compatible impl), following the exact `evidence`/`connectors` pattern. Nothing consumes them yet at route level until Part 4 — but the options, defaults, and types land here.
- `.env.example`: `# Design layer (Sprint 41 Part 3)` block with the `OPEN_DESIGN_*` and `ASSET_STORAGE_*` vars above.
- `infra/`: compose file (or documented service) for the self-hosted Open Design daemon, mirroring the `r2r:up`/`nango:up` pattern (`npm run opendesign:up`/`:down`). Not needed for tests.

## Out of scope (this part)

- Carousel/ad product flows, `drafts.media`, entitlement gating, any UI (Part 4/5).
- Skill authoring inside Open Design beyond using `"social-carousel"`; marketplace publishing.
- Font/image asset upload flows (a template references whatever URLs the design doc contains).

## Automated verification (`apps/api/test/design-pipeline.test.ts`)

- `getOrAuthorTemplate`: miss -> calls fake provider once, persists row; second call with same inputs -> **zero** provider calls (cache hit assertion is the core cost guarantee); changed markdown -> new fingerprint -> re-author.
- `OpenDesignProvider`: fake `fetcher` asserting project-create + chat + files-read sequence, auth header, allowlisted skillId, `orchestratorWorkspace` tag; daemon 500/timeout -> `DesignProviderError`. Never a real network call.
- `AssetStorage` S3 impl: fake `fetcher` asserting signed PUT shape + returned public URL; failure -> `StorageError`. Tests for consumers use an inline fake returning canned URLs.
- `render.ts`: fixture template + values -> PNG bytes non-empty and correct dimensions (decode header, no pixel-diffing); missing placeholder value -> throws; substituted values are HTML-escaped. (If Playwright-in-CI proves flaky, gate the browser test behind an env flag but keep substitution/escaping tests pure.)

## Founder acceptance

- [ ] `npm run opendesign:up` brings up the self-hosted daemon; a manual script (or REPL call) authors a real `social-carousel` template for the workspace's design system and the row appears in `design_templates`.
- [ ] Calling it again does nothing (cache hit — verify via logs/timing that no Open Design/Gemini call happened).
- [ ] Edit the Design tab content, call again: a new template is authored (fingerprint changed).
- [ ] A rendered PNG for a fixture slide is fetchable at a public URL.

## Known limitations

- Whole-doc fingerprint invalidation may re-author more often than strictly necessary; fine at this volume.
- Templates are workspace-scoped — no cross-tenant reuse (correct for brand isolation); each new workspace pays one authoring call per slide shape it uses.
- If Open Design's byok runtime doesn't accept an OpenAI-compatible/OpenRouter provider entry, template authoring pins to the Gemini key (platform-level fallback for authoring only; the main app's Part 1 fallback is unaffected).

## Progress log

- 2026-07-09 — Implemented: `design/provider.ts` (interface + `extractPlaceholders`), `design/open-design.ts` (project-create → byok-opencode chat → files read-back; byok protocol follows the Part 1 primary: `google` for Gemini, `openai-compatible` + OpenRouter base URL otherwise — the latter still to be verified against the live daemon per Known limitations; refuses to cache token-less templates), `design/storage.ts` (`S3AssetStorage` with hand-rolled SigV4 single-chunk PUT — no SDK; content-addressed `design/<sha256>.<ext>` keys; injectable clock for signature tests), `design/render.ts` (pure `substituteTemplate` with escaping + missing-placeholder throw, shared lazily-launched chromium closed via `app.onClose`), `design/templates.ts` (`getOrAuthorTemplate` fingerprint cache). `design_templates` table (migration 0038). Contracts gain `SLIDE_ARCHETYPES` + `SLIDE_WORD_BUDGETS` + `AD_IMAGE_SLIDE_SHAPE` + `DESIGN_SKILL_ALLOWLIST` (competitor-scan Tier 1: explicit archetype vocabulary; word budgets enforced at write time instead of render-time text-fit). `buildApp` options `design`/`assetStorage` with real defaults. `infra/open-design/compose.yaml` + `opendesign:up`/`:down` scripts; `.env.example` block. playwright added to apps/api; chromium installed locally. 14 tests in `test/design-pipeline.test.ts` (cache-hit zero-call guarantee, daemon sequence/auth/tag assertions, SigV4 shape, PNG dimension check via real chromium — browser test auto-skips where chromium is missing, e.g. CI). Full suite 1067 + typecheck clean (also fixed noUncheckedIndexedAccess errors that had slipped into the Part 1/2 test files).
