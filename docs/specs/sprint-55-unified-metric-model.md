# Sprint 55 — Unified Metric Model

> **Phase:** I (Architectural Convergence) · **Workstream:** W2
> **Closes:** Atlas conflict #8 (four metric stores)
> **PRD:** `prd-agentic-platform.md` §4, Sprint 55
> **Size:** L · **Risk:** Medium (migration + every insights reader moves)
> **Status:** Plan awaiting founder approval — no code written yet.

---

## 0. Branch and merge order

**Branch `sprint-55-unified-metric-model` off `sprint-54-ads-governance-spine`.
Required merge order: 52 → 53 → 54 → 55.**

52 claims migrations `0060`/`0061`, 53 claims `0062`, 54 adds none. The journal's max `idx` is **62**,
so Sprint 55's migration is **`0063`**. Branching off `main` would collide.

> **Why this sprint matters beyond tidiness.** It is a prerequisite for Phase L: the learning loop
> (Sprint 68) and the eval harness (Sprint 67) both need one place to ask *"did this work?"*. Every
> sprint after this one that measures outcomes is blocked on it.

---

## 1. The problem

Four stores, verified in code:

| Store | Subject | Time semantics | Metrics (as **columns**) | Written by |
|---|---|---|---|---|
| `engagementMetrics` (`schema.ts:807`) | `draftId` — **nullable, no FK** — plus a free-text `channel` | `recordedAt`: a **point reading**, no window | `impressions`, `engagements`, `clicks` | manual entry |
| `publicationMetrics` (`schema.ts:2095`) | `publicationId` (FK, cascade) | `window` (`"24h"` \| `"7d"`) + `capturedAt`; **unique on (publicationId, window)** → a **cumulative snapshot** at that age | `likes`, `comments`, `shares`, `impressions`, `clicks` | platform capture |
| `adCampaignMetrics` (`schema.ts:1012`) | `adCampaignId` (FK, cascade) | `date` `YYYY-MM-DD`; **unique on (adCampaignId, date)** → a **daily bucket** | `spendCents`, `impressions`, `clicks`, `conversions` | provider sync (`services/ads.ts`) |
| `insights` (`services/insights.ts`) | — | aggregates the other three on the fly | — | — |

**Three different meanings of "when", and metric names that collide across them.** `impressions` and
`clicks` appear in all three but mean *point reading*, *cumulative-at-24h*, and *that day's total*
respectively. Summing them today would be wrong, and nothing stops a future reader from doing it.

**Known readers** (each is a migration site): `services/insights.ts`, `services/learning.ts`,
`services/inbox.ts`, `services/ads.ts`, `services/copilot-tools.ts`, `services/next-action.ts`,
`services/outreach-funnel.ts`, plus `apps/web` — the workspace home, `/insights`, `/outreach`, the
campaigns list, and campaign overview.

---

## 2. Design

### 2.1 The fact table

```
metrics(
  id, workspace_id,
  subject_type,        -- publication | campaign | lane | ad_campaign | sequence | draft
  subject_id,
  metric_key,          -- from the contracts vocabulary (§2.2)
  value,               -- integer; money in cents, never floats
  window,              -- from the window vocabulary (§2.3)
  period_start,        -- inclusive; the period this value covers
  source,              -- manual | captured | synced | derived
  captured_at,         -- when we learned it
  created_at
)
```

**Grain: one row per `(workspace, subject_type, subject_id, metric_key, window, period_start)`** —
enforced by a unique index, which is what makes re-sync idempotent (an upsert, matching how both
existing unique indexes already behave).

`value` is an integer. Money is cents (`spend` carries cents, as `spendCents` does today). No floats
in the DB, per the existing convention.

### 2.2 Metric vocabulary (`packages/contracts`, defined once — the existing enum rule)

`impressions`, `clicks`, `likes`, `comments`, `shares`, `engagements`, `conversions`, `spend`,
`replies`.

**The one real semantic decision — `engagements`.** Manual entry records a single `engagements`
number; platform capture records `likes`/`comments`/`shares` separately. They are the same concept at
different granularity. **Recommendation: store what each source actually observed, and derive nothing
on write.** A manual row writes `engagements`; a captured row writes `likes`, `comments`, `shares`.
`insights` may sum the components when `engagements` is absent, and that derivation lives in one
place, in the read path, where it can be inspected. Writing a derived `engagements` row would create
a number no source ever reported and make double-counting easy.

### 2.3 Window vocabulary — the load-bearing part

The three stores disagree about time, so `window` must be explicit rather than implied:

| `window` | Meaning | Source today |
|---|---|---|
| `point` | a reading taken at `captured_at`, covering no defined period | `engagementMetrics` |
| `24h` / `7d` | **cumulative** total since the subject went live, observed at that age | `publicationMetrics` |
| `1d` | that calendar day's total, `period_start` = the day | `adCampaignMetrics` |

**`cumulative` and `per-period` values must never be summed together.** That is the defect this table
could institutionalise if `window` were dropped or fudged. The contracts layer should make the
distinction queryable (e.g. a helper that classifies a window as cumulative or periodic), so a reader
cannot mix them by accident.

### 2.4 Migration strategy

- **Backfill** all three stores into `metrics`, preserving their real semantics per §2.3.
- **Existing tables keep their writers for now** and additionally write to `metrics` (dual-write), so
  a rollback loses nothing. `insights` reads **only** `metrics`.
- **Do not drop the old tables in this sprint.** They stay readable for one release, per the PRD.
  Physical removal is a follow-up, recorded as a deferred item — consistent with how Sprint 53 handled
  the legacy signal columns, and because SQLite `DROP COLUMN`/table-recreate is avoided in this repo.

### 2.5 Out of scope

New metric sources; changing what any provider sync fetches; the `/insights` visual design; and
dropping the old tables.

---

## 3. Implementation plan

> TDD throughout. Explicit-pathspec commits. `npm test` + `npm run typecheck` green before each commit
> (baseline: 199 files / 2188 tests).

### Task 1 — Verify the semantics this plan assumes, before building on them
**This task exists because the plan above was written from schema shapes, not from every call site.**
- [ ] Confirm `publicationMetrics` is genuinely **cumulative** at its window (not a delta) by reading
      the capture writer, and confirm `adCampaignMetrics.date` rows are genuinely **per-day**.
- [ ] Enumerate every metric concept across the three stores and every reader listed in §1; confirm
      none was missed (`replies` in particular — the PRD names it but it may live in
      `outreach-funnel.ts` rather than a metric store).
- [ ] Confirm whether any store is written **by the worker on a schedule** — if so, the backfill must
      tolerate in-flight writes.
- [ ] Confirm `engagementMetrics.draftId` really is nullable/un-FK'd, and decide what `subject_type`
      a null-subject manual row gets. **A metric with no subject cannot go in a fact table keyed on
      one** — if these exist in real data, the plan needs a subject (workspace-level?) before Task 2.
- [ ] **Write findings into this spec** and adjust §2 before proceeding. Report contradictions rather
      than coding around them.

### Task 2 — Contracts vocabulary + the `metrics` table
- [ ] Metric-key and window vocabularies in `packages/contracts`, with the cumulative-vs-periodic
      classifier from §2.3. Tests pin that the classifier refuses to treat `24h` as periodic.
- [ ] `metrics` table in `schema.ts` + unique index on the grain; migration via
      `npm run db:generate -w apps/api` (**never hand-write schema SQL**) — expect `0063`.
- [ ] A `recordMetric` / `recordMetrics` service with upsert-on-grain semantics; tests prove
      re-recording the same grain updates rather than duplicates.

### Task 3 — Backfill the three stores
- [ ] Idempotent, size-independent backfill (production row counts unknown — the checked-in dev DB is
      empty). Follow the `external-action-backfill.ts` / `campaign-plan-backfill.ts` precedent for a
      boot-time idempotent sweep, or a data migration if that is genuinely better — justify.
- [ ] Each store maps with its **real** window semantics: manual → `point`, publication → `24h`/`7d`
      cumulative, ad → `1d` periodic.
- [ ] Test: backfill twice → identical rows, no duplicates. Test: a row from each store round-trips
      with its semantics intact.

### Task 4 — Dual-write from the existing writers
- [ ] Manual entry, platform capture, and provider sync each additionally write `metrics`.
- [ ] Tests: writing through each existing path produces the correct `metrics` row **and** the legacy
      row. Rollback safety is the point — do not remove the legacy writes in this sprint.

### Task 5 — `insights` reads only `metrics`
- [ ] Rewrite the aggregation against the fact table. **Snapshot the current `/insights` output
      first** and assert the new implementation matches it — this is the regression guard that makes
      the cutover safe. Where output legitimately changes, say why.
- [ ] The `engagements`-vs-components derivation (§2.2) lives here, in one place.
- [ ] Migrate the other readers found in Task 1 (`learning.ts`, `copilot-tools.ts`, `next-action.ts`,
      `outreach-funnel.ts`, and the web pages).
- [ ] **Acceptance: `/insights` reads one table** — assert no insights code path touches the three
      legacy tables.

### Task 6 — Prove the second acceptance criterion
- [ ] **"A new metric source is one writer, not a new schema."** Add a test that records a metric from
      a fictitious new source and shows it flows to `/insights` with **no schema change** — this is
      the criterion made executable rather than asserted in prose.

### Task 7 — Verify, document, push
- [ ] Full `npm test` + `npm run typecheck` green.
- [ ] `docs/deferred-improvements.md`: dropping the three legacy tables after one release.
- [ ] Progress log filled in. Push. **Do not merge** — founder merges, after 52, 53 and 54.

---

## 4. Acceptance criteria

- [ ] `/insights` reads one table.
- [ ] A new metric source is one writer, not a new schema — proven by a test.
- [ ] Cumulative and periodic values cannot be summed together by accident.
- [ ] Backfill is idempotent and preserves each store's real time semantics.
- [ ] Legacy tables still readable; nothing dropped this sprint.
- [ ] `npm test` and `npm run typecheck` pass.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| **Cumulative vs periodic silently merged** — the defect this table could institutionalise | §2.3 makes `window` explicit and adds a classifier; Task 2 tests that it refuses to misclassify |
| A metric with **no subject** (`engagementMetrics.draftId` is nullable) cannot key a fact table | Task 1 resolves this **before** Task 2 builds the schema |
| `/insights` output changes silently during cutover | Task 5 snapshots current output first and diffs against it |
| Backfill races the worker if a store is written on a schedule | Task 1 confirms; backfill must be idempotent and tolerate in-flight writes |
| Dual-write drifts between legacy and `metrics` | Accepted for one release — that is what makes rollback safe. Tests assert both are written |
| Scope creep into dropping tables | §2.5 — explicitly out of scope, recorded as a deferred item |

---

## 6. Progress log

- **2026-08-02** — Plan written from a fast schema-level recon (the three store definitions, the
  reader list, and the journal's max `idx` = 62). **§2 rests on assumptions Task 1 must verify before
  any schema is built** — in particular that `publicationMetrics` is cumulative, that
  `adCampaignMetrics` is per-day, and what to do with subject-less manual rows. Awaiting founder
  approval. No code written yet.
