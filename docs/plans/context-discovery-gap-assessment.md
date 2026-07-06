# Context & Discovery Gap Assessment — 2026-07-02

Founder-raised gaps, verified against the code on 2026-07-02, plus two founder-requested research deep-dives (context selection, R2R alternatives) completed the same day. Written to stand alone across session resets. Nothing here is implemented yet.

## The three gaps, verified

### Gap 1 — Every prompt carries the whole brain (verified, with nuance)

All generation paths (content, launches, sequences, outbound, PR, signals, replies, ad creatives, review passes) funnel through a single assembler: `resolveContext()` in `packages/brain/src/resolver.ts`. Its output string is sent verbatim as the sole user message (`apps/api/src/llm/gemini.ts` — no system prompt, no second packing layer).

What it does today:

- Concatenates **all five brain docs verbatim** (`resolver.ts:367-382`) — empty docs are skipped, but there is **no relevance filtering, no summarization, no per-doc truncation** anywhere.
- There IS a token budget (`DEFAULT_TOKEN_BUDGET = 8_000`, `packages/contracts`), but its only levers are: trim evidence chunks, then drop `org:history` **whole**, then `channel` whole (`BUDGET_SACRIFICE_ORDER`, `resolver.ts:354`). `soul`/`icp`/`voice`/`now` are never cut — an over-budget bundle is just flagged `overBudget: true` and **sent anyway**.
- Docs can each be `BRAIN_DOC_MAX_CHARS = 50_000` (~12.5k tokens). Five mature docs ≈ 60k+ tokens against an 8k budget: `history` gets silently dropped every time, cost balloons, and the relevant needle is buried.

Upside: the resolver already produces a full per-section **trace** (`{key, layer, included, reason, tokens}`, persisted as `sectionsJson`). A selective layer plugs into exactly one choke point and inherits the inspectability requirement.

Grounding note: dev-DB brain docs are currently empty; the reference draft `soul.md` (repo root) is ~1.7k tokens with 8 clean H2/H3 sections — real docs are heading-structured and section-parseable.

### Gap 2 — Configuration is too thin at persona/campaign/channel level (verified)

| Level | Configurable today | Missing |
|---|---|---|
| Persona | name (≤100), description (≤500), one free-text overlay (≤10k); social-account routing (primary account + `defaultTarget` per channel) | topics/themes, structured drafting rules (tone/format/length/do-not-say), per-channel voice |
| Campaign | objective/kpi/timeframe/audience, pillars (`string[]`, campaign-wide), target channels, personas, one overlay, automation mode + cap, audiences, cadences | per-channel pillars, per-persona campaign guidance |
| Channel | one workspace-global guidance text per channel (`guidance_overrides`, 7 hardcoded enum channels) | persona×channel or campaign×channel scoping; user-defined channels |
| Account (connection) | displayName; persona binding + `defaultTarget` | topic/content profile per account, per-account cadence defaults |

The founder's scenario — "one X account posts about AI/tech, another about consciousness/psychology, each drafting under its own guidelines" — is **unrepresentable**: guidance has no persona or account dimension, and topics don't exist below campaign level. Multi-account plumbing itself is solid (N connections per provider, `persona_social_accounts` routing) — the missing part is the content configuration on top.

### Gap 3 — Discovery matches content to pipelines, then throws the match away (verified)

- `scoreUnscoredItems` (`apps/api/src/services/discovery.ts`) already LLM-scores every discovered item 0–100 **and assigns a best-fit `suggestedPersonaId` + `suggestedCampaignId`** with a reason.
- But `runAutomation` (`apps/api/src/services/automation.ts`) **ignores the mapping entirely**: every signal fans out to every active automated campaign × its channels, and no persona is ever passed. Already logged as `docs/deferred-improvements.md` #11. The suggestions only pre-fill the manual draft form.
- Mapping is single-best-fit and computed once (`isNull(score)` filter — never re-scored when personas/campaigns change). An item relevant to two pipelines reaches at most one.
- `discovery_sources` has **no `connectionId`** — sources are workspace-scoped; "10 Reddit + 5 LinkedIn + 5 X accounts each with their own content lane" has no representation, and dedup is per-source only (`(sourceId, externalId)`), not per-pipeline.
- Source coverage: 8 keyless adapters live (RSS, Google News, Reddit-via-RSS, HN, YouTube, podcast, Google Trends, funding-news). `x`/`linkedin`/`g2`/`capterra` are inert `needs_api_key` stubs; Instagram absent; **no competitor tracking**; discovery never reads the workspace's own connected accounts. Everything runs synchronously on 30-min worker ticks (deferred #8).
- Spec note: `docs/specs/sprint-31-discovery-expansion.md` is what was built (branch `sprint-31-discovery-expansion`, 679 green, 2026-06-24). `docs/specs/sprint-31-discovery-source-expansion.md` is a competing spec that was NOT built — don't plan off it.

## Research deep-dive 1 — The selection paradox: what decides which context a post gets

Founder question: "before drafting we won't exactly know what we need from the brain — we can't send everything, but we can't select either."

**The paradox dissolves once you stop treating all brain content as one kind of thing.** Three observations:

1. **Identity is not information.** `soul`, `voice`, `now`, and the *keyed* overlays (the target channel's guidance, the target persona's overlay, the target campaign's overlay) are constitutional — they apply to every draft by definition and must never compete on a relevance score (they'd lose to any news signal). They just need to be small.
2. **The task descriptor IS the query.** Before drafting we already know: task type, channel, persona, campaign (objective/pillars/audience), and usually the triggering signal (title + summary). That is a rich retrieval query for the *informational* content (`history` sections, long `icp` detail, evidence).
3. **Nothing has to be invisible.** Map-then-zoom: the bundle always includes every doc's **outline** (headings + one-line summaries, maintained at save time), and pulls **full sections** only when they score against the composed query. The model always knows what exists and the drafts never silently lose access to a doc — they lose only the full text of sections that don't matter for this post.

Evidence that this beats send-everything (all primary sources, incl. Gemini 2.5 Flash tested directly):

- Chroma's **"Context Rot"** study (18 models incl. Gemini 2.5 Flash/Pro): focused ~300-token prompts **beat** ~113k-token prompts containing the same relevant facts; even one irrelevant distractor measurably degrades output at all lengths, and degradation is steepest when query↔needle similarity is low (exactly the brand-doc case). https://www.trychroma.com/research/context-rot
- **Lost in the Middle** (Liu et al.): U-shaped attention; middle content underweighted as context grows. https://arxiv.org/abs/2307.03172
- **Irrelevant context actively harms** (GSM-IC, ICML 2023): a single irrelevant sentence degrades reasoning on otherwise-solved problems. https://arxiv.org/abs/2302.00093
- Even with perfect retrieval and position control, padding alone drops performance 13.9–85% (https://arxiv.org/abs/2510.05381). Their mitigation — recite the binding constraints before writing — is essentially the angle/brief step.
- Honest nuance: Databricks found Gemini-family models unusually flat on long-context RAG QA, so 60k tokens won't *collapse* on Gemini — it's just strictly dominated: 5–8× the cost and latency for at-best-equal quality, and the distractor effects still apply per Chroma.
- Competitor check (Jasper/Writer/Typeface/Copy.ai/HubSpot Breeze): all separate a small always-applied voice/identity layer from a retrieved knowledge layer; **none expose per-generation selection reasoning** (Jasper's retrieval is criticized as silent/uninspectable). Tuezday's inspect-before-call trace is a real differentiator.

### The chosen mechanism: three-tier deterministic resolver ("Resolver v2")

`resolveContext(taskDescriptor)` becomes:

- **Tier 1 — Constitutional (always in, never scored):** `soul`, `voice`, `now`, channel guidance for the target channel, persona overlay for the target persona, campaign overlay for the target campaign, task instruction. Kept small via per-doc token-budget warnings in the UI (social enforcement, not truncation). Trace reason: `always: constitutional` / `keyed: channel=linkedin`.
- **Tier 2 — Task matrix (editable data, shipped defaults):** a `taskType × doc → {full | outline | omit}` table with a human-readable reason per cell (e.g. `outbound_email × icp → full`, `linkedin_post × history → outline`, `pr_pitch × history → full`, `reply × icp → omit`). Lives as data (contracts defaults + per-workspace override), so the policy itself is inspectable and founder-editable.
- **Tier 3 — Map-then-zoom:** docs in `outline` mode contribute headings + one-line section summaries (regenerated at doc-save time); sections are scored against a **composed query** (task type + channel + campaign objective/pillars + signal title/summary + chosen angle when present) and the top-k under a per-doc cap are included in full. At this corpus size (≤ tens of k tokens per workspace), **BM25/lexical scoring in-process is sufficient, deterministic, and dependency-free** — no embeddings, no vector store; add embeddings later only if lexical recall measurably fails (log as deferred).
- **Angle-first doubles as the brief:** when the existing Sprint-22 angle step is on, run it against Tier 1 + outlines only (cheap), then feed the chosen angle into the Tier 3 query and re-resolve before drafting. One draft call, optionally one already-paid cheap call. No agentic retrieval (2–5× call cost, non-deterministic, violates inspect-before-call).
- **Ordering & cost:** stable constitutional prefix first (Gemini context caching makes repeated drafts near-free on that block), volatile task/signal material last — matches the lost-in-the-middle U-curve.
- **Learning loop stays advisory:** join `sectionsJson` traces with output ratings to surface per-section acceptance lift as *suggestions* ("this history section appeared in 14 rejected drafts, 0 accepted"), never silent reweighting — preserves reproducibility and the editable canon.

Expected effect: typical bundle ~60k → ~6–12k tokens (≈5× cost/latency cut), quality up (distractors removed), every inclusion/exclusion carries a reason, and the five docs remain untouched canonical markdown.

## Research deep-dive 2 — R2R replacement

R2R is confirmed dormant: last release v3.6.5 (2025-06-06), last commit 2025-11-07, issues accumulating (team pivoted). Survey of alternatives (mid-2026):

- **RAGFlow** (the plan's named backup): healthiest engine (Apache-2.0, 84k stars, weekly releases), real headless HTTP API with hybrid search/rerank/citations/dataset-per-tenant — but requires MySQL + Elasticsearch/Infinity + Redis + MinIO (~3.4 GB image, 16 GB RAM advised). Wrong operational trade for one founder.
- **LlamaIndex.TS archived (Mar 2026)** — the only TS-native framework is dead; no credible new self-hosted engine emerged 2025–26. Ecosystem energy moved to *components* (docling for parsing, Postgres extensions, rerankers).
- **Industry pattern is unanimous:** context-heavy products own the pipeline and rent/embed a store — Notion AI on turbopuffer, Dust on Qdrant, Intercom Fin fully bespoke, Writer's own graph retrieval; Cognee's own defaults are embedded in-process components (SQLite + LanceDB + Kuzu). Nobody serious builds on an off-the-shelf RAG server.
- **DIY honestly evaluated:** Tuezday already owns retrieval policy and rank-blending in `services/evidence.ts`. R2R's remaining contributions are chunk storage + hybrid search (≈100 lines: FTS5 BM25 + sqlite-vec KNN + RRF now; tsvector + pgvector + RRF at the Postgres swap) and file parsing (solve with docling on demand, or defer — most evidence is born-digital text). Managed fallback worth tracking: Gemini File Search (free storage, JS SDK) — fine as an optional tier, wrong as default for a self-host-first product.

**Decision path:** (1) freeze R2R now — no new features against it; `EvidenceStore` is the contract; exit triggers = any security advisory, upgrade incompatibility, or needed bugfix. (2) Build `DbEvidenceStore` on better-sqlite3 (FTS5 + sqlite-vec, embeddings via a new `embed()` on the LLM gateway with Gemini `gemini-embedding-001`). (3) Parity-check against R2R with a golden-query set (same interface, cheap to compare). (4) Cut over via the `buildApp` evidence option, retire the R2R compose stack. (5) Port to pgvector at the Postgres swap; optional reranker seam only if quality demands. (6) Update `oss-integration-recommendations.md`: RAGFlow remains fallback only if heavy messy-PDF parsing becomes core.

## Proposed sprint decomposition (no-compromise ordering)

**Sprint A — Resolver v2: tiered selective context.** Section parser (H2/H3, stable IDs) + save-time outline summaries; Tier 1/2/3 mechanism above; task matrix as contracts defaults + workspace overrides (editable in UI); composed-query BM25 zoom in-process; angle-first wired as the brief; stable-prefix ordering; real budget enforcement; full trace reasons. Touches `packages/brain`, `packages/contracts`, `apps/api`, resolver/brain UI. No new infra, no embeddings.

**Sprint B — Scoped guidance & topics.** Guidance scoped workspace × channel × optional persona × optional campaign (most-specific-wins with trace); persona topics/themes + structured drafting fields; per-account (connection) content profile. Prerequisite for C; feeds Tier 1 keyed lookups and discovery matching.

**Sprint C — Discovery routing that honors the match.** Multi-candidate scoring (item can match several persona×campaign×channel pipelines above threshold); `runAutomation` consumes the mapping (kills deferred #11) and passes persona; re-score on config change; per-pipeline uniqueness + cross-source dedup (URL/content hash).

**Sprint D — Connected-account & competitor sourcing.** `discovery_sources.connectionId` (sources reading through the workspace's own OAuth connections via Nango: X, LinkedIn, authenticated Reddit); competitor-handle tracking; Instagram; queue/back-pressure (deferred #8).

**Sprint E — Own the evidence store.** `DbEvidenceStore` (FTS5 + sqlite-vec + RRF) behind the existing seam; gateway `embed()`; golden-query parity vs R2R; cutover + retire the R2R Docker stack. Independent of A–D; schedule on the R2R exit triggers or convenience.

Order: A first (standalone, biggest cost/quality win). B before C. D after C. E independent. Numbering/slotting into `sprint-guide-21-onward.md` (existing "Sprint 32 RAG hardening" is superseded by E) is a founder call.

## Decisions

1. ~~Integrate a memory framework?~~ **No — build native.** Confirmed by both research passes; Cognee (the founder's "Cognibrain", cloned at `Desktop\Cognee Brain\cognee`) stays a reference architecture and a future candidate for temporal/entity learning-loop memory.
2. Resolver v2 shape: three-tier deterministic mechanism above (BM25 in-process, no vector infra) — **founder sign-off pending**.
3. R2R: freeze now, replace with app-owned store per decision path — **founder sign-off pending**.
4. Sprint order A→B→C→D (+E independent) — **founder sign-off pending; recommend starting with A**.
