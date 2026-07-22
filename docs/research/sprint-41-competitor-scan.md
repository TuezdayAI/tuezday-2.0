# Sprint 41 Competitor Scan — Design Layer, Carousels & Ad Images

Research date: 2026-07-09. Method: parallel web research across five angles (carousel generators, ad-creative generators, template-render APIs, brand-kit norms, UX/content heuristics), sources cited inline. Claims that could not be confirmed against a primary source are marked *(unverified)*.

Context: Tuezday's Sprint 41 design layer = per-workspace `design_systems` markdown doc (palette/typography/spacing) + agent-authored cached HTML/CSS slide templates + deterministic Playwright text-into-template PNG rendering + Instagram carousel / Meta ad publishing behind the approval gate, metered by plan credits.

---

## 1. AI Social Carousel Generators

**Predis.ai** — Business-oriented, credit-metered (15 credits/slide) generator with the fullest brand kit in the segment: logo, brand colors + gradients, fonts, preferred templates, and brand tone/voice/language, set once and auto-applied to everything. Its standout feature is user-authored "AI-editable" templates: build a template in a blank editor (or import from Canva/Figma/Adobe) and mark it as a shell the AI populates — the closest commercial analogue to Tuezday's cached-template model. Input is a short text description (blog-URL input on higher plans); slide archetypes are implicit in templates, not named. Free tier is watermarked with no commercial rights. ([predis.ai/features](https://predis.ai/features/), [pricing](https://predis.ai/pricing/))

**ContentDrips** — LinkedIn/Instagram carousel tool with the cleanest dual brand model: a *personal branding block* (name, headshot, handle — stamped top-left on every slide) plus a *business brand kit* (logo, colors, fonts). 1,000+ whole-carousel templates at 1080x1350/1080x1080; input = topic, blog URL, or YouTube link; text-to-carousel splits on an explicit `---` delimiter with a manual "add slide" escape hatch; recommends 40–60 words/slide. Notably it also sells a **render API** (templates with placeholder fields for name/handle/avatar/content; carousel = 10 credits) — a programmatic pipeline much like Tuezday's. ([contentdrips.com/carouselmaker](https://contentdrips.com/carouselmaker/), [api](https://contentdrips.com/api/), [pricing](https://contentdrips.com/pricing/))

**aiCarousels** — Freemium personal-brand tool with the widest input set: topic, pasted text, website URL, YouTube video, or PDF → carousel in one click. Curated color-palette + font-pairing combos rather than a full brand manager; "Smart Auto-Resize" keeps text fitting as length changes; distinct intro/outro slide types, built-in swipe arrows and per-slide counters ("2/8"). Best-in-class per-slide text micro-actions: improve / rephrase / make shorter / simplify per text block. Free tier watermarked; PRO ~$15/mo, up to 20 slides/carousel. ([aicarousels.com](https://www.aicarousels.com/), [editor walkthrough](https://fernandopessagno.medium.com/a-step-by-step-guide-to-using-aicarousels-com-deeb327cda3a))

**Taplio** — Free-standalone LinkedIn carousel maker (watermarked unless subscribed; main product $39–199/mo). Lightweight personal branding (photo, name, handle) + theme colors. The only tool that surfaces **named slide roles in the UI** — "tl;dr slide" and "Outro slide" — and prompts a strong CTA + handle/headshot on the last slide. Repurpose mode turns a tweet/thread/Reddit post into slides; exports PDF at 1080x1350 (default) or 1080x1080. ([taplio.com/carousel](https://taplio.com/carousel))

**Supergrow** — LinkedIn content platform ($19–139/mo, no credits; carousels Pro-only) with workspace-level brand kits (hex colors, fonts + weights, logos; multiple kits for agencies; one-click rebrand of a whole carousel). 50+ templates categorized by content type (thought leadership, frameworks, case studies, lists); users can save their own carousels as reusable templates. Differentiators: publishes carousels **natively as LinkedIn documents** (no PDF dance) and has a built-in team approval workflow — the only competitor with an approval gate. ([supergrow.ai carousel maker](https://www.supergrow.ai/features/linkedin-carousel-maker), [pricing](https://www.supergrow.ai/pricing))

**Ocoya** — Weak fit: it's a scheduler + AI copywriter + Canva-integrated editor; carousels are just multi-photo posts you attach manually — no text-to-slides pipeline, no structured brand kit. Credit-priced ($15–159/mo, ~1 credit/generation). Useful only as evidence that scheduling-first tools don't own this design problem. ([ocoya.com/pricing](https://www.ocoya.com/pricing), [help doc](https://help.ocoya.com/en/articles/8554291-how-to-create-a-carousel-multi-photo-post-for-instagram))

**Simplified** — All-in-one design suite whose carousel generator sits on a full brand-asset manager (logo, palette, fonts; can ingest an uploaded *brandbook* to auto-apply brand; stamps URL/handles on every slide). Input = prompt, pasted text, or full articles; enforces **character limits per slide** "for the best visual layout"; AI image generation for slide art; built-in scheduler for LinkedIn/Instagram/TikTok. Free-forever tier; AI-credit system on paid tiers. ([simplified.com/ai-carousel-generator](https://simplified.com/ai-carousel-generator), [features](https://simplified.com/ai-carousel-generator-features))

## 2. AI Ad Creative Generators

**AdCreative.ai (Semrush)** — Onboards a brand by scraping a URL ("Import Brand": name, logos, colors, fonts auto-extracted) or manual entry; brand entity ≈ logo(s), ~3 colors, ~2 fonts, description, connected ad accounts. Generates large batches (10–50 variants varying copy/layout/color/composition), each stamped with a 0–100 "conversion score" plus saliency heatmaps and point-valued suggestions ("+10: change button color"). Sizes chosen at generation time (1080x1080, 1080x1920, 1200x628). Pricing is credits-per-*download* — generation is free, you pay to take the asset out. Direct push to Meta/Google/LinkedIn. ([adcreative.ai/creative-scoring](https://www.adcreative.ai/creative-scoring), [semrush KB](https://www.semrush.com/kb/1424-adcreative-ai))

**Creatopy (rebranded "The Brief")** — The master-template + auto-resize philosophy: design once, AI Smart Resize adapts it to 50+ preset sizes (1:1, 4:5, 9:16, 16:9, IAB display) preserving layout; batch-edit 100 ads at once. Brand kit is richer than most: colors, fonts, logos, typography hierarchies, spacing guidelines, approved messaging frameworks, brand voice for AI copy in 30+ languages. Feed-driven variants (CSV row → ad) at 10,000+ combinations. No creative scoring. Seat + credit hybrid pricing. ([thebrief.ai/ad-studio](https://www.thebrief.ai/ad-studio/))

**Celtra** — Enterprise creative-automation platform; brand enters via designer-built **Toolkits**: master templates with locked/unlocked elements, so marketers can only edit within approved boundaries — the strongest "guardrails not freedom" pattern in the scan and philosophically closest to Tuezday's cached-template + approval-gate approach. ML "Auto-Sizes" computes the minimum set of master layouts needed to cover a whole size matrix; automated text treatment (line-break rules for 30+ languages, orphan/widow control). Variants = template x placements x sizes x markets x feed rows. Sales-led pricing. ([celtra.com toolkits](https://celtra.com/blog/creative-automation-for-marketing-teams-reimagining-campaign-workflow-with-toolkits/), [design automation](https://celtra.com/blog/supercharging-creative-production-with-advanced-design-automation/))

**Pencil (Brandtech)** — Manual brand kit (logos, fonts, colors, description + 3–5 example images/videos so models learn the brand); Enterprise adds *lockable* brand controls (fonts, colors, tone, claims) — locking tone/claims is a pattern worth noting for brain overlays. Signature is "Predictive Scoring": a relative per-variant rank (trained on pooled + first-party ad performance) used to cull the bottom ~30% of a batch before testing, not a calibrated forecast. Generation-quota pricing ($14–55/mo, 50–250 generations). ([trypencil.com/the-platform](https://trypencil.com/the-platform), [for-enterprise](https://trypencil.com/for-enterprise), [pricing](https://trypencil.com/pricing))

## 3. Template-Render APIs

**Bannerbear** — Visual editor → every layer is an API-addressable named object. Richest layer taxonomy: text, image, rects/circles, SVG, bar/line charts, star ratings, QR/barcodes. Substitution = `modifications` array keyed by layer name (`text`, `color`, `image_url`, `hide`, `shift_x/y`, ...). Per-layer **Text Fit** (auto shrink/grow to box) + Truncate + Line Clamp. **Template Sets**: one payload renders the same design across N sizes (layer names shared). Async by default; signed URLs for stateless GET rendering. $49/mo per 1,000 credits (1 image = 1 credit), hard cap. ([developers.bannerbear.com/v2](https://developers.bannerbear.com/v2/), [text fitting](https://www.bannerbear.com/help/articles/23-text-fitting/), [pricing](https://www.bannerbear.com/pricing/))

**Placid** — Same named-layer model; layer types: text, picture (image/screenshot/video), shape, browserframe, barcode/QR, rating, subtitle. Unspecified properties fall back to template defaults. Four text modes with **Fit (auto-shrink) as the default**, plus single-line/clamp ellipsis. URL API with bracket notation, cached after first render. Credits: image=1, PDF page=2, 10s video=10; quotas 500–100k/mo, no overage (generation stops), watermarked previews are free and unlimited. ([placid.app/docs layers](https://placid.app/docs/2.0/rest/layers), [text modes](https://placid.app/help/add-and-edit-text-elements-in-your-template), [pricing](https://placid.app/pricing))

**Templated.io** — Bannerbear-alike at lower prices ($29/mo per 1,000 credits); differentiators: **Canva import** (public Canva link → reconstructed layered template in ~60–90s), AI template generation from prompts, synchronous rendering (~2s), and per-render geometry overrides (x/y/width/height per layer). Formats: jpg/png/webp/pdf/mp4/html. ([templated.io/docs/renders/create](https://templated.io/docs/renders/create/), [Canva import](https://templated.io/blog/how-to-import-canva-templates-directly-into-templated-for-automation/), [pricing](https://templated.io/pricing/))

**htmlcsstoimage.com (HCTI)** — The existence proof for Tuezday's exact architecture: raw HTML/CSS templates + **Handlebars placeholders** (`{{title_text}}`) rendered in headless Chrome. Templates are **versioned** (render pins latest or a specific `template_version`). No layer semantics or text-fit — pure CSS. Size is per-request viewport, so one responsive template covers multiple ratios. Cheapest per render (~$0.007–0.014/image; $14/mo per 1,000, metered overage $10/1,000); rendered images get permanent CDN-cached URLs. ([docs templates](https://docs.htmlcsstoimage.com/getting-started/templates/), [API](https://docs.htmlcsstoimage.com/getting-started/using-the-api/), [pricing](https://htmlcsstoimage.com/pricing))

**Canva Connect API** — Consumes, does not author: Brand Templates designed in Canva expose declared "data fields" (text, image-by-asset-id, chart); `POST /autofills` is an async job returning a new *design*, then a separate async export job (PNG/JPG/PDF/MP4, download URLs expire in 24h). Both developer and end user must be on **Canva Enterprise**, and public integrations need Canva review — high friction; a source of templates, not a render competitor. ([canva.dev autofill guide](https://www.canva.dev/docs/connect/autofill-guide/), [exports](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/))

## 4. Brand-Kit Field Norms

**Canva Brand Kit**: logos (multiple variants, no role labels) · named color palettes of hex/CMYK swatches (no semantic roles; position implies importance) · font roles **heading / subheading / body / quote / caption** · **Brand Voice as free text, 500-char limit**, consumed by Magic Write · asset buckets (photos/graphics/icons + custom) · Brand Controls: restrict pickers to brand colors/fonts, require approval before publish, element locks on templates. ([canva.com/help/brand-kit](https://www.canva.com/help/brand-kit/), [brand-voice](https://www.canva.com/help/brand-voice/), [brand-control](https://www.canva.com/help/brand-control/))

**Figma variables / W3C DTCG (stable 2025.10)**: variables typed color/number/string/boolean in collections with **modes** (light/dark = one value per mode) and aliasing for primitive → semantic tiers. DTCG token types: color, dimension, fontFamily (fallback array), fontWeight, duration, plus composites (typography = family/size/weight/lineHeight/letterSpacing; shadow; border). Naming convention: primitive (`blue-500`) → semantic (`color-text-primary`, `surface`, `on-primary`) → component tokens; **Material 3's `on-X` convention** ("color for content placed on X") is the key portable idea for auto-contrast. ([designtokens.org format](https://www.designtokens.org/tr/drafts/format/), [M3 color roles](https://m3.material.io/styles/color/roles), [Figma variables](https://help.figma.com/hc/en-us/articles/14506821864087))

**Others**: Adobe Express (logos w/ variants, 3–5 core colors, heading+body fonts, graphics bucket); Looka (kit *derived from the logo*: extracted colors, suggested font pairings, auto-generated guidelines doc); Frontify (typed guideline blocks incl. free-text tone of voice; standardizes color hierarchy as **primary / secondary / accent / background**).

### Table: Brand-kit fields across tools

| Field | Canva | Adobe Express | Predis | ContentDrips | Supergrow | AdCreative | Pencil | DTCG/Figma | Tuezday DESIGN.md should have |
|---|---|---|---|---|---|---|---|---|---|
| Logo + variants | Y (multi) | Y (multi) | Y | Y (paid) | Y | Y (scraped) | Y | n/a | Y — light/dark variants noted |
| Color palette (hex) | Y (no roles) | Y (3–5) | Y (+gradients) | Y | Y | ~3 colors | Y | primitive tokens | Y |
| Semantic color roles | N | N | N | N | N | N | N | **Y** (primary/on-primary/surface/text/accent) | **Y — differentiator** |
| Font roles | heading/sub/body/quote/caption | heading+body | Y | Y | Y (+weights) | ~2 fonts | Y | typography composite | heading + body (+weights, fallbacks) |
| Spacing/radius/shadow | N | N | N | N | N | N | N | Y (dimension tokens) | Y (scale + radius + shadow) |
| Voice/tone free text | **Y (500 chars)** | N | Y (tone/language) | N | N | description | Y + lockable claims | n/a | lives in `voice` brain doc — link, don't duplicate |
| Personal block (name/handle/headshot) | N | N | N | **Y** | N | N | N | n/a | Y — optional, feeds CTA/footer |
| Do/don't usage rules | locks | N | N | N | N | N | locks (enterprise) | n/a | Y — free-text "never do" list |

## 5. Slide Archetypes & Carousel Structure

Nearly every tool teaches **hook → body → CTA** but bakes archetypes into templates implicitly; only Taplio (tl;dr, outro) and aiCarousels (intro/outro) surface named slide types. **An explicit slide-archetype vocabulary is an open differentiator.**

### Table: Common slide archetypes

| Archetype | Purpose / conventions | Seen in |
|---|---|---|
| **Hook / cover** | 5–8 word headline, largest text on deck; curiosity gap or numbered promise ("7 ways to…"); swipe cue (arrow / "swipe →" / peek of next slide); sets the carousel's aspect ratio | All tools implicitly; hook conventions per Hootsuite/Buffer guides |
| **List / numbered item** | One idea per slide, big index number, 15–30 words body | ContentDrips, Supergrow ("lists" category), template norms |
| **Quote** | Large quotation + attribution; quote font role exists in Canva kits | ContentDrips quote cards, Canva |
| **Stat / big number** | One oversized metric + one-line context | Ad tools + carousel template galleries |
| **Framework / diagram-lite** | Titled 2–4 step structure per slide | Supergrow "frameworks" category |
| **Body / text** | Heading + 15–30 words (hard cap ~50–60; ContentDrips allows 40–60); min ~40px text on 1080px canvas, max 2 fonts | Universal |
| **tl;dr / summary** | Mid/late-deck recap slide | Taplio (named in UI) |
| **CTA / outro** | Follow/save/share ask ("Save this post" is highest-value — carousels saved ~2x more, Buffer); handle + headshot + logo block; strongest branding on deck | Taplio outro, aiCarousels outro, ContentDrips |
| **Cross-slide furniture** | Slide counter ("2/8"), swipe arrow, persistent author strip (avatar+name+handle top-left), page-edge branding | aiCarousels counters/arrows, ContentDrips author strip |

**Structure norms**: Instagram allows 20 slides (2024 change) but 5–10 is the recommended band, 8–10 the educational sweet spot; engagement is front-loaded (slides 1–3), so lead with the hook. Meta ads carousels: **2–10 cards, all one aspect ratio**. Splitting heuristics: one idea per slide; ~15–30 words body copy target; ContentDrips exposes an explicit `---` delimiter as a manual override — a cheap, good escape hatch. ([Hootsuite](https://blog.hootsuite.com/instagram-carousel/), [Buffer](https://buffer.com/resources/do-instagram-carousels-get-more-engagement/), [Meta ads guide](https://www.facebook.com/business/ads-guide/update/carousel))

**Aspect ratios**: minimal viable preset set = **1080x1080 (1:1), 1080x1350 (4:5), 1080x1920 (9:16)**. 4:5 is the organic-engagement default; 1:1 is the safest cross-placement ad default (4:5 can be center-cropped to 1:1 in some placements). 2025 grid change: profile grid previews are 3:4 center-crops of 4:5 posts — keep hook headlines inside a centered 3:4 zone. 9:16 safe zones: ~14% top unsafe, **~35% bottom unsafe on Reels** (design to the tighter Reels spec and it's safe everywhere). Meta's 20% text rule was removed in 2020 but Meta still advises <20% text coverage performs better — a soft warning, not a block. ([Meta specs](https://www.facebook.com/business/help/1114358518575630), [safe zones](https://blog.adnabu.com/meta-ads/meta-safe-zones/), [SEJ on text rule](https://www.searchenginejournal.com/facebook-removes-the-20-text-limit-on-ad-images/381844/))

## 6. UX Patterns Worth Stealing

1. **Per-slide text micro-actions** (aiCarousels): shorter / rephrase / simplify / regenerate per slide — coarse whole-deck regenerate is a separate action. No tool verified to regenerate one slide *with deck-coherence context* — open differentiator that Tuezday's context resolver can win.
2. **Persistent author/brand strip** (ContentDrips): avatar + name + handle rendered on every slide from brand settings; stronger identity block on the outro.
3. **Explicit split delimiter** (ContentDrips `---`) as an override on top of AI splitting.
4. **Named-layer modifications contract** (Bannerbear/Placid): `{layerName: {text | image_url | color | hide}}` is the de-facto industry vocabulary — worth mirroring in template briefs/render params for future portability.
5. **Text-fit as a per-slot mode** (Bannerbear/Placid default): auto-shrink-to-fit + line-clamp. In HTML/CSS this is a small deterministic algorithm (binary-search font-size or clamp + character budgets enforced at generation time — Simplified enforces per-slide character limits at the *writing* step, which is cheaper than fitting at render).
6. **Template sets** (Bannerbear): same layer names across sizes → one payload renders all ratios.
7. **Template versioning** (HCTI): renders pin a `template_version`; cached templates should be immutable-by-version so approved creatives are reproducible.
8. **Guardrails not freedom** (Celtra toolkits, Pencil brand locks, Canva Brand Controls): lock brand-critical elements; let generation vary only copy/imagery. Tuezday's cached templates + approval gate already embody this — lean into it as positioning.
9. **Credits charged on output, not attempts** (AdCreative charges per download; Placid gives unlimited watermarked previews): meter renders/publishes, keep previews cheap or free so iteration doesn't feel taxed.
10. **Swipe preview**: every carousel tool previews slides as a horizontally swipeable strip at platform aspect ratio; Supergrow adds duplicate/delete/reorder per slide in one click.

---

## Recommendations for Tuezday Sprint 41

Ranked by impact-per-effort; all fit the existing plan (design_systems markdown + overlays, cached HTML/CSS templates, deterministic Playwright render, approval gate). No scope expansions.

### Tier 1 — low effort, high impact (do these)

1. **Define an explicit slide-archetype enum in `packages/contracts`**: `hook | body | list_item | stat | quote | framework | tldr | cta`. Template briefs request one HTML/CSS layout per archetype; the carousel planner outputs typed slides. Nobody in the market exposes this cleanly (only Taplio names two roles) — it's cheap, on-architecture, and a real differentiator. It also makes per-slide regenerate trivially safe (regenerate a `stat` slide as a `stat` slide).
2. **Bake hook/CTA conventions into the template-authoring brief**, not just prompts: hook = 5–8 word max headline slot + swipe cue element; CTA = handle/logo block + save/follow ask; every slide gets a slide-counter slot ("2/8") and optional persistent author strip. These are furniture in the HTML, so they're deterministic and free at render time.
3. **Ship a starter DESIGN.md skeleton informed by brand-kit norms** (auto-drafted like the brain docs): logo (+ light/dark variant notes) · palette as **semantic roles** — `primary`, `on-primary`, `background`, `surface`, `text`, `accent` (Material-style `on-X` gives you auto-contrast rules no consumer brand kit has) · typography as `heading` + `body` families with weights and fallback stacks · spacing scale + corner radius + shadow · a "never do" list (Celtra/Canva lock analogue, as prose). Keep voice/tone in the existing `voice` brain doc and reference it — don't duplicate (Canva's 500-char voice field validates free-text voice feeding AI).
4. **Word-budget the splitter, don't text-fit the renderer**: enforce per-archetype character/word budgets at generation time (hook ≤ 8 words; body 15–30 words, hard cap ~50; one idea per slide; default 6–10 slides, max 20 IG / 10 Meta-ads cards). Add a single CSS `line-clamp` fallback in templates as the safety net. This is Simplified's approach and avoids building Bannerbear-style text-fit machinery.

### Tier 2 — moderate effort, high impact

5. **Aspect-ratio presets via responsive templates, not per-size templates**: author each template's CSS responsively and render at `1080x1080`, `1080x1350`, `1080x1920` by changing the Playwright viewport (HCTI's model). Store the preset on the render record. Default 4:5 for organic IG, 1:1 for Meta ads (cross-placement-safe). Keep hook headline inside a centered 3:4 zone (2025 grid crop) — a CSS padding rule in the brief.
6. **Version cached templates and pin renders to a version** (HCTI pattern): `template_id + version` on every render so an approved creative is exactly reproducible and template regeneration never mutates approved output. Fits the deterministic-render goal and the approval gate.
7. **Per-slide regenerate with deck context**: expose `regenerate slide N` where the LLM call receives the whole deck plan + the slide's archetype + word budget. No competitor verified to do context-aware single-slide regeneration — Tuezday's context resolver makes this nearly free.
8. **Safe-zone + text-coverage lint as soft warnings in review**: for 9:16 renders, warn if text slots intrude on top ~14% / bottom ~35% (Reels-grade spec covers everything); for ad images, a soft "<20% text area recommended" note (rule removed 2020, still a performance heuristic). Implement as static checks on template geometry, not image analysis.

### Tier 3 — nice-to-have polish (only if time remains)

9. **`---` manual split override** when a user pastes long text for a carousel (ContentDrips pattern) — a few lines in the splitter.
10. **Meter on publish/export, not preview** (AdCreative/Placid pattern): if credit pressure is felt, make low-res previews cheap/free and charge full credits on approved render/publish. If plans ever include a free tier, watermark bottom-corner (universal free-tier norm).
11. **Named-slot vocabulary in template briefs** mirroring Bannerbear/Placid (`headline`, `body`, `image`, `accent_shape`, `logo`, `counter`) so a future migration to/from commercial render APIs, or a Canva/Templated import path, stays cheap.

### Explicitly not recommended for Sprint 41

- Creative scoring (AdCreative/Pencil) — needs performance-data volume Tuezday doesn't have; the learning loop already covers the feedback direction.
- Master-template auto-resize engines (Creatopy/Celtra) — responsive CSS + three viewports covers the need.
- Visual template editor / Canva or Figma import — Predis/Templated prove demand, but it's a different product surface; the agent-authored brief is the moat.
- User-facing brand-asset libraries (photos/graphics buckets) — out of scope; logo + palette + type is enough for v1.
