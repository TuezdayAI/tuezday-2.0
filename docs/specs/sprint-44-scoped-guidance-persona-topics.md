# Spec + Implementation Plan: Sprint 44 — Scoped guidance & persona topics

> Status: in build (started 2026-07-03)
> Roadmap entry: `docs/plans/sprint-guide-21-onward.md` → Phase G → Sprint 44 (**"Sprint B"** in
> `docs/plans/context-discovery-gap-assessment.md`, Gap 2).
> Branch: `sprint-44-scoped-guidance-persona-topics`, **off `sprint-43-resolver-v2-selective-context`**
> (it builds on Resolver v2's tier-1 keyed lookups and trace vocabulary).
> **Required merge order: `main` ← `sprint-43-resolver-v2-selective-context` ← this branch.**
> Operating rules unchanged: written spec → tests-before-implementation → build → automated
> verification → founder manual acceptance → frozen. This is an **M** slice.

This document is **self-contained**: it is both the slice spec and the step-by-step build guide, so
a fresh session can resume from it without re-deriving context. "Build order" is the checklist; the
"Progress log" at the bottom records what is done.

---

## Decisions locked (founder, 2026-07-03)

1. **Precedence: persona beats campaign.** Most-specific-wins order for channel guidance:
   `persona+campaign > persona > campaign > workspace channel > built-in default`. This matches the
   existing overlay ontology (org → channel → campaign → persona; persona is the most specific
   layer) — "who is speaking" outranks "which initiative".
2. **Per-connection content profiles are injected at draft time**, not store-only: a new tier-1
   keyed `account` section carries the publishing account's topics + guidelines into the prompt.
   This is what makes the founder's two-X-accounts scenario actually draft differently.
3. From the gap assessment (already founder-reviewed): scoped guidance **replaces** less-specific
   guidance (most-specific-wins) — it does not stack; the trace names the scope that won.

## Goal

Gap 2 (verified 2026-07-02): configuration is too thin below the workspace level.

- Guidance has exactly one dimension — `guidance_overrides` is one row per (workspace, channel).
  The founder's scenario — "one X account posts about AI/tech, another about
  consciousness/psychology, each drafting under its own guidelines" — is unrepresentable.
- Personas carry only name (≤100), description (≤500), one free-text overlay (≤10k). No
  topics/themes, no structured drafting rules (tone / style / never-say).
- Connections (social accounts) have a displayName and persona routing but zero content
  configuration.

This sprint adds the three missing configuration surfaces and wires them into the Resolver-v2
tier-1 keyed lookups so every one shows up in the context trace:

1. **Scoped guidance** — `workspace × channel × optional persona × optional campaign`,
   most-specific-wins with the winning scope named in the trace.
2. **Persona topics & structured drafting fields** — `topics[]`, `tone`, `styleRules`, `avoid`,
   rendered as labeled lines in the persona section; topics feed the Tier-3 zoom query now and
   discovery matching in Sprint 45.
3. **Per-connection content profile** — `topics[]` + `guidance` per connection, editable on the
   Connectors page, injected as a tier-1 `account` section when the publishing account is known at
   draft time.

Prerequisite for Sprint 45 (discovery routing matches items against persona/account topics).

## Founder-visible chain (acceptance)

Brain page → Scoped guidance card → add a LinkedIn guidance override scoped to persona "Field CTO"
→ Resolver page → run Resolve for `linkedin_post` with that persona → the Channel section shows the
scoped text and the reason names the persona scope; without the persona it falls back to the
workspace/default text → Personas: give a persona topics + tone + never-say → the persona section
of the trace shows the labeled lines and the zoom query contains the topics → Connectors: write a
content profile on an X connection bound to a persona → generate an X draft as that persona → an
"Account" section appears in the trace carrying the profile, reason naming the handle → an inbox
reply on that connection carries the same account section.

## Out of scope (logged in `docs/deferred-improvements.md` where marked ⏸)

- Discovery consuming topics for matching/routing — Sprint 45 ("C").
- `runAutomation` passing persona (deferred #11) — Sprint 45.
- Deriving a persona from the connection binding for engagement replies (⏸ — replies get the
  account section from the item's own `connectionId`, but scoped guidance for replies stays
  workspace-level until Sprint 45 routing passes persona).
- Per-account cadence defaults (gap table's fourth row, "later").
- User-defined channels (channels stay the 7-value contracts enum).
- Guidance versioning/history (unchanged from Sprint 21).
- Stacking/composing scoped guidance (most-specific-wins only, per decision 3).

---

## Design

### 1. Scoped guidance

**Schema** (`apps/api/src/db/schema.ts` → migration `0031_*`): `guidance_overrides` gains

```ts
personaId: text("persona_id").references(() => personas.id, { onDelete: "cascade" }),   // nullable
campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }), // nullable
```

The old unique index `(workspaceId, channel)` is replaced by
`(workspaceId, channel, personaId, campaignId)`. SQLite/Postgres treat NULLs as distinct in unique
indexes, so the index does not deduplicate unscoped rows by itself — the service upserts
select-first (single-writer better-sqlite3, same pattern as Sprint 21), and the index still guards
fully-scoped rows. Cascade deletes clean up scoped rows when a persona/campaign is removed.

**Contracts** (`packages/contracts/src/index.ts`):

- `updateGuidanceInputSchema` gains optional `personaId` / `campaignId` (uuid). Existing callers
  are unaffected (both optional).
- `channelGuidanceSchema` (the resolved read model) gains
  `personaId: uuid.nullable()`, `campaignId: uuid.nullable()` — both null for workspace-level and
  default rows — and keeps `source: "default" | "workspace"` meaning "built-in text vs
  founder-written text".
- New `guidanceOverrideSchema` — the management read model for the scoped list:
  `{ id, channel, content, personaId, campaignId, personaName, campaignName, updatedAt }`
  (names joined in for the UI).
- New `GUIDANCE_CONTENT_MAX_CHARS = 4_000` constant (was an inline literal).

**Service** (`apps/api/src/services/guidance.ts`):

```ts
export interface GuidanceScope { personaId?: string | null; campaignId?: string | null }

resolveChannelGuidance(db, workspaceId, channel, scope?: GuidanceScope): ResolvedGuidance
// Loads all rows for (workspace, channel), picks by precedence:
//   persona+campaign match > persona match > campaign match > unscoped row > built-in default.
// ResolvedGuidance gains personaId/campaignId (of the winning row) and
// scopeLabel?: string — a preformatted human label (persona "X" / campaign "Y" /
// persona "X" + campaign "Y") the resolver folds into the trace reason.

listChannelGuidance(db, workspaceId)            // unchanged: 7 workspace-level rows (scoped rows excluded)
listScopedGuidance(db, workspaceId)             // new: all rows with a persona or campaign scope, names joined
setChannelGuidance(db, workspaceId, channel, content, scope?)   // upsert at that exact scope
resetChannelGuidance(db, workspaceId, channel, scope?)          // delete that exact scope row
```

**Routes** (`apps/api/src/routes/guidance.ts`):

| Endpoint | Behavior |
|---|---|
| `GET /workspaces/:id/guidance` | unchanged — 7 workspace-level rows. |
| `GET /workspaces/:id/guidance/overrides` | all scoped rows (`guidanceOverrideSchema[]`) for the management UI. |
| `GET /workspaces/:id/guidance/:channel/effective?personaId=&campaignId=` | the most-specific-wins result for that scope — `channelGuidanceSchema` + `scopeLabel`. Powers the UI preview and the acceptance test. |
| `PUT /workspaces/:id/guidance/:channel` | body gains optional `personaId`/`campaignId`; each must exist in the workspace (404 `persona_not_found` / `campaign_not_found`); upserts at that exact scope. |
| `DELETE /workspaces/:id/guidance/:channel?personaId=&campaignId=` | deletes that exact scope row (idempotent 200, as today). |

**Resolver** (`packages/brain/src/resolver.ts`): `ResolveInput.channelGuidance` gains optional
`scope?: string` (the preformatted label). The channel section's reason becomes e.g.
`Channel guidance for x (tier 1, keyed — workspace override, scoped: persona "AI Account").`
No scope → reasons unchanged byte-for-byte (pinned tests don't move).

**Call sites** — pass the scope wherever persona/campaign ids are known at draft time
(all 11 `resolveChannelGuidance` call sites audited 2026-07-03):

| Call site | Scope passed |
|---|---|
| `routes/generations.ts` (draft + angle) | `parsed.data.personaId` / `campaignId` |
| `routes/personas.ts` (`/resolve` context inspector) | request personaId / campaignId |
| `services/signal-drafting.ts` | `opts.persona?.id` / `opts.campaign?.id` |
| `services/launches.ts` | `launchRow.personaId` / `campaignId` |
| `services/launch-sequences.ts` | `launch.personaId` / `campaignId` |
| `routes/pr.ts` ×2, `routes/ad-creatives.ts`, `routes/outbound.ts` | campaignId where the request carries one; persona n/a |
| `services/engagement-reply.ts` | none this sprint (see out-of-scope ⏸) |

`services/review.ts` inherits the caller's resolved guidance via `ReviewContext` — reviewers
automatically judge against the same scoped text.

### 2. Persona topics & structured drafting fields

**Schema**: `personas` gains

```ts
topicsJson: text("topics_json").notNull().default("[]"),   // string[]
tone: text("tone").notNull().default(""),                   // ≤ 300 chars
styleRules: text("style_rules").notNull().default(""),      // ≤ 2000 chars, one rule per line
avoid: text("avoid").notNull().default(""),                 // ≤ 1000 chars — "never say"
```

**Contracts**: `personaSchema` + `upsertPersonaInputSchema` gain
`topics: string[]` (≤ `PERSONA_TOPICS_MAX = 20` items, each trimmed 1–`PERSONA_TOPIC_MAX_CHARS =
80`), `tone`, `styleRules`, `avoid` (constants `PERSONA_TONE_MAX_CHARS = 300`,
`PERSONA_STYLE_RULES_MAX_CHARS = 2_000`, `PERSONA_AVOID_MAX_CHARS = 1_000`). All default to
empty — existing clients keep working.

**Service** (`apps/api/src/services/personas.ts`): rows now need mapping (`topicsJson` →
`topics`); add `rowToPersona` and update create/update/list/get. New
`toResolvePersona(persona): ResolvePersona` helper so the six call sites that hand-build
`{ name, description, overlay }` stop drifting (generations, signal-drafting, launches,
launch-sequences, personas-preview, review context assembly).

**Resolver**: `ResolvePersona` gains optional `topics?: string[]`, `tone?`, `styleRules?`,
`avoid?`. The persona section renders labeled lines after the overlay:

```
Speaking as: Field CTO.
<description>
<overlay>
Topics this persona covers: agentic coding, evals, context engineering
Tone: dry, technical, first-person
Style rules:
<styleRules verbatim>
Never say / avoid:
<avoid verbatim>
```

Empty fields render nothing — a persona with only name/description/overlay produces byte-identical
output to today. `composeZoomQuery` (`packages/brain/src/zoom.ts`) appends persona topics (and
account topics, below) — they describe what this voice covers, exactly the query material Tier 3
needs.

### 3. Per-connection content profile

**Schema**: `connections` gains `contentProfileJson: text("content_profile_json").notNull().default("{}")`.

**Contracts**: `connectionContentProfileSchema = { topics: string[] (≤20 × ≤80 chars, default []),
guidance: string (≤ CONNECTION_GUIDANCE_MAX_CHARS = 2_000, default "") }`;
`connectionSchema` gains `contentProfile`; `updateConnectionContentProfileInputSchema` for the PUT.

**Service/routes**: `rowToConnection` parses the profile; new
`setConnectionContentProfile(db, workspaceId, connectionId, profile)`;
`PUT /workspaces/:id/connections/:connectionId/content-profile` on the existing connections route
group.

**Draft-time account resolution** — new `apps/api/src/services/resolve-account.ts`:

```ts
resolveDraftAccount(db, workspaceId, args: {
  personaId?: string | null;
  channel: Channel;
  connectionId?: string;      // explicit — inbox replies
}): ResolveAccount | undefined
```

- Explicit `connectionId` (engagement replies — `inbox_items.connectionId`): load the connection.
- Else persona + social channel (`linkedin`/`x`/`instagram`): reuse
  `resolvePersonaSocialConnection` (the exact routing publishing uses — primary account for that
  persona × provider × channel). Any routing error → `undefined` (drafting never fails on this).
- Returns `undefined` unless the connection resolves **and** its content profile is non-empty
  (no noise sections for unconfigured accounts).
- `ResolveAccount = { name, handle?, provider, topics?, guidance? }`.

**Resolver**: new optional `account?: ResolveAccount` input; new `"account"` `ContextLayer`; a
**conditional** section (pushed only when present, like `conversation`/`angle` — existing section
lists stay byte-identical) placed after `persona`, before the zoom sections (it is tier-1 keyed
identity, part of the stable prefix). Content:

```
Publishing as: <name> (@handle) on <provider>.
This account covers: <topics>
Account guidelines:
<guidance>
```

Reason: `Account content profile for @handle (tier 1, keyed): the account this draft publishes
from.` Account topics feed `composeZoomQuery`.

**Call sites wired** (draft paths where the account is knowable):

- `routes/generations.ts` (draft + angle brief) — persona + channel.
- `routes/personas.ts` `/resolve` — persona + channel (the inspector shows exactly what a
  generation would send).
- `services/signal-drafting.ts` — persona + channel.
- `services/launches.ts` — launch persona + per-channel (`x`/`linkedin`/`instagram`).
- `services/launch-sequences.ts` — launch persona + `x` for `x_dm` follow-ups.
- `services/engagement-reply.ts` — the item's own `connectionId`.
- Not wired (no publishing account exists): outbound email, pr, ad-creatives.

### Web (`apps/web`)

- **Brain page** — the Channel guidance section gains a **Scoped guidance** card: a list of all
  scoped overrides (channel, persona/campaign names, content preview, edit, delete) + a create
  form (channel select, persona select (optional), campaign select (optional, at least one scope
  required), textarea ≤ 4000). Save → `PUT` with scope; delete → `DELETE` with scope params.
- **Resolver page** — the persona editor gains the four new fields (topics as a comma-separated
  input, tone input, style-rules textarea, avoid textarea). The context-inspector trace renders
  the new `account` section with a `.layer-account` badge (new CSS variable/class alongside
  `.layer-zoom`).
- **Connectors page** — each connected social account gets a small **Content profile** editor
  (topics comma-separated + guidance textarea, Save).

---

## Tests (before/with implementation; all suites green before push)

### `packages/contracts`
- Persona upsert: defaults (empty topics/tone/styleRules/avoid), rejects >20 topics, >80-char
  topic, over-limit tone/styleRules/avoid.
- Guidance input: accepts optional personaId/campaignId uuids, rejects non-uuids.
- Connection content profile: defaults, limits; `connectionSchema` round-trips with profile.

### `packages/brain`
- Persona section renders the labeled lines; empty fields → byte-identical to today.
- Account section: absent when no `account` input (section list unchanged); present after
  `persona` with the reason; content renders name/handle/topics/guidance.
- `channelGuidance.scope` label appears in the channel reason; absent scope → unchanged reason.
- `composeZoomQuery` includes persona + account topics.

### `apps/api` (`guidance.test.ts` extended; `selective-context.test.ts` / persona / connection suites extended)
- Scoped CRUD: PUT with personaId creates a scoped row; workspace-level GET still returns 7
  unscoped rows; `/guidance/overrides` lists the scoped row with names; DELETE with scope removes
  only that row; unknown persona/campaign → 404.
- Precedence via `/guidance/:channel/effective`: seed all four override kinds, assert
  persona+campaign > persona > campaign > workspace > default as scopes are peeled away.
- Cascade: deleting the persona deletes its scoped guidance rows.
- Generation integration: persona-scoped LinkedIn override + `POST /generate` with that persona →
  the stored channel section carries the scoped text and the reason names the persona; without the
  persona → workspace text.
- Personas: upsert with topics/tone/styleRules/avoid round-trips; `/resolve` trace shows the
  labeled lines and the zoom query contains the topics.
- Connections: content-profile PUT round-trips (fake fabric fixtures as in existing connection
  tests).
- Account injection: persona bound to a connection with a profile → sandbox X draft's persisted
  `sectionsJson` contains the `account` section; connection without a profile → no section; inbox
  reply → account section from the item's connection.

---

## Build order (checklist)

1. [ ] Branch off `sprint-43-resolver-v2-selective-context`; commit this spec.
2. [ ] Contracts: guidance scope inputs/read models, persona fields + limits, connection content
   profile. Contract tests.
3. [ ] Brain: persona labeled lines, `account` section + layer, guidance scope in reason, topics
   into `composeZoomQuery`. Brain tests.
4. [ ] Schema: guidance scope columns + index swap, persona columns, connection profile column;
   `npm run db:generate -w apps/api` (migration `0031_*`).
5. [ ] API: guidance service precedence + routes; personas service mapping + `toResolvePersona`;
   connections profile + route; `resolve-account.ts`; wire all call sites (scope + persona fields
   + account).
6. [ ] API tests green; full `npm test` + `npm run typecheck` clean.
7. [ ] Web: scoped-guidance card, persona fields, connection profile editor, `.layer-account`
   trace rendering; `next build` clean.
8. [ ] Docs: `docs/founder-acceptance-tests.md` § Sprint 44; `docs/deferred-improvements.md`
   (reply persona derivation ⏸); sprint-guide 44 entry marked built; progress log below.
9. [ ] Commit(s) with the `Co-Authored-By` trailer; `git push -u origin
   sprint-44-scoped-guidance-persona-topics`. **Do NOT merge into `main`.**

---

## Progress log

- 2026-07-03 — Spec written after a full code audit (11 `resolveChannelGuidance` + 13
  `resolveContext` call sites mapped; publish-time connection routing confirmed reusable at draft
  time via `resolvePersonaSocialConnection`; `inbox_items.connectionId` confirmed for replies).
  Founder locked the two open decisions (persona > campaign precedence; account profiles injected
  at draft time). Branch cut off the Sprint 43 branch. Implementation starting at step 2.
