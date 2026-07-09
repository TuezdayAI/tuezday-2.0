# Tuezday UI Revamp — Design

- **Date:** 2026-07-09
- **Branch:** `ui-revamp-design`, cut from `main` (`0bb9d7f`)
- **Status:** approved by founder in chat (2026-07-09) — direction "Editorial," rollout capped at 2 phases
- **Do NOT merge into `main` as-is.** This is a design/spec doc; implementation happens on its own branch(es) per the plan that follows.

## Why

The founder's brief: change the *whole* UI of Tuezday — "from buttons to major cards" — using Blaze AI as inspiration, not a template, with room for our own creative direction. Three concrete visual directions were mocked up and compared (Studio, Signal, Editorial); the founder picked **Editorial**: paper-warm canvas, serif display type, hairline-ruled cards, a single muted accent for state. It leans directly into Tuezday's actual differentiator — the Central Brain is five *readable, editable documents* — rather than borrowing Blaze's confetti-accent SaaS energy wholesale.

Today's UI is one hand-written `apps/web/app/globals.css` (1,673 lines), no component primitives, no formal token layer, no Tailwind. Every one of the ~32 nav-registered pages hand-rolls its own markup against ad-hoc classes (`.panel`, `.layer-badge`, `.filter-tab`, …). This revamp:
1. Establishes a real **token layer** (oklch-based, dark-mode-ready but light-only for now).
2. Builds a **React primitive library** every screen consumes — buttons become one `Button` component, cards become one `Card`, etc.
3. Re-skins the app on top of that foundation, in **two founder-approved phases** (token budget constraint — no 3rd/4th phase right now).

## Non-goals (explicit YAGNI)

- **No dark mode shipped.** Tokens are architected so dark is a later flip of one value set; no dark theme is designed, tested, or shipped in this work.
- **No framework migration.** Native CSS custom properties + CSS Modules (or plain scoped `.css` files, matching the existing per-page pattern) — no Tailwind, no CSS-in-JS runtime, no component-library adoption (no shadcn/MUI/etc.). Per founder decision, this is a token-layer + hand-built-primitives approach.
- **No copy rewrite beyond what a screen's redesign naturally touches.** Existing microcopy stays; new/rebuilt surfaces follow the voice guide below.
- **No new features.** This is visual/structural only — no new API endpoints, no new data.
- **No mobile-first redesign.** Existing responsive behavior is preserved/improved incidentally, not redesigned as a goal.
- **No Phase 3.** Everything not covered by Phase 1 or Phase 2 (see Rollout) is explicitly deferred to a future, separately-scoped initiative.

## Direction: "Editorial"

**Personality:** quiet, trustworthy, document-forward. The Brain is where Tuezday's edge lives, and the whole app should feel like a well-kept notebook, not a dashboard trying to impress you. Confidence comes from restraint and typography, not saturation or motion.

### Palette (light; dark-ready via token indirection, not designed)

| Role | Value | Use |
|---|---|---|
| `--canvas` | `oklch(0.965 0.012 85)` (≈ `#F4EFE4`) | Page background |
| `--panel` | `oklch(0.98 0.008 85)` (≈ `#FBF7EE`) | Sidebar / secondary surfaces |
| `--surface` | `oklch(0.995 0.004 85)` (≈ `#FFFFFF`) | Cards, inputs |
| `--hairline` | `oklch(0.87 0.015 75)` (≈ `#E4DCCB`) | Default border |
| `--hairline-strong` | `oklch(0.80 0.02 75)` (≈ `#D2C7B0`) | Emphasized divider |
| `--ink` | `oklch(0.22 0.012 60)` (≈ `#211E1A`) | Primary text |
| `--ink-secondary` | `oklch(0.47 0.014 60)` (≈ `#726B5E`) | Secondary text |
| `--ink-muted` | `oklch(0.62 0.012 65)` (≈ `#9A9384`) | Placeholders, captions |
| `--accent` | `oklch(0.46 0.055 165)` (≈ `#2F6E5A`, muted teal) | Primary actions, links, "state = good" |
| `--accent-deep` | `oklch(0.36 0.05 165)` (≈ `#24513F`) | Accent hover/active |
| `--accent-wash` | `oklch(0.93 0.025 165)` (≈ `#E3EDE7`) | Accent-tinted fills |
| `--highlight` | `oklch(0.58 0.075 75)` (≈ `#9A7B4F`, warm ochre) | Rare emphasis, never a second primary |
| `--warn` | ochre pair, wash `#F0E6D2` / ink `#7A5A22` | "draft / pending" state |
| `--danger` | clay-red, wash `#F7E3DE` / ink `#A83E2B` | Errors, destructive actions |

One accent (teal), one rare highlight (ochre), never both at full saturation on the same surface. Semantic state colors (approved/pending/thin/error) are the *only* other hues in the system — this is a deliberate constraint carried over from the current palette's discipline, tightened.

### Typography

- **Display / serif:** `Fraunces` (variable, optical size range) — page titles, Brain doc titles, the workspace name, large numbers/stats. Carries the "readable document" personality.
  - *Fallback option if Fraunces reads too ornamental in testing:* `Source Serif 4` — noted here so the choice is revisited once real screens are built, not re-litigated from scratch.
- **Body / UI:** existing `Inter` stack, kept — buttons, labels, table cells, form inputs, nav. No reason to change a working, legible workhorse sans.
- **Mono:** existing mono stack, kept — for token/ID/code display (evidence sources, IDs, etc.), unchanged.
- **Scale:** display 28/22/17px (Fraunces, weight 400–500 only — serif at heavy weights looks clumsy); body 15/13/11.5px (Inter, 400/500). No weight above 500 anywhere.

### Shape & elevation

- Cards: `8px` radius. Controls (buttons, inputs, chips): `6px` radius. **No pill buttons.** This is a deliberate departure from Blaze (and from the onboarding wizard's current pill styling) — Editorial reads as structured/document, not bubbly/consumer.
- Depth comes from **hairline borders**, not shadows. `box-shadow` is reserved for floating layers only: popovers, modals, the toast stack. At most one shadow token in active use per screen at a time (mirrors the "at most two floating elevations" discipline).
- Dividers inside a card (e.g., between a header and body) use `--hairline`; the card's own border uses `--hairline` at rest, `--hairline-strong` on hover for interactive cards.

### Motion

- Durations: 160ms (micro, e.g. hover/focus) / 220ms (panel transitions, module fade-in) — both `cubic-bezier(0.23, 1, 0.32, 1)` (kept from the current `--ease-out`, it already fits Editorial's restraint).
- No bounce, no overshoot, no scale-pop. Fades and short translateY only.
- Everything wrapped in `@media (prefers-reduced-motion: no-preference)`, matching the existing convention from the onboarding work.

### Voice (light touch — applies where copy is rewritten as part of a screen's redesign)

Sentence case throughout (buttons, headings, nav labels — already mostly true, now formalized). Verb-first button labels ("Run generation", not "Generate"). No exclamation points on system copy. Errors state what happened + what to do, no "Error:" prefix. This mirrors conventions already present in the codebase (`PageHeader`, `EmptyState` copy) — the revamp formalizes rather than reinvents.

## Architecture: tokens → primitives → screens

Three layers, each consumed only by the one above it — a screen never reaches past primitives into raw tokens for a *component-level* concern (a card, a button), though page-level layout (grids, spacing between sections) may reference layout tokens directly.

```
1. apps/web/app/tokens.css       — CSS custom properties (palette, radius, motion, spacing, type scale)
2. apps/web/src/components/ui/   — primitive React components, each with its own scoped .module.css
3. apps/web/app/**/page.tsx      — screens compose primitives; page-specific layout only, no new
                                    button/card/badge styling ever written at the page level
```

### 1. Tokens (`apps/web/app/tokens.css`)

Replaces the `:root { ... }` block currently at the top of `globals.css` (lines 5–55). One file, organized in the same groups as the palette table above, plus:
- Radius scale: `--radius-control: 6px`, `--radius-card: 8px`, `--radius-lg: 12px` (rare, e.g. the onboarding wizard's outer frame).
- Spacing scale: `--space-1` through `--space-8` (4px base, matching current ad-hoc px usage — formalized, not changed).
- Motion tokens as above.
- Type tokens: `--font-display: 'Fraunces', Georgia, serif`, `--font-body: 'Inter', ui-sans-serif, ...` (existing stack kept), `--font-mono` (unchanged), plus the size scale.

`globals.css` shrinks to: `@import "./tokens.css";` + true globals (CSS reset, `body` base styles, scrollbar styling) + any *page-specific* classes not yet migrated to a primitive (during the transition — see Rollout). It does not go away in one shot; it's drained as primitives replace its sections.

### 2. Primitive component library (`apps/web/src/components/ui/`)

One component per file, each: a `.tsx` (props + JSX) + a `.module.css` (scoped styles reading only tokens, never hex/px literals). Inventory, derived from an audit of `globals.css`'s existing sections (buttons, panels, badges, filter tabs, state chips, forms) plus what Editorial's card-forward direction needs:

| Primitive | Replaces (from `globals.css`) | Notes |
|---|---|---|
| `Button` | `.button`, `.button-secondary`, `.link-button` | variants: `primary` \| `secondary` \| `ghost` \| `danger`; sizes `sm` \| `md`. No pill. |
| `IconButton` | ad-hoc icon-only buttons scattered per-page | 32px hit target minimum. |
| `Card` | `.panel` (lines 822+) | the base "major card" unit — header slot, body, optional footer, optional hover-interactive state. |
| `PageHeader` | `.page-header` (line 439) | title (Fraunces) + subtitle + trailing actions slot — already exists as a pattern, formalized into a component. |
| `Badge` / `StateChip` | `.layer-badge`, `.state-*` (lines 1134+) | approval states, doc-completeness states, connection states — one component, a `tone` prop mapping to the semantic palette. |
| `Input`, `Textarea`, `Select` | form styles in `.panel`/forms section (525+) | consistent 36px control height, focus ring via `--accent`. |
| `Toggle` | ad-hoc checkboxes/switches | for automation/settings toggles. |
| `Tabs` | `.filter-tab` (1108+) | approvals/discovery filter rows. |
| `ListRow` | workspace list, connection list items (574+) | a bordered/hoverable row primitive for list-of-things screens (connectors, team, campaigns). |
| `Table` | ad-hoc tables (evidence, metrics) | header row + cell primitives, no per-page table CSS. |
| `EmptyState` | `.empty` + existing `EmptyState` component (`src/components/empty-state.tsx`) | already partially componentized — formalize into the token system. |
| `Meter` | billing usage bars (from the 2026-07-03 UI polish work) | generalized beyond billing — Brain completeness also becomes a `Meter`. |
| `Modal` | none today (check per-screen) | shadow-elevated, the one place shadows are expected. |
| `Toast` | none today | success/error confirmations, replacing inline `<p className="error">` where a page currently has no feedback pattern. |
| `Tooltip` | none today | for icon-only buttons and truncated content. |
| `Avatar` | team/member initials circles | reused from the workspace-member display already present. |
| `Sidebar` | `.workspace-shell` sidebar (125+) | the nav shell itself — one component, `WORKSPACE_NAV` renders through it. |

This is the *component inventory*, not a task list — the implementation plan (next skill) turns each row into build+test+adopt steps.

### 3. Screens

Screens import only from `components/ui` (and existing data-fetching/lib code, unchanged). A screen's own `.module.css`, if any, contains only layout (grid/flex arrangement of primitives) — zero color, radius, shadow, or font-size literals. This is the enforcement mechanism against drift: a future PR adding a raw hex or `border-radius: 4px` in a page file is the smell that something should have been a primitive or token instead.

## Rollout — two phases (founder-capped, token-budget constrained)

Both phases ship real value; there's no dark "foundation-only" release with nothing visible. Phase 1 is a bigger lift (it builds everything) but *also* covers the surfaces founders/users see most. Phase 2 is largely mechanical — same primitives, remaining screens — and can be paused/resumed per-module without re-opening design.

### Phase 1 — Foundation + the spine

Builds the entire token layer and primitive library (all rows in the inventory table), then re-skins the app's structural shell and highest-traffic surfaces:

- **Shell:** `Sidebar` / nav (all of `WORKSPACE_NAV`'s groups render through the new component, even though most *linked* pages aren't re-skinned yet — the chrome around every page changes immediately), `PageHeader`, global layout.
- **Onboarding** (`apps/web/app/onboarding/**`) — highest-visibility surface, most recently touched, and the one place a pill-button removal + serif-card treatment will be most visible to a first-time user.
- **Home** (`apps/web/app/page.tsx` — workspace list/create) and **Workspace home** (`apps/web/app/workspaces/[id]/page.tsx`).
- **Brain** group: Brain docs editor, Context inspector — the direction's namesake surface.
- **Review** group: Approval queue — the second-most-trafficked screen per the product's own framing ("nothing ships without review").
- **Billing** — already token-clean from the 2026-07-03 UI polish pass; migrate its bespoke CSS onto the new primitives (low-risk, proves the `Meter`/`Card` primitives on a real screen).

Founder-visible outcome of Phase 1: every page's chrome (sidebar, headers) is the new look; the app's four most-used surfaces are fully rebuilt; the primitive library exists and is proven on 6+ real screens.

### Phase 2 — Remaining modules (mechanical re-skin)

Every other `WORKSPACE_NAV` entry, grouped by the nav's own existing groups (no new prioritization scheme needed — the nav structure already reflects usage tiers):

- **Create** group: Content, Playground, Ad creatives.
- **Campaigns** group: Campaign home, Calendar, Cadence, Automation, Ads, Launch ads, Insights.
- **Discover** group.
- **Audience** group: Outbound, Lists & segments, Launches, CRM, PR & media.
- **Settings** group (remaining): Integrations, Team, Activity, and any not covered in Phase 1.
- Evidence library, Learning, Inbox (Review group remainder).

No new primitives should be needed in Phase 2 — if one is, that's a signal the Phase 1 inventory was incomplete and the plan should note it rather than silently drift back to bespoke CSS. Phase 2 can be split into founder-approved sub-batches at implementation-plan time (it does not need to land as one PR) — that granularity is a `writing-plans` concern, not a design concern.

## Testing / verification approach

- No new automated visual-regression tooling introduced (out of scope/cost). Verification is: `npm run build -w apps/web` stays green after every primitive/screen change; manual dev-server walkthrough per screen touched (screenshot or live check) before marking a task done — same discipline used throughout the onboarding sprints.
- A short lint/grep check is worth adding as a cheap guard: a repo search for raw hex codes or `px` radius/shadow literals inside `apps/web/app/**/*.tsx` and page-level `.module.css` (excluding `tokens.css` and `components/ui/**`) should return nothing once a phase completes — this is how "no page-level bespoke styling" gets verified without new tooling.

## Progress log

- 2026-07-09 — Spec drafted on branch `ui-revamp-design` (off `main` `0bb9d7f`). Direction "Editorial" chosen after a 3-way visual comparison (Studio/Signal/Editorial) and one applied mockup on a real dense screen (workspace home + Brain + Review). Rollout capped at 2 phases per founder token-budget constraint. Awaiting founder review before writing-plans.

## Phase 1 implementation log

- 2026-07-09 — Phase 1 built via subagent-driven development (controller + parallel implementer agents). Delivered: `tokens.css` Editorial repaint + Fraunces font; 7 primitives (Button/IconButton, Card, Badge, Input/Textarea/Select, Tabs, Meter) + restyled PageHeader/EmptyState; workspace shell/sidebar restyle; 5 of 6 target screens re-skinned onto primitives (home, workspace home, Brain, Approvals, Billing). Full `npm run build -w apps/web` green (7/7 pages).
- Deferred to a Phase 1 follow-up: the Onboarding wizard re-skin (Task 16) — its implementer agent died when the parent process exited, having done no real work; the screen still functions and inherits the new palette from the token repaint, but its markup is not yet on the primitives.
- Flag for founder review: the Approvals screen's approve/reject buttons now render as solid primary (teal) / danger (red) rather than the previous neutral secondary — a deliberate emphasis improvement, but a visible change to confirm.
