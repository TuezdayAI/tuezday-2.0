# Sprint 34 — Native GTM insights & reports dashboard

- **Status:** planned
- **Roadmap item:** U2 (A6 analytics surface) — `docs/plans/sprint-guide-21-onward.md`, "Sprint 34"
- **Branch:** `sprint-34-gtm-insights-dashboard`, cut from `main`
- **Merge order:** none. All "Builds on" dependencies — ads metrics (Sprint 14), engagement metrics + publication metrics (Sprint 29), approval/learning data (Sprints 5/10), publications (Sprint 17), campaigns (Sprint 8) — are already merged into `main` (verified: `origin/main` contains the Sprints 21–30 outbound chain). No unmerged 21+ predecessor is required. The unmerged branches `sprint-30-rag-hardening` and `sprint-31-discovery-expansion` are **not** dependencies of this sprint.
- **Size:** M–L. Two slices (A then B), each founder-acceptable on its own.
- **Do NOT merge into `main`.** Push the branch; the founder reviews, accepts, and merges.

> Numbering note: this repo's local working branches diverged from the guide for the RAG/discovery sprints (a branch `sprint-30-rag-hardening` exists alongside the merged `sprint-30-outbound-sequences`). This spec uses the **guide's canonical numbering**, where Sprint 34 = "Native GTM insights & reports dashboard." It is independent of the RAG/discovery branches.

---

## Goal

A **customer-facing GTM insights surface**, built **native** (locked product decision — PostHog/Superset are for internal product analytics, Sprint 35; the customer dashboard stays native). The headline deliverable is the founder-acceptance flow:

> Open a campaign → **one view** of paid + organic + outbound performance, plus the brain's own quality signals (approval rate, output ratings).

Plus a workspace-level rollup (channel performance + brain completeness/usage) and CSV export.

This sprint is **read-only aggregation over data that already exists**. Every source table is already populated by earlier sprints; Sprint 34 adds no new ingestion, no new worker job, and no new external integration. It adds a read-model (services), its contracts, two API routes, two web surfaces, and export.

---

## Decisions locked (recommended defaults)

1. **All-time rollup for v1, no time-series/trends.** The acceptance is "one view," not a charting tool. Totals are all-time per campaign (matching the existing `getCampaignAdMetrics`, which is all-time). Date-range filtering and sparklines/trends are out of scope (see Known limitations). This keeps the read-model deterministic and the spec small.
2. **Roll up onto the campaign object** (the research's "HubSpot bar" point). The per-campaign view is the primary surface; the workspace view is a thin cross-campaign aggregation of the same read-model.
3. **Reuse, don't duplicate.** Paid metrics come from `getCampaignAdMetrics` (ads.ts) unchanged; approval/draft counts reuse the `getCampaignDetail` pattern. New code only adds the organic + outbound + ratings + by-channel rollups and the workspace aggregation.
4. **No new enum vocab.** Channels are the existing `CHANNELS`; ratings are `OUTPUT_RATINGS`; approval states are `APPROVAL_STATES` (all in `packages/contracts`).
5. **Export = CSV via `?format=csv`** on the existing GET routes (default JSON), returning `text/csv`. No new export subsystem; mirrors how the app already treats CSV as a flat string (`adsCsvImportInputSchema`).
6. **Brain completeness/usage is workspace-scoped and lightweight**: which of the five brain docs are filled, overlay/persona/campaign coverage counts, and generation counts in the workspace. No new "usage tracking" instrumentation (that is Sprint 35).
7. **Money stays integer cents** end-to-end (`spendCents`), formatted only in the web layer — consistent with the existing ads model ("no floats in the DB").

---

## Out of scope (YAGNI)

- Date-range filters, time-series, trend deltas, charts/sparklines (all-time totals only for v1).
- PostHog / product-behavior analytics (Sprint 35) — explicitly a different surface.
- Dashboard UX redesign / nav restructure (Sprint 33). Sprint 34 adds pages; Sprint 33 reorganizes IA. The campaign insights view is reachable from the existing campaigns page.
- New metric capture/sync (paid sync is Sprint 14; publication metrics polling is Sprint 29). If a number is empty, it is because the upstream sprint hasn't captured it, not Sprint 34's job to fetch it.
- Cross-workspace / org-level reporting.
- Scheduled/emailed reports.

---

## Architecture & boundary

UI → API route → `insights` service → DB reads (no writes). The service composes existing read helpers; it owns the GTM metric model (native boundary: "GTM dashboard" is must-own per CLAUDE.md). No external BI tool, no new connector.

New files:

- `apps/api/src/services/insights.ts` — the read-model.
- `apps/api/src/routes/insights.ts` — two GET endpoints + CSV.
- `apps/web/app/workspaces/[id]/insights/page.tsx` — workspace insights.
- The per-campaign insights view is rendered from the existing campaigns page (a campaign detail/insights panel), reusing the campaigns route the founder already opens (acceptance = "open a campaign").

Touched files:

- `packages/contracts/src/index.ts` — add the insights response schemas/types.
- `apps/api/src/routes/index.ts` (or wherever routes register) — register the insights routes.
- `apps/web/app/workspaces/[id]/campaigns/page.tsx` — surface the campaign insights view + a link/tab.
- Web nav (the workspace layout) — add an "Insights" entry.

---

## Data model

**No schema changes.** Sprint 34 reads existing tables:

| Pane | Source tables | Join to campaign |
|---|---|---|
| Paid | `ad_campaigns`, `ad_campaign_metrics`, `ad_accounts` | `ad_campaigns.campaignId = campaigns.id` (via `getCampaignAdMetrics`) |
| Quality — approvals | `drafts` | `drafts.campaignId` |
| Quality — output ratings | `generations` (`rating`, `ratedAt`) | `generations.campaignId` |
| Organic — publishing | `publications` → `drafts`; `publication_metrics`; `engagement_metrics` | `publications.draftId → drafts.campaignId`; `engagement_metrics.draftId → drafts.campaignId` |
| Outbound | `launches`, `launch_messages`; reply via `sequence_recipients` / `inbox_items` | `launches.campaignId`; messages via `launch_messages.launchId` |
| By channel | all of the above, grouped | `CHANNELS` |
| Brain (workspace) | `brain_documents`, `guidance_overrides`, `personas`, `campaigns`, `generations` | workspace-scoped |

Notes grounding the joins (verified against `origin/main` schema):
- `publications` has no `campaignId`; it joins to the campaign **through its draft** (`publications.draftId → drafts.campaignId`). `publication_metrics` is keyed `(publicationId, window)` with `window ∈ {"24h","7d"}` — v1 reads the `7d` row when present, else `24h`.
- `engagement_metrics` (learning-loop, manually/learning-recorded) is **separate** from `publication_metrics` (platform-polled). Both feed "organic"; keep them as distinct sub-totals to avoid double-counting (impressions live in both with different provenance).
- Outbound reply detection: a `launch_message` is "replied" when its `sequence_recipients` row is in a replied/stopped-on-reply state, or an `inbox_items` row links to it via `launchMessageId`. v1 counts replies via `inbox_items.launchMessageId` (the canonical reply record) and reports `repliedCount / sentCount`.
- Output ratings come from `generations.rating` (`OUTPUT_RATINGS`), filtered by `generations.campaignId`. Drafts also link to their generation via `drafts.sourceGenerationId` if a draft-centric count is ever needed; v1 uses `generations.campaignId` directly.

---

## Contracts (`packages/contracts/src/index.ts`)

Add response schemas (no new enums). Sketch:

```ts
// Reuses AdsReportTotals shape already implied by ads.ts.
export const metricTotalsSchema = z.object({
  spendCents: z.number().int(),
  impressions: z.number().int(),
  clicks: z.number().int(),
  conversions: z.number().int(),
});

export const campaignInsightsSchema = z.object({
  campaign: z.object({ id: z.string(), name: z.string(), status: z.string() }),
  paid: z.object({
    totals: metricTotalsSchema,
    adCampaigns: z.array(z.object({
      id: z.string(), name: z.string(), accountName: z.string(),
      currency: z.string(), totals: metricTotalsSchema,
    })),
  }).nullable(),                       // null when no linked ad campaigns
  organic: z.object({
    publishedCount: z.number().int(),
    scheduledCount: z.number().int(),
    platform: z.object({               // summed publication_metrics
      likes: z.number().int(), comments: z.number().int(),
      shares: z.number().int(), impressions: z.number().int(), clicks: z.number().int(),
    }),
    learning: z.object({               // summed engagement_metrics
      impressions: z.number().int(), engagements: z.number().int(), clicks: z.number().int(),
    }),
  }),
  outbound: z.object({
    launchCount: z.number().int(),
    sentCount: z.number().int(),
    failedCount: z.number().int(),
    repliedCount: z.number().int(),
    replyRate: z.number(),             // repliedCount / max(sentCount,1)
  }),
  quality: z.object({
    draftCounts: z.record(z.enum(APPROVAL_STATES), z.number().int()),
    approvalRate: z.number(),          // approved / max(reviewed,1)
    ratings: z.record(z.enum(OUTPUT_RATINGS), z.number().int()),
  }),
  byChannel: z.array(z.object({
    channel: z.enum(CHANNELS),
    published: z.number().int(),
    impressions: z.number().int(),     // organic+paid combined for the channel
    spendCents: z.number().int(),
    sent: z.number().int(),
    replied: z.number().int(),
  })),
});
export type CampaignInsights = z.infer<typeof campaignInsightsSchema>;

export const workspaceInsightsSchema = z.object({
  campaigns: z.array(/* compact per-campaign rollup: id, name, paid totals, published, sent, approvalRate */),
  byChannel: z.array(/* same shape as campaign byChannel, workspace-wide */),
  brain: z.object({
    docs: z.array(z.object({ type: z.string(), filled: z.boolean() })),  // the 5 brain docs
    overlayCount: z.number().int(),
    personaCount: z.number().int(),
    campaignCount: z.number().int(),
    generationsTotal: z.number().int(),
    completenessPct: z.number(),       // filled docs / 5
  }),
});
export type WorkspaceInsights = z.infer<typeof workspaceInsightsSchema>;
```

(Exact field set may shrink during TDD; keep it the minimum the two web views render.)

---

## Behavior

### Slice A — Insights read-model + API

`apps/api/src/services/insights.ts`:

- `getCampaignInsights(db, campaign: Campaign): CampaignInsights`
  - **paid:** delegate to `getCampaignAdMetrics(db, campaign)` (unchanged).
  - **quality:** reuse the `getCampaignDetail` draft-count logic; `approvalRate = approved / (approved + rejected + edited)` (reviewed = decisions that left `pending_review`); ratings from `generations` where `campaignId = campaign.id`.
  - **organic:** publications whose draft belongs to the campaign → counts by `status` (published vs scheduled); sum `publication_metrics` (prefer `7d` window) and `engagement_metrics` separately.
  - **outbound:** launches where `campaignId = campaign.id` → `launch_messages` status tally; replies from `inbox_items.launchMessageId`.
  - **byChannel:** fold the above into one row per `CHANNELS` value that has any activity.
- `getWorkspaceInsights(db, workspaceId): WorkspaceInsights`
  - per-campaign compact rollups (loop `listCampaigns` → a trimmed `getCampaignInsights`), workspace-wide `byChannel`, and `brain` completeness (read `brain_documents` for the five doc types, count `guidance_overrides`, `personas`, `campaigns`, `generations`).
- `toCampaignInsightsCsv(insights)` / `toWorkspaceInsightsCsv(insights)` — flatten to CSV strings.

`apps/api/src/routes/insights.ts`:

- `GET /workspaces/:id/campaigns/:campaignId/insights` → `CampaignInsights` (JSON) or `text/csv` when `?format=csv`. 404 if the campaign isn't in the workspace.
- `GET /workspaces/:id/insights` → `WorkspaceInsights` (JSON) or CSV.
- Both auth/membership-guarded exactly like the existing `campaigns`/`ads` routes (same `requireWorkspace`/member middleware pattern).

**Founder-acceptable at end of Slice A:** hit the campaign insights endpoint for a campaign that has paid + a publication + a launch, and see all three plus approval rate in one JSON response; `?format=csv` downloads it.

### Slice B — Web insights surfaces

- **Campaign insights view** (primary, the acceptance flow): from `apps/web/app/workspaces/[id]/campaigns/page.tsx`, opening a campaign shows an insights panel/tab with four blocks — **Paid**, **Organic**, **Outbound**, **Quality** — and a per-channel table. Money formatted from `spendCents` + currency; reply rate / approval rate as percentages. An **Export CSV** button hits `?format=csv`.
- **Workspace insights page** `apps/web/app/workspaces/[id]/insights/page.tsx`: a campaigns table (one row each: spend, published, sent, approval rate), the workspace-wide channel table, and a **brain completeness** card (5 docs filled? overlay/persona counts, generations total). Add an **Insights** nav entry in the workspace layout.
- Follow existing page conventions (server component fetch via the app's API client, the same card/table styling used by `ads/page.tsx` and `campaigns/page.tsx`). No new design system.

**Founder-acceptable at end of Slice B:** open a campaign → one view of paid + organic + outbound + quality; open Insights → channel performance + brain completeness; export CSV from either.

---

## Step-by-step plan (tests-first, bottom-up)

**Slice A**
1. Add contracts schemas/types (`metricTotalsSchema`, `campaignInsightsSchema`, `workspaceInsightsSchema`) + a contracts test asserting parse round-trips.
2. Write `insights.service.test.ts` against seeded fixtures: a workspace with one campaign linked to an ad campaign+metrics, a published publication with `publication_metrics`, a manual `engagement_metrics` row, a launch with messages + one inbox reply, drafts across approval states, and rated generations. Assert each pane's numbers and that empty panes are zero/null (not crashes).
3. Implement `getCampaignInsights` until green; then `getWorkspaceInsights`; then the CSV serializers (+ a small CSV-shape test).
4. Write `insights.routes.test.ts`: JSON shape, `?format=csv` content-type, 404 for foreign campaign, 401/403 for non-member. Implement `routes/insights.ts`; register it.
5. `npm test` + `npm run typecheck` green. Commit. **Founder acceptance checkpoint A.**

**Slice B**
6. Workspace insights page + nav entry (server fetch → render tables + brain card). Add a light render/smoke test if the web app has the harness; otherwise manual.
7. Campaign insights panel on the campaigns page + Export CSV button.
8. Manual walkthrough of the acceptance flow; `npm test` + `npm run typecheck` green. Commit. **Founder acceptance checkpoint B.**

Each commit ends with the `Co-Authored-By: Claude Opus 4.8` trailer. Push the branch; do not merge.

---

## Test inventory

- **contracts:** `campaignInsightsSchema` / `workspaceInsightsSchema` parse valid payloads, reject malformed.
- **service (api, in-memory SQLite + checked-in migrations):**
  - paid totals delegate correctly (matches `getCampaignAdMetrics`); null when no linked ad campaign.
  - approvalRate and ratings distribution from seeded drafts/generations.
  - organic: platform vs learning sub-totals not double-counted; published vs scheduled split.
  - outbound: sent/failed tally + reply rate from inbox link.
  - byChannel folding; empty campaign → all-zero, no throw.
  - workspace: cross-campaign aggregation + brain completeness (e.g. 3/5 docs filled ⇒ 60%).
  - CSV serializers produce header + one row per entity.
- **routes (api):** JSON 200 shape; CSV content-type + filename; 404 foreign campaign; 403 non-member.

---

## Known limitations (documented, intentional)

- All-time totals only; no date range, trend, or chart. (Date-range insights are a natural Sprint-34.1 follow-on; `defaultMetricRange()` already exists in ads.ts to build on.)
- Paid totals are all-time regardless of any future range param (inherited from `getCampaignAdMetrics`).
- "Organic impressions" can appear in both the platform-polled and learning-loop sub-totals with different provenance; they are reported separately and **not** summed, to avoid double counting.
- Reply attribution relies on `inbox_items.launchMessageId` being set by the Sprint 29 poller; DMs that never linked back show as un-replied.
- Brain "usage" is a generation count, not true resolver-trace usage analytics (that depth is Sprint 35 / PostHog territory).

---

## Founder acceptance checklist

1. Seed/representative workspace with a campaign that has: a linked ad account+campaign with metrics, at least one published post with metrics, one outbound launch with a reply, and a few drafts/generations across states.
2. Open the campaign → the insights view shows **paid** (spend + impressions/clicks/conversions), **organic** (published count + platform engagement), **outbound** (sent + reply rate), and **quality** (approval rate + ratings) in one view. ✅ (roadmap acceptance)
3. Per-channel table reflects activity per channel.
4. Open **Insights** (workspace) → campaigns table + channel performance + brain completeness card (e.g. "4/5 brain docs filled").
5. **Export CSV** from both views downloads a flat report.
6. A campaign with no activity renders zeros/empty states, not errors.

---

## Open decisions (none blocking; recommended default in brackets)

1. **Campaign insights placement** — inline panel on the campaigns page vs a dedicated `/campaigns/[campaignId]/insights` route. *[Inline panel/tab on the existing campaigns page — fewest clicks, matches "open a campaign," avoids pre-empting Sprint 33's IA work.]*
2. **Conversions/CTR derived metrics** — show raw counts only, or also computed CTR/CPC/CPA. *[Show raw + CTR and CPC (cheap, common GTM bar); skip CPA until conversion definitions are firmer.]*
3. **CSV granularity** — one summary row per campaign, or also per-channel breakdown rows. *[Summary row + per-channel rows in the campaign export; summary-only for the workspace export.]*

---

## Progress log

- 2026-06-26 — Spec drafted. Verified against `origin/main`: Sprints 21–30 merged (all deps present); schema tables (`campaigns`, `ad_campaign_metrics`, `publications`, `publication_metrics`, `engagement_metrics`, `launches`, `launch_messages`, `inbox_items`, `generations`, `approval_decisions`, `brain_documents`, `guidance_overrides`) and reuse points (`getCampaignAdMetrics` ads.ts:472, `getCampaignDetail` campaigns.ts:166, `CHANNELS`/`OUTPUT_RATINGS`/`APPROVAL_STATES` in contracts) confirmed present. No schema changes required. Branch not yet cut (awaiting founder go-ahead, per one-sprint-at-a-time rule).
