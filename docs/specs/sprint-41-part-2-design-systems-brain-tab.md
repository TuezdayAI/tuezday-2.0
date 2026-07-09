# Spec: Sprint 41, Part 2 — Design systems: Brain "Design" tab, overlays, resolver

- **Status:** spec — not started.
- **Umbrella:** `docs/specs/sprint-41-design-layer-carousel-pipeline.md` (Decisions 4, 10). Self-contained; umbrella is context only.
- **Branch:** `sprint-41-design-layer-carousel-pipeline` (commit this part before starting Part 3).
- **Depends on:** nothing in Sprint 41 (independent of Part 1). Reuses Sprint 44's `guidance_overrides` pattern (already on `main`).
- **Size:** M.

> **For agentic workers:** strict TDD. `npm test` and `npm run typecheck` green before committing.

## Goal

Give every workspace an editable **visual identity**: a DESIGN.md-shaped markdown doc (palette, typography, spacing, components, motion, anti-patterns) that appears as one additional **Design** tab in the Brain UI, plus channel/campaign/persona **overlays** with most-specific-wins resolution. This is the data + resolution layer the rest of Sprint 41 consumes; nothing here calls Open Design or an LLM.

Two hard constraints (founder decisions):

1. **Separate from the brain.** It *looks* like a 6th brain tab, but it is NOT a brain doc: do not touch `BRAIN_DOC_TYPES` in `packages/contracts`, do not touch `packages/brain`'s resolver (`ResolveInput`/`BrainContents`). Sprint 43 made brain context selective; injecting design markdown into every text prompt would regress that. Design systems get their own tables, service, routes, and resolver.
2. **Multi-design-system capable from day one.** Schema/services support multiple named systems per workspace (like cloud design tools). v1 seeds and surfaces exactly **one org-level default** — no switcher/creator UI yet — but adding a second system later must be a UI change, not a migration.

## Data model (`apps/api/src/db/schema.ts`, then `npm run db:generate -w apps/api`)

```ts
// Design systems — Brain UI's additional "Design" tab. Deliberately NOT part of
// brain_documents / BRAIN_DOC_TYPES. Multiple named systems per workspace are
// supported; v1 seeds exactly one org-level default (isDefault = 1) and the UI
// surfaces only that one. Uniqueness is (workspaceId, name), NOT workspaceId.
export const designSystems = sqliteTable("design_systems", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("Default"),
  isDefault: integer("is_default").notNull().default(0), // exactly one per workspace, enforced in the service
  content: text("content").notNull(), // DESIGN.md-shaped markdown
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("design_systems_workspace_name").on(t.workspaceId, t.name)]);

// Channel/campaign/persona overlays — clones guidance_overrides' shape and
// most-specific-wins precedence verbatim (Sprint 44), scoped to a design system.
export const designOverlays = sqliteTable("design_overlays", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  designSystemId: text("design_system_id").notNull().references(() => designSystems.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  personaId: text("persona_id").references(() => personas.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  content: text("content").notNull(), // partial DESIGN.md override/addendum
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("design_overlays_system_channel_scope").on(t.designSystemId, t.channel, t.personaId, t.campaignId)]);
```

Contracts (`packages/contracts/src/index.ts`): `designSystemSchema`, `designOverlaySchema`, `resolvedDesignSystemSchema` (content + trace). Channels reuse the existing channel vocabulary from contracts — do not redeclare.

## Service (`apps/api/src/services/design-systems.ts`)

Mirror `apps/api/src/services/guidance.ts` structurally:

- `ensureDefaultDesignSystem(db, workspaceId)` — seeds the org-level default row (name "Default", `isDefault: 1`, starter DESIGN.md skeleton content) if none exists. Called from workspace creation, same place `ensureBrainDocs` seeds the five brain docs; also called lazily by reads so pre-existing workspaces get one on first touch.
- CRUD: `getDesignSystem` / `updateDesignSystem` (content edits bump `updatedAt`); `listDesignSystems` (multi-capable surface, even though v1 UI uses only the default); overlay CRUD (`listOverlays`, `upsertOverlay`, `deleteOverlay`), all workspace-scoped.
- Service enforces exactly one `isDefault` per workspace (flipping default is out of v1 UI scope but the invariant lives here, not in the UI).
- `resolveDesignSystem(db, workspaceId, { channel, personaId?, campaignId?, designSystemId? })`:
  - `designSystemId` optional, defaults to the workspace's `isDefault` system — v1 callers never pass it; the parameter exists so multi-system selection later is additive.
  - Winner chain, identical precedence to `resolveChannelGuidance`: `persona+campaign > persona > campaign > channel-only > base row`. Only overlays belonging to the selected design system are considered.
  - Returns `{ content, trace: { source: "persona+campaign" | "persona" | "campaign" | "channel" | "base", overlayId? , designSystemId } }` — same transparency contract the brain promises. Overlay content is appended to the base content ("base + override addendum"), matching how Sprint 44 guidance is applied.

## Routes (`apps/api/src/routes/design-systems.ts`, mirror `routes/guidance.ts`)

- `GET /workspaces/:id/design-system` — default system (ensures seed).
- `PUT /workspaces/:id/design-system` — update default system content.
- `GET /workspaces/:id/design-system/overlays`, `PUT .../overlays` (upsert by scope), `DELETE .../overlays/:overlayId`.
- `GET /workspaces/:id/design-system/resolve?channel=...&personaId=...&campaignId=...` — returns resolved content + trace (the "readable before any LLM call" promise; Part 4's pipeline calls the service directly).
- Register in `app.ts` alongside the other route groups. Validation via the new contracts schemas; thin routes, logic in the service; writes attributed via `actorOf(request)` if version history is later added (v1: plain `updatedAt`, matching guidance).

## UI (`apps/web/app/workspaces/[id]/brain/design/page.tsx`)

- Add a **Design** tab to the existing Brain tab bar (6th tab position; same editor UX as the five brain docs — textarea/markdown editor + save).
- Below the editor: overlay manager modeled directly on Sprint 44's channel-guidance overlay UI — list overlays with scope chips (channel / +persona / +campaign), add/edit/delete.
- v1 shows only the default system; no system switcher/creator.

## Out of scope (this part)

- Any Open Design / LLM / rendering code (Part 3), pipeline usage (Part 4), entitlement gating (Part 4 — editing a design doc is free; only *generation* spends plan credits per umbrella Decision 10).
- Multi-system switcher/creator UI; per-generation system selection.
- Versioned history of design docs (can adopt the brain-doc versioning pattern later).

## Automated verification (`apps/api/test/design-systems.test.ts`)

- Seeding: workspace creation (and lazy read) yields exactly one default system; repeat calls don't duplicate.
- CRUD round-trips validate against contracts schemas; overlay upsert respects the `(designSystemId, channel, personaId, campaignId)` uniqueness.
- `resolveDesignSystem` precedence: all five winner-chain cases, mirroring the existing guidance test structure; trace `source` correct in each.
- Multi-system readiness: create a second system directly via the service, attach an overlay to it, and assert resolution against the *default* system ignores it; resolution with explicit `designSystemId` of the second system uses it.
- Membership enforcement: non-member gets 403 on all routes (auth guard stays real via `buildAuthedApp`).

## Founder acceptance

- [ ] Open the Brain — a "Design" tab appears alongside soul/icp/voice/history/now; edit and save the base visual identity.
- [ ] Add a campaign-scoped overlay and a channel-only overlay; the resolve endpoint (or UI preview) shows the right winner for each scope combination, with a trace saying why.
- [ ] Confirm nothing changed in text generation prompts (design content must not appear in any brain context bundle).

## Progress log

*(not started)*
