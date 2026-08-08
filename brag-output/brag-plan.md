# Brag Plan: Tuezday

## What is this app?

Tuezday is a GTM orchestration platform built on a shared, human-editable "Central Brain" — five plain-English documents (Soul, ICP, Voice, History, Now) that every campaign, channel, and AI generation resolves context from, so marketing and sales work compounds instead of resetting every week.

## The angle

Every GTM tool on the market is a *doing* tool. Tuezday is a *remembering* tool. Its own strategy doc says it outright: **"The product is not 'more AI content.' The product is GTM that remembers."** And that isn't marketing gloss bolted on afterward — `GTM that remembers.` is the literal `<meta description>` in `apps/web/app/layout.tsx` and the tagline in the app sidebar.

So the video is not a feature tour. It is a **loop that closes**. It opens on the actual failure mode — a real, specific sentence from Tuezday's own positioning doc about ads learning something outbound never hears — then reveals the five brain documents, then shows the machinery that makes them binding (context resolver → draft → approval gate), then closes the circle by sending what worked back into the brain.

Specificity comes from putting Tuezday's *real vocabulary and real UI* on screen: the five doc tiles in their real tone colors, the real FlowStrip `soul → icp → voice → now → bundle` with its live token counts, the real approval states `Draft → Pending review → Approved`. Every line of copy in this video is lifted verbatim from the product or its positioning doc. A competitor could not swap their name into it.

## Hook (first 2-3 seconds)

Two lines, stated flatly, one after the other:

> Your ads learned what converts.
> Your outbound never heard about it.

Adapted directly from `product-strategy-and-positioning.md` ("Your ad campaign learns that one pain point converts. Your outbound sequence never sees it."). No logo, no product, no swell — just the problem, stated as fact. The viewer recognizes it instantly because it is their week.

## Key moments (the middle)

- **The reset.** Five channel chips (Content · Ads · Outbound · CRM · PR) each holding a small learned insight — then all five drain to grey at once, under the verbatim line *"Every new campaign starts like none of that happened."*
- **The five documents.** Soul, ICP, Voice, History, Now arrive one by one as real DocTiles in their real tone colors (Soul red, ICP cyan, Voice amber, History green, Now magenta), each carrying a trimmed fragment of its real description. This is the moat and it gets the most screen time.
- **The resolver makes it binding.** The real Brain-hero FlowStrip assembles — `soul → icp → voice → now → bundle`, hairline-connected, live `~tok` counts, the `bundle` node emphasized in accent — under the real resolver promise: *"See the exact context Tuezday would assemble — before any AI sees it."* Then a draft appears and the gate steps `Draft → Pending review → Approved`.
- **The loop closes.** The approved item publishes, and a thin accent path curves *back* into the Now document, which gains an update badge. Real Home-screen language: *"What the brain learned"*, drawn as the app's own LoopGlyph — `signal → change`.

## Outro / punchline

The wordmark, then the product's literal tagline:

> Tuezday
> GTM that remembers.

## User flow worth showing

Entry → key action → result, exactly as the product's own onboarding stages it:

1. **Entry:** `/workspaces/[id]/brain` — *"Everything Tuezday knows about your company — edit it anytime."* Five living documents.
2. **Key action:** `/workspaces/[id]/resolver` — the Context inspector assembles the bundle *before* generation, section by section with plain-English reasons; the operator then approves at `/workspaces/[id]/review`.
3. **Result:** approved → published → the learning loop writes back into Now, surfaced on Home as *"What the brain learned."*

The centerpiece scenes (2, 3, 4) show this flow. There is no marketing page in this app to fall back on, and it doesn't need one — the product's own screens are the strongest material it has.

## Tone

- **Preset:** `polished`
- **Creative direction:** *the memory layer, shown as a loop that closes*
- **Interpretation:** Restraint is the point. This product is not a joke and does not need volume to be interesting — its mechanism is the interesting part. Longer holds, generous whitespace, one idea per scene, soft crossfades. No exclamation marks, no hype metrics, no "10x". The video earns credibility by showing real product vocabulary and letting it sit there. This matches the app's own design posture, which its token file describes as *"editorial GTM control-room typography, cool neutral working surfaces"* and which deliberately ships **no gradients and no 3D**.

## Format: landscape — 1920x1080
## Duration: 22.93 seconds

## Visual identity (from the project)

Verified from `apps/web/app/tokens.css` (header comment: *"derived from tuezdayai.com"*), `apps/web/app/globals.css`, and `apps/web/app/layout.tsx`.

- **Background:** `oklch(0.966 0.005 256)` (near-white cool paper); sunk `oklch(0.944 0.006 256)`
- **Surface (cards):** `oklch(0.995 0.003 256)`
- **Ink:** `oklch(0.205 0.013 264)` · muted `oklch(0.405 0.012 264)` · tertiary `oklch(0.535 0.010 264)`
- **Accent (indigo, `--c5`):** `oklch(0.555 0.150 256)`; deep `oklch(0.485 0.150 256)`; wash `oklch(0.945 0.035 256)`
- **Lines:** `oklch(0.855 0.008 264)`; soft `oklch(0.905 0.006 264)`
- **Doc tone colors (real `data-tone` mapping):** Soul `oklch(0.635 0.190 27)` red · Voice `oklch(0.760 0.150 66)` amber · History `oklch(0.775 0.135 132)` green · ICP `oklch(0.715 0.105 205)` cyan · Now `oklch(0.585 0.175 350)` magenta
- **Status semantics:** ready/green `oklch(0.550 0.130 150)` (ink `oklch(0.390 0.100 150)`, wash `oklch(0.950 0.035 150)`) · attention/amber `oklch(0.730 0.145 66)` (wash `oklch(0.955 0.045 75)`) · progress/blue `oklch(0.620 0.120 230)`
- **Primary button is ink-black**, not indigo: `--button-primary: var(--ink)` with `--button-primary-ink: var(--surface)`. The Approve button must be black-on-white.
- **Display font:** Archivo (500/600/700; `h1` is weight 720, `letter-spacing: -0.02em`; logo weight 760, `-0.03em`)
- **Body font:** Inter (14px, line-height 1.55)
- **Mono font:** JetBrains Mono (500/600) — used for kickers and section labels, uppercase, 10–10.5px, letter-spacing 0.06–0.12em. This is exactly how the app renders overlines, so the video should too.
- **Radii:** 4 / 6 / 9 / 16 / 999px · **Shadow:** `0 1px 2px oklch(0.205 0.020 264 / 0.07), 0 3px 10px oklch(0.205 0.020 264 / 0.05)` · **Ease:** `cubic-bezier(0.23, 1, 0.32, 1)`
- **Strongest visual element:** the **Brain hero FlowStrip** on `/brain` — five tone-colored DocTiles above hairline-connected nodes reading `soul → icp → voice → now → bundle`, each with a live `~{n} tok` count, the `bundle` node emphasized in accent border + wash. It is the product's entire thesis drawn as a diagram, with real numbers. Recreate this faithfully.

## Share copy (draft)

Most GTM tools help you produce more. Tuezday makes sure the next campaign knows what the last one learned — five editable brain docs, every AI call resolved from them, and you can inspect the exact context before any model sees it. GTM that remembers.

## Audio direction

- **Role:** sparse professional accents over a low, steady bed — support, never drive
- **Music:** `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3` (steady and clean; the recommended track for `polished`)
- **Music treatment:** start at 0, volume 0.30, gentle fade-in over 0.6s, fade out under the final wordmark from ~21.5s so the closing line lands in near-silence
- **Music cue guidance:** bundled preset at `assets/music/cues/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`, 109.96 BPM. Strong cues targeted: **9.29s** (brain → resolver turn), **17.47s** (loop closes), **18.56s** (wordmark lands). Beat-grid window for the five sequential DocTiles: 5.34 / 6.00 / 6.56 / 7.09 / 7.64. Beat grid for the three FlowStrip nodes: 10.37 / 10.93 / 11.46.
- **Audio-reactive treatment:** subtle; use music RMS/bass to let the accent wash behind the brain cluster and the final wordmark breathe. No waveform bars, no equalizers, no strobing, no pulsing text.
- **SFX posture:** sparse — 5 cues total, motion-matched, low high-frequency risk, volume 0.55–0.70. This is a restrained business product; the sound should read as expensive, not busy.
- **Audio-coupled moments:** the five DocTiles arriving one by one; the gate landing on `Approved`; the path closing back into Now; the wordmark landing.
- **Restraint rule:** no sound on every element. Nothing comedic, nothing glitchy, nothing that reads as a mobile-game ad. If a cue is not reinforcing a specific motion, cut it.

## Storyboard

### Scene 1 — The forgetting — 4.39s

Near-empty light frame (`--bg`). Two lines of large Archivo display type appear in sequence, left-aligned upper-middle: **"Your ads learned what converts."** holds, then **"Your outbound never heard about it."** lands under it. Below, five small pill chips in mono — `Content` `Ads` `Outbound` `CRM` `PR` — each carrying a faint accent insight dot. At ~3.3s all five dots drain to grey together, and a third smaller line in muted ink appears: *"Every new campaign starts like none of that happened."*
Sequential/interaction: yes — two headline lines land ~1.3s apart, each held ≥1.5s settled; then five chips desaturate together on one beat.
Audio intent: cool and matter-of-fact. The bed has just started; nothing triumphant. The desaturation is the first moment sound acknowledges anything.
Audio-coupled idea: one soft dry cue on the chips draining — a single low `interface/drop` family sound, not a hit.
Music: low steady bed, fading in over the first 0.6s.
Transition mood: soft crossfade → Scene 2

### Scene 2 — The brain — 4.90s

Frame recomposes around a centered cluster. Mono overline: `CENTRAL BRAIN`. Five white DocTiles arrive one by one, each in its real tone color with the real doc name and a trimmed fragment of its real description:
- **Soul** — *what it believes, and what it refuses to be*
- **ICP** — *segments, pains, triggers, and who we are not for*
- **Voice** — *tone, vocabulary, words we never use*
- **History** — *launches, lessons, what worked and what failed*
- **Now** — *what matters this week*

Beneath, settled and held: *"Everything Tuezday knows about your company — edit it anytime."* (verbatim `/brain` subtitle).
Sequential/interaction: yes — five tiles arrive on consecutive beats (5.34 / 6.00 / 6.56 / 7.09 / 7.64, ~0.55s apart) with a soft card cue on the **first and last only**; the full set then **holds on screen until 9.29s**, giving every label ≥1.65s of settled read time. Titles are short labels; the descriptions are secondary and set smaller.
Audio intent: the bed opens up slightly; this is the reveal the whole video is built around.
Audio-coupled idea: card-family SFX on tile 1 and tile 5; the middle three ride the music only.
Music: bed continues, warmer.
Transition mood: clean → Scene 3

### Scene 3 — Resolved, then gated — 5.44s

Two-stage scene, beat-locked at its open (9.29s strong cue).

*Stage A (9.29–12.3s):* the five tiles compress into a narrow left stack, and the real **FlowStrip** draws left to right: `soul` → `icp` → `voice` → `now` → **`bundle`**, hairline connectors, each node with a small `~{n} tok` count, the `bundle` node emphasized with accent border + accent wash. Mono overline `CONTEXT INSPECTOR`. Line held beneath: *"See the exact context Tuezday would assemble — before any AI sees it."*

*Stage B (12.3–14.73s):* a draft card materializes from the bundle node, and the approval gate runs beneath it as real status pills: `Draft` → `Pending review` → **`Approved`**. The final pill lands in the semantic ready-green with its wash, beat-locked to the strong cue at ~13.11s. Small muted line: *"Everything it writes goes through your review — nothing publishes itself."*
Sequential/interaction: yes — three FlowStrip nodes reveal on beats 10.37 / 10.93 / 11.46, then the strip holds complete ≥1.4s; then three gate pills step through with the `Approved` transition beat-locked.
Audio intent: precise and procedural — this is the machinery working, and it should sound competent rather than exciting.
Audio-coupled idea: a very light tick as the FlowStrip completes into `bundle`; one clean confirmation cue exactly when `Approved` lands.
Music: steady, unchanged — let the visual carry.
Transition mood: clean → Scene 4

### Scene 4 — The loop closes — 3.83s

The approved card travels right into a small `Published` marker, then a thin accent path curves **back up and left** into the Now tile, which pulses once and gains a small update badge. The five-doc stack stays visible throughout so the return reads as a *return*. Mono overline `WHAT THE BRAIN LEARNED`, with the app's own LoopGlyph phrasing set beneath in mono: `signal → change`. Held line: *"What worked flows back into the brain."*
Sequential/interaction: yes — one continuous path draw (~1.1s), its arrival into Now beat-locked to the strong cue at ~17.47s.
Audio intent: resolution. This is the emotional payoff of the whole piece — the circle completing.
Audio-coupled idea: one warm bell-family cue at the moment the path lands in Now. Nothing after it.
Music: bed swells very slightly into the arrival.
Transition mood: soft → Scene 5

### Scene 5 — Wordmark — 4.37s

Full-bleed light frame, everything else gone. The **Tuezday** wordmark sets in Archivo at large scale, centered, landing on the strong cue at ~18.56s. Beneath it, after a beat: **"GTM that remembers."** — the product's literal tagline. Both hold in stillness while the music fades from ~21.5s, so the final second is nearly silent.
Sequential/interaction: yes — wordmark lands, tagline fades up ~0.8s later and holds ≥2.4s.
Audio intent: land, then get out of the way. The silence at the end is deliberate and is the last thing the viewer feels.
Audio-coupled idea: one restrained cue on the wordmark landing; nothing on the tagline.
Music: fades to zero across the last ~1.4s.
Transition mood: n/a — end

**Music mood for this video:** steady, clean, low — a bed, not a driver.
**Audio summary:** A quiet, competent bed that starts under a stated problem, opens slightly for the brain reveal, stays procedural through the resolver and gate, swells once as the loop closes, then withdraws entirely so "GTM that remembers." lands in silence.

## Duration check

| Scene | Start | End | Length |
|---|---|---|---|
| 1 — The forgetting | 0.00 | 4.39 | 4.39 |
| 2 — The brain | 4.39 | 9.29 | 4.90 |
| 3 — Resolved, then gated | 9.29 | 14.73 | 5.44 |
| 4 — The loop closes | 14.73 | 18.56 | 3.83 |
| 5 — Wordmark | 18.56 | 22.93 | 4.37 |
| **Total** | | | **22.93s** ✓ (15–25s) |

Scene boundaries at 4.39 / 9.29 / 14.73 / 18.56 all sit on beat-grid points; 9.29, 17.47 and 18.56 are strong cues.

## Copy provenance (every on-screen line is real)

| On-screen line | Source |
|---|---|
| "Your ads learned what converts. / Your outbound never heard about it." | `product-strategy-and-positioning.md` — "Your ad campaign learns that one pain point converts. Your outbound sequence never sees it." |
| "Every new campaign starts like none of that happened." | `product-strategy-and-positioning.md`, verbatim |
| Soul / ICP / Voice / History / Now + descriptions | `packages/brain/src/index.ts` doc definitions |
| "Everything Tuezday knows about your company — edit it anytime." | `/brain` page subtitle, verbatim |
| `soul → icp → voice → now → bundle` | `/brain` Brain-hero FlowStrip, verbatim node order |
| "See the exact context Tuezday would assemble — before any AI sees it." | `/resolver` subtitle ("…for any task — before any AI sees it.") |
| `Draft` / `Pending review` / `Approved` | `/review` `STATE_LABELS`, verbatim |
| "Everything it writes goes through your review — nothing publishes itself." | onboarding draft panel, verbatim |
| "What the brain learned" / `signal → change` | workspace Home zone 3 heading + LoopGlyph, verbatim |
| "GTM that remembers." | `apps/web/app/layout.tsx` metadata description + sidebar tagline, verbatim |
