# Spec: Sprint 31 — Discovery Source Expansion + Auto-Mapping to Campaigns/Personas

> Status: **planned** (spec for founder review — nothing built yet).
> Roadmap: `docs/plans/sprint-guide-21-onward.md` → **Sprint 31 (U9)**, "Discovery source expansion + auto-mapping to campaigns/personas."
> **Branch:** `sprint-31-discovery-source-expansion`, cut from `main`.
> **Merge order:** none. "Builds on" names **Sprint 9 (discovery), Sprint 8 (campaigns), and personas (Sprint 3)** — all already on `main`, no 21+ predecessor — so this branches directly off `main` with no predecessor merge required.
> **Size:** M–L. Delivered as **two founder-accepted slices on one branch** (A then B); no new slice until the previous is accepted. New adapters beyond the two in Slice A continue to land on the **continuous discovery-adapter track**, not this sprint.

---

## Goal

Widen where Tuezday's brain hears the outside world, and stop making the founder hand-route every signal. Today discovery has three live source types (`rss`, `google_news`, `reddit`) and two credential-gated stubs (`x`, `linkedin`); each discovered item is brain-scored 0–100 and gets a single `suggestedPersonaId` + `scoreReason`, but **nothing maps an item to a campaign**, and accepting an item creates a bare signal that throws away the suggested persona on the way to drafting. This sprint adds new source adapters behind the existing signal contract and a **mapping/triage** step that routes each item to a candidate **campaign + persona** with a reason, then carries those suggestions through accept → draft — so a founder enables a source, sees scored + mapped items, and reaches a pre-targeted draft in one triage action.

## Decisions to confirm with the founder (recommended defaults locked in this spec)

These shape the slice. The spec builds to the **recommended** option; the founder can flip any in review (see "Open decisions" at the bottom). They are written here as locked so the implementation is unambiguous if accepted as-is.

1. **In-sprint new adapters = Hacker News + YouTube (both no-key, real today).** Hacker News via the public Algolia Search API (no credentials); YouTube via per-channel RSS (no credentials, reuses the existing feed parser). **Podcasts need no new type** — a podcast is an RSS feed, so it uses the existing `rss` adapter unchanged (the "no special-casing" rule in action).
2. **Intent/funding/hiring signals = a credential-gated provider seam (`intent`), not scraping.** Registered like `x`/`linkedin`: `needs_api_key` until a provider key exists. The concrete provider is an **open decision** (§Open decisions #1); the adapter is written against an injectable REST fetcher with fixture-driven tests so the choice touches one function. For a **no-key demo of the mapping flow today**, the founder can add a `google_news` source with a funding query (e.g. `"seed funding" fintech`) — that exercises HN + a funding-style source + mapping end-to-end without any paid key.
3. **Mapping is single-best, not multi-candidate.** Extend the existing **singular** `suggestedPersonaId` with a sibling **`suggestedCampaignId`** (+ the existing `scoreReason` explains both). Multi-candidate campaign/persona fan-out is a documented YAGNI deferral.
4. **Mapping stays founder-gated.** High scores never auto-create drafts. The brain *proposes* campaign + persona; the founder *accepts* (optionally one-click "Accept & draft"). This matches the standing rule that the brain "judges and routes, it does not invent," and that every state change passes a human.
5. **G2/Capterra reviews and Google Trends are deferred** (no official API for either at acceptable terms; the no-scraping boundary forbids the unofficial route). They re-enter via the continuous track if a provider API is chosen later.

## What this slice does

A founder adds a **Hacker News** source (a query) and/or a **YouTube** source (a channel) — no keys — and they fetch on the existing discovery tick alongside RSS/Reddit/Google News. The registered **`intent`** provider type appears too, `needs_api_key` until its key is set, flipping live exactly like `x`/`linkedin` do. During the same scoring pass that already assigns a relevance score and persona, the brain now also picks the **best-fit campaign** (from the workspace's active campaigns) and explains the routing. The discovery inbox shows each item with its score, **suggested campaign + persona chips**, and the reason; **Accept** carries those suggestions onto the created signal, and **Accept & draft** goes straight to a brain-resolved, campaign-and-persona-targeted draft through the existing signal→draft path — no retyping the targeting the brain already inferred.

## Out of scope (YAGNI)

- G2/Capterra review adapters and Google Trends (deferred — no official API within the no-scraping boundary).
- Multi-candidate mapping (an item → many campaigns/personas). Single best-fit only this sprint.
- Auto-routing / auto-drafting without founder triage. Acceptance stays a human action.
- A paid intent provider's billing, quota dashboards, or webhook ingestion — the seam + polling adapter only.
- Editable scoring/mapping weights or prompts UI (the scoring prompt stays in `services/discovery.ts`; making guidance per-scope editable is the Sprint-21 pattern, a later generalization).
- Re-scoring already-scored items when campaigns change (an item is scored once; see "Known limitations").
- Any scraping of any source.

---

## Architecture & boundary

Unchanged top-level contract: **discovery adapters normalize an outside source into items behind one signal contract; the brain scores + routes; the approval gate drafts.** Everything new lives on the Tuezday side of the existing seams:

- **Adapters** (`apps/api/src/discovery/adapters.ts`): new fetchers added to the `fetchSourceItems` switch + `isLiveSourceType`. The injectable `Fetcher` keeps tests off the network. No adapter is special-cased downstream — each returns `RawDiscoveredItem[]`.
- **Source vocabulary + config** (`packages/contracts`): new entries in `DISCOVERY_SOURCE_TYPES`, new optional `discoverySourceConfigSchema` fields, new `SignalSource` values — enum vocabularies live only here, per the repo rule.
- **Scoring + mapping** (`apps/api/src/services/discovery.ts`): the existing single batched LLM call in `scoreUnscoredItems` is extended to also return a validated `campaignId`; one extra brain-resolved field, not a new call.
- **Triage → draft**: reuses the existing signal→draft path (`draftSignalRequestSchema` already carries `personaId` + `campaignId`); accept carries suggestions forward instead of dropping them.
- **Boundary:** buy signal data via provider APIs; never scrape. Tokens/keys live in `.env` (the `intent` provider key), never in the DB, never in logs — same rule as every credential-gated source.

### Code seam recap (current state)

- `DISCOVERY_SOURCE_TYPES = ["rss","google_news","reddit","x","linkedin"]`; `discoverySourceConfigSchema = { feedUrl?, query?, subreddit? }` (`packages/contracts/src/index.ts`).
- `fetchSourceItems(type, config, fetcher)` dispatches per type; `isLiveSourceType` gates which fetch without keys; `NeedsApiKeyError` is thrown by `x`/`linkedin` (`discovery/adapters.ts`).
- `createDiscoverySource` sets `status` to `active` for live types, `needs_api_key` otherwise, via `isLiveSourceType`; `defaultSourceName` and `SIGNAL_SOURCE_BY_TYPE` switch over every type (`services/discovery.ts`) — **exhaustive switches, so adding a type is a compile-time checklist.**
- `scoreUnscoredItems` builds one prompt per batch of 10 with the brain digest + persona list and writes `score`, `suggestedPersonaId`, `scoreReason` (`services/discovery.ts`).
- `acceptDiscoveredItem` creates a signal from the item and marks it `accepted`, but does **not** carry persona/campaign forward.
- `discovered_items` columns: `score`, `suggestedPersonaId`, `scoreReason` exist; **no campaign column.**
- Worker polls `/workspaces/:id/discovery/run` every `DISCOVERY_INTERVAL_MIN` (default 30); the API owns all DB access (`apps/worker/src/index.ts`).
- Routes: source CRUD, `POST /discovery/run`, `GET /discovery/items?status=`, `POST /discovery/items/:itemId/accept`, `.../skip`, `POST /discovery/suggest` (`routes/discovery.ts`).

---

## Data model changes

Via `npm run db:generate -w apps/api` after editing `apps/api/src/db/schema.ts`. Keep Postgres-portable (text ids, integer epoch-ms, no SQLite-only types).

### Altered table — `discovered_items` (Slice B)

Add the campaign mapping alongside the existing persona suggestion:

| column | type | notes |
|---|---|---|
| `suggestedCampaignId` | text, nullable, FK→campaigns (set null on delete) | best-fit active campaign chosen during scoring; null when none fits |

`suggestedPersonaId` and `scoreReason` are unchanged; `scoreReason` now explains both persona **and** campaign routing.

No new tables. The `intent` provider needs no schema (its config rides `discoverySourceConfigSchema`); credentials live in `.env`.

### Contracts (`packages/contracts/src/index.ts`)

- **Source types (Slice A):** extend `DISCOVERY_SOURCE_TYPES` → add `"hackernews"`, `"youtube"`, `"intent"`. Add matching `SIGNAL_SOURCES` values so accepted items attribute correctly: add `"hackernews"`, `"youtube"`, `"intent"` (or map to existing buckets — see §A3 mapping table; recommended: distinct values for traceability).
- **Config fields (Slice A):** widen `discoverySourceConfigSchema` with optional `channelId` (YouTube) and `intentType` (`"funding" | "hiring" | "job_change"`, for the `intent` provider). `query` is reused by Hacker News. Add `superRefine` rules to `createDiscoverySourceInputSchema`: `hackernews` needs `query`; `youtube` needs `channelId` **or** `feedUrl`; `intent` needs `intentType` (and is gated `needs_api_key`).
- **Mapping (Slice B):** add `suggestedCampaignId: z.string().uuid().nullable()` to `discoveredItemSchema`.
- **Defaults stay in contracts**; the DB only holds per-workspace source rows and item rows, as today.

---

## Behavior — Slice A (Source expansion)

### A1. Hacker News adapter (live, no key)

`fetchHackerNews(config, fetcher)` in `adapters.ts`. Calls the public Algolia HN Search API — an official JSON endpoint, **not scraping**:

`https://hn.algolia.com/api/v1/search_by_date?query={q}&tags=story&hitsPerPage={MAX_ITEMS}`

Map each hit → `RawDiscoveredItem`: `externalId = "hn-" + objectID`; `title = hit.title || hit.story_title`; `url = hit.url || "https://news.ycombinator.com/item?id=" + objectID`; `summary = (hit.story_text || hit._highlightResult excerpt || "").slice(MAX_SUMMARY_CHARS)`; `publishedAt = hit.created_at_i * 1000`. Reuses the existing `MAX_ITEMS`/`MAX_SUMMARY_CHARS` constants and `cleanText`.

### A2. YouTube adapter (live, no key)

`fetchYouTube(config, fetcher)`. YouTube publishes per-channel Atom feeds — official, no key:

`https://www.youtube.com/feeds/videos.xml?channel_id={channelId}` (or `config.feedUrl` if the founder pasted a full feed URL).

Parse with the **existing** `parseFeed` (Atom branch already handled). This deliberately reuses the RSS/Atom path — YouTube is "an Atom feed with a friendlier setup step," so the only new code is URL construction + config validation.

### A3. `intent` provider seam (credential-gated)

Register `intent` like `x`/`linkedin`: `isLiveSourceType("intent") === false`, so `createDiscoverySource` stores it `needs_api_key` and `runDiscovery` skips it until live. `fetchSourceItems` throws `NeedsApiKeyError("intent")` unless an `INTENT_API_KEY` env is present, in which case `fetchIntent(config, fetcher)` calls the chosen provider's REST search for `config.intentType` (funding / hiring / job_change), normalizing results to `RawDiscoveredItem` (provider event id → `externalId`; headline → `title`; provider URL → `url`; structured fields → `summary`; event date → `publishedAt`). The provider is the one open decision; the adapter is isolated to `fetchIntent` + a fixture test, so swapping providers touches one function.

Exhaustive-switch housekeeping (compile-enforced): add the three types to `fetchSourceItems`, `isLiveSourceType`, `defaultSourceName`, and `SIGNAL_SOURCE_BY_TYPE`.

### A4. Web (`/workspaces/[id]/discovery`)

- "Add source" gains **Hacker News** (query), **YouTube** (channel id / feed URL), and **Intent signals** (type picker: funding / hiring / job change) options; the Intent option renders a `needs_api_key` badge + helper text until its key exists, mirroring how `x`/`linkedin` already present.
- No change to the items list yet (that's Slice B).

### Slice A founder acceptance gate

1. Add a Hacker News source with a query relevant to the company → run discovery (or wait for the tick) → HN stories appear as scored items in the inbox.
2. Add a YouTube source by channel id → recent videos appear as items.
3. A podcast RSS URL added via the existing **RSS** type still works (proves no regression / no special-casing).
4. The **Intent signals** source shows as `needs_api_key` with no key set; setting `INTENT_API_KEY` (provider chosen) flips it live and it fetches — demoed against the provider, or shown via the fixture test if no live key at acceptance.

---

## Behavior — Slice B (Auto-mapping + triage→draft)

### B1. Campaign + persona mapping in scoring (`services/discovery.ts`)

Extend `scoreUnscoredItems` — **the same single batched call**, one more field:

- Load the workspace's **active** campaigns (`listCampaigns` filtered to `status === "active"`) and build a `campaignList` block (`- {id}: {name} — {objective}`), plus a `campaignIds` validation set (mirrors the existing `personaIds` guard).
- Prompt addition: *"…and which active campaign (by id) this signal best serves, or null if none fits."* Response schema becomes `[{"index","score","personaId","campaignId","reason"}]`.
- Validate `campaignId` against `campaignIds` exactly like `personaId` against `personaIds` (unknown/`null` → stored `null`). Write `suggestedCampaignId` next to the existing `suggestedPersonaId`/`scoreReason`. Scoring still **assists, never gates**: a parse failure or gateway error leaves items unscored and triagable, unchanged.

### B2. Carry suggestions through accept → draft

- `acceptDiscoveredItem` records the chosen persona + campaign. New optional params `{ personaId?, campaignId? }` default to the item's `suggestedPersonaId` / `suggestedCampaignId`. The created signal is unchanged in shape (signals carry no targeting), but the accept **response** returns the resolved `{ personaId, campaignId }` so the UI can pre-fill the draft step.
- New convenience endpoint **`POST /workspaces/:id/discovery/items/:itemId/accept-and-draft`** (body: optional `channel`, `personaId`, `campaignId`, `tokenBudget`, `useEvidence` — same shape as `draftSignalRequestSchema`): accepts the item, then calls the **existing** signal-draft service with the suggested-or-overridden persona + campaign, returning the created draft. Pure reuse of the Sprint 6/7 path — no new drafting logic. Re-accepting a triaged item → `409` (existing `ItemNotTriagableError`).
- The plain `accept` endpoint keeps working (persona/campaign optional); `skip` unchanged.

### B3. Web (`/workspaces/[id]/discovery`)

- Each item row shows its **score**, a **suggested campaign** chip and **suggested persona** chip (names resolved client-side), and the `scoreReason`.
- Two triage actions: **Accept** (creates the signal, pre-targeted) and **Accept & draft** (opens/streams the draft with campaign + persona pre-selected, editable before send). A **Skip** stays.
- Empty/none states: "No campaign fits" when `suggestedCampaignId` is null — accept still works, founder picks at draft time.

### Slice B founder acceptance gate

1. With ≥1 active campaign and ≥2 personas, run discovery on HN + a funding-style source → items show a **score, a mapped campaign, a mapped persona, and a one-line reason**; a clearly off-topic item maps to no campaign (null) without breaking.
2. **Accept & draft** a mapped item → the draft opens already targeted to the suggested campaign + persona, in the right channel/voice, through the normal approval gate.
3. Override the suggestion at triage (pick a different campaign/persona) → the draft respects the override.
4. Gateway down mid-scoring → items remain unscored + triagable (manual accept still works); nothing is lost.

---

## Step-by-step implementation plan

Tests are written **before/with** each change; `npm test` and `npm run typecheck` stay green at every commit. Order is bottom-up (contracts → adapters → service → routes → worker/web).

### Slice A — Source expansion

1. **Contracts:** add `hackernews`/`youtube`/`intent` to `DISCOVERY_SOURCE_TYPES` + `SIGNAL_SOURCES`; add `channelId`/`intentType` to `discoverySourceConfigSchema`; add the `superRefine` validation rules. Unit-test: valid/invalid configs per new type.
2. **Adapters:** implement `fetchHackerNews`, `fetchYouTube` (reusing `parseFeed`), `fetchIntent` (provider REST, key-gated) + extend `fetchSourceItems`/`isLiveSourceType`. Tests against the fixture fetcher: HN JSON → items; YouTube Atom → items; `intent` without key throws `NeedsApiKeyError`; with a fixture key, provider JSON → items.
3. **Service switches:** extend `defaultSourceName` + `SIGNAL_SOURCE_BY_TYPE` (compile-enforced exhaustiveness); `createDiscoverySource` gates `intent` as `needs_api_key`. Tests: source creation status per type.
4. **Web:** add the three options to "Add source" with the `intent` `needs_api_key` affordance. Typecheck-covered (no web test project, per repo convention).
5. **Slice A verification:** full `npm test` + `npm run typecheck`; walk the Slice A gate; pause for founder acceptance.

### Slice B — Auto-mapping + triage→draft

6. **Schema + migration:** add `discovered_items.suggestedCampaignId` (FK→campaigns, set null on delete). `npm run db:generate`; confirm it applies in the in-memory test DB.
7. **Contracts:** add `suggestedCampaignId` to `discoveredItemSchema`. Schema test.
8. **Mapping in scoring:** load active campaigns, extend the prompt + response parsing + validation, persist `suggestedCampaignId`. Tests (fake LLM returning fixed JSON): valid campaign id stored; unknown/null → null; reason persisted; gateway failure leaves items unscored.
9. **Accept carry-through + accept-and-draft route:** thread persona/campaign through `acceptDiscoveredItem`; add `POST .../accept-and-draft` reusing the signal-draft service; `409` on re-triage. Tests: suggestions default through; overrides win; draft created with correct campaign/persona; double-accept 409.
10. **Web:** campaign/persona/reason chips on item rows; **Accept** + **Accept & draft** + override controls. Typecheck-covered.
11. **Slice B verification:** full `npm test` + `npm run typecheck`; walk the Slice B gate; pause for founder acceptance.

---

## Automated verification (test inventory)

- **Contracts:** new source-type enums; new config fields; per-type `superRefine` validation; `discoveredItemSchema` includes `suggestedCampaignId`.
- **Adapters (fixture fetcher):** HN search JSON → normalized items (id/url fallbacks, timestamp ms); YouTube channel feed → items via `parseFeed`; `intent` throws `NeedsApiKeyError` without key and normalizes provider JSON with a fixture key; `isLiveSourceType` correct per type.
- **Service:** `defaultSourceName`/`SIGNAL_SOURCE_BY_TYPE` exhaustive for new types; `createDiscoverySource` status (`active` vs `needs_api_key`); `runDiscovery` skips `needs_api_key` `intent` sources.
- **Mapping (fake LLM):** campaign id validated against active campaigns; unknown/null handled; reason stored; batch scoring still idempotent on already-scored items; gateway error leaves items unscored + triagable.
- **Accept/draft:** accept carries suggested persona+campaign; explicit overrides applied; `accept-and-draft` produces a draft via the existing path with the right targeting; re-triage → 409; plain `skip`/`accept` unchanged.

## Known limitations (intentional, documented)

- An item is **scored/mapped once**; if campaigns change afterward it is not re-mapped (the unscored-only filter prevents re-scoring). Acceptable this sprint.
- **Single best-fit** campaign + persona per item; multi-candidate fan-out is deferred.
- The `intent` provider is **polling-only**, key-gated; without a key it's inert infrastructure (demoable via fixtures). Provider choice is the one open decision.
- G2/Capterra + Google Trends remain out until an official-API path exists (no-scraping boundary).
- Scoring/mapping prompt + weights are fixed in `services/discovery.ts` (not per-workspace editable) — a natural follow-on once Sprint-21-style scoped guidance is generalized.

## Founder acceptance checklist (sprint gate = both slices)

- **Slice A:** Hacker News + YouTube sources fetch with no keys and appear as scored items; an existing RSS/podcast feed still works (no regression); the `intent` source shows `needs_api_key` and flips live when its key is set.
- **Slice B:** items show score + mapped campaign + mapped persona + reason; off-topic items map to no campaign without breaking; **Accept & draft** lands a pre-targeted draft through the approval gate; overrides win; a gateway outage degrades to manual triage with nothing lost.

---

## Open decisions for the founder

1. **Intent/funding provider (the only blocking choice):** which paid API backs the `intent` source (e.g. a funding/hiring/job-change data provider)? Until chosen, `intent` ships as inert `needs_api_key` infra and the funding flow is demoed via a `google_news` funding query. Naming the provider lets `fetchIntent` be wired against its real REST + a fixture test.
2. **Distinct `SignalSource` values vs reuse:** give HN/YouTube/intent their own `SignalSource` entries (recommended — cleaner attribution on accepted signals) or fold into existing buckets (`news`/`other`)?
3. **Single vs multi-candidate mapping:** ship single best-fit campaign+persona (recommended — matches the existing singular field, simplest triage) or model multiple candidates now?
4. **YouTube setup ergonomics:** accept a channel id only (recommended — stable, official feed) or also resolve a channel/handle URL to its id (extra call, friendlier input)?

---

## Progress log

- 2026-06-24 — Spec drafted from `docs/plans/sprint-guide-21-onward.md` Sprint 31 (U9), grounded against the live discovery stack (`packages/contracts` source vocab, `discovery/adapters.ts`, `services/discovery.ts` scoring, `routes/discovery.ts`, worker tick). Recommended defaults locked; four open decisions surfaced for founder review. **Pending:** founder answers (esp. the intent provider), then cut branch `sprint-31-discovery-source-expansion` from `main` and build Slice A → acceptance → Slice B → acceptance. Not merged to `main` (founder merges).
