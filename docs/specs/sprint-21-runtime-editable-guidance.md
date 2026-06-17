# Spec + Implementation Plan: Sprint 21 — Runtime-editable channel/platform guidance (A4)

> Status: in build (started 2026-06-17)
> Roadmap entry: `docs/plans/sprint-guide-21-onward.md` → Phase A → Sprint 21.
> Operating rules unchanged: written spec → tests-before-implementation → build → automated
> verification → founder manual acceptance → frozen. This is an **S** slice.

This document is **self-contained**: it is both the slice spec and the step-by-step build guide, so a
fresh session can resume from it without re-deriving context. The "Build order" section is the
checklist; the "Progress log" at the bottom records what is done.

---

## Decisions locked (founder, 2026-06-17)

1. **Proceed now.** Build Sprint 21 while Sprints 14–20 are accepted manually in parallel. (Founder
   acceptance of prior sprints is a human step Claude can't perform.)
2. **Override scope = per-workspace, per-channel.** DB stores at most one override row per
   `(workspace, channel)`. The built-in defaults in `packages/contracts` are the "global" fallback.
   The resolver trace shows `built-in default` vs `workspace override`. (No campaign/persona scope,
   no cross-workspace global DB override in this slice — both are future extensions the table leaves
   room for.)
3. **Editor home = the Brain page.** A new "Channel guidance" section on
   `apps/web/app/workspaces/[id]/brain/page.tsx`, beside the five brain docs.

---

## Goal (from the roadmap)

Stop shipping channel guidance as hardcoded source. Make it editable per scope, with **zero deploy** —
the pattern the old repo had (`pipeline_config`) and the new repo regressed on.

## What this slice does

Today the resolver injects channel guidance from a hardcoded `CHANNEL_GUIDANCE` map living in
`packages/brain/src/resolver.ts`. This slice:

1. **Moves the defaults to `packages/contracts`** (`CHANNEL_GUIDANCE_DEFAULTS`) — the single source of
   truth and the fallback. The text is moved **verbatim** so generation behavior is unchanged until a
   founder edits something.
2. **Adds a per-workspace, per-channel override** persisted in a new `guidance_overrides` table, read
   at resolve time. No redeploy needed to change guidance.
3. **Makes the resolver report the source.** The `channel` context section's `reason` now states
   whether the text is the built-in default or a workspace override, so the trace is inspectable.
4. **Adds an editor** on the Brain page: per channel, edit the text, Save (creates/updates the
   override), or Reset to default (deletes the override). Each channel shows a Default / Workspace
   override badge.

Founder-visible chain: Brain page → Channel guidance → edit LinkedIn → Save → generate a LinkedIn post
→ the output reflects the edited guidance with no redeploy → the resolved-context trace shows the
edited text labelled **"workspace override."**

## Out of scope

Campaign/persona/lead-scoped guidance (only channel scope); a cross-workspace global override editable
from the DB (defaults stay in code); versioning/history of guidance edits (brain docs have history;
guidance does not in this slice); guidance for anything other than the six existing `Channel` values
(`linkedin`, `x`, `email`, `ads`, `web`, `pr`); changing the actual default text (moved verbatim).

---

## Data model

New table (Drizzle, `apps/api/src/db/schema.ts`), Postgres-portable like the rest:

```ts
export const guidanceOverrides = sqliteTable(
  "guidance_overrides",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("guidance_overrides_workspace_channel").on(t.workspaceId, t.channel)],
);
export type GuidanceOverrideRow = typeof guidanceOverrides.$inferSelect;
```

Generate the migration with `npm run db:generate -w apps/api` after editing the schema (do **not**
hand-write the SQL). It becomes `apps/api/drizzle/0018_*.sql`.

---

## Contracts (`packages/contracts/src/index.ts`)

Add near the channel definitions (`CHANNELS` is at ~line 42):

```ts
/**
 * Built-in channel guidance — the global fallback. Workspaces may override any
 * channel's text at runtime (Sprint 21); the DB holds overrides only, these stay
 * the default. Moved verbatim from packages/brain/src/resolver.ts.
 */
export const CHANNEL_GUIDANCE_DEFAULTS: Record<Channel, string> = {
  linkedin: "Channel: LinkedIn. Professional but human feed. ...",   // verbatim move
  x: "Channel: X (Twitter). ...",
  email: "Channel: Email. ...",
  ads: "Channel: Paid ads. ...",
  web: "Channel: Website. ...",
  pr: "Channel: PR / media pitch. ...",
};

/** Human label per channel for the guidance editor. */
export const CHANNEL_LABELS: Record<Channel, string> = {
  linkedin: "LinkedIn",
  x: "X (Twitter)",
  email: "Email",
  ads: "Paid ads",
  web: "Website",
  pr: "PR / media",
};

export const GUIDANCE_SOURCES = ["default", "workspace"] as const;
export type GuidanceSource = (typeof GUIDANCE_SOURCES)[number];

/** A channel's resolved guidance + where it came from (read model for the editor). */
export const channelGuidanceSchema = z.object({
  channel: z.enum(CHANNELS),
  content: z.string(),
  source: z.enum(GUIDANCE_SOURCES),
  updatedAt: z.number().int().nullable(), // null when source === "default"
});
export type ChannelGuidance = z.infer<typeof channelGuidanceSchema>;

export const updateGuidanceInputSchema = z.object({
  content: z.string().trim().min(1, "Guidance cannot be empty").max(4000),
});
export type UpdateGuidanceInput = z.infer<typeof updateGuidanceInputSchema>;
```

`CHANNEL_GUIDANCE_DEFAULTS` is the **only** copy of the default text after this slice.

---

## Brain package (`packages/brain/src/resolver.ts`)

- Delete the local `CHANNEL_GUIDANCE` const. Import the defaults from contracts and re-export them so
  brain consumers keep one import site: `export { CHANNEL_GUIDANCE_DEFAULTS } from "@tuezday/contracts";`
- Extend `ResolveInput` with an optional, DB-free hand-off (the resolver stays pure — the API resolves
  the override and passes it in):

```ts
/**
 * The channel guidance to use and where it came from. Omitted → the resolver
 * falls back to the built-in default for `channel`. The API passes the
 * workspace override here when one exists.
 */
channelGuidance?: { content: string; source: GuidanceSource };
```

- In `resolveContext`, replace the hardcoded lookup:

```ts
const guidance =
  input.channelGuidance ??
  { content: CHANNEL_GUIDANCE_DEFAULTS[input.channel], source: "default" as const };
sections.push({
  key: "channel",
  layer: "channel",
  title: `Channel: ${input.channel}`,
  content: guidance.content,
  included: true,
  reason:
    guidance.source === "workspace"
      ? `Channel guidance for ${input.channel} (workspace override).`
      : `Channel guidance for ${input.channel} (built-in default).`,
  tokens: estimateTokens(guidance.content),
});
```

(The budget sacrifice order already references `"channel"` by key — unchanged.)

---

## API service (`apps/api/src/services/guidance.ts`, new)

Mirrors the `ad-settings` service shape (`getAdSettings`/`updateAdSettings`).

```ts
export interface ResolvedGuidance { content: string; source: GuidanceSource; updatedAt: number | null; }

// Used by the resolver call sites.
export function resolveChannelGuidance(db, workspaceId, channel): ResolvedGuidance;
// override row → {content, "workspace", updatedAt}; else {default, "default", null}

export function listChannelGuidance(db, workspaceId): ChannelGuidance[];
// CHANNELS.map(resolveChannelGuidance) — always 6 rows, defaults included

export function setChannelGuidance(db, workspaceId, channel, content): ChannelGuidance;
// upsert by (workspaceId, channel); returns {channel, content, "workspace", updatedAt}

export function resetChannelGuidance(db, workspaceId, channel): ChannelGuidance;
// delete the override row; returns the now-default ChannelGuidance
```

## API routes (`apps/api/src/routes/guidance.ts`, new; registered in `app.ts`)

All workspace-guarded with the existing `workspaceOr404` pattern.

| Endpoint | Behavior |
|---|---|
| `GET /workspaces/:id/guidance` | `listChannelGuidance` → 6 `ChannelGuidance` rows (defaults + any overrides). |
| `PUT /workspaces/:id/guidance/:channel` | `:channel` must be in `CHANNELS` (400 `invalid_channel` otherwise); body via `updateGuidanceInputSchema` (400 on empty/too-long); upsert → returns the `ChannelGuidance`. |
| `DELETE /workspaces/:id/guidance/:channel` | reset to default; returns the default `ChannelGuidance`. Idempotent (deleting a non-existent override is a no-op 200). |

`registerGuidanceRoutes(app, db)` added to `buildApp` in `apps/api/src/app.ts`.

## Wire the resolver call sites

At each `resolveContext(...)` call, resolve the override first and pass it through:

```ts
const channelGuidance = resolveChannelGuidance(db, workspaceId, <channel>);
const resolved = resolveContext({ ..., channelGuidance: { content: channelGuidance.content, source: channelGuidance.source } });
```

Six call sites (confirmed):
- `apps/api/src/routes/generations.ts:68` (channel = `parsed.data.channel`)
- `apps/api/src/routes/outbound.ts:126`
- `apps/api/src/routes/pr.ts:147` **and** `pr.ts:250` (two calls — pitch + boilerplate)
- `apps/api/src/routes/signals.ts:94`
- `apps/api/src/routes/ad-creatives.ts:81`
- `apps/api/src/routes/personas.ts:112` (resolved-context preview)

---

## Web (`apps/web/app/workspaces/[id]/brain/page.tsx`)

Add a "Channel guidance" section below the brain-doc editor (match existing styling, `apiFetch`):

- On load, `GET /workspaces/:id/guidance` → list the 6 channels using `CHANNEL_LABELS`.
- Per channel: a `<textarea>` bound to the current content, a source badge (**Default** /
  **Workspace override**), a **Save** button (`PUT`, disabled until the text is dirty), and a
  **Reset to default** button (`DELETE`, shown only when `source === "workspace"`).
- After Save/Reset, re-fetch so badges + content reflect the new state.

---

## Automated verification (write tests BEFORE implementing)

- **Contracts** (`packages/contracts/test/contracts.test.ts`): `CHANNEL_GUIDANCE_DEFAULTS` and
  `CHANNEL_LABELS` cover every `Channel`; `updateGuidanceInputSchema` rejects empty and >4000 chars;
  `channelGuidanceSchema` parses a valid row.
- **Brain resolver** (`packages/brain/test/resolver.test.ts`): update the existing `CHANNEL_GUIDANCE`
  references to `CHANNEL_GUIDANCE_DEFAULTS`; assert the `channel` section uses a provided
  `channelGuidance` and the `reason` says "workspace override"; assert that omitting it falls back to
  the default text with the "built-in default" reason.
- **API** (`apps/api/test/guidance.test.ts`, new): list returns 6 defaults for a fresh workspace; PUT
  creates an override (source `workspace`, `updatedAt` set) and GET reflects it; second PUT updates in
  place (still one row); DELETE resets to default; invalid channel → 400; empty content → 400;
  **integration**: set a LinkedIn override, `POST /generate` a `linkedin_post`, assert the stored
  generation's `channel` section content equals the override and its reason mentions "workspace
  override". (Use the fake LLM gateway already used by `generations.test.ts`.)
- Full suite (`npm test`) and `npm run typecheck` green.

## Founder acceptance checklist

1. Brain page → **Channel guidance** → each channel shows its current text with a **Default** badge.
2. Edit **LinkedIn** guidance (e.g. add "Always open with a contrarian one-liner.") → **Save** → badge
   flips to **Workspace override**.
3. Sandbox/Content → generate a **LinkedIn post** → the output reflects the edited guidance; no
   redeploy happened.
4. Resolver/trace for that generation → the **Channel: linkedin** section shows the edited text and the
   reason reads **"workspace override."**
5. **Reset to default** on LinkedIn → badge returns to **Default**; next generation uses the original
   guidance again.

---

## Build order (checklist)

1. [x] Spec written (this doc).
2. [x] Contracts: `CHANNEL_GUIDANCE_DEFAULTS`, `CHANNEL_LABELS`, `GUIDANCE_SOURCES`,
       `channelGuidanceSchema`, `updateGuidanceInputSchema` (+ contracts tests).
3. [x] Brain resolver: drop local map, import/re-export defaults, add `channelGuidance` input, source
       in trace (+ resolver test updates).
4. [x] Schema: `guidanceOverrides` table; migration `0018_flat_the_spike.sql`.
5. [x] Service `services/guidance.ts` + routes `routes/guidance.ts`; registered in `app.ts`.
6. [x] Wired all six `resolveContext` call sites (generations, outbound, signals, ad-creatives, pr ×2,
       personas).
7. [x] API tests `test/guidance.test.ts` (incl. generation integration).
8. [x] Web: Channel guidance section on the Brain page (+ globals.css).
9. [x] `npm test` (535 passing) + `npm run typecheck` green.
10. [x] Progress log updated; ready for founder acceptance.

## Progress log

- 2026-06-17: Spec drafted; founder decisions locked (proceed now / per-workspace per-channel /
  Brain page).
- 2026-06-17: **Implementation complete.** Contracts own the defaults (`CHANNEL_GUIDANCE_DEFAULTS`),
  brain resolver reads `channelGuidance` + labels the source in the trace, `guidance_overrides` table
  + service + routes (`GET`/`PUT`/`DELETE /workspaces/:id/guidance[/:channel]`), all six resolver
  call sites pass the resolved override, Brain page has a Channel guidance editor. Full suite green
  (535 tests, incl. 11 new guidance + new contracts/resolver assertions); typecheck clean.
  **Awaiting founder manual acceptance** (checklist above).
</content>
</invoke>
