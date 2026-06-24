# Spec: Sprint 31 — Discovery Source Expansion + Auto-Mapping to Campaigns/Personas

> Status: **planned** (spec for founder review — nothing built yet).
> Roadmap: `docs/plans/sprint-guide-21-onward.md` → **Sprint 31 (U9)** (reorg numbering, now committed on `main`).
> **Branch:** `sprint-31-discovery-expansion`, cut from `main` (`d08c7c6`).
> **Merge order:** none. Builds on Sprint 7 (signal discovery), Sprint 8 (campaigns), and personas — all merged to `main`. No unmerged 21+ dependency, so this branches directly off `main`.
> **Size:** XL. Delivered as **three founder-accepted slices on one branch** (A → B → C); no new slice until the previous is accepted.

---

## Goal

Two things, both extending the Sprint 7 discovery engine without changing its contract:

1. **More signal sources** — add every source the roadmap lists (Hacker News, YouTube, podcasts, G2/Capterra reviews, Google Trends, and intent signals: job changes / funding / hiring), each behind the existing adapter contract — no special-casing.
2. **Auto-mapping** — route each discovered item to the right **campaign + persona** automatically, with a reason, so triage becomes "accept the obvious ones" instead of "figure out where this goes."

## Decisions locked with the founder (2026-06-24)

1. **Scope = everything in the roadmap** (all eight new source types), structured into **three slices** because it is genuinely XL.
2. **Funding/intent = keyless now + scaffold the boundary.** The first funding source is a keyless Google-News funding feed (ships now, meets acceptance). A real paid intent-data provider is **not** wired this sprint; instead an `IntentProvider` boundary is scaffolded so plugging one in later is a uniform add.
3. **Triage → draft = accept carries the mapping.** Accepting a discovered item creates a signal tagged with the suggested **campaign + persona**, and the Content draft step is **pre-filled** with them. The founder still triggers and approves the draft — the approval gate stays.
4. **Boundary respected.** Keyless sources go live; G2 / Capterra / intent are **registered-but-inert** (`needs_api_key`, exactly like today's `x`/`linkedin`) — bought via provider APIs later, **never scraped**.

## What this slice does

The founder registers new discovery sources (HN query, a YouTube channel, a podcast feed, a Google-Trends geo, a funding-news query — all keyless and live; plus G2/Capterra/intent sources that register but show "needs API key"). The existing pipeline fetches + dedupes them through the same adapter contract. Scoring is extended: each item is judged for relevance **and** mapped to a candidate persona **and** campaign, with a one-line reason. The triage inbox shows the suggested campaign + persona; accepting creates a signal carrying that mapping, and the Content draft form pre-fills the persona + campaign. Everything else (worker poll, brain-suggested sources, the closed loop into draft → approval) is unchanged.

## Out of scope (YAGNI)

- **Live G2 / Capterra / intent fetching** — registered infra + `needs_api_key` only this sprint; flips live when a key/provider exists (the Sprint 7 `x`/`linkedin` pattern).
- **Paid intent-data provider integration** — the `IntentProvider` boundary is scaffolded; no provider is wired (no new `$` dependency this sprint).
- **YouTube search** (needs an API key) — only keyless **channel RSS** this sprint.
- Auto-drafting without triage; engagement-based re-ranking; scraping any source; OAuth flows.

---

## Architecture & boundary

Unchanged contract: **adapters turn a source config into a normalized `RawDiscoveredItem[]` via an injectable fetcher; Tuezday owns scoring, mapping policy, and triage.**

- **New adapters** are new `case`s in `fetchSourceItems` (`apps/api/src/discovery/adapters.ts`). Keyless ones reuse the existing `parseFeed` (RSS 2.0 + Atom) or add a small JSON mapper (HN). Provider-gated ones throw `NeedsApiKeyError` until keyed, and `isLiveSourceType` keeps gating which run.
- **`IntentProvider` boundary** (new, `apps/api/src/discovery/intent.ts`): a thin injectable interface with a `NullIntentProvider` default that refuses (mirrors how `EvidenceStore` is injected into `buildApp`). The `intent` source type routes through it; wiring a real provider later is one implementation.
- **Auto-mapping** extends `scoreUnscoredItems` (`apps/api/src/services/discovery.ts`) — the LLM that already returns `{score, personaId, reason}` now also returns `campaignId`, validated against the workspace's campaigns. Deterministic, inspectable, same gateway.

The worker is unchanged: it already polls `/discovery/run`; new sources run automatically.

---

## Data model changes

All via `npm run db:generate -w apps/api`. Keep Postgres-portable.

### Altered tables

| Table | Change | Notes |
|---|---|---|
| `discovered_items` | `+ suggestedCampaignId` (text, nullable) | set by scoring, alongside the existing `suggestedPersonaId`/`scoreReason` |
| `signals` | `+ suggestedPersonaId` (text, nullable), `+ suggestedCampaignId` (text, nullable) | copied from the item on accept; pre-fills the Content draft (manual signals leave them null) |

### Contracts (`packages/contracts`)

- `DISCOVERY_SOURCE_TYPES` += `hacker_news`, `youtube`, `podcast`, `google_trends`, `funding_news`, `g2`, `capterra`, `intent`.
- `SIGNAL_SOURCES` += the new provenance kinds so accepted items keep honest provenance (mirrors how Sprint 7 added `rss`/`news`).
- Extend `discoveredItemSchema` (`+suggestedCampaignId`), `signalSchema` (`+suggestedPersonaId`, `+suggestedCampaignId`), and the `DiscoverySourceConfig` shape (`+channelId`, `+geo`, `+sector`; reuse `feedUrl`/`query`/`subreddit`).
- `LIVE_SOURCE_TYPES` / `isLiveSourceType` updated for the new keyless types.

---

## Behavior — Slice A (Campaign/persona auto-mapping)

The core new capability; provable on **existing** sources (rss/reddit) before any new adapter exists.

### A1. Scoring extension (`scoreUnscoredItems`)
- Add the workspace's **active campaigns** to the scoring context: `- {id}: {name} — {objective excerpt}` (truncated), alongside the existing persona list.
- Extend the prompt + parsed JSON from `{index, score, personaId, reason}` → `{index, score, personaId, campaignId, reason}`. `campaignId` is validated against real campaign ids (unknown → null), exactly as `personaId` already is.
- Store `suggestedCampaignId` on the item. Parse failures still leave items triagable (scoring assists, never gates).

### A2. Accept carries the mapping (`acceptDiscoveredItem`)
- When the signal is created, copy `suggestedPersonaId` + `suggestedCampaignId` onto it.
- Existing source mapping preserved; new types map to their honest `SIGNAL_SOURCES` value.

### A3. Web
- **Triage inbox**: each item shows the suggested **campaign** chip next to the existing persona chip + reason.
- **Content draft**: when drafting from a signal, the persona + campaign pickers **default to the signal's suggested values** (founder can override; still triggers + approves).

### Slice A founder acceptance gate
1. With ≥1 campaign and ≥1 persona, run discovery on an existing source → items show a suggested **campaign + persona + reason**.
2. Accept one → the signal is tagged; opening it in Content pre-fills both pickers → draft → approve (gate unchanged).
3. An item with no good campaign shows persona-only (campaign null) — mapping assists, never forces.

---

## Behavior — Slice B (Keyless content adapters — live now)

New source types that fetch today with no credentials, reusing the existing parsing.

| Type | Fetch | Config | Parse |
|---|---|---|---|
| `hacker_news` | HN Algolia `search_by_date?query=&tags=story&hitsPerPage=25` (keyless JSON, official) | `{query}` | map hits → `RawDiscoveredItem` (objectID, title, url ∥ HN item link, points/comments summary, `created_at_i`×1000) |
| `youtube` | channel RSS `youtube.com/feeds/videos.xml?channel_id=` (keyless Atom) | `{channelId}` | `parseFeed` (Atom) |
| `podcast` | podcast RSS `{feedUrl}` | `{feedUrl}` | `parseFeed` (RSS) |
| `google_trends` | daily-trends RSS `trends.google.com/trends/trendingsearches/daily/rss?geo=` | `{geo}` (default `US`) | `parseFeed` (RSS) |
| `funding_news` | Google-News RSS with a funding-scoped query (reuses `fetchGoogleNews`) | `{query, sector?}` | `parseFeed` (RSS) — the acceptance "funding source" |

- Each is a `case` in `fetchSourceItems` + (keyless) added to `isLiveSourceType`.
- Per-type config validation in the source-create path; type-aware add-form fields in the web Sources panel.

### Slice B founder acceptance gate
1. Add a **Hacker News** source (query) and a **funding-news** source → Run discovery → real items appear, scored **and mapped** (Slice A) → accept → draft.
2. Add a YouTube channel, a podcast feed, a Google-Trends geo → each fetches real items.
3. Re-run → no duplicates (existing `externalId` dedupe holds for the new types).

---

## Behavior — Slice C (Provider-gated sources + `IntentProvider` boundary)

Delivers the remaining roadmap sources as real registered infrastructure that flips live when keyed — never scraped.

- New types `g2`, `capterra`, `intent` register like any source but `fetchSourceItems` throws `NeedsApiKeyError` (status `needs_api_key`), identical to today's `x`/`linkedin`.
- **`IntentProvider` boundary** (`apps/api/src/discovery/intent.ts`): `interface IntentProvider { fetchSignals(config): Promise<RawDiscoveredItem[]> }` + `NullIntentProvider` (throws `NeedsApiKeyError`), injected into `buildApp` (tests use a fake). The `intent` adapter delegates to it. Wiring a real provider later = one implementation, no schema/contract change.
- Web: these sources show the "needs API key" badge + explanation; the add-form notes a provider/key is required.

### Slice C founder acceptance gate
1. Add a **G2** (or Capterra, or intent) source → it registers and shows **"needs API key"**, runs nothing — exactly like `x`/`linkedin` today.
2. A fake `IntentProvider` injected in tests proves the `intent` type fetches through the boundary when a provider exists.

---

## Step-by-step implementation plan

Tests written **before/with** each change; `npm test` + `npm run typecheck` green at every commit. Order is bottom-up (contracts/db → adapters/services → routes → web), per slice.

### Slice A — Auto-mapping
1. **Contracts + schema:** `+suggestedCampaignId` on `discovered_items`; `+suggestedPersonaId`/`+suggestedCampaignId` on `signals`; extend the schemas; migration. Confirm it applies in the in-memory test DB.
2. **Scoring:** extend `scoreUnscoredItems` (campaigns in context; parse + validate `campaignId`). Unit tests: campaign suggested + clamped to real ids; persona path unchanged; malformed tolerated.
3. **Accept:** carry persona + campaign onto the signal. Tests: signal carries the mapping; manual signals leave them null.
4. **Web:** triage campaign chip + Content draft pre-fill.
5. **Verify Slice A green**; founder gate.

### Slice B — Keyless adapters
6. **Contracts:** add the five keyless types + `isLiveSourceType`; per-type config validation.
7. **Adapters:** `hacker_news` (Algolia JSON mapper), `youtube`/`podcast`/`google_trends` (`parseFeed`), `funding_news` (funding query). Fixture tests per adapter (no network).
8. **Source CRUD + web add-forms** for the new types.
9. **Verify Slice B green**; founder gate.

### Slice C — Provider-gated + boundary
10. **Contracts:** add `g2`, `capterra`, `intent` (credential-gated).
11. **`IntentProvider` boundary** + `NullIntentProvider`; inject into `buildApp`; `intent` adapter delegates. `g2`/`capterra` throw `NeedsApiKeyError`. Tests: refusal; fake provider fetches through the boundary.
12. **Web:** needs-api-key UI for the three.
13. **Verify Slice C green**; founder gate.

---

## Automated verification (test inventory)

- **Contracts:** new source-type + signal-source enums; widened item/signal/config schemas.
- **Adapters (fixtures, no network):** HN Algolia JSON mapping; YouTube/podcast/Trends RSS+Atom parsing; funding-news URL construction; `g2`/`capterra`/`intent` `NeedsApiKeyError`; `isLiveSourceType` correctness.
- **Scoring:** campaign suggestion parsed + validated against real campaigns (unknown → null); persona path unchanged; malformed-response tolerance.
- **Pipeline/accept:** dedupe holds for new types; accept carries persona + campaign onto the signal with honest provenance; double-accept 409.
- **`IntentProvider`:** fake provider fetches through the boundary; null provider refuses.
- **API/web:** source CRUD + per-type config validation for all new types; triage shows campaign; needs-api-key surfaces for gated types.

## Known limitations (intentional)

- G2 / Capterra / intent are inert until a provider/key is supplied (no scraping).
- YouTube is channel-RSS only (search would need an API key); funding signals are news-feed-derived until a paid intent provider is wired behind the boundary.
- Google Trends gives trending *topics* (daily RSS), not per-query interest-over-time (that needs an unofficial/paid endpoint).

## Founder acceptance checklist (sprint gate = all three slices)

- **Slice A:** discovered items show a suggested **campaign + persona + reason**; accept pre-fills the Content draft with both; the gate is unchanged.
- **Slice B:** Hacker News + funding-news (+ YouTube/podcast/Trends) fetch real items, scored and mapped; re-runs don't duplicate.
- **Slice C:** a G2/Capterra/intent source registers and shows "needs API key" and runs nothing; the `IntentProvider` boundary is in place for a future provider.

---

## Progress log

- 2026-06-24 — Worktree `sprint-31-discovery-expansion` created off `main` (`d08c7c6`); `npm install` clean. Existing discovery engine (Sprint 7) reviewed.
- 2026-06-24 — Spec drafted; founder locked the four decisions above. **Awaiting founder review of this spec before implementation.**
