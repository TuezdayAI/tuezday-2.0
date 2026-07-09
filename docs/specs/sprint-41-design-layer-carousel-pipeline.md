# Sprint 41 — Design layer: Open Design carousel pipeline (umbrella plan)

- **Status:** split into 5 parts (founder decision, 2026-07-08) — this file is the umbrella: shared decisions, part index, build order. Each part has its own self-contained spec (see Part index) and is built/committed **one part per session** so no single context window carries the whole sprint.
- **Roadmap entry:** `docs/plans/sprint-guide-21-onward.md` -> Phase F -> Sprint 41, "Design layer: automated carousel/image pipeline" (U11). Founder decision resolves the open "Open Design vs Canva" question in favor of **Open Design**, self-hosted behind a `DesignProvider` boundary.
- **Branch:** `sprint-41-design-layer-carousel-pipeline`, cut from `main` (43/44/45/46 already merged to local `main`; Part 2 reuses 44's scoped-resolution pattern). **All parts ship on this one branch**, committed part by part (founder decision, 2026-07-08).
- **Builds on:** Sprint 6 (content), Sprint 15 (ad creative), Sprint 17 (social publish — `SocialAdapter`/`PublishMedia`), Sprint 37 (plan entitlements — metering seam), Sprint 44 (scoped `guidance_overrides` most-specific-wins pattern).
- **Do NOT merge into `main`.** Push the branch; founder reviews/accepts/merges.

> **For agentic workers:** work from the **part spec** you were pointed at, not this file alone. Strict TDD per part. REQUIRED SUB-SKILL: superpowers:executing-plans.

---

## Part index and build order

| Part | Spec file | Scope (one line) | Depends on |
|---|---|---|---|
| 1 | `sprint-41-part-1-llm-provider-flexibility.md` | OpenRouter gateway + configurable primary provider + automatic fallback behind the existing `LlmGateway` seam | none (independent) |
| 2 | `sprint-41-part-2-design-systems-brain-tab.md` | `design_systems` (multi-system-capable) + `design_overlays` tables, `resolveDesignSystem()`, CRUD routes, Brain "Design" tab UI | none |
| 3 | `sprint-41-part-3-template-authoring-render-storage.md` | `DesignProvider`/`OpenDesignProvider`, `AssetStorage`, `design_templates` cache, deterministic Playwright renderer, Open Design self-host ops | Part 2 (resolver), Part 1 (authoring key selection) |
| 4 | `sprint-41-part-4-carousel-pipeline-instagram.md` | `carousels.ts` service, `drafts.media`, entitlement gating, approval-gate integration, Instagram publish wiring, generation + preview UI | Parts 2 + 3 |
| 5 | `sprint-41-part-5-meta-ads-image-creative.md` | `uploadAdImage` + `createAdCreative(imageHash)` on Meta adapter, ad-launch wiring, "Generate ad image" UI | Parts 2 + 3 (+4's gating pattern) |

Build order: **1 → 2 → 3 → 4 → 5** (1 and 2 are independent of each other; everything else is sequential). Each part ends with `npm test` + `npm run typecheck` green and a commit on this branch before the next part starts.

---

## Goal

Give Tuezday's brain a visual identity and a way to turn approved copy into on-brand images without becoming a design tool. A founder edits a **Design** tab in the brain UI (same posture as soul/icp/voice/history/now, but a separate concept — see Decision 4), and from then on: approved content can render as a branded Instagram carousel, and approved ad copy can render as a branded static ad image — both through the existing approval gate, both attached automatically to the right connector at publish/launch time.

Founder-facing outcome:

> Approve a post -> generate a branded carousel from it -> preview -> approve the visual -> publish to Instagram. Approve ad copy -> generate a matching ad image -> launch on Meta. All of it paid for by the subscriber's included plan allowance — never by connecting an API key.

---

## Decisions locked

1. **`DesignProvider` boundary, backed by a self-hosted Open Design instance — a separate deployed service, not vendored into this monorepo.** Same posture as `EvidenceStore`/R2R and `ConnectorFabric`/Nango: Tuezday owns the boundary interface (`apps/api/src/design/provider.ts`), Open Design runs as its own Docker service reachable only from the API, never exposed to the browser or to customers.

2. **No paid coding-agent CLI. Generation runs through Open Design's `byok-opencode` runtime, pointed at Tuezday's own platform LLM credentials.** Verified in `apps/daemon/src/runtimes/defs/byok-opencode.ts` in the Open Design repo: it spawns the free, open-source **OpenCode CLI**, configured per-run via a `byokProvider` entry (`protocol: "google"` verified for Gemini; an OpenAI-compatible protocol path for OpenRouter is to be verified at Part 3 implementation time — if unsupported, template authoring pins to the Gemini key as a documented limitation). `byokProvider` is run-scoped and never persisted — Open Design never stores our credential. Requires the `opencode-cli` binary in the self-hosted container; no CLI subscription of any kind.

3. **Open Design's role is template *authoring* only. It never runs per-post.** A slide/creative *layout* is generated once (agentic, via `byok-opencode`) per (workspace design system version x skill x slide shape) and cached as a template. Every actual post/ad after that is a **deterministic render**: substitute real copy into the cached template's placeholders and screenshot it. No LLM call, no Open Design call, on the hot path. This is the only way "static background, swap the text" stays cheap at volume.

4. **Visual identity is a brain-adjacent concept, deliberately *not* added to `BRAIN_DOC_TYPES`.** Do NOT add `"design"` to `packages/contracts`' `BRAIN_DOC_TYPES` — `packages/brain/src/resolver.ts` (Sprint 43) injects every member into *every* resolution, and a palette/type/motion doc is only relevant to visual tasks; injecting it everywhere would regress Sprint 43's token discipline. Instead:
   - New table `design_systems` holds design-system docs, presented as one additional **Design** tab in the Brain UI — brain-tab UX, separate concept, read through its own service, never through `packages/brain`'s general resolver.
   - **Multiple named design systems per workspace are supported at the schema/service level from day one** (founder decision, 2026-07-08): `name` + `isDefault` columns, uniqueness on `(workspaceId, name)`. v1 seeds and surfaces exactly **one org-level default**; adding a second system later is a UI change, not a migration.
   - New table `design_overlays` clones Sprint 44's `guidance_overrides` shape and most-specific-wins precedence, scoped to a design system, for channel/campaign/persona-specific visual variants.
   - A new resolver, `resolveDesignSystem()`, is called only by the carousel/ad-image pipeline — never wired into `ResolveInput`/`BrainContents`.

5. **New `AssetStorage` boundary — the one genuinely new piece of infrastructure this sprint requires.** No blob/file storage exists in this repo today; every existing `media` reference is a plain public URL. Instagram's Graph API and Meta's ad-image upload both need publicly fetchable URLs. `apps/api/src/design/storage.ts` defines a minimal `AssetStorage` interface (`put(bytes, contentType) -> { url }`); real impl is an S3-compatible client (pick the cheapest provider at implementation time). Deliberately not a DAM — no library UI, no folders, no search.

6. **Approval Gate gets a `media` field, reusing the existing `LaunchMedia` shape.** `drafts.media` (JSON, `{ url, type: "image" }[]`) alongside the existing `content`/`state` columns. `content` holds per-slide copy (what a reviewer reads); `media` holds rendered image URLs (what a reviewer sees). `transitionTo()`/`canTransition()` untouched.

7. **Two publish targets in this sprint:** Instagram carousel (Part 4 — `InstagramAdapter.publishPost` already implements the 2-10 item Graph API carousel flow) and Meta Ads static image (Part 5 — extend `createAdCreative` + new `uploadAdImage`). LinkedIn/X/Twitter carousel/image publishing are **not** in scope (their connectors don't exist yet).

8. **MCP is explicitly out of scope.** Tuezday's backend talks to Open Design's plain REST/SSE surface (`/api/projects`, `/api/chat`) directly — Tuezday is the orchestrator, not another agent consuming Open Design as a tool.

9. **Skill/template selection is an explicit allowlist, not the full Open Design catalog.** Only `skillId: "social-carousel"` (or a Tuezday-authored variant) is ever sent; no project the API creates gets access to skills outside this list.

10. **No user-supplied API key anywhere; design usage draws from the subscriber's included plan allowance (Sprint 37 entitlements).** The entire pipeline runs on Tuezday's platform credentials. A subscriber never connects a key to use the design layer; subscribing to a plan is sufficient. Each carousel/ad-image **generation request** is gated with `assertWithinLimit(db, workspaceId, "monthlyGenerations", ...)` (the exact seam `routes/generations.ts` uses) and recorded in the `generations` table so it draws down the same base "credits" every plan includes (free 50 / pro 1000 / scale unlimited, per `PLANS`). Template authoring (rare, cached) is internal cache-fill cost — not billed separately. Hitting the limit shows the standard upgrade prompt, never an "add API key" prompt. If a true credit-balance system later replaces Sprint 37's fixed limits, design flows inherit it automatically through this single metering seam.

11. **Multi-provider LLM resilience via OpenRouter, behind the existing `LlmGateway` seam (Part 1; founder decision, 2026-07-08).** The platform must not hard-depend on Gemini being up. A new `OpenRouterGateway` implements `LlmGateway`; a **configurable primary** (`LLM_PROVIDER=gemini|openrouter`, env/deploy-level — not per-workspace in v1) picks which provider serves first, and a `FallbackGateway` automatically retries a failed call through the other configured provider. Routes and services keep depending only on `LlmGateway` — zero call-site changes. OpenRouter is chosen over wiring individual extra providers because one OpenAI-compatible endpoint fronts many models. Billing to subscribers is unchanged: generations meter through entitlements (Decision 10) regardless of which provider served the call.

---

## API grounding (Open Design)

- Repo: `github.com/nexu-io/open-design`, Apache-2.0. Self-hosted via the published Docker image (`deploy/README.md`), fronted by `OD_API_TOKEN` bearer auth, bound to an internal network only — never a public IP.
- Chat/generation contract: `POST /api/chat` accepts `agentId: "byok-opencode"`, `projectId`, `skillId`/`skillIds`, `designSystemId`, `model`, and `byokProvider: { protocol, apiKey }` — run-scoped, never persisted.
- Orchestrator contract: `docs/orchestrator-workspaces.md` and `docs/external-media-orchestration.md` (Open Design repo) — Open Design owns rendering/design-system context; Tuezday owns auth, budgets, provider credentials, writeback. Projects tagged `orchestratorWorkspace: { kind: "scratch", writeback: "external" }`.
- Multi-tenancy: none natively — Tuezday enforces isolation by creating/addressing projects exclusively from the API; no workspace ever gets a daemon URL or token.

---

## Out of scope (whole sprint)

- MCP integration with Open Design (Decision 8).
- Landing pages/prototypes, GTM decks, video/HyperFrames, image-model generation, audio.
- LinkedIn/X/Twitter carousel or image publishing (connectors don't exist yet).
- A DAM UI, asset library, folders/search (Decision 5).
- Any change to `packages/brain`'s general context resolver (Decision 4).
- Per-workspace LLM provider choice or user-connected API keys of any kind (Decisions 10/11 — provider config is deploy-level).
- Publishing a Tuezday plugin back to Open Design's marketplace.
- Running Claude Code, Codex, or any paid coding-agent CLI (Decision 2).

---

## Founder acceptance (sprint-level; each part spec has its own detailed checklist)

- [ ] Part 1: kill the Gemini key (or force an error) and confirm a generation still succeeds via OpenRouter; flip `LLM_PROVIDER` and confirm the primary switches.
- [ ] Part 2: open the Brain, see a "Design" tab, edit the base visual identity, add a campaign-scoped overlay.
- [ ] Part 3: first carousel-shaped template gets authored via self-hosted Open Design; editing the design system re-authors (fingerprint change); repeat renders hit the cache.
- [ ] Part 4: approve content -> generate carousel -> per-slide previews in approval UI -> approve -> publish -> real multi-image Instagram carousel. Works on a plain subscribed workspace with **no API key connected anywhere**; hitting the plan's generation limit shows the standard upgrade prompt.
- [ ] Part 5: approve ad copy -> generate matching ad image -> launch on Meta -> live ad has the image attached.

---

## Progress log

- 2026-07-08 — Founder review: (a) confirmed no user API key anywhere — design ops spend the plan's included generation allowance (Decision 10); (b) design systems stay separate from the brain (one extra tab, own tables/resolver) and must be multi-system-capable at the schema level with one org-level default in v1 (Decision 4); (c) added OpenRouter-backed configurable-primary + fallback LLM resilience (Decision 11); (d) split the sprint into 5 parts on one branch, one spec per part. Part specs written; implementation not started.
