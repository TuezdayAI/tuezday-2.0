# Spec + Implementation Plan: Sprint 45 — Discovery routing that honors the match

> Status: built, awaiting founder acceptance (spec written + built 2026-07-03).
> Roadmap entry: `docs/plans/sprint-guide-21-onward.md` → Phase G → Sprint 45 (**"Sprint C"** in
> `docs/plans/context-discovery-gap-assessment.md`, Gap 3).
> **Branch:** `sprint-45-discovery-routing`, cut from `sprint-44-scoped-guidance-persona-topics`
> (Sprint 44 is not yet merged to `main`, and this sprint's scoring prompt uses persona topics —
> a Sprint 44 field — so it must sit on top of it).
> **Required merge order: `main` ← `sprint-43-resolver-v2-selective-context` ←
> `sprint-44-scoped-guidance-persona-topics` ← this branch.**
> Operating rules unchanged: written spec → tests-before-implementation → build → automated
> verification → founder manual acceptance → frozen. This is an **M** slice.

This document is self-contained: it is both the slice spec and the step-by-step build guide, so a
fresh session can resume from it without re-deriving context. "Build order" is the checklist; the
"Progress log" at the bottom records what is done.

---

## Decisions locked (founder, 2026-07-03)

1. **Manual signals get scored too.** `POST /workspaces/:id/signals` now runs the same
   persona×campaign matching discovery items get, unless the caller already named a persona and/or
   campaign explicitly — in which case that explicit input is trusted as a single high-confidence
   match and the LLM is never called. This fully closes deferred #11 (today it's half-closed:
   discovery-sourced signals would still fall back to blind fan-out for anything created by hand).
2. **Cross-source duplicates are kept and linked, not dropped.** When the same story surfaces from
   two sources (e.g. Google News and an RSS feed), the second copy is inserted with a new
   `duplicate` status pointing at the first (canonical) item via `duplicateOfId`. It never enters
   the triage queue (which filters on `status = "new"`), but it isn't silently discarded — the
   canonical item shows a "seen via N sources" count and the founder can see which sources
   corroborated it.
3. **The match threshold is a workspace setting**, not a hardcoded constant — `matchThreshold` on
   `SocialAutomationSettings`, next to the existing kill switch and daily caps, default `50`.

## Goal

Gap 3 (verified 2026-07-02): discovery already computes a good campaign/persona fit for every item
— `scoreUnscoredItems` LLM-judges relevance and picks the best persona + campaign — and then two
things throw that computation away:

- **`runAutomation` never reads it.** Every new signal fans out to *every* active automated
  campaign × all of its channels, with no persona passed at all (`docs/deferred-improvements.md`
  #11). An item scored as a perfect fit for "Campaign A, Field CTO persona" generates identical
  drafts for Campaign B, C, D too, authored by nobody in particular.
- **It's single-best-fit only, computed once.** An item relevant to two campaigns reaches at most
  one. Rescoring never happens — `isNull(score)` means an item scored before a persona existed, or
  before this month's campaign pivot, keeps its stale mapping forever.

There's a third gap in the same area: discovery dedup is per-source only (`(sourceId,
externalId)`), so the same story from two sources shows up twice in triage with no link between
them.

This sprint makes discovery's judgment actually drive automation:

1. **Multi-candidate scoring** — an item (or a manually-created signal) can clear the match
   threshold for several persona×campaign pairs, each stored as its own scored candidate, not
   collapsed into one "best" guess.
2. **`runAutomation` consumes the mapping** — a campaign only gets a draft from a signal that
   actually matched it above threshold, and the draft is generated *as* the matched persona. Kills
   deferred #11 for both discovery-sourced and manually-created signals.
3. **Re-score on config change** — items still sitting in triage (`status = "new"`) get re-judged
   the next time discovery runs if a persona or campaign changed since they were last scored, using
   Sprint 44's persona topics as part of what's matched against.
4. **Cross-source dedup** — URL/content-hash matching links corroborating items across sources
   instead of showing the same story twice with no relationship.

## Founder-visible chain (acceptance)

1. Two active automated campaigns exist with distinct personas and distinct Sprint-44 topics:
   Campaign A ("Product Launch", channel `linkedin`, mode `scheduled_auto`, persona "Field CTO" —
   topics: agentic coding, evals) and Campaign B ("Community", channel `x`, mode
   `human_in_the_loop`, persona "Community Lead" — topics: developer culture, memes).
2. Discovery finds an article about a new agentic-coding benchmark → triage shows it scored high
   with **one** candidate: Campaign A + Field CTO, with a reason. Campaign B does not appear — it
   didn't clear the threshold.
3. Accept it → run automation → **only** Campaign A gets a LinkedIn draft, auto-approved
   (scheduled_auto), and the draft reads in the Field CTO voice (Sprint 44 scoped guidance + persona
   topics show up in its resolve trace). Campaign B generates nothing this run.
4. A second article relevant to both personas' topics → triage shows **two** candidates. Accept it
   → automation generates a LinkedIn draft for Campaign A (auto-approved) *and* an X draft for
   Campaign B (sitting at `pending_review`, since it's human-in-the-loop).
5. The same underlying story is also picked up via a second discovery source (e.g. an RSS feed
   alongside Google News) → triage does not show a second, unrelated-looking item; the original
   item shows "seen via 2 sources," expandable to see both.
6. Founder posts a signal by hand (Content → "New signal", no persona/campaign chosen) → it gets
   auto-matched the same way a discovered item would, instead of fanning out to every campaign on
   the next automation run.
7. Founder lowers "match threshold" in Automation Settings from 50 to 30 → on the next discovery
   run, previously-below-threshold candidates start qualifying.
8. Founder edits the Field CTO persona's topics → on the next discovery run, items still sitting
   untriaged get re-scored against the new topics (already-accepted signals are untouched — history
   doesn't rewrite itself).

## Out of scope (logged in `docs/deferred-improvements.md` where marked ⏸)

- **Sprint 46 territory**: `discovery_sources.connectionId`, competitor-handle tracking, Instagram
  sourcing, queue/back-pressure (deferred #8) — untouched here.
- **Deferred #25 is not closed by this sprint.** That's engagement replies
  (`services/engagement-reply.ts`) not automation (`runAutomation`) — a different pipeline. Passing
  persona through `runAutomation` doesn't reach the inbox reply path. Closing #25 would mean
  deriving a persona from `inbox_items.connectionId` (reverse persona-social-account lookup) — a
  small, separate add-on if the founder wants it pulled forward.
- **Re-score is full-backlog, not incremental** ⏸ — the config-change check re-scores every
  still-`new` item on the next run, not just the ones affected by what changed. Fine at today's
  triage-queue sizes; log as a new deferred item if a large untriaged backlog makes a persona edit
  visibly expensive.
- **Duplicate UX is a linked list, not a merge** ⏸ — a duplicate stays its own row (own source,
  own externalId) pointed at the canonical item; there's no merged/diffed view of what changed
  between the two copies. Good enough until corroboration itself becomes a signal worth surfacing
  (e.g. "3 sources picked this up" as a relevance boost).
- **Matching stays lexical LLM judgment**, not embeddings — same boundary as Sprint 43's BM25 zoom
  (deferred #22); no vector infra added here.
- Per-channel match scoring (a persona×campaign pair scored once, not once per channel) — the
  existing `hasDraftFor` per-channel uniqueness check is unchanged and is what actually gates
  channel-level duplication; no new mechanism needed there.

---

## Design

### 1. Multi-candidate scoring

**Schema** (`apps/api/src/db/schema.ts` → migration `0032_*`):

New child table, one row per candidate persona×campaign pairing an item (or signal) scored above
zero relevance for:

```ts
export const discoveredItemMatches = sqliteTable(
  "discovered_item_matches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull().references(() => discoveredItems.id, { onDelete: "cascade" }),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("discovered_item_matches_item").on(t.itemId)],
);

export const signalMatches = sqliteTable(
  "signal_matches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    signalId: text("signal_id").notNull().references(() => signals.id, { onDelete: "cascade" }),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("signal_matches_signal").on(t.signalId),
    index("signal_matches_signal_campaign").on(t.signalId, t.campaignId),
  ],
);
```

`discoveredItems` gains `scoredAt: integer("scored_at")` (nullable — when it was last judged, for
the re-score watermark below). The existing `score` / `suggestedPersonaId` / `suggestedCampaignId`
/ `scoreReason` columns stay as **derived convenience fields** — the top-scoring match, kept so
existing triage-list sort order (`ORDER BY score DESC`) and the accept/pre-fill flow don't need to
change shape. `score` on the item stays the model's *overall relevance* judgment (a different axis
from each match's *fit-to-this-pipeline* score — see prompt design below).

**Contracts** (`packages/contracts/src/index.ts`):

```ts
export const DEFAULT_MATCH_THRESHOLD = 50;
export const DISCOVERY_MAX_MATCHES_PER_ITEM = 5;

export const discoveredItemMatchSchema = z.object({
  personaId: z.string().uuid().nullable(),
  personaName: z.string().nullable(),
  campaignId: z.string().uuid().nullable(),
  campaignName: z.string().nullable(),
  score: z.number().int().min(0).max(100),
  reason: z.string(),
});
export type DiscoveredItemMatch = z.infer<typeof discoveredItemMatchSchema>;
```

`discoveredItemSchema` gains `matches: z.array(discoveredItemMatchSchema)` (names joined in for
display). `signalSchema` gains `matches: z.array(discoveredItemMatchSchema)` (same shape, reused).

**Scoring prompt** (`scoreUnscoredItems`, `apps/api/src/services/discovery.ts`): extends the
existing persona/campaign context blocks and response shape.

- Persona list line grows to include Sprint 44 topics: `- {id}: {name} — topics: {topics.join(",
  ")}` (falls back to today's `name (description)` line when a persona has no topics yet — byte
  parity for workspaces that haven't adopted Sprint 44 fields).
- Campaign list line grows to show **which personas are assigned to it**
  (`campaign.personaIds`), so the model can only suggest a persona that's actually allowed to speak
  for that campaign: `- {id}: {name} — {objective} — personas: [{id}: {name}, ...]`.
- Response shape changes from `{index, score, personaId, campaignId, reason}` to:
  ```
  [{"index": <n>, "score": <0-100 overall relevance>,
    "matches": [{"personaId": <id or null>, "campaignId": <id or null>, "score": <0-100 fit>, "reason": "..."}]}]
  ```
  `matches` may be empty (nothing worth routing to) or have multiple entries. Parsing keeps the
  existing defensive posture: unknown `campaignId`/`personaId` → null (not rejected); a suggested
  `personaId` not in that campaign's `personaIds` → dropped to null (keep the campaign match, lose
  the invalid persona); more than `DISCOVERY_MAX_MATCHES_PER_ITEM` entries → keep the top-scoring
  five; a response with no `matches` key falls back to treating the (legacy) top-level
  `personaId`/`campaignId` as a single match, so a partial/older-shaped model response still
  produces one usable candidate instead of nothing.
- The item's own `score`/`scoreReason`/`suggestedPersonaId`/`suggestedCampaignId`/`scoredAt` are set
  from the top-level relevance score and the best-scoring match (ties broken by array order).
- `discoveredItemMatches` rows for an item are replaced (delete-then-insert) each time it's scored,
  so a re-score doesn't accumulate stale candidates.

**Re-score on config change**: the unscored-items query changes from `isNull(score)` to items where
`status = "new" AND duplicateOfId IS NULL AND (scoredAt IS NULL OR scoredAt < configVersion)`,
where `configVersion = max(personas.updatedAt, campaigns.updatedAt)` for the workspace (a cheap
`MAX()` over two small tables, computed once per `scoreUnscoredItems` call; `0` when neither table
has rows). Both `updatePersona` and campaign updates already bump `updatedAt` today — no schema
change needed there. Only `new` items are eligible; `accepted`/`skipped`/`duplicate` items are
frozen once triaged (their signal, if any, already carries the matches it was created with).

**Manual signal matching** (`services/signals.ts`, `routes/signals.ts`): new
`createSignalWithMatching(db, llm, workspaceId, input): Promise<Signal>`, used by the
`POST /workspaces/:id/signals` route in place of the bare `createSignal`:

```ts
export async function createSignalWithMatching(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  input: CreateSignalInput,
): Promise<Signal> {
  const signal = createSignal(db, workspaceId, input);
  if (input.suggestedPersonaId || input.suggestedCampaignId) {
    // Explicit human intent wins outright — one high-confidence match, no LLM call.
    insertSignalMatch(db, workspaceId, signal.id, {
      personaId: input.suggestedPersonaId ?? null,
      campaignId: input.suggestedCampaignId ?? null,
      score: 100,
      reason: "Set explicitly at signal creation.",
    });
  } else {
    await scoreSignalMatches(db, llm, workspaceId, signal); // best-effort; LLM failure never blocks creation
  }
  return signal;
}
```

`scoreSignalMatches` shares the prompt-building and response-parsing logic factored out of
`scoreUnscoredItems` (one item, same shape) — a signal has no `discoveredItems` row to update, so it
writes straight to `signalMatches` and patches the signal's `suggestedPersonaId`/`suggestedCampaignId`
convenience fields.

**Accept carries the full candidate list forward** (`acceptDiscoveredItem`,
`services/discovery.ts`): instead of copying only the single `suggestedPersonaId`/`suggestedCampaignId`
onto the new signal, it copies every `discoveredItemMatches` row for that item into `signalMatches`
rows for the new signal id (no LLM call — reuses what discovery already computed). The
`createSignal` call's `suggestedPersonaId`/`suggestedCampaignId` inputs are unchanged (still the
item's top match, for the existing pre-fill behavior).

### 2. `runAutomation` consumes the mapping

`apps/api/src/services/automation.ts` — the outer per-campaign loop, kill-switch pre-check, and
`AutomationCampaignResult` shape are **unchanged** (every active automated campaign still gets one
result row, so the Automation settings page's shape doesn't change). What changes is the inner
fan-out: instead of every signal unconditionally qualifying for every campaign's channels, a signal
only reaches a campaign if it has a `signalMatches` row for that campaign scoring at or above
`settings.matchThreshold` — and the draft is generated **as that match's persona**.

```ts
for (const campaign of campaigns) {
  // ...kill-switch pre-check unchanged...
  let generated = 0, autoApproved = 0, skipped = 0;
  for (const signal of signals) {
    const match = getBestSignalMatchForCampaign(db, signal.id, campaign.id);
    if (!match || match.score < settings.matchThreshold) continue;
    const persona = match.personaId ? personasById.get(match.personaId) : undefined;
    for (const channel of campaign.channels) {
      if (hasDraftFor(db, signal.id, campaign.id, channel)) continue; // unchanged per-pipeline uniqueness
      try {
        const draft = await generateSignalDraft(
          db, llm, evidence, workspace, signal,
          { channel, campaign, persona, useEvidence: true },
          SYSTEM_ACTOR,
        );
        generated += 1;
        if (campaign.automationMode === "scheduled_auto") {
          applyDraftAction(db, draft, "approve", SYSTEM_ACTOR);
          autoApproved += 1;
        }
      } catch { skipped += 1; }
    }
  }
  results.push({ ...base, generated, autoApproved, skipped, blocked: null });
}
```

`getBestSignalMatchForCampaign(db, signalId, campaignId)` — the highest-scoring `signalMatches` row
for that (signal, campaign) pair (a signal can have two candidate personas for the same campaign;
only the best one drives generation). `personasById` is a `Map` built once per run from
`listPersonas`, mirroring the existing `campaignsById`-style lookups elsewhere in the codebase.

This is the behavior change the founder acceptance chain exercises: a signal with zero matches
above threshold now generates **nothing**, where today it would generate a draft per channel of
every active automated campaign regardless of fit. `generateSignalDraft` already accepts an
optional `persona` (Sprint 44 wired it through for scoped guidance + account resolution) — this
sprint is the first caller to actually pass one from automation.

### 3. Cross-source dedup

**Schema**: `discoveredItems` gains

```ts
urlHash: text("url_hash"),
contentHash: text("content_hash").notNull().default(""),
duplicateOfId: text("duplicate_of_id"), // self-ref, no declared FK — see note below
```

with non-unique indexes `(workspaceId, urlHash)` and `(workspaceId, contentHash)` (duplicates are
allowed rows, so no unique constraint — the lookup is a plain `SELECT ... LIMIT 1`, canonical
candidates only: `duplicateOfId IS NULL`, oldest match wins). No `references()` on `duplicateOfId`:
nothing in this codebase deletes a `discoveredItems` row today (only its parent source cascades),
so a real FK buys nothing yet and would hit the same drizzle-kit SQLite `ALTER TABLE ADD` cascade
gap already logged as deferred #26 — service-level only, matching that precedent.

`DISCOVERED_ITEM_STATUSES` gains `"duplicate"`. `discoveredItemSchema` gains
`duplicateOfId: z.string().uuid().nullable()` and `duplicateCount: z.number().int()` (0 for a plain
or duplicate row; the number of linked duplicates for a canonical item, computed with one grouped
`COUNT(*) ... GROUP BY duplicateOfId` query per list call, not per row).

**Hashing** (`apps/api/src/services/discovery.ts`, `node:crypto`): `hashUrl(url)` — normalize
(strip protocol, `www.`, trailing slash, known tracking params `utm_*`/`fbclid`/`gclid`/`ref`) then
sha256; `hashContent(title, summary)` — normalize whitespace/case on `title` + first 300 chars of
`summary`, then sha256. Always compute both; `urlHash` is null when the fetched item has no URL.

**Ingest** (`runDiscovery`'s per-source fresh-item loop, unchanged up through the existing
per-source `externalId` dedupe): for each fresh item, look up an existing **canonical**
(`duplicateOfId IS NULL`) item in the workspace matching `urlHash` or `contentHash`, oldest first.
Found → insert with `status: "duplicate"`, `duplicateOfId: <found.id>` (skips scoring — a duplicate
inherits nothing to score, it's the same content). Not found → insert as today (`status: "new"`).
Because inserts happen synchronously one at a time in the existing loop, two duplicates arriving in
the same fetch batch still resolve correctly (the second sees the first via its own DB lookup).

**Read model / route**: `listDiscoveredItems` (default, status-filtered) naturally excludes
`duplicate` rows — no new endpoint needed for the triage queue itself. New
`GET /workspaces/:id/discovery/items/:itemId/duplicates` returns
`{ id, sourceId, sourceName, createdAt }[]` for the linked rows, used to render the expandable
"seen via" list on a canonical item.

### Web (`apps/web`)

- **Discovery / triage inbox** (`app/workspaces/[id]/discovery/page.tsx`): replace the single
  persona chip + campaign chip with a small list of candidate chips, one per `matches[]` entry
  (persona name / campaign name / score), each showing its own reason on hover/expand. An item with
  `duplicateCount > 0` gets a "seen via N sources" badge; expanding it calls the new duplicates
  endpoint and lists source name + fetched date.
- **Automation settings** (`app/workspaces/[id]/automation/page.tsx`): add a "Match threshold"
  number input (0–100) next to the existing kill switch and daily-cap fields, PATCHed through the
  existing `updateSocialAutomationSettingsInputSchema` payload (just gains the field).
- **Content → new signal form**: unchanged UI — the auto-matching happens server-side on submit:
  leaving persona/campaign blank now triggers the same matching a discovered item gets, instead of
  going in unmapped.

---

## Tests (before/with implementation; all suites green before push)

### `packages/contracts`
- `discoveredItemMatchSchema` round-trips; `discoveredItemSchema`/`signalSchema` accept `matches`;
  `DISCOVERED_ITEM_STATUSES` includes `"duplicate"`; `discoveredItemSchema` accepts
  `duplicateOfId`/`duplicateCount`.
- `socialAutomationSettingsSchema` / `updateSocialAutomationSettingsInputSchema` accept
  `matchThreshold` (0–100, rejects out-of-range).

### `apps/api` (`discovery.test.ts`, `automation.test.ts`, `signals.test.ts` extended)
- **Multi-candidate scoring**: a fake LLM response with 2 `matches` entries produces 2
  `discovered_item_matches` rows; the item's convenience fields reflect the best one; more than
  `DISCOVERY_MAX_MATCHES_PER_ITEM` entries are truncated to the top-scoring five; a suggested
  persona not in the matched campaign's `personaIds` is dropped to null without dropping the
  campaign match; a legacy-shaped response (no `matches` key) still produces one candidate.
- **Re-score on config change**: an already-scored `new` item is re-scored after a persona's
  `updatedAt` advances past the item's `scoredAt`; an `accepted` item with the same stale
  `scoredAt` is *not* re-scored; an item with no config change since its last score is left alone
  (no wasted LLM call — assert the fake gateway wasn't invoked for it).
- **Accept carries all matches**: accepting an item with 2 matches produces 2 `signal_matches` rows
  on the new signal, not just the top one.
- **Manual signal matching**: `POST /signals` with neither `suggestedPersonaId` nor
  `suggestedCampaignId` calls the LLM and produces `signal_matches` rows; supplying either one
  skips the LLM and writes a single score-100 explicit match; an LLM failure during manual scoring
  still returns 201 with the signal created and zero matches.
- **`runAutomation` routing**: a signal matching only Campaign A (above threshold) generates a
  draft for Campaign A only, passing that match's persona (assert `generateSignalDraft` received
  it — check the resulting draft's `personaId`); Campaign B (no match, or below threshold) gets
  zero drafts from that signal but still appears in `results` with zero counts; a signal matching
  two campaigns generates drafts for both; lowering `matchThreshold` admits a previously-sub-threshold
  match on the next run; `hasDraftFor` idempotency (unchanged behavior) still prevents a re-run from
  duplicating drafts.
- **Cross-source dedup**: two sources fetching the same URL → the second insert is `status:
  "duplicate"` with `duplicateOfId` set to the first; `listDiscoveredItems(status: "new")` excludes
  it; the canonical item's `duplicateCount` is 1; the duplicates endpoint returns the linked row's
  source name; two different URLs with matching normalized content (same contentHash) also link;
  scoring skips `duplicate`-status items.

---

## Build order (checklist)

1. [x] Branch off `sprint-44-scoped-guidance-persona-topics`; commit this spec.
2. [x] Contracts: `discoveredItemMatchSchema`, `matches` on item/signal schemas, `"duplicate"`
   status, `duplicateOfId`/`duplicateCount`, `matchThreshold` on automation settings schemas,
   `DEFAULT_MATCH_THRESHOLD`, `DISCOVERY_MAX_MATCHES_PER_ITEM`. Contract tests.
3. [x] Schema: `discovered_item_matches`, `signal_matches` tables; `discoveredItems` gains `scoredAt`,
   `urlHash`, `contentHash`, `duplicateOfId` + indexes; `socialAutomationSettings` gains
   `matchThreshold`; `npm run db:generate -w apps/api`.
4. [x] API — discovery: multi-candidate scoring (shared prompt/parse helpers), config-version re-score
   query, dedup hashing + ingest-time lookup, duplicates endpoint, accept carries full match list.
5. [x] API — signals: `createSignalWithMatching` + `scoreSignalMatches`; wire the route.
6. [x] API — automation: `getBestSignalMatchForCampaign`; rewrite the inner fan-out in `runAutomation`
   to be match-driven and pass persona; `matchThreshold` read from settings.
7. [x] API tests green; full `npm test` + `npm run typecheck` clean.
8. [x] Web: triage candidate chips + duplicate badge/expansion; automation settings match-threshold
   field; `next build` clean.
9. [x] Docs: `docs/founder-acceptance-tests.md` § Sprint 45; any new deferred-improvements entries
   (full-backlog re-score, duplicate-as-merge); sprint-guide 45 entry marked built; progress log
   below.
10. [x] Commit(s) with the `Co-Authored-By` trailer; `git push -u origin sprint-45-discovery-routing`.
    **Do NOT merge into `main`.**

---

## Progress log

- 2026-07-03 — Spec written after a full audit of `services/discovery.ts` (`scoreUnscoredItems`,
  `acceptDiscoveredItem`, `runDiscovery`), `services/automation.ts` (`runAutomation`'s blind
  per-campaign fan-out confirmed — no persona passed, every active automated campaign always
  looped regardless of signal fit), `services/signal-drafting.ts` (`generateSignalDraft` already
  accepts an optional `persona` since Sprint 44 — automation is simply the first caller to use it),
  and `services/signals.ts`/`routes/signals.ts` (confirmed `registerSignalRoutes` already has `llm`
  injected, so manual-signal matching needs no new dependency wiring). Confirmed Sprint 31's
  auto-mapping code is merged into this branch's history (`git merge-base --is-ancestor
  origin/sprint-31-discovery-expansion HEAD` → yes) even though the branch itself isn't merged to
  `main` yet. Confirmed `updatePersona`/campaign updates already bump `updatedAt`, so the
  config-change re-score watermark needs no new bookkeeping column on those tables. Founder locked
  the three open decisions above (manual signals scored too; duplicates linked not dropped; match
  threshold is workspace-configurable). Nothing implemented yet — build starts at step 1.
- 2026-07-03 — **Built** (contracts + schema + API, steps 2–7; spec commit `614277f`, API commit
  `3bf2f1f`). Migration `0032_same_scorpion`: `discovered_item_matches` + `signal_matches` tables;
  `discovered_items` gains `scored_at`/`url_hash`/`content_hash`/`duplicate_of_id` plus the two
  hash indexes; `social_automation_settings` gains `match_threshold` (default 50). The
  prompt-building / response-parsing / match helpers were factored into a new shared
  `apps/api/src/services/matching.ts` used by discovery, signals, and automation. Multi-candidate
  scoring landed per design: up to `DISCOVERY_MAX_MATCHES_PER_ITEM` (5) persona×campaign candidates
  per item, defensive parse (unknown ids → null; a persona outside the campaign's `personaIds` →
  dropped to null with the campaign match kept; a legacy no-`matches` response → one candidate),
  delete-then-insert on re-score. Re-score watermark = `max(personas.updatedAt,
  campaigns.updatedAt)` applied to still-`new`, non-duplicate items only. `runAutomation` is
  match-driven — threshold read from settings, draft generated **as** the matched persona — which
  fully closes deferred #11 (moved to Done in `docs/deferred-improvements.md`). Manual signals are
  auto-matched on POST (an explicit persona/campaign pick becomes a single score-100 match with no
  LLM call; an LLM failure never blocks the 201). Accept copies every match onto the new signal.
  Cross-source dedup: url/content sha256, second copy inserted as `status: "duplicate"` with
  `duplicateOfId`, `duplicateCount` on the canonical, duplicates endpoint; duplicates skip scoring.
  Full suite **905 green across 68 files**, `npm run typecheck` clean. New deferred #27
  (full-backlog re-score) and #28 (duplicates linked, not merged); acceptance tests added
  § Sprint 45; sprint-guide 45 entry marked built. The web slice (triage candidate chips +
  duplicate badge/expansion, match-threshold field — checklist 8) lands on this branch alongside
  this docs pass; the push (10) follows.
