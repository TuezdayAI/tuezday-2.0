# Sprint 36.2 — Website scraper + brand-profile extraction

**Part of:** the Onboarding V2 program — `docs/plans/onboarding-v2-roadmap.md`,
sprint **36.2 of 6**.

**Branch:** `sprint-36-2-website-scrape`, cut from `sprint-36-1-onboarding-shell`
(**merge order: 36.1 must merge to `main` first**). Do NOT merge into `main` —
push the branch; the founder reviews and merges.

**Goal:** The moment onboarding Step 2 submits a website URL, the API fetches the
site in the background, strips it to a text corpus, and one LLM call turns it
into a structured, zod-validated **brand profile** (business name, summary, tone,
target age, the seven named voice dimensions, content pillars) stored per
workspace and exposed at `GET /workspaces/:id/brand-profile` with a live
`scraping → extracting → ready | failed` status. This is the data Step 4's
verification screen (36.5) edits, and part of the corpus 36.4 drafts the brain
from.

**Research basis (multi-agent survey, 2026-07-07):**
- The codebase runs async work **inline in the API** (discovery/inbox/publish
  runs are awaited route handlers; the worker just POSTs to them on intervals) —
  no job queue. The scrape run follows suit: fire-and-forget at workspace
  creation + a deterministic awaited `refresh` route.
- `Fetcher = typeof fetch` (`apps/api/src/discovery/adapters.ts:11`) is already
  injected via `BuildAppOptions.fetcher` and stubbed in tests with
  fixture/capturing fetchers (`apps/api/test/adapters.test.ts:55-67`).
- HTML-strip precedent: `cleanText()` regex in `discovery/adapters.ts:32-51` —
  no cheerio/jsdom in the repo; we stay dependency-free.
- **No zod-validated LLM output or repair-retry exists yet** (discovery uses
  silent-fallback `parseJsonArray`, learning uses prose delimiters). This sprint
  introduces the pattern: JSON extract → `safeParse` → one repair retry with the
  validation error appended.
- Storage conventions mirrored from `evidence_documents`/`publications`: text
  status column with default, `*Json` text columns, FK + cascade, `error`
  column, epoch-ms timestamps.
- LLM test stub: prompt-marker fake gateway (`apps/api/test/ad-creatives.test.ts:11-38`).
  GatewayError→502 applies only to user-facing routes; the background run
  records failures into the row instead.

## Scope (in)

1. **Contracts** (`packages/contracts`): `VOICE_DIMENSIONS` (the fixed
   Purpose/Audience/Tone/Emotions/Character/Syntax/Language vocabulary shared
   with 36.4/36.5), `brandProfileSchema`, `BRAND_PROFILE_STATUSES`,
   `brandProfileViewSchema`, `updateBrandProfileInputSchema` (partial edit).
2. **Scrape service** (`apps/api/src/services/scrape.ts`): fetch the URL +
   up to 4 same-origin "about-ish" links (`about|product|pricing|service|company|
   mission|team|features`), strip HTML (script/style blocks, tags, entities),
   cap the corpus at 20 000 chars. Plain `fetch` only — JS-only sites are a
   documented limitation (YAGNI).
3. **Brand-profile service** (`apps/api/src/services/brand-profile.ts`):
   `extractBrandProfile(llm, corpus)` (JSON prompt → parse → zod → one repair
   retry), `runBrandProfile(db, llm, fetcher, workspaceId, url)` (status
   machine, never throws), `getBrandProfileView`, `updateBrandProfile`.
4. **DB**: `brand_profiles` table — one row per workspace (unique index),
   overwritten on re-run, editable when ready.
5. **Routes**: `GET /workspaces/:id/brand-profile`,
   `POST /workspaces/:id/brand-profile/refresh` (awaited inline run; 400 if the
   workspace has no `websiteUrl`), `PATCH /workspaces/:id/brand-profile`
   (partial edit, only when `ready`). Workspace creation fire-and-forgets the
   same run when `websiteUrl` is present.

## Scope (out — YAGNI / later sprints)

- Any web UI (the Step-3 animation + Step-4 verification screen are 36.5; this
  sprint's founder acceptance is via the API).
- Evidence/RAG sink for the scraped corpus (roadmap marks it optional-behind-a-
  flag; deferred until 36.4 decides what the brain drafts from).
- New event types, headless-browser scraping, sitemap parsing, robots.txt
  (single-digit page fetches of the customer's own site at their request).
- Worker involvement (runs are user-triggered, inline).

## Contracts (exact shapes — 36.4/36.5 depend on these names)

```ts
export const VOICE_DIMENSIONS = [
  "purpose", "audience", "tone", "emotions", "character", "syntax", "language",
] as const;
export type VoiceDimension = (typeof VOICE_DIMENSIONS)[number];

export const brandProfileSchema = z.object({
  businessName: z.string().trim().min(1).max(200),
  tagline: z.string().max(300).default(""),
  summary: z.string().max(2000).default(""),
  targetAgeRange: z.string().max(100).default(""),
  tone: z.string().max(500).default(""),
  voiceDimensions: z.object({
    purpose: z.string().max(500).default(""),
    audience: z.string().max(500).default(""),
    tone: z.string().max(500).default(""),
    emotions: z.string().max(500).default(""),
    character: z.string().max(500).default(""),
    syntax: z.string().max(500).default(""),
    language: z.string().max(500).default(""),
  }),
  pillars: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
  sourceNotes: z.string().max(1000).default(""),
});
export type BrandProfile = z.infer<typeof brandProfileSchema>;

export const BRAND_PROFILE_STATUSES = ["scraping", "extracting", "ready", "failed"] as const;
export type BrandProfileStatus = (typeof BRAND_PROFILE_STATUSES)[number];

export const brandProfileViewSchema = z.object({
  status: z.enum([...BRAND_PROFILE_STATUSES, "none"]),
  profile: brandProfileSchema.nullable(),
  sourceUrl: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.number().int().nullable(),
});
export type BrandProfileView = z.infer<typeof brandProfileViewSchema>;

export const updateBrandProfileInputSchema = brandProfileSchema.partial();
export type UpdateBrandProfileInput = z.infer<typeof updateBrandProfileInputSchema>;
```

## DB

```ts
export const brandProfiles = sqliteTable(
  "brand_profiles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    status: text("status").notNull().default("scraping"),
    profileJson: text("profile_json"),
    error: text("error"),
    corpusChars: integer("corpus_chars").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("brand_profiles_workspace").on(t.workspaceId)],
);
```

Migration via `npm run db:generate -w apps/api` (never hand-written).

## Run state machine (`runBrandProfile` — never throws)

```
upsert row {status: "scraping", sourceUrl, error: null}
  → scrapeWebsite(url, fetcher)            [failure → status "failed", error]
  → set {status: "extracting", corpusChars}
  → extractBrandProfile(llm, corpus)       [gateway/parse failure → "failed", error ≤500 chars]
  → set {status: "ready", profileJson}
```

`extractBrandProfile`: one `llm.generate` with a strict JSON-only prompt naming
every field; response → `match(/\{[\s\S]*\}/)` → `JSON.parse` →
`brandProfileSchema.safeParse`. On any failure, ONE repair retry appending the
raw response and the exact parse/validation error; second failure throws
`BrandExtractError` (recorded by the run as `failed`).

## Tests (before/with implementation)

- contracts: schema accepts a full/minimal profile, rejects an over-long pillar
  list and unknown voice-dimension keys (strict object); statuses fixed.
- api unit: `stripHtml` removes script/style/tags/entities and collapses
  whitespace; `scrapeWebsite` (capturing fixture fetcher) fetches the root,
  follows only same-origin about-ish links (≤4), tolerates per-page failures,
  caps corpus at 20 000 chars.
- api unit: `extractBrandProfile` — clean JSON → profile; fenced/noisy JSON →
  profile; first-bad-then-good (marker stub counting calls) → profile with
  exactly 2 calls; twice-bad → throws.
- api routes: create workspace with `websiteUrl` (fixture fetcher + fake llm) →
  view eventually `ready` with the extracted `businessName`; `refresh` awaited →
  `ready` deterministically; `refresh` on a workspace without `websiteUrl` →
  400; failing fetcher → `failed` with error; `GET` before any run → `none`;
  `PATCH` edits `tone` and persists; `PATCH` while not ready → 409.

## Founder acceptance

With the API running and a real `GEMINI_API_KEY`: create a workspace through
onboarding with a real URL → within seconds
`GET /workspaces/:id/brand-profile` returns `ready` and a populated,
correct-ish profile (name, tone, voice dimensions, pillars) that could be shown
on a verification screen; `POST …/refresh` re-runs it; `PATCH` edits stick.

## Progress log

- 2026-07-07 — Spec written on branch `sprint-36-2-website-scrape` (cut from
  36.1 tip `9e6b9ed`), grounded in a 3-agent parallel codebase survey
  (worker/fetcher architecture, LLM JSON precedents, storage/polling
  conventions). Founder directive: proceed without per-sprint verification;
  all 36.x sprints verified together at the end.
- 2026-07-07 — Implemented TDD: contracts + brand_profiles table/migration
  0031; scrape + extraction services; routes + workspace-create trigger.
  24 new tests (7 contracts + 17 api). Full suite 837/837, typecheck +
  next build green.
- 2026-07-07 — Live smoke with the real Gemini model: created a workspace
  pointed at https://www.anthropic.com → status walked scraping (≈9s) →
  extracting (≈3s) → ready with a plausible, fully-populated profile
  (name, tagline, tone, all seven voice dimensions, 8 pillars). Founder
  verification deferred: all 36.x sprints verified together (founder,
  2026-07-07).
