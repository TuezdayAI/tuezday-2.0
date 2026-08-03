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
| `engagementMetrics` (`schema.ts:807`) | `draftId` — **nullable, no FK** — plus `channel`, a closed `CHANNELS` enum | `recordedAt`: a **point reading**, no window | `impressions`, `engagements`, `clicks` | manual entry |
| `publicationMetrics` (`schema.ts:2095`) | `publicationId` (FK, cascade) | `window` (`"24h"` \| `"7d"`) + `capturedAt`; **unique on (publicationId, window)** → a **cumulative snapshot** at that age | `likes`, `comments`, `shares`, `impressions`, `clicks` | platform capture |
| `adCampaignMetrics` (`schema.ts:1012`) | `adCampaignId` (FK, cascade) | `date` `YYYY-MM-DD`; **unique on (adCampaignId, date)** → a **daily bucket** | `spendCents`, `impressions`, `clicks`, `conversions` | provider sync (`services/ads.ts`) |
| `insights` (`services/insights.ts`) | — | aggregates the other three on the fly | — | — |

**Three different meanings of "when", and metric names that collide across them.** `impressions` and
`clicks` appear in all three but mean *point reading*, *cumulative-at-24h*, and *that day's total*
respectively. Summing them today would be wrong, and nothing stops a future reader from doing it.

**Readers — corrected by Task 1** (each is a Task 5 migration site). Confirmed:
`services/insights.ts`, `services/learning.ts`, `services/inbox.ts` (writer *and* reader),
`services/ads.ts`, `services/copilot-tools.ts`. **Removed** (read none of the three tables):
`next-action.ts`, `outreach-funnel.ts`. **Missed by the first draft and added:**
`services/publications.ts`, `services/campaigns.ts`, `services/ad-creatives.ts`, and — critically —
**`routes/public-api.ts` (`GET /api/v1/insights`)** and **`apps/mcp` (`fetch-insights`)**.

> **The blast radius is customer-facing.** The same `getWorkspaceInsights` output is served to the
> dashboard, two CSV exports, the campaign overview, the **public API**, the **MCP tool**, and three
> copilot tools. A silent numeric change here changes what a customer's API returns and what the
> copilot tells the founder.

---

## 2. Design

### 2.1 The fact table

```
metrics(
  id, workspace_id,
  subject_type,        -- publication | campaign | ad_campaign | channel
  subject_id,
  metric_key,          -- from the contracts vocabulary (§2.2)
  value,               -- integer; money in cents, never floats
  window,              -- point | 24h | 7d | 1d  (§2.3)
  period_start,        -- inclusive; the period this value covers
  source,              -- manual | captured | synced | imported
  captured_at,         -- when we learned it
  created_at
)
```

**Grain: one row per `(workspace, subject_type, subject_id, metric_key, window, period_start)`**,
enforced by a unique index. `value` is an integer; money is cents.

**Corrections from Task 1 — the original draft was wrong on four counts:**

- **`channel` is a subject type.** `engagementMetrics.draftId` is nullable and the UI produces
  subject-less rows on its default path. Their only subject information is `channel`, which is a
  closed `CHANNELS` enum in contracts — so `subject_type: "channel"`, `subject_id`: the channel name.
  Rejected: `workspace` (throws away the channel and collides every channel onto one grain) and
  refusing the rows (the UI advertises them as supported; the backfill would silently drop real
  founder-entered data).
- **`lane` and `sequence` are dropped** from `subject_type` — nothing writes them.
- **A null metric produces NO fact row.** All three of `impressions`/`engagements`/`clicks` are
  optional and nullable. **Absence is not zero**, and conflating them would invent data.
- **`source` gains `imported`** (`adCampaignMetrics.source` already stores `"csv"`) and **loses
  `derived`** — nothing derives in this sprint.

### 2.2 Metric vocabulary (`packages/contracts`, defined once — the existing enum rule)

`impressions`, `clicks`, `likes`, `comments`, `shares`, `engagements`, `conversions`, `spend`.

**`replies` is REMOVED from the vocabulary.** Task 1 established it is not a stored observation at
all — it is computed on the fly from `inboxItems` (`insights.ts:180-202`, `outreach-funnel.ts:38-45`)
and is always current. Storing it as a fact would create a snapshot that goes stale the moment an
inbox item arrives, giving two answers to one question — the exact defect this sprint removes. *If a
connector ever reports a platform reply count, that number is a genuine fact and earns the key back.*

**`engagements` vs `likes`/`comments`/`shares`:** each source writes what it actually observed —
manual writes `engagements`, capture writes the three components. **Nothing derives one from the
other today**, so adding a read-path derivation would be a behaviour change and is **deferred out of
Sprint 55**.

### 2.3 Window vocabulary — the load-bearing part

| `window` | Meaning | Source |
|---|---|---|
| `point` | a reading at `captured_at`, covering no defined period | `engagementMetrics` |
| `24h` / `7d` | **cumulative** since the subject went live, observed at **at least** that age | `publicationMetrics` |
| `1d` | that calendar day's total, `period_start` = the day | `adCampaignMetrics` |

`period_start` (for a publication, its `publishedAt`) and `captured_at` are genuinely different
instants; both are kept.

> **⚠️ The no-mixing rule is already violated in production.** `insights.ts:229` and `:236` add
> prorated cumulative organic impressions and an all-time sum of daily paid buckets into the *same*
> displayed cell. Task 2's classifier guards every **new** reader; Task 5 carries a **single,
> explicitly commented escape hatch** that reproduces the legacy mixing. Without saying this out
> loud, Task 5 could not both use the classifier and pass its own snapshot test.

### 2.4 Migration strategy — dual-write BEFORE backfill

**Order matters and Task 1 corrected it.** Dual-write ships first; the backfill runs second and is
**insert-if-absent, never clobber-on-conflict** — because the ads sync restates a rolling 28-day
window every 6 hours, so a clobbering backfill could overwrite fresher synced values with staler ones.

- Existing tables keep their writers and additionally write `metrics`. `insights` reads only `metrics`.
- **Nothing is dropped this sprint.** And `engagement_metrics` can **never** be fully replaced: an
  all-null row carries no metric values at all, existing purely for its `description`/`notes`, and
  `notes` is read verbatim into the learning-synthesis prompt (`learning.ts:276`). The deferred
  "drop the legacy tables" item is narrowed accordingly.


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

### Task 5 — `insights` reads only `metrics` (faithful cutover — **no number moves**)
- [ ] **Snapshot the current `/insights` output first**, then reimplement the aggregation against
      `metrics` so the snapshot passes **byte-for-byte** — including the proration, the prefer-7d
      fallback, the `ads`-cell merge, and the exclusion of `point` readings. This is a storage change
      only; **no displayed number moves.**
- [ ] Carry the §2.3 escape hatch as a single, explicitly commented exception, so the classifier can
      guard new readers while Task 5 reproduces the legacy mixing.
- [ ] Migrate the public API and MCP readers too — they serve the same aggregation.
- [ ] Migrate the other readers found in Task 1 (`learning.ts`, `copilot-tools.ts`, `next-action.ts`,
      `outreach-funnel.ts`, and the web pages).
- [ ] **Acceptance: `/insights` reads one table** — assert no insights code path touches the three
      legacy tables.

### Task 5b — Fix the mixings, each on its own, on top of a passing snapshot
**Founder decision: fix the numbers and report what changed.** Task 1 confirmed `/insights` really
does mix incompatible semantics. But fixing during the storage cutover would make a genuine
regression indistinguishable from an intentional correction — so the fix is **sequenced after** it,
never conflated with it.
- [ ] One commit per mixing, each with a before/after of the affected figure:
      **(a)** cumulative organic + all-time paid summed in the same `ads` cell;
      **(b)** 24h and 7d cumulative values summed together (a figure that silently changes as
      publications age past 7d);
      **(c)** organic impressions prorated by *published-post count* rather than attributed to each
      publication's actual channel — which is already known at `insights.ts:86` and being discarded;
      **(d)** per-channel `Math.round` drift, so the column does not sum to the total shown elsewhere.
- [ ] Also record the fifth, by omission: manual `point` readings never reach the channel table.
- [ ] Each commit states the direction of the change. **(c)** can move a channel either way; **(a)**
      moves the `ads` cell down.
- [ ] Because this changes the **public API and MCP** output, note it plainly in the sprint summary.

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
| **A numeric change reaches the public API and MCP, not just the dashboard** | Task 5 moves no number at all; Task 5b changes them deliberately, one at a time, each documented |
| Backfill overwrites fresher synced values | §2.4 — dual-write first, backfill is insert-if-absent; ads restates a rolling 28-day window every 6 hours |
| `engagement_metrics` assumed droppable | It is not — all-null rows carry only prose that feeds the learning prompt. Deferred item narrowed |

---

## 6. Progress log

- **2026-08-02 — Task 1 complete (verification only; no production code).** Eight assumptions
  checked against code. **Q8 answered YES:** `/insights` genuinely mixes incompatible semantics in
  the Channels **Impressions** column — four distinct mixings plus one omission, detailed in Task 5b.
  §2 was corrected on four counts (`channel` as a subject type, `lane`/`sequence` dropped, null ≠
  zero, `source` vocabulary), `replies` was removed from the vocabulary entirely (it is derivable,
  not observed), the migration order was **reversed** to dual-write-then-backfill, and the reader
  list was both over- and under-inclusive. Full detail in
  `.superpowers/sdd/sprint-55-unified-metric-model/task-1-report.md`.
  *(The Task 1 agent died mid-write from an API error after producing its report; the controller
  folded the findings into this spec.)*

- **2026-08-02** — Plan written from a fast schema-level recon (the three store definitions, the
  reader list, and the journal's max `idx` = 62). **§2 rests on assumptions Task 1 must verify before
  any schema is built** — in particular that `publicationMetrics` is cumulative, that
  `adCampaignMetrics` is per-day, and what to do with subject-less manual rows. Awaiting founder
  approval. No code written yet.
