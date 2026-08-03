# Sprint 58 — Structured Output Migration

> **Phase:** J (Agent Runtime Foundation) · **Direction doc:** Move 7 (consolidation)
> **PRD:** `docs/plans/prd-agentic-platform.md` §5, Sprint 58
> **Branch:** `sprint-58-structured-output-migration` (off `sprint-57-tool-registry-agent-inspector` @ `82e76f1`)
> **Required merge order:** Sprint 56 → Sprint 57 → Sprint 58. 58's hard dependency is 56
> (Gateway v2 `agentStep` + `responseSchema`); it branches off 57's tip because 57 shipped
> the zod→JSON-Schema converter this sprint extends, and the founder merges in order anyway.
> **Size:** L · **Risk:** Low · **Depends on:** 56
> **Status:** see Progress log at the bottom.

**No product behavior change intended.** This is a correctness and code-volume sprint:
every service that needs *structure* from the model stops parsing free text and moves to
schema-constrained generation validated against a zod schema. Parsers are deleted, not
deprecated. A malformed model response surfaces as a typed error with a recorded failure
class — never a silent empty array.

---

## 1. Problem

`generate({prompt}) → {text}` forced every structured consumer into
prompt-assembly-then-parse-text. The repo has accumulated nine hand-rolled LLM text
parsers, each with its own fence-stripping, bracket-hunting, and silent-failure policy:

| Parser | File | Parses |
|---|---|---|
| `parseJsonArray` + legacy fallback in `parseEntryMatches` | `services/matching.ts` | relevance scoring entries |
| (uses the above) | `services/discovery-matching.ts` | batch item scoring |
| (uses the above) | `services/discovery.ts` (`suggestDiscoverySources`) | source proposals |
| `parseJsonArray` (a second, private copy) | `services/mailbox-inbox.ts` | email reply labels |
| `parseReviewOutput` (SCORE:/ISSUES: lines) | `services/review.ts` | reviewer score + issues |
| `parseAngles` (line stripping) | `services/angles.ts` | angle candidates |
| `parseGeneratedVariants` (`---` splitting + label re-parse) | `services/ad-creatives.ts` (called from `routes/ad-creatives.ts`) | ad variant sets |
| `parseProfileText` + a hand-rolled repair retry | `services/brand-profile.ts` | brand profile JSON |
| `parseOutlineSummaries` (SUMMARY n: lines) | `services/brain.ts` | outline summaries |

Plus one free-text call that *should* be constrained but has no parser:
`services/brain-autodraft.ts` (drafts are taken as raw `result.text`, so fenced/preambled
output pollutes brain docs).

Silent-failure examples today: matching returns `[]` on garbage (item scored 0 with no
explanation of why), mailbox items just stay unlabeled, review scores silently become
`null`-and-never-flag.

### PRD-listed files that turn out not to be migration targets

- **`services/carousels.ts`** — contains **no LLM call at all**. `splitIntoSlides` is
  deterministic splitting of *human-approved draft content* (an author-facing `---`
  convention, not model output), and slide templates come from the `DesignProvider`
  daemon, not the gateway. Nothing to migrate; recorded here so the file stops appearing
  on parser inventories.
- **`services/copilot.ts`** (`parseJsonObject`) — deliberately **deferred, not skipped**.
  The copilot loop's contract is "EITHER a JSON tool call OR free prose", which is
  structurally not single-schema-constrainable; its correct migration is to real function
  calling via `agentStep` tools / the AgentRunner, which is the Phase O chat-surface
  refactor (the runner + registry it needs shipped in 56/57). Constraining it now to a
  `{action, tool, args, answer}` envelope would change the prompt protocol and degrade
  prose answers — a behavior change this sprint explicitly avoids. `parseJsonObject` is
  the **one** surviving free-text parser, with a comment pointing at Phase O.

## 2. Scope

**In:**
1. `generateStructured<T>` — one shared helper in `apps/api/src/llm/structured.ts`, with
   `StructuredOutputError` + failure classes.
2. Response-schema support in the zod→JSON-Schema converter (Sprint 57's
   `agents/json-schema.ts` moves to `llm/json-schema.ts`, gaining `nullable` and
   top-level-array support; `agents/` imports update).
3. Zod output schemas for every migrated call site, in `packages/contracts` (the single
   schema home, next to `brandProfileSchema` which already lives there).
4. Migration of all ten call sites listed above; every hand-rolled parser deleted.
5. Prompt-instruction updates in `packages/brain/src/resolver.ts` (angle, both review
   passes, ad-creative) and the affected service prompts: instructions now describe the
   JSON shape instead of line formats.
6. Test updates: canned fake responses move from line formats to JSON; assertions on
   persisted outcomes stay identical (the output-equivalence guard); new
   `llm/structured` unit tests.

**Out (explicitly):**
- `copilot.ts` (§1 above — Phase O).
- Model routing / caching / budgets → Sprint 59.
- Any new HTTP route or UI.
- Retrofitting `AgentRunner`'s terminal `responseSchema` parse to zod validation is **in**
  only as far as reusing the same extraction helper; runner behavior is untouched.

## 3. Design

### 3.1 `generateStructured` (`apps/api/src/llm/structured.ts`)

```ts
export type StructuredFailureClass = "no_json" | "invalid_json" | "schema_mismatch";

export class StructuredOutputError extends Error {
  readonly failureClass: StructuredFailureClass;  // the recorded failure class
  readonly issues: string[];                       // zod issues / JSON.parse message
  readonly rawText: string;                        // final model text, truncated to 2000 chars
}

export interface GenerateStructuredParams {
  prompt: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateStructuredResult<T> {
  value: T;
  model: string;
  provider: string;
  durationMs: number;   // summed across attempts
  repaired: boolean;    // true when the repair retry produced the value
}

export async function generateStructured<T>(
  llm: LlmGateway,
  schema: z.ZodType<T>,
  params: GenerateStructuredParams,
): Promise<GenerateStructuredResult<T>>;
```

Semantics:
- **Transport.** When the gateway implements `agentStep`, call it with
  `{system: "", messages: [{role: "user", content: prompt}], responseSchema, maxOutputTokens, signal}`
  — real constrained decoding on Gemini (`responseMimeType: application/json`). When it
  doesn't (every pre-56 test fake), fall back to `generate({prompt, ...})` — the prompt
  instructions already describe the JSON shape, and validation below is identical. This
  keeps all existing fakes valid with JSON canned text and needs no interface change:
  the helper is a free function *over* `LlmGateway`, not a new interface method, so
  `FallbackGateway`/fakes/OpenRouter need nothing.
- **Extraction, centralized.** Strip markdown fences, then take the substring from the
  first `{`/`[` to its matching last `}`/`]`. This is the **only** place in the codebase
  allowed to be tolerant about LLM JSON framing.
- **Validation.** `JSON.parse` then `schema.safeParse`. Both must pass.
- **One repair retry** (PRD requirement) on any failure class: second call carries the
  previous raw response plus the exact parse/validation error ("Your previous response
  could not be used. Error: … Return ONLY corrected JSON."). Via `agentStep`, the prior
  response rides as an assistant message with the repair as a follow-up user message.
- **Typed failure.** Second failure throws `StructuredOutputError` carrying the failure
  class. `GatewayError`/aborts propagate untouched — transport failure is not a schema
  failure, and existing best-effort catch blocks keep their meaning.
- The failure class is *recorded* on the error object; best-effort call sites that
  persist an error code keep doing so (e.g. discovery matching records
  `matching_malformed_response`), now triggered by `instanceof StructuredOutputError`
  instead of a `null` parse.

### 3.2 Response schemas via the Sprint 57 converter

`agents/json-schema.ts` moves to `llm/json-schema.ts` (the agents module re-imports from
there — `llm` must not import from `agents`). Two exports:

- `jsonSchemaFor(zod)` — unchanged contract: tool inputs, object-rooted, throws on
  unsupported constructs.
- `responseJsonSchemaFor(zod)` — same converter, but the root may be an object **or an
  array**, and `z.nullable()` is supported (emitted as OpenAPI-style `nullable: true`,
  which Gemini's response-schema dialect accepts). Matching needs `personaId: string | null`.

Same philosophy as 57: cover exactly the subset our schemas use, throw loudly on
anything else at composition time.

`gemini.ts` gets one defensive fix: omit `systemInstruction` when `params.system` is
empty (generateStructured passes `system: ""`), instead of sending an empty text part.

### 3.3 Output schemas (`packages/contracts`)

Response shapes stay as close as possible to what the prompts already ask for — that is
what keeps this a no-behavior-change migration and keeps most canned test JSON valid:

| Schema | Shape (top level) | Used by |
|---|---|---|
| `matchingResponseSchema` | `[{index, score, matches: [{personaId: string\|null, campaignId: string\|null, score, reason}]}]` | matching, discovery-matching |
| `emailReplyClassificationResponseSchema` | `[{index, label: EMAIL_REPLY_LABELS enum}]` | mailbox-inbox |
| `sourceProposalsResponseSchema` | `[{type: "google_news"\|"reddit"\|"rss", name, config: {feedUrl?, query?, subreddit?}, reason}]` | discovery `suggestDiscoverySources` |
| `reviewCheckResponseSchema` | `{score: int 0–100, issues: string[]}` | review (both passes) |
| `anglesResponseSchema` | `[string]` | angles |
| `metaAdVariantsResponseSchema` | `{variants: [{primaryText, headline, description}]}` | ad creatives (meta) |
| `googleRsaResponseSchema` | `{headlines: string[], descriptions: string[]}` | ad creatives (RSA) |
| `outlineSummariesResponseSchema` | `[{index: int, summary}]` | brain outline enrichment |
| `brainDocDraftResponseSchema` | `{content: string}` | brain-autodraft |
| `brandProfileSchema` | *(already exists)* | brand-profile |

Length clamps (reason ≤ 500 chars, name ≤ 200, ≤ 5 issues, ≤ 6 proposals) stay where
they are today — post-validation domain code — so an over-long model value is trimmed,
not rejected (same tolerance as before).

### 3.4 Per-site migration

Semantic validation is **not** parsing and is kept everywhere: unknown persona/campaign
ids → null, persona-outside-campaign dropped, top-5 matches, write-time revalidation,
`validateAdCreative` limits, etc.

1. **`matching.ts`** — `judgeSignalMatches` → `generateStructured(matchingResponseSchema)`.
   `parseJsonArray` deleted. `parseEntryMatches` becomes `sanitizeEntryMatches(entry, ctx)`
   over the *typed* entry — the "no `matches` key → legacy top-level personaId/campaignId"
   fallback dies with free text (schema guarantees `matches`). Gateway/structured failures
   keep today's contract (propagate; callers already degrade to empty).
2. **`discovery-matching.ts`** — `runMatchingBatch` calls
   `generateStructured(matchingResponseSchema, {signal: effectiveSignal})`.
   `StructuredOutputError` → `matching_malformed_response` (same retryable path the
   `null` parse used to take); abort/gateway errors → `matching_timeout`/
   `matching_gateway_failed` exactly as today.
3. **`discovery.ts`** — `suggestDiscoverySources` → `generateStructured(sourceProposalsResponseSchema)`;
   keeps `slice(0, 6)`, `r/` stripping, char clamps. On `StructuredOutputError` returns
   `[]` (today's `?? []`), but the route's error path can now distinguish classes later.
4. **`mailbox-inbox.ts`** — `classifyNewItems` → `generateStructured(emailReplyClassificationResponseSchema)`;
   the private `parseJsonArray` copy is deleted; any throw (gateway or structured) leaves
   the batch unlabeled, unchanged.
5. **`review.ts`** — `runCheck` → `generateStructured(reviewCheckResponseSchema)`;
   `parseReviewOutput` deleted. `composeBrandVoiceReviewInstruction` /
   `composeChannelFitReviewInstruction` now ask for `{"score": …, "issues": […]}` (≤ 5
   issues, empty array when none). Best-effort stays: any throw yields the
   `score: null, issues: ["Review unavailable: …"]` result exactly as today.
6. **`angles.ts`** — `generateAngles` → `generateStructured(anglesResponseSchema)` +
   `slice(0, count)`; `parseAngles` deleted; `composeAngleInstruction` asks for a JSON
   array of N one-sentence strings, strongest first.
7. **`ad-creatives.ts`** — `parseGeneratedVariants` deleted. The route calls
   `generateStructured` with the per-taskType schema and a new
   `variantsToContents(taskType, parsed): string[]` serializer (contracts field values →
   `formatAdCreative` canonical text — same stored format, byte-compatible).
   `composeAdCreativeInstruction` describes the JSON shape (limits stay in the prompt;
   `validateAdCreative` still surfaces violations on the stored drafts).
   `generation_unparseable` (502) now fires on `StructuredOutputError` instead of an
   empty variant list. **`parseAdCreative` in contracts survives** — it parses *stored
   human-edited draft text*, not model output.
8. **`brand-profile.ts`** — `extractBrandProfile` → one
   `generateStructured(brandProfileSchema)` call; `parseProfileText` and the hand-rolled
   repair loop deleted (the helper *is* that loop, generalized). `BrandExtractError`
   preserved, wrapping the structured error's class + issues.
9. **`brain.ts`** — `enrichOutlineSummaries` → `generateStructured(outlineSummariesResponseSchema)`;
   `parseOutlineSummaries` deleted; prompt asks for `[{index, summary}]`; best-effort
   fallback-summaries behavior unchanged (structured failure → keep fallbacks).
10. **`brain-autodraft.ts`** — per-doc call → `generateStructured(brainDocDraftResponseSchema)`,
    keeping the five independent calls and per-doc failure isolation (spec 36.4
    decision #2); `drafts[docType] = value.content.trim()`.

### 3.5 Testing

- New `apps/api/test/structured.test.ts`: agentStep path (responseSchema passed through,
  ScriptedGateway), generate-fallback path, fence/noise extraction, repair retry success
  (`repaired: true`), double failure → `StructuredOutputError` with correct class,
  gateway error propagation, nullable + top-level-array schema conversion.
- Existing suites: canned fake text moves to JSON where the format changed (review,
  angles, ad creatives, outlines, autodraft); matching / mailbox / source-proposal /
  brand-profile fakes already return JSON in today's shapes and mostly survive as-is.
  **Assertions on persisted rows / API responses are not weakened or reshaped** — they
  are the output-equivalence guard the PRD asks for.
- Failure-path tests updated for the retry: "malformed" fakes must serve the garbage
  twice (the helper retries once before degrading).

## 4. Step-by-step plan

1. Contracts schemas (§3.3) + `npm run typecheck`.
2. Converter move + `responseJsonSchemaFor` (+ nullable/array) + gemini empty-system fix.
3. `generateStructured` + `StructuredOutputError` + `structured.test.ts` (red→green).
4. Migrate matching → discovery-matching → discovery sources → mailbox-inbox; run their
   suites.
5. Migrate review + angles (+ resolver instructions); run their suites.
6. Migrate ad-creatives (+ instruction + serializer); brand-profile; brain outlines;
   brain-autodraft; run their suites.
7. Grep-sweep: no `parseJsonArray`/`parseJsonObject`-style parsing outside
   `llm/structured.ts` and the documented copilot exception; net line count check.
8. Full `npm test` + `npm run typecheck`; Progress log; push; sync Plane (TAP Sprint 58
   epic: branch, HEAD, awaiting founder merge).

## 5. Acceptance (from PRD)

- [x] Net line reduction across services (`apps/api/src` services+routes: −68 lines;
      every deleted parser gone, not deprecated).
- [x] Zero hand-rolled LLM text parsers remain (documented exception: `copilot.ts`
      pending its Phase O function-calling refactor — annotated in-code; `carousels.ts`
      never had one). Verified by grep sweep: the only `text.match` over model output
      left in services/routes is `copilot.ts`.
- [x] A malformed model response surfaces as a typed error (`StructuredOutputError`
      with failure class), not a silent empty array — proven by the repurposed
      discovery test (retryable `matching_malformed_response`), the ad-creatives
      `generation_unparseable` path (now stores the raw failed output), and the
      suggest-sources 502.
- [x] Shared `generateStructured<T>` with one repair retry and a recorded failure class
      (`no_json` / `invalid_json` / `schema_mismatch`), 11 unit tests.
- [x] Snapshot/equivalence: existing persisted-outcome assertions pass unchanged —
      full suite 2198/2198, typecheck clean.

## 6. Progress log

- 2026-08-03 — Branch created off `sprint-57` tip @ `82e76f1`. Call-site inventory done
  (ten migration targets; carousels has no LLM call; copilot deferred to Phase O with
  rationale). Spec written. Implementation starting.
- 2026-08-03 — Implemented in full: nine response schemas in `packages/contracts`
  (+ `brandProfileSchema` reuse); converter moved to `llm/json-schema.ts` with
  `responseJsonSchemaFor` (nullable + array roots); `llm/structured.ts`
  (`generateStructured`, `StructuredOutputError`, agentStep-preferred transport with
  generate() fallback, centralized JSON extraction, one repair retry); Gemini omits an
  empty systemInstruction. All ten call sites migrated; angle/review/ad-creative
  instructions in `packages/brain` now describe JSON; ad-creatives route stores the raw
  output of a post-repair failure and 502s with the generation id. Test fakes across
  11 files moved to JSON canned responses; persisted-outcome assertions untouched.
  Full suite green: 2198/2198 across 203 files; typecheck clean. Awaiting founder
  review/merge (merge order 56 → 57 → 58).
