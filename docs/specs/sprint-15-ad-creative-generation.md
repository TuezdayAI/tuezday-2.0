# Spec: Sprint 15 — Ad Creative Generation

> Status: built, awaiting founder acceptance
> The brain produces platform-ready ad creative through the same resolve → generate → approve loop every other module uses. Copy only — no image generation this sprint. Two platforms are defined by contract from day one: **Meta** (founder's live account, hooks into Sprint 14 reporting) and **Google RSA** (the format whose hard limits make this slice's constraint machinery earn its keep). Variants are generated **as a set** in one LLM call, land in the existing approval queue as individual drafts, and approved creative exports paste-ready — with the hard guarantee that nothing exported can ever violate the platform's character limits.

## What this slice does

1. **Per-platform task types with hard format constraints.** Two new task types — `meta_ad_creative` and `google_rsa` — with their field shapes and character limits defined once in `packages/contracts` and enforced at every door: generation flags violations, edit refuses them (400), approve refuses them (409). Approved ⇒ valid ⇒ export never needs rework.
2. **Generation through the resolver.** Channel overlay = `ads` (existing guidance), campaign overlay drives the offer/angle (campaign is **required** — ad creative without a campaign is a sandbox toy, not a slice), persona optional, evidence as usual. One LLM call returns the whole variant set so variants are distinct angles, not N independent rolls.
3. **Approval queue reuse, zero schema change.** A variant set = one `generations` row + N `drafts` rows sharing `sourceGenerationId`. No new tables. Drafts carry the canonical human-readable text format (below); the existing approvals page renders them as-is; approve/reject decisions feed the learning loop exactly like content and outbound.
4. **Export.** Per-platform CSV download (Meta: one row per variant; Google RSA: padded `headline_1..15`, `description_1..4` columns) plus per-variant copy-to-clipboard on the page.
5. **Performance next to creative.** Where the set's campaign has linked ad campaigns (Sprint 14), the set shows that campaign's paid totals — the first creative-level feedback surface. Campaign grain; ad/creative-level grain stays out until the metric model grows it.

Founder-visible chain: pick campaign + platform → Generate → a set of variants in the right voice, each with live character counts → edit/approve in place (or in the Review queue) → Export CSV / copy → paste into Ads Manager with zero rework.

## Out of scope

Image/video generation (spike later), pushing creative to the platform via API (Sprint 20 — Native Ads Execution), ad-level/creative-level metrics (Sprint 14's model is campaign-grain; linking a specific variant to a specific platform ad arrives with execution), more platforms (LinkedIn/X ads land behind the same format-spec pattern), editable channel guidance, A/B test orchestration.

## Behavior

### Contracts (`packages/contracts`)

- `TASK_TYPES` gains `"meta_ad_creative"` and `"google_rsa"`. Exported subset `AD_CREATIVE_TASK_TYPES = ["meta_ad_creative", "google_rsa"]` + `isAdCreativeTaskType(t)` guard. The legacy sandbox `ad_copy_variant` is untouched (it remains the unconstrained playground task).
- `AD_CREATIVE_FORMATS: Record<AdCreativeTaskType, AdCreativeFormat>` — the single source of truth for field shapes:

  | | fields | per-field limit | count |
  |---|---|---|---|
  | `meta_ad_creative` | `primary_text`, `headline`, `description` | 125 / 40 / 30 chars | exactly 1 each |
  | `google_rsa` | `headline` ×N, `description` ×N | 30 / 90 chars | headlines 3–15, descriptions 2–4 |

  Meta's limits are the **display-safe** limits (before "…see more" truncation) — Meta's API caps are far higher, but display-safe is what "paste without rework" means. Google's are the platform's hard caps. Each format also carries `label`, `variantCount: { min, max, default } | null` (Meta sets default 3, max 10; Google RSA is `null` — one asset set *is* the variant set, one draft per generation).

- **Canonical text format.** Draft content stays a plain human-readable string (no schema change, approvals page renders it untouched):

  ```
  Primary text: <may span
  multiple lines>
  Headline: <text>
  Description: <text>
  ```

  Google RSA uses numbered labels (`Headline 1:` … `Description 4:`). Parsing: a line matching a known label starts a field; following lines append to it (multi-line primary text works); labels are case-insensitive; content before the first label is a parse error.

- Helpers exported and round-trip-tested:
  - `parseAdCreative(taskType, content)` → `{ fields: { key, index, value }[] }` or `null` when no labels are recognizable.
  - `validateAdCreative(taskType, content)` → `{ ok, violations: [{ field, message }] }` — over-limit chars, missing/duplicate/unknown fields, count out of range, unparseable.
  - `formatAdCreative(taskType, fields)` → canonical text.
- `generateAdCreativesInputSchema`: `{ taskType (ad-creative enum), campaignId (uuid, required), personaId?, variantCount? (int 1–10, Meta only — 400 if sent for google_rsa), tokenBudget?, useEvidence? }`.

### Resolver (`packages/brain`)

- `ResolveInput` gains optional `taskInstruction?: string` — overrides the static `TASK_INSTRUCTIONS` entry for the task section (same trace, reason notes the override). This is how the per-platform constraint block and the requested variant count reach the prompt while staying fully visible in the context trace.
- `TASK_INSTRUCTIONS` gains static defaults for both new task types (used by anything that doesn't pass an override).
- The ad-creatives service composes the instruction from `AD_CREATIVE_FORMATS` — exact char limits, field labels, variant count, "return only the labeled fields, separate variants with `---`" — so the constraints in the prompt and the constraints enforced at the gate are provably the same numbers.

### Endpoints (`apps/api/src/routes/ad-creatives.ts`)

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/ad-creatives/generate` | Validates input (400), campaign must exist (404) and be active (409 `campaign_archived`), persona must exist (404). Resolves context (channel `ads`, composed campaign overlay, evidence) with the composed `taskInstruction` → **one** LLM call → split output on `---` → parse each variant → re-serialize to canonical text → store one generation + one draft per variant (auto-submitted to `pending_review`, like outbound). Returns 201 `{ generationId, drafts: [{ ...draft, violations }] }`. Gateway failure → 502 `generation_failed`. Output with no parseable variant → 502 `generation_unparseable` (generation row still stored for the trace; nothing enters the queue). Variants that parse but break a limit **are** created, flagged via `violations` — the approve gate keeps them from going anywhere until edited. |
| `GET /workspaces/:id/ad-creatives` | Variant sets, newest first: drafts with ad-creative task types grouped by `sourceGenerationId` → `{ generationId, taskType, campaignId, campaignName, personaId, createdAt, drafts: [{ ...draft, violations }], adMetrics }`. `adMetrics` reuses Sprint 14's `getCampaignAdMetrics` for the set's campaign (`null` when nothing linked). |
| `GET /workspaces/:id/ad-creatives/export.csv?taskType=&campaignId=&state=` | `state` defaults to `approved` (400 on unknown). Meta: `campaign,primary_text,headline,description,state`, one row per draft. Google RSA: `campaign,headline_1..headline_15,description_1..description_4,state`, padded. Unparseable drafts (possible only in non-approved exports) are skipped. Standard `csvField` escaping, attachment filename `tuezday-ad-creatives-<taskType>-<state>.csv`. |

### Approval gate format enforcement (`apps/api/src/routes/drafts.ts`)

For drafts whose `taskType` is an ad-creative type:

- `edit` → content must validate → otherwise 400 `format_violation` with the violation messages (an edit can never *introduce* a violation).
- `approve` → content must validate → otherwise 409 `format_violation`. Combined with edit-validation this is the hard guarantee: an approved ad-creative draft is always platform-valid.
- `reject`/`resubmit` unchanged. Non-ad-creative drafts: nothing changes.

`draft.approved` / `draft.rejected` events fire as usual — no new event types.

### Web

- **`/workspaces/[id]/ad-creatives`** (new page, nav: child of **Campaigns**, next to Ads):
  - Generate panel: campaign select (required), platform select (Meta / Google RSA), persona select, variant count (Meta only), Generate.
  - Sets, newest first: platform + campaign + persona + when; per-variant card with parsed fields, **live character counters** (`97/125`), violations highlighted; field-level editor (serializes back to canonical text → existing draft `edit` endpoint, resubmit + approve/reject buttons per state); copy-to-clipboard per variant.
  - Per-set "Paid performance" chip when `adMetrics` is non-null (spend / impressions / clicks / conversions all-time, linking to the Ads page).
  - Export bar: platform + state → CSV download.
- **Sandbox page**: the two ad-creative task types are filtered out of the task-type dropdown (sets belong to the ad-creatives flow; the playground keeps `ad_copy_variant`).
- **Approvals page**: no changes — ad-creative drafts appear with their canonical text, which is designed to be readable there. A 409 on approve surfaces the format violation message like any other API error.

## Automated verification

- **Contracts:** new task types present; format table shapes (limits exactly 125/40/30 and 30/90, counts 3–15/2–4, Meta default 3); parse → format round-trip; multi-line primary text; case-insensitive labels; validation catches over-limit, missing field, too few/many headlines, duplicate index, unknown label, garbage; `generateAdCreativesInputSchema` (campaign required, variantCount bounds, google_rsa + variantCount → reject).
- **API (fake LLM):** generate creates 1 generation + N pending drafts sharing `sourceGenerationId` with correct taskType/channel/campaign/persona; variant count honored in the prompt; campaign required/404/409-archived, persona 404; over-limit fake output → drafts created with violations flagged; unparseable fake output → 502, no drafts; edit with over-limit content → 400 `format_violation`; approve of an invalid draft → 409 `format_violation`; valid edit → resubmit → approve works; sets endpoint groups + orders + includes violations; `adMetrics` non-null when the set's campaign has a linked ad campaign with metrics (seeded via the Sprint 14 CSV import), null otherwise; export defaults to approved-only, escapes correctly, Google RSA columns padded, non-ad-creative drafts never leak in.
- **Resolver:** `taskInstruction` override replaces the task section content and shows in the trace; static defaults exist for both new task types.

## Founder acceptance checklist

1. Ad creatives page → pick your campaign + **Meta** + persona → Generate → 3 distinct variants appear, in the workspace voice, every field within its counter.
2. Push a field over its limit in the editor → save is refused with the exact violation; fix it → resubmit → approve.
3. Try to approve a flagged variant untouched (if generation ever over-runs a limit) → Tuezday refuses; after an edit it approves.
4. Variants also appear in **Review & approve** alongside everything else; approving there works identically.
5. Export CSV (approved) → open it → paste into Ads Manager with zero rework. Copy-per-variant also pastes clean.
6. Generate a **Google RSA** set → 15 headlines ≤30 chars, 4 descriptions ≤90 → export → columns match the editor sheet shape.
7. With your Meta ad campaign linked (Sprint 14) to the same Tuezday campaign → the set shows the "Paid performance" chip with real spend next to the creative.
