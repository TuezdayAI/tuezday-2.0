# Hyperframes Composition Brief: Tuezday

## Objective

Create a short launch-style brag video for Tuezday — a GTM orchestration platform whose thesis is that GTM should *remember*. The video must feel like the product: editorial, restrained, control-room-clean. It is a loop that closes, not a feature tour.

## Output

- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 22.93 seconds

## Source Material

- Project root: `/Users/ranjan/Desktop/tuezday-2.0`
- Primary files read: `apps/web/app/tokens.css`, `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, `apps/web/app/workspaces/[id]/brain/page.tsx`, `apps/web/app/workspaces/[id]/resolver/page.tsx`, `apps/web/app/workspaces/[id]/review/page.tsx`, `packages/brain/src/index.ts`, `packages/contracts/src/index.ts`, `product-strategy-and-positioning.md`, `README.md`, `tuezday-dashboard-reel-concept.png`
- Product name: **Tuezday**
- Tagline / strongest claim: **"GTM that remembers."** — this is the literal `<meta description>` in `app/layout.tsx` and the sidebar tagline, not invented marketing.
- Key UI moment to recreate: the **Brain hero** on `/brain` — five tone-colored DocTiles above a hairline **FlowStrip** reading `soul → icp → voice → now → bundle`, each node carrying a live `~{n} tok` count, with the `bundle` node emphasized in accent border + accent wash.
- Copy that must appear verbatim (all sourced — see `brag-plan.md` → Copy provenance):
  - "Your ads learned what converts."
  - "Your outbound never heard about it."
  - "Every new campaign starts like none of that happened."
  - "Everything Tuezday knows about your company — edit it anytime."
  - "See the exact context Tuezday would assemble — before any AI sees it."
  - "Everything it writes goes through your review — nothing publishes itself."
  - "What worked flows back into the brain."
  - "GTM that remembers."
  - Doc names: `Soul` `ICP` `Voice` `History` `Now`
  - FlowStrip nodes: `soul` `icp` `voice` `now` `bundle`
  - Gate states: `Draft` `Pending review` `Approved`
  - Loop glyph: `signal → change`

## Creative Direction

- **Tone preset:** `polished`
- **Creative direction:** the memory layer, shown as a loop that closes
- **Interpretation:** Restraint is the point. Long holds, generous whitespace, one idea per scene, soft crossfades (0.3–0.4s). No hype, no metrics theatre, no exclamation marks. The app itself ships **no gradients and no 3D** by deliberate design decision — the video must honor that. Credibility comes from real product vocabulary sitting still on screen long enough to read.
- **Angle:** Every GTM tool is a *doing* tool; Tuezday is a *remembering* tool. Open on the real failure mode (ads learn something outbound never hears), reveal the five brain documents, show the machinery that makes them binding (resolver → draft → approval gate), then close the circle by sending what worked back into the brain.
- **Hook:** "Your ads learned what converts." / "Your outbound never heard about it." — stated flatly, no logo, no swell.
- **Outro / punchline:** the `t` mark and **Tuezday** wordmark, then **"GTM that remembers."**, held in near-silence.
- **Avoid:**
  - Generic SaaS language ("streamline", "supercharge", "10x")
  - Abstract filler visuals, particle systems, gradient meshes
  - Any visual redesign that contradicts the real token system
  - Dark mode — this product is a light, cool-paper control room

## Visual Identity

Exact values from `apps/web/app/tokens.css` (header: *"derived from tuezdayai.com"*).

- **Background:** `oklch(0.966 0.005 256)`; sunk `oklch(0.944 0.006 256)`
- **Surface (cards):** `oklch(0.995 0.003 256)`
- **Text:** ink `oklch(0.205 0.013 264)` · muted `oklch(0.405 0.012 264)` · tertiary `oklch(0.535 0.010 264)`
- **Accent:** `oklch(0.555 0.150 256)` · deep `oklch(0.485 0.150 256)` · wash `oklch(0.945 0.035 256)`
- **Lines:** `oklch(0.855 0.008 264)` · soft `oklch(0.905 0.006 264)`
- **Doc tone colors:** Soul `oklch(0.635 0.190 27)` · ICP `oklch(0.715 0.105 205)` · Voice `oklch(0.760 0.150 66)` · History `oklch(0.775 0.135 132)` · Now `oklch(0.585 0.175 350)`
- **Ready/green (for `Approved`):** `oklch(0.550 0.130 150)`, ink `oklch(0.390 0.100 150)`, wash `oklch(0.950 0.035 150)`
- **Display font:** Archivo (700/760, letter-spacing −0.02 to −0.03em)
- **Body font:** Inter
- **Mono font:** JetBrains Mono — overlines uppercase 0.06–0.12em tracking, exactly as the app renders kickers
- **Radii:** 6 / 9 / 16 / 999px · **Shadow:** `0 1px 2px oklch(0.205 0.020 264 / 0.07), 0 3px 10px oklch(0.205 0.020 264 / 0.05)` · **Ease:** `cubic-bezier(0.23, 1, 0.32, 1)` → GSAP `power3.out`
- **Primary button is ink-black**, not indigo (`--button-primary: var(--ink)`).
- Fonts must be bundled locally or loaded at page init — no render-time network dependency for required assets.

## Storyboard

Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. **The forgetting** — 0.00→4.39s — two hook lines land; five channel chips drain to grey; "Every new campaign starts like none of that happened."
2. **The brain** — 4.39→9.29s — `CENTRAL BRAIN` overline; five DocTiles arrive one by one on beats, hold as a full set; "Everything Tuezday knows about your company — edit it anytime."
3. **Resolved, then gated** — 9.29→14.73s — FlowStrip `soul → icp → voice → now → bundle` builds with token counts and the accent-emphasized `bundle`; then draft card + `Draft → Pending review → Approved`.
4. **The loop closes** — 14.73→18.56s — approved → `Published`, then an accent path curves back into the Now tile, which gains an update badge; `signal → change`.
5. **Wordmark** — 18.56→22.93s — `t` mark + **Tuezday**, then "GTM that remembers.", held in stillness.

## Audio

- **Audio role:** sparse professional accents over a low, steady bed
- **Audio arc:** starts under a stated problem → opens slightly for the brain reveal → stays procedural through resolver and gate → swells once as the loop closes → withdraws entirely so the final line lands in silence
- **Music:** `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`
- **Music treatment:** `data-start="0"`, volume **0.30**, fade in over the first 0.6s, fade out from ~21.5s to 0 by 22.93s so the outro is near-silent
- **Music cue guidance:** preset at `assets/music/cues/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json` — 109.96 BPM.
  - Strong-cue locks (±0.15s): **9.29s** scene-3 open · **13.11s** `Approved` lands · **17.47s** loop closes into Now · **18.56s** wordmark lands
  - Beat grid (±0.10s) for sequential reveals: DocTiles at **5.34 / 6.00 / 6.56 / 7.09 / 7.64**; FlowStrip nodes at **10.37 / 10.93 / 11.46**
- **Audio-reactive treatment:** subtle. Pre-extracted data is already inlined at `assets/audio-data.js` (`var AUDIO_DATA`, 30fps, 692 frames, 16 bands, plus per-frame `rms`). Drive **only**: the accent wash glow behind the brain cluster (bass, ≤12% swing) and the final wordmark's presence (rms, ≤4% scale). Sample per frame with `tl.call()` in a loop — not a single tween. No waveform bars, no equalizers, no strobing, no pulsing text.
- **Audio-coupled moments:**
  - Scene 1 chips drain (~3.29s) — soft dry reset
  - Scene 2 DocTile 1 (5.34s) and DocTile 5 (7.64s) — card arrivals, first and last only
  - Scene 3 `Approved` lands (13.11s) — clean success confirmation
  - Scene 4 path lands in Now (17.47s) — warm resolution, the emotional payoff
  - Scene 5 wordmark lands (18.56s) — one restrained accent, nothing after
- **SFX selection guidance:** low/medium high-frequency risk only (checked against `sfx-analysis.md`). Already staged in `assets/sfx/`:
  - `impact/impactSoft_medium_000.ogg` (0.12s, warm, **low** risk) — chips drain, vol ~0.45
  - `casino/card-slide-1.ogg` (0.60s, medium) — DocTiles 1 and 5, vol ~0.40
  - `impact/impactBell_heavy_000.ogg` (1.48s, medium) — `Approved`, vol ~0.55
  - `impact/impactBell_heavy_003.ogg` (0.65s, medium) — loop closes, vol ~0.60
  - `interface/bong_001.ogg` (0.12s, warm, **low** risk) — wordmark, vol ~0.50
  - Deliberately excluded: `casino/card-place-*` (high HF risk — too sharp for this tone)
- **Exact SFX choice:** Hyperframes may adjust filenames, timestamps, and volumes to match the implemented animation, keeping the sparse posture (≈6 cues total across 23s).
- **Track allocation:** music at `data-track-index="10"`, SFX ascending from 11. Never share a track index between overlapping audio.
- **Audio files:** already copied into `brag-output/composition/assets/`.

## Hyperframes Instructions

Load the composition-building Hyperframes domain skills — `hyperframes-core` (composition contract + `data-*` timing), `hyperframes-animation` (motion), `hyperframes-creative` (design spec, beats, audio-reactive), `hyperframes-keyframes` (seek-safe keyframes, SVG path draw), and `hyperframes-cli` (lint/check/render). This is the `/brag` workflow — do not enter the `hyperframes` intent interview or the generic product-launch-video route. Prefer native Hyperframes conventions over anything in `/brag`.

Requirements:

- Show at least one real UI element from the source project — the Brain hero FlowStrip and the DocTiles are the mandatory ones.
- Keep all text readable: short labels ≥0.8s settled, sentences ≥0.3s/word (min 1.2s). The hook lines get the most.
- Sequential DocTiles reveal ~0.55s apart but **hold as a complete set until 9.29s**, so no label is ever under-read.
- Total duration exactly 22.93s.
- Structural rules to honor: root carries `data-start="0"`; scene fills go on a full-bleed child, never the composition root; visual clips are direct children of the root with `class="clip"`; animate inner wrappers, never the `.clip` elements themselves; no CSS initial transform paired with a GSAP tween on the same property; one paused timeline at `window.__timelines["main"]`, built synchronously.
- Run `npx hyperframes check` before render — it is brag's single gate.
