---
name: Tuezday Platform
description: Product UI for GTM that remembers what it learned.
colors:
  canvas: "oklch(0.966 0.005 256)"
  canvas-sunk: "oklch(0.944 0.006 256)"
  surface: "oklch(0.995 0.003 256)"
  ink: "oklch(0.205 0.013 264)"
  ink-muted: "oklch(0.405 0.012 264)"
  line: "oklch(0.855 0.008 264)"
  belief: "oklch(0.635 0.190 27)"
  voice: "oklch(0.760 0.150 66)"
  history: "oklch(0.775 0.135 132)"
  icp: "oklch(0.715 0.105 205)"
  system: "oklch(0.555 0.150 256)"
  signal: "oklch(0.585 0.175 350)"
typography:
  display:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "2rem"
    fontWeight: 720
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 450
    lineHeight: 1.55
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.72rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.system}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
  nav-item-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
---

# Design System: Tuezday Platform

## 1. Overview

**Creative North Star: "The Editorial GTM Control Room"**

The authenticated product should feel like a control room for a founder's GTM system: cool, structured, readable, and clearly alive with signals. It should borrow the brand site's Chromatic Control Panel system, but adapt it for repeated daily work. Marketing surfaces can be more expressive; this product UI should be denser, calmer, and more operational.

The app rejects generic AI-SaaS polish. No purple-gradient dashboards, glass cards, oversized marketing panels, or route sprawl. The strongest visual move is disciplined structure: a cool bone canvas, near-black ink, cobalt as the system through-line, and six coded hues used for meaning.

**Key Characteristics:**
- Cool bone canvas with white working surfaces.
- Cobalt system accent, used sparingly for primary actions and active states.
- Six coded hues for GTM meaning and status, not decoration.
- Tight product typography, readable at dashboard density.
- Hairline dividers and tonal layering before shadows.

## 2. Colors

The palette is a coded signal system. Cobalt is the main system color; the other hues explain what kind of GTM context or state the user is seeing.

### Primary
- **System Cobalt** (`oklch(0.555 0.150 256)`): primary actions, active nav, focus, system state, and "Brain" moments.

### Secondary
- **Signal Magenta** (`oklch(0.585 0.175 350)`): market signals, inbox activity, and "new" indicators.
- **ICP Teal** (`oklch(0.715 0.105 205)`): audiences, CRM, contact context, and customer clarity.
- **Belief Vermillion** (`oklch(0.635 0.190 27)`): warnings, belief/soul context, and high-attention states.
- **Voice Amber** (`oklch(0.760 0.150 66)`): voice/persona and draft energy.
- **History Citron** (`oklch(0.775 0.135 132)`): history, learning, and proof.

### Neutral
- **Cool Bone Canvas** (`oklch(0.966 0.005 256)`): body background.
- **Recessed Canvas** (`oklch(0.944 0.006 256)`): sidebar, toolbars, quiet bands.
- **White Work Surface** (`oklch(0.995 0.003 256)`): active panels, forms, cards.
- **Cool Ink** (`oklch(0.205 0.013 264)`): primary text.
- **Muted Ink** (`oklch(0.405 0.012 264)`): secondary text.

### Named Rules

**The Meaning-First Color Rule.** A hue must explain source, state, priority, or channel. If it is only decoration, remove it.

**The No Warm-Cream Rule.** Do not return to the old beige SaaS canvas. The app uses a cool bone neutral so the coded hues stay crisp.

## 3. Typography

**Display Font:** Archivo, system-ui fallback

**Body Font:** Inter, system-ui fallback

**Label/Mono Font:** JetBrains Mono, ui-monospace fallback

**Character:** Product surfaces use one sans family for trust and speed. Mono labels are allowed for system readouts, compact metadata, and coded context labels.

### Hierarchy
- **Display** (720, 2rem, 1.08): page titles and major dashboard readouts only.
- **Headline** (680, 1.25rem, 1.2): panel titles and grouped workflow headings.
- **Title** (650, 1rem, 1.25): list items, card headings, and section labels.
- **Body** (450, 0.875rem, 1.55): normal interface copy with a 65-75ch max for prose.
- **Label** (650, 0.72rem, uppercase, mono): metadata, state, short system labels.

### Named Rules

**The No Display Labels Rule.** Buttons, nav labels, inputs, tables, and chips never use display styling. Product UI earns trust through familiarity.

## 4. Elevation

Depth is mostly tonal. Sidebar, content, and cards are separated with neutral layers and hairline rules. Shadows are reserved for modal overlays and meaningful raised states.

### Shadow Vocabulary
- **Low Lift** (`0 1px 2px oklch(0.205 0.02 264 / 0.07), 0 3px 10px oklch(0.205 0.02 264 / 0.05)`): subtle hover or floating toolbar only.
- **Modal Lift** (`0 16px 50px oklch(0.205 0.03 264 / 0.14)`): blocking overlays and dialogs.

### Named Rules

**The Hairline-First Rule.** Use borders, dividers, and background layers before shadows. A dashboard should not look like a stack of floating landing-page cards.

## 5. Components

### Buttons
- **Shape:** compact rounded rectangles (6px), not large pills except for chips.
- **Primary:** cobalt fill with white text, 10px vertical padding, 14px horizontal padding.
- **Hover / Focus:** active tone shift plus visible focus ring. Never rely on color alone.
- **Secondary:** white or transparent background with a cool hairline border.

### Chips
- **Style:** pill shape with hue wash background and deep hue text.
- **State:** use for source, channel, approval state, and capability status.

### Cards / Containers
- **Corner Style:** 8px for regular panels, 12px only for larger grouped surfaces.
- **Background:** white work surfaces on cool bone canvas.
- **Shadow Strategy:** flat by default, hairline border first.
- **Internal Padding:** 16px to 24px depending on density.

### Inputs / Fields
- **Style:** white background, 1px cool border, 6px to 9px radius.
- **Focus:** cobalt focus outline with offset.
- **Error / Disabled:** plain language copy; vermillion only when the state is blocking.

### Navigation
- **Style:** grouped sidebar with section labels, active route marker, and child routes nested where the workflow relationship is obvious.
- **Mobile Treatment:** sidebar collapses above content; navigation remains readable and scrollable.
- **Rule:** do not create top-level items for module details that belong under Campaigns, Review, Audience, or Settings.

### Empty States
- **Style:** instructional, not decorative. State what will appear, why it matters, and the next useful action.
- **Tone:** clear and founder-aware. Do not make blocked states cute.

## 6. Do's and Don'ts

### Do:
- **Do** group routes around the GTM loop: Brain, Campaigns, Discover, Create, Review, Audience, Settings.
- **Do** show "why this output" as a trust feature behind a disclosure, not as a primary route.
- **Do** use coded hues to make source, state, and channel scannable.
- **Do** keep product surfaces dense enough for repeated work.
- **Do** use plain GTM language: campaigns, drafts, review, signals, audience, settings.

### Don't:
- **Don't** expose resolver, connector fabric, or internal architecture as front-door navigation.
- **Don't** use gradient text, glassmorphism, purple AI glow, or warm-cream SaaS wallpaper.
- **Don't** create top-level tabs for Integrations, Team, Billing, Calendar, Cadence, or Automation. House them where they belong.
- **Don't** use card grids as the default layout answer.
- **Don't** use vague AI copy such as "supercharge", "unlock", "streamline", or "transform".
