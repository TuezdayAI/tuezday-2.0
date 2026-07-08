# Spec + Implementation Plan: Sprint 41 - Design layer: Open Design carousel pipeline

- **Status:** spec draft — not started.
- **Roadmap entry:** `docs/plans/sprint-guide-21-onward.md` -> Phase F -> Sprint 41, "Design layer: automated carousel/image pipeline" (U11). Founder decision (this spec) resolves the open "Open Design vs Canva" question in favor of **Open Design**, self-hosted behind a `DesignProvider` boundary.
- **Branch:** `sprint-41-design-layer-carousel-pipeline`, cut from `main` (43/44/45/46 are already merged to local `main`; this sprint builds on 44's scoped-resolution pattern, so cutting after that merge is required, not optional — see Decision 4).
- **Builds on:** Sprint 6 (content), Sprint 15 (ad creative), Sprint 17 (social publish — `SocialAdapter`/`PublishMedia`), Sprint 44 (scoped `guidance_overrides` most-specific-wins pattern, reused verbatim for design overlays).
- **Size:** L. Split into two build parts (see below) — Part 1 ships an end-to-end Instagram carousel; Part 2 extends Meta Ads to consume the same pipeline.
- **Do NOT merge into `main`.** Push the branch; founder reviews/accepts/merges.

> **For agentic workers:** self-contained spec. Strict TDD. REQUIRED SUB-SKILL: superpowers:executing-plans.

---

## Goal

Give Tuezday's brain a visual identity and a way to turn approved copy into on-brand images without becoming a design tool. A founder edits a **Design** tab in the brain (same posture as soul/icp/voice/history/now), and from then on: approved content can render as a branded Instagram carousel, and approved ad copy can render as a branded static ad image — both through the existing approval gate, both attached automatically to the right connector at publish/launch time.

Founder-facing outcome:

> Approve a post -> generate a branded carousel from it -> preview -> approve the visual -> publish to Instagram. Approve ad copy -> generate a matching ad image -> launch on Meta.

Research backing this spec: `docs/research/open-design-integration-audit.md`-equivalent findings from the Open Design audit (see API grounding below) — this spec supersedes the "coding-agent CLI is required and expensive" concern raised during that audit with a verified, cheaper path.

---

## Decisions locked

1. **`DesignProvider` boundary, backed by a self-hosted Open Design instance — a separate deployed service, not vendored into this monorepo.** Same posture as `EvidenceStore`/R2R and `ConnectorFabric`/Nango: Tuezday owns the boundary interface (`apps/api/src/design/provider.ts`), Open Design runs as its own Docker service reachable only from the API, never exposed to the browser or to customers.

2. **No paid coding-agent CLI. Generation runs through Open Design's `byok-opencode` runtime, pointed at our own Gemini key.** Verified in `apps/daemon/src/runtimes/defs/byok-opencode.ts` and `byok-opencode.ts` in the Open Design repo: it spawns the free, open-source **OpenCode CLI**, configured via `@ai-sdk/google` against `https://generativelanguage.googleapis.com/v1beta` with `protocol: "google"` — i.e. our existing `GEMINI_API_KEY`, same billing as every other LLM call in this codebase. This is a real agentic CLI (not a raw completion), so filesystem artifacts, prompt-injected skill loading, and export all work exactly as they do for the CLI-backed adapters — nothing is degraded by skipping Claude Code/Codex. Requires the `opencode-cli` binary in the self-hosted Open Design container; no CLI subscription of any kind.

3. **Open Design's role is template *authoring* only. It never runs per-post.** A slide/creative *layout* is generated once (agentic, via `byok-opencode`) per (workspace design system version x skill x slide shape) and cached as a template. Every actual post/ad after that is a **deterministic render**: substitute real copy into the cached template's placeholders and screenshot it. No LLM call, no Open Design call, on the hot path. This is the only way "static background, swap the text" stays cheap at volume — see Architecture.

4. **Visual identity is a brain-adjacent concept, deliberately *not* added to `BRAIN_DOC_TYPES`.** The naive read of "design systems as another brain tab" is to add `"design"` to `packages/contracts`' `BRAIN_DOC_TYPES` array. **Do not do this.** `packages/brain/src/resolver.ts` (Sprint 43) iterates `BRAIN_DOC_TYPES` and injects every member into *every* task-type/channel resolution (tier-1 constitutional or tier-2 matrix) — the entire point of Sprint 43 was to stop shipping irrelevant context into every prompt. A DESIGN.md-shaped palette/type/motion doc is only relevant to visual-generation tasks; injecting it into outbound emails and text-only social drafts would silently regress Sprint 43's token discipline for zero benefit. Instead:
   - New table `design_systems` holds the workspace-level base doc (the "org" layer), presented as a 6th tab in the Brain UI, human-editable and versioned exactly like the other five — but read through its own service, not `packages/brain`'s general resolver.
   - New table `design_overlays` clones Sprint 44's `guidance_overrides` shape and precedence exactly (`workspaceId, channel, personaId, campaignId`, most-specific-wins) for channel/campaign/persona-specific visual variants (a LinkedIn carousel can look different from an Instagram one; a launch campaign can have a seasonal treatment).
   - A new resolver, `resolveDesignSystem()`, is called only by the carousel/ad-image pipeline — never wired into `ResolveInput`/`BrainContents`.
   This gets the founder-facing "it's part of the brain" UX without reopening Sprint 43's selective-context work.

5. **New `AssetStorage` boundary — the one genuinely new piece of infrastructure this sprint requires.** Grounding confirms there is no blob/file storage anywhere in this repo today; every existing `media` reference (`LAUNCH_MEDIA_TYPES`, `publications.mediaJson`, `PublishMedia`) is always a plain public URL string the founder or an external system already hosts. Instagram's Graph API and Meta's ad-image upload both need a publicly fetchable URL. `apps/api/src/design/storage.ts` defines a minimal `AssetStorage` interface (`put(bytes, contentType) -> { url }`); the real implementation is an S3-compatible client (any provider — Cloudflare R2, Backblaze B2, AWS S3; pick the cheapest at implementation time). This is deliberately not a DAM — no library UI, no folders, no search; just "bytes in, public URL out," matching the roadmap's explicit boundary note ("Integrate, don't build a DAM").

6. **Approval Gate gets a `media` field, reusing the existing `LaunchMedia` shape rather than inventing a new one.** `drafts.media` (JSON, `{ url, type: "image" }[]`) sits alongside the existing `content`/`state` columns. A carousel draft's `content` holds the per-slide copy (what a reviewer reads); `media` holds the rendered slide image URLs (what a reviewer sees). The existing `transitionTo()`/`canTransition()` state machine is untouched — a visual draft moves through `draft -> pending_review -> approved/rejected/edited` exactly like a text draft.

7. **First vertical slice ships as two parts, both under Sprint 41:**
   - **Part 1 — Social/Instagram carousel**, because `InstagramAdapter.publishPost` (`apps/api/src/connectors/social/instagram.ts`) already implements the full 2-10 item Graph API carousel flow. This is the fastest path to a real, demoable, founder-acceptable loop end to end.
   - **Part 2 — Meta Ads static image creative**, extending `MetaAdsAdapter.createAdCreative` (currently text-only — no image/creative-asset parameter at all) to upload via Meta's `adimages` endpoint and reference the resulting `image_hash`.
   LinkedIn/X/Twitter carousel and image publishing are **not** in scope here — those connectors' OAuth/publish surfaces land in their own sprints (per `docs/plans/sprint-guide-21-onward.md`, social OAuth expansion is a continuous track).

8. **MCP is explicitly out of scope.** Tuezday's backend talks to Open Design's plain REST/SSE surface (`/api/projects`, `/api/chat`) directly, per `docs/external-media-orchestration.md`'s "Recommended Composition" (HTTP/SSE between the external service and Open Design, not the MCP path) — Tuezday is the orchestrator here, not another agent consuming Open Design as a tool.

9. **Skill/template selection is an explicit allowlist, not the full Open Design catalog.** `OpenDesignProvider` only ever sends `skillId: "social-carousel"` (or a Tuezday-authored variant, see Known limitations) — it never exposes Open Design's other 100+ bundled skills. No project the API creates should have access to skills outside this list.

---

## API grounding (Open Design)

- Repo: `github.com/nexu-io/open-design`, Apache-2.0. Self-hosted via the published Docker image (`deploy/README.md`), fronted by `OD_API_TOKEN` bearer auth, bound to an internal network only — never a public IP.
- Chat/generation contract: `POST /api/chat` (`packages/contracts/src/api/chat.ts` in the Open Design repo) accepts `agentId: "byok-opencode"`, `projectId`, `skillId`/`skillIds`, `designSystemId`, `model`, and `byokProvider: { protocol: "google", apiKey }`. The daemon's own comment confirms `byokProvider` is **run-scoped and never persisted** — translated into child env for that run only — so Tuezday's API injects `GEMINI_API_KEY` per request and Open Design never stores our credential.
- BYOK runtime: `apps/daemon/src/runtimes/defs/byok-opencode.ts` + `byok-opencode.ts` — spawns `opencode-cli`/`opencode` configured with a per-run provider entry (`@ai-sdk/google` for the `google` protocol). Confirms this is a genuine agentic CLI run, not a degraded raw-completion fallback.
- Orchestrator contract: `docs/orchestrator-workspaces.md` and `docs/external-media-orchestration.md` (Open Design repo) define exactly the boundary this spec follows — Open Design owns rendering/design-system context; the external service (Tuezday) owns auth, budgets, provider credentials, and writeback. Workspaces we hand it should be tagged `orchestratorWorkspace: { kind: "scratch", writeback: "external" }`.
- Multi-tenancy: Open Design has none natively (explicitly out of scope in its own `docs/architecture.md` §11). Tuezday enforces isolation by mapping one Open Design **project** to one Tuezday **design-template context** (see Data model), created and addressed exclusively by the API — no workspace ever gets a daemon URL or token directly.

---

## Out of scope

- MCP integration with Open Design (Decision 8).
- Landing pages/prototypes, GTM decks, competitive teardown, or any other pipeline from the original Open Design audit — explicitly deferred, tracked for a later sprint.
- Video/HyperFrames, image-model (gpt-image-2) generation, audio.
- LinkedIn/X/Twitter carousel or image publishing (their connectors don't exist yet).
- A general digital asset management UI, asset library, or folder/search browsing (Decision 5).
- Any change to `packages/brain`'s general context resolver (Decision 4 is precisely about *not* touching it).
- Publishing a Tuezday plugin back to Open Design's marketplace.
- Running Claude Code, Codex, or any paid coding-agent CLI (Decision 2).

---

## Architecture

```
apps/api/src/design/
  provider.ts          # DesignProvider interface + DesignProviderError
  open-design.ts        # OpenDesignProvider implements DesignProvider (calls the self-hosted daemon)
  storage.ts             # AssetStorage interface + S3-compatible impl
  render.ts               # deterministic template -> PNG renderer (playwright), no LLM call
  templates.ts             # template cache lookup/store (design_templates table)
apps/api/src/services/
  design-systems.ts        # design_systems + design_overlays CRUD + resolveDesignSystem()
  carousels.ts               # content -> slide breakdown -> template resolve/generate -> render -> draft
apps/api/src/routes/
  design-systems.ts          # brain "Design" tab CRUD + overlay CRUD (mirrors routes/guidance.ts)
  carousels.ts                 # trigger carousel generation for an approved/draft content piece
apps/web/app/workspaces/[id]/brain/design/
  page.tsx                     # new Brain tab: base design system + per-channel/campaign/persona overlays
```

### Modified files

- `packages/contracts/src/index.ts` — new `DesignSystemDoc`, `DesignOverlay`, `CarouselDraft` types; extend `draftSchema` with optional `media: LaunchMedia[]`.
- `apps/api/src/db/schema.ts` — new tables (below); new `media`/columns on `drafts`; new columns on the ad-creative-adjacent table for Part 2.
- `apps/api/src/app.ts` — new `BuildAppOptions.design?: DesignProvider` (defaults to `new OpenDesignProvider()`) and `assetStorage?: AssetStorage`, following the exact `evidence`/`connectors` pattern already there.
- `apps/api/src/connectors/social/instagram.ts` — no interface change; `publishPost` already accepts `media: PublishMedia[]`. Wire the carousel draft's `media` into this call at publish time.
- `apps/api/src/connectors/ads/meta.ts`, `apps/api/src/connectors/ads/index.ts` — Part 2: extend `createAdCreative` to accept an optional image reference; add an `uploadAdImage` method.
- `apps/api/src/services/ad-launches.ts` — Part 2: pass the creative draft's `media[0].url` through to `uploadAdImage` before calling `createAdCreative`.
- `.env.example` — new `# Design layer (Sprint 41)` block: `OPEN_DESIGN_BASE_URL`, `OPEN_DESIGN_API_TOKEN`, plus whichever S3-compatible vars `AssetStorage`'s real impl needs.

---

## Data model

```ts
// Base visual identity per workspace — the "org" layer. Brain UI's 6th tab.
// Deliberately NOT part of brain_documents / BRAIN_DOC_TYPES (Decision 4).
export const designSystems = sqliteTable("design_systems", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  content: text("content").notNull(), // DESIGN.md-shaped markdown: palette, type, spacing, components, motion, voice, anti-patterns
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("design_systems_workspace").on(t.workspaceId)]);

// Channel/campaign/persona overlays — clones guidance_overrides' shape and
// most-specific-wins precedence verbatim (Sprint 44 pattern, Decision 4).
export const designOverlays = sqliteTable("design_overlays", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  personaId: text("persona_id").references(() => personas.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  content: text("content").notNull(), // partial DESIGN.md override/addendum
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("design_overlays_workspace_channel_scope").on(t.workspaceId, t.channel, t.personaId, t.campaignId)]);

// Cached, agent-authored HTML/CSS templates — the thing Open Design generates
// ONCE per shape (Decision 3). Rendering never touches this table's producer again.
export const designTemplates = sqliteTable("design_templates", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  skillId: text("skill_id").notNull(), // e.g. "social-carousel"
  designSystemFingerprint: text("design_system_fingerprint").notNull(), // hash of resolved design-system content, invalidates on brand change
  slideShape: text("slide_shape").notNull(), // e.g. "title+body", "stat-card", "quote"
  html: text("html").notNull(),
  css: text("css").notNull(),
  placeholders: text("placeholders_json").notNull(), // string[] of token names the renderer substitutes
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("design_templates_lookup").on(t.workspaceId, t.skillId, t.designSystemFingerprint, t.slideShape)]);
```

`drafts` (extend, don't replace):

```ts
media: text("media_json"), // nullable; LaunchMedia[]-shaped JSON: { url, type: "image" }[]
```

Part 2 only — extend whatever table backs `ad_launches.creativeDraftId`'s creative object with:

```ts
metaImageHash: text("meta_image_hash"), // set after uploadAdImage succeeds, consumed by createAdCreative
```

---

## Design system resolution

`resolveDesignSystem(db, workspaceId, { channel, personaId, campaignId })` in `apps/api/src/services/design-systems.ts`, mirroring `resolveChannelGuidance`'s winner chain (`apps/api/src/services/guidance.ts`) exactly:

```
persona+campaign override > persona override > campaign override > channel-only override > base design_systems row
```

Falls back to the base `design_systems` row (not a contracts-level hardcoded default — every workspace must have exactly one base row, seeded on workspace creation the same way `ensureBrainDocs` seeds the five brain docs today).

Returns the resolved markdown plus a trace (`source: "persona+campaign" | "persona" | "campaign" | "channel" | "base"`) — same transparency contract the rest of the brain already promises.

---

## `DesignProvider` boundary

```ts
// apps/api/src/design/provider.ts
export interface DesignProvider {
  authorTemplate(input: {
    skillId: string;
    designSystemMarkdown: string;
    slideShape: string;
    brief: string; // e.g. "a 4-slide carousel template: title, three body slides, CTA"
  }): Promise<{ html: string; css: string; placeholders: string[] }>;
}
export class DesignProviderError extends Error {}
```

`OpenDesignProvider implements DesignProvider` (`apps/api/src/design/open-design.ts`), constructor reads `process.env.OPEN_DESIGN_BASE_URL` / `OPEN_DESIGN_API_TOKEN` with the same fallback pattern as `NangoFabric`/`R2REvidenceStore`. `authorTemplate`:

1. `POST /api/projects` on the self-hosted Open Design daemon, tagged `orchestratorWorkspace: { kind: "scratch", sourceLabel: "tuezday:design-template", writeback: "external" }` — one project per template-authoring call, never reused as a workspace's permanent home.
2. `POST /api/chat` with `agentId: "byok-opencode"`, `byokProvider: { protocol: "google", apiKey: process.env.GEMINI_API_KEY }`, `skillId` from the curated allowlist (Decision 9), the resolved design-system markdown, and the brief.
3. Read back the generated HTML/CSS artifact via the project's files API; extract `{{placeholder}}` tokens the skill is instructed (in its prompt) to leave for later substitution.
4. Store the result in `design_templates`, keyed by `(workspaceId, skillId, designSystemFingerprint, slideShape)`.

This method is called rarely: on first use of a given (design system version x slide shape), and again only when `designSystemFingerprint` changes (i.e. the founder edits the brand).

---

## Deterministic render pipeline (no LLM, no Open Design call)

`apps/api/src/design/render.ts`, using `playwright` (new native dependency — small, well-understood, chosen over routing back through Open Design's own export pipeline specifically so the hot path never depends on Open Design's uptime or token cost, per Decision 3):

1. Look up (or trigger authoring of, via `DesignProvider`, if missing) the cached template for this `(workspaceId, skillId, designSystemFingerprint, slideShape)`.
2. Substitute real content into `{{placeholder}}` tokens in the template's HTML.
3. Launch a headless page, set the substituted HTML as `page.content()`, `page.screenshot()` to PNG at the target dimensions (1080x1080 for Instagram carousel slides).
4. Upload the PNG via `AssetStorage.put()`, get back a public URL.

This is plain code — no network call to Gemini or Open Design on this path, matching Decision 3's cost goal directly.

---

## Carousel generation flow (content -> slide breakdown -> templated render -> preview -> approval -> publish)

```
1. A content draft is approved (existing Sprint 6 flow) or a founder explicitly
   requests "make this a carousel" from an approved draft.
2. carousels.ts native slide-breakdown step splits draft.content into N slides
   (title + body per slide) — plain text logic, reuses the existing Gemini
   gateway only if a smarter split is worth the token cost; no Open Design call.
3. resolveDesignSystem() resolves the workspace/channel/campaign/persona-scoped
   design system markdown.
4. For each distinct slide shape needed: render.ts resolves or authors
   (DesignProvider.authorTemplate) the cached template.
5. render.ts substitutes each slide's real copy into its template and
   screenshots it; AssetStorage.put() for each slide image.
6. A new drafts row is created: taskType carries the carousel task type,
   content = the per-slide copy (reviewable text), media = the N slide image
   URLs. Enters the approval gate exactly like any other draft
   (draft -> pending_review -> approved/rejected/edited).
7. On approval + publish: the existing publish route calls
   InstagramAdapter.publishPost({ ..., media: draft.media }) — the 2-10 item
   carousel Graph API flow already implemented in instagram.ts fires unchanged.
```

---

## Ads image creative flow (Part 2)

```
1. Ad copy draft (existing meta_ad_creative taskType) is approved.
2. Founder (or automation) requests a matching ad image; same
   resolveDesignSystem() + render.ts path as the carousel flow, single slide,
   ad-specific slideShape (e.g. "ad-1080x1080").
3. MetaAdsAdapter.uploadAdImage(externalAccountId, pngBytesOrUrl) -> image_hash
   via Meta's /act_{id}/adimages endpoint.
4. createAdCreative(...) extended to accept { imageHash } and include it in
   the creative object's object_story_spec.link_data.image_hash.
5. ad-launches.ts wires the creative draft's media[0] through uploadAdImage
   before calling createAdCreative, same creativeDraftId join already in place.
```

---

## UI changes

- **Brain > Design tab** (`apps/web/app/workspaces/[id]/brain/design/`): base design system editor (same editing UX as the other five brain docs) + an overlay manager for channel/campaign/persona scoping, modeled directly on the existing channel-guidance overlay UI from Sprint 44.
- **Content/Campaign view:** a "Generate carousel" action on an approved draft; carousel preview (slide carousel/swiper of the rendered images) inside the existing approval UI, sitting alongside the text content already shown there.
- **Ad creative view:** a "Generate ad image" action alongside existing ad copy review, Part 2.

---

## Error handling

- Open Design daemon unreachable / auth failure -> `DesignProviderError`, surfaced as a clear "design service unavailable, try again" state; does not block text-only content flows (this whole module is additive).
- Gemini quota/rate-limit during template authoring -> same retry/backoff posture as the existing `GeminiGateway` calls elsewhere in the codebase; template authoring is rare enough that a manual retry is an acceptable v1 UX.
- Render failure (Playwright crash, malformed template) -> fails the carousel-generation request with the underlying error; never partially publishes a draft with missing slide images.
- `AssetStorage` upload failure -> same treatment as render failure; no draft is created with a broken media URL.
- Meta `adimages`/`createAdCreative` failure (Part 2) -> surfaced through the existing ad-launch error path, unchanged.

---

## Implementation checklist

**Part 1 — Social/Instagram carousel:**
- [ ] `design_systems`, `design_overlays`, `design_templates` tables + migration.
- [ ] `drafts.media` column + migration.
- [ ] `resolveDesignSystem()` + CRUD service + routes (mirrors `guidance.ts`/`routes/guidance.ts`).
- [ ] `DesignProvider` interface + `OpenDesignProvider` impl + inline test fake.
- [ ] `AssetStorage` interface + S3-compatible impl + inline test fake.
- [ ] `render.ts` (Playwright) deterministic renderer.
- [ ] `carousels.ts` service: slide breakdown -> template resolve/author -> render -> draft creation.
- [ ] Wire `drafts.media` into `InstagramAdapter.publishPost` at the existing publish route.
- [ ] Brain "Design" tab UI + overlay manager.
- [ ] Carousel preview + "Generate carousel" UI on the content/campaign view.
- [ ] Self-host Open Design (Docker) with `opencode-cli` installed in the image; `.env.example` entries.

**Part 2 — Meta Ads image creative:**
- [ ] `uploadAdImage` on `MetaAdsAdapter`; `createAdCreative` accepts `imageHash`.
- [ ] Wire ad-creative draft `media` through `ad-launches.ts` before `createAdCreative`.
- [ ] Ad creative view UI: "Generate ad image" action.

---

## Automated verification

- Unit tests for `resolveDesignSystem()` precedence (mirrors existing `guidance.ts` test suite structure) — no network.
- `OpenDesignProvider` and `AssetStorage` tested exclusively against inline fakes typed as their interfaces (matching the existing `ConnectorFabric`/`EvidenceStore` test convention) — tests never hit a real Open Design instance, Gemini, or S3-compatible storage.
- `render.ts` tested with a fixed template + fixture content, asserting the produced PNG dimensions/non-emptiness rather than pixel-diffing.
- Carousel flow integration test: fake `DesignProvider` returns a canned template, fake `AssetStorage` returns canned URLs, asserts the resulting `drafts` row has the right `media` shape and moves through `draft -> pending_review -> approved` correctly.
- Instagram publish test extended to assert `media` from an approved carousel draft reaches `publishPost` unchanged.
- Part 2: `createAdCreative`/`uploadAdImage` tested against a fake Meta adapter, asserting `image_hash` flows from upload to creative object.

`npm test` and `npm run typecheck` must stay green per the standing rule.

---

## Founder acceptance checklist

- [ ] Open the Brain, see a "Design" tab, edit the base visual identity, save.
- [ ] Add a campaign-specific design overlay; confirm a carousel generated for that campaign reflects the override (and one generated outside it doesn't).
- [ ] Approve a piece of content -> generate a carousel -> see per-slide previews in the approval UI -> approve -> publish -> the Instagram post is a real multi-image carousel.
- [ ] Regenerate a second carousel for the same design system/slide shape and confirm (via logs/timing) no new Open Design/Gemini call happened — only the deterministic renderer ran.
- [ ] Edit the base design system, generate a third carousel, confirm a new template gets authored (fingerprint changed) rather than reusing the stale cached one.
- [ ] Part 2: approve ad copy -> generate a matching ad image -> launch on Meta -> the live ad has the generated image attached.

---

## Known limitations

- Self-hosting Open Design is real ops surface: a Docker service, an `opencode-cli` binary in that image, and a `GEMINI_API_KEY` with enough headroom for occasional template-authoring calls. Not zero-maintenance.
- Only Instagram gets end-to-end publish in this sprint; LinkedIn/X/Twitter carousels wait on their own connector sprints.
- No background/brand-asset library — a "static background" referenced by a template is whatever URL the founder pastes into the design system doc or overlay content for now; a proper upload flow can ride on top of `AssetStorage` later without changing this sprint's shape.
- Template cache invalidates on any design-system content change (whole-doc fingerprint), which may re-author more often than strictly necessary if only an unrelated section changed; fine at this volume, revisit if template-authoring cost becomes material.
- `design_templates` is workspace-scoped, not shared across workspaces — no cross-tenant template reuse, which is the correct tradeoff for brand isolation but means every new workspace pays one authoring call per slide shape it actually uses.

---

## Progress log

*(not started)*
