# Tuezday UI/UX — Industry-Ready Design

*Design spec, 2026-07-10. Produced from a founder-led brainstorm comparing Tuezday against Blaze (blaze.ai), using the founder's screen recording (`~/Downloads/Blaze UI recording for audit.mov`, frames at `~/blaze_audit_frames/`) and the audit doc (`~/Downloads/Blaze UI UX Rebuild Audit.md`). Successor to the 2026-07-09 "Editorial" revamp, which changed palette/type but shipped zero icons, zero imagery, no top bar, and no guided loop.*

## 1. Problem

The 2026-07-09 revamp re-skinned all screens onto primitives but the founder's verdict was "all we changed is button and page colors." Verified against the Blaze recording, four gaps hold:

1. **No post-onboarding loop** — after the onboarding wizard, users land on a data dashboard with no guidance on what to do next.
2. **Text-only UI** — the app has exactly one `<img>` (a Google favicon), no icon library, no imagery, no previews. Everything is text in bordered boxes.
3. **Weak visual hierarchy** — sidebar-only navigation; no top bar; every page starts cold at the content.
4. **No icons/badges as wayfinding** — status and counts are text; nothing tells the user where work is waiting.

The Blaze recording is Blaze loaded with *Tuezday's own GTM content* (founders' photos, Tuezday messaging) — effectively a mockup of Tuezday wearing Blaze's clothes. It is the reference for *feel*, not for product shape.

## 2. Decisions (founder-approved)

| Decision | Choice |
|---|---|
| Scope of borrow from Blaze | **Skin + patterns only.** Product shape, IA, and all 28 routes unchanged. Blaze is a content scheduler; `soul.md` explicitly refuses that shape. We import visual craft and interaction patterns, not the object model. |
| Aesthetic direction | **Evolve Editorial.** Keep warm paper, Fraunces serif, single teal accent, hairline borders, OKLCH tones (`tokens.css` values frozen). Finish the identity with icons, previews, hierarchy, richer status. Not a pivot to clean-white SaaS. |
| Visual scope | All four pillars: icon system, content/creative previews, show-your-work diagrams, dataviz + rich empty states. |
| Home & loop | Guided work-queue + persistent setup checklist + **badge-driven wayfinding (the Guide system)**. Smart landing during activation phase. |
| Module settings | Blaze-style contextual Settings action in the top bar per module, opening a centered modal. |
| Integrations | Copy Blaze's Integrations module pattern (hub + nav progress count + contextual connect prompts), translated to Tuezday's connector context. |
| Execution | Approach C: thin spine → four hero screens → tone-grouped sweep in waves. |

## 3. Design-system spine

All work is **additive**. No existing token value changes; no route is added or removed.

### 3.1 TopBar (new, in `apps/web/app/workspaces/[id]/layout.tsx`)

A thin (~52px) bar above the content canvas on every workspace screen:

- **Left:** page title (Fraunces serif) with its module icon + breadcrumb when nested.
- **Center/right:** contextual primary actions for the current module.
- **Far right:** workspace health chip, notifications entry, user avatar.
- Styled in Editorial language: hairline bottom border, paper surface, no heavy chrome. Absorbs the existing `PageHeader` role (component folded in; `PageHeader` retired during the sweep).

### 3.2 Module-settings convention

Any module with configurable behavior shows a quiet `⚙ Settings` action in the TopBar, opening a **centered modal over a blurred canvas** (`SettingsModal`, §6.6):

- Campaigns → cadence defaults, auto-generation behavior, channels per content type
- Approvals → review rules, auto-approve thresholds
- Brain → resolver defaults, overlay precedence
- Outbound → export target, sending windows
- Ads → launch guardrails, budget defaults
- Discovery → sources, scan frequency
- Insights → connected channels, date defaults

Rule: **module settings = how the module behaves; workspace settings (team, billing, integrations, activity) stay in the Settings nav group.** No setting appears in both. Where an existing nav page is really "settings for a module" (e.g. `cadence`, `automation`), the settings surface becomes the modal reached from that module's TopBar; routes keep working but the nav de-emphasizes them.

### 3.3 Token additions (append-only to `apps/web/app/tokens.css`)

- `--icon-sm: 16px; --icon-md: 20px; --icon-lg: 24px; --icon-stroke: 1.75;`
- `--shadow-preview` — soft elevation **reserved for content previews only**; structural cards keep borders (extends the existing elevation rule).
- `--c1`–`--c6` tones become the canonical mapping for nav groups, content types, and badge families: each family draws icon color (deep) and wash from its tone. One source of truth.

## 4. Icon system

- **Library: Lucide** (`lucide-react`), constrained: stroke `1.75` always, never filled, sizes locked to the icon tokens, `currentColor` inheritance (muted ink by default; tone-deep color only inside a tone context; teal accent reserved for primary actions).
- **One-file registry** at `apps/web/src/components/ui/icon.tsx`: every icon in the app is exported from a named registry (`<Icon name="brain" />`). No page imports Lucide directly. ~40 names at launch; the registry is the auditable vocabulary.
- **Brand-mark carve-out:** provider logos (LinkedIn, X/Twitter, Instagram, Reddit, Meta, Google, Freshsales, …) ship as bundled monochrome SVGs (sourced from simple-icons, checked into the registry). Ink-colored at rest; full brand color only on connect surfaces.

### Vocabulary

| Family | Mapping |
|---|---|
| Nav groups (tone-colored) | Home `house` · Brain `brain` · Campaigns `megaphone` · Discover `radar` · Create `pen-tool` · Review `check-circle` · Audience `users` · Settings `settings` |
| Content types | email `mail` · social post `image` · blog `file-text` · ad `target` · carousel `layers` |
| Status (pairs with Badge) | review `alert-circle` · live/posting `radio` · generating `sparkles` · approved `check` · rejected `x` · learning `trending-up` |
| Brain docs | soul `flame` · icp `crosshair` · voice `mic` · history `book-open` · now `zap` |
| Actions | approve `check` · edit `pencil` · regenerate `refresh-cw` · connect `plug` · settings `settings-2` |
| Providers | brand SVGs per carve-out above |

## 5. The Guide system and hero screens

### 5.1 Next-action engine (single source of truth)

The workspace continuously derives **one next action** from real state, priority-ordered:

1. Draft waiting for review
2. Channel connection blocking a scheduled/approved post
3. Live campaign with no content generating
4. Insights available but unconnected
5. Remaining setup-checklist items

This one value drives smart landing, the guide dot, and the Home checklist — they can never disagree. Computed server-side and exposed via a shared contract so nav, Home, and login redirect consume the same answer.

### 5.2 Smart landing

- **Activation phase** (setup checklist incomplete): login lands directly on the next-action page — e.g. post-onboarding, Approvals with the first draft open.
- **Activated workspace:** login lands on Home. Predictability over guidance once the loop is learned.

### 5.3 Guide dot (wayfinding badges)

- **Exactly one guide dot exists at any moment** — a small teal accent dot next to the nav module holding the next action. Complete the action → the dot moves to wherever the loop goes next (e.g. campaign created → posts generate → dot on Review → approved → no channel connected → dot on Integrations).
- **Dot ≠ count.** Count badges (`Review ③`, `Integrations 1/5`) are passive muted-ink state, always visible. The dot is the only animated, accent-colored element: one soft pulse on arrival, then still.
- **Silent otherwise:** no auto-tooltips, no coach-marks, no modals. Hover shows the why ("1 draft waiting for review").
- **It retires:** once the checklist completes and the loop has been exercised once, the dot only reappears for genuinely blocking states.
- **System-working state:** when the next action belongs to the system (generating, brain updating), no dot appears; Home's queue shows a quiet `⟳ Generating — 3 posts arriving ~2pm` status instead.

### 5.4 Hero screen: Home

Three stacked zones under the TopBar (checklist deliberately *not* first — the queue is):

1. **Needs you now** — the work queue. Horizontal `PreviewCard`s: content thumbnail, type icon, campaign name, `Review` badge, one-click into Approvals. Top card always mirrors the current next action. Empty = calm all-clear + what's generating next.
2. **Setup checklist** (activation phase only; disappears forever when complete) — `Set up your GTM engine — 3/6` with icon steps: brain reviewed, channel connected, first campaign, first approval, insights live, team invited. Each step deep-links; count mirrors as the Home nav badge; completing an action elsewhere briefly gives Home the dot + updated count, inviting the tick-off visit.
3. **What the brain learned** — 2–3 recent learning-loop entries (signal → what changed) with brain-doc icons.

Plus a slim icon+count strip replacing today's four large stat cards: `Needs review ③ · Signals ⑫ · Brain updates ② · Live ①`, each deep-linking.

### 5.5 Hero screen: Approvals

Blaze's gallery pattern with Tuezday content: campaign/date-range group headers with `Approve all`; grid of `PreviewCard`s (rendered email/post/ad previews with `--shadow-preview` lift, type icon + scheduled time, `Review` badge); hover reveals Approve / open-editor; approving advances focus to the next card.

### 5.6 Hero screen: Brain

- Five `DocTile`s (soul/icp/voice/history/now with tone-colored icons) showing freshness and update source ("now · updated 2h ago by learning loop").
- **Resolver trace strip** (`FlowStrip`): `soul → icp → voice → now → bundle` as connected icon nodes with per-layer contribution — the moat made visible.

### 5.7 Hero screen: Integrations

Translation of Blaze's module to Tuezday's connector context (today: bare `connectors` page):

1. **Nav progress badge** — `Integrations 1/5`, counting connected providers against the workspace's relevant capabilities.
2. **Hub page** — provider cards grouped by what they unlock: **Publishing** (LinkedIn, X, Instagram, Reddit) · **Ads** (Meta) · **CRM** (Freshsales) · **Evidence** (website/source scrape). Each card: brand icon, one-line GTM value promise ("Publish approved posts on schedule", "Pull ad results into the learning loop"), status badge, and once connected, recent contribution ("12 signals this week"). Nango flow behind every Connect.
3. **`ConnectPrompt` (reusable)** — contextual connect prompts wherever a missing integration blocks value: Insights (blurred sample charts behind "Connect LinkedIn to see your numbers"), approval editor's "Posting to" rail (inline `Connect`), Outbound/Ads/CRM empty states.

## 6. Visual kit (reusable components, `apps/web/src/components/ui/`)

### 6.1 `PreviewCard`

One component, four renderers by content type: social post (platform-framed mock: avatar slot, copy, media area, platform icon) · email (subject + first lines in letter frame) · blog (title + dek + reading time) · ad creative (thumbnail + headline + platform chip). Shared chrome: type icon + tone-wash header, scheduled time, status Badge, hover action rail. The only `--shadow-preview` consumer. Used by: Approvals, Home queue, Content, Ad-creatives, Calendar hovers, Sandbox output.

### 6.2 `Badge` family (extend existing `badge.tsx`)

Existing approval-state tones stay. Added: **count variant** (`Review ③`, `0/4` progress, muted ink), **tone variant** (any `--c1`–`--c6`), and **`GuideDot`** (accent, single pulse on arrival, hover-title). One file so state language never drifts.

### 6.3 `DiagramKit`

Three purpose-built pieces (not a chart lib): `FlowStrip` (connected icon nodes, resolver trace), `DocTile` (brain doc: tone icon, freshness, update source), `LoopGlyph` (signal → change learning entries). Drawn at 1.75 stroke with hairlines — penned, not imported.

### 6.4 `Chart`

Thin wrapper over **Recharts**, locked to Editorial: tone palette series, hairline axes, Inter labels, paper background, no gradients/3D. Line, bar, sparkline. Run through the dataviz skill before implementation for form/color validation.

### 6.5 `EmptyState` (enrich existing)

Current simple mode stays. New **preview-value mode**: blurred sample chart/cards behind a centered `ConnectPrompt` (brand icon, one-line GTM value promise, Connect button). Rule: no blank pages — every empty state previews value or shows the system working (`⟳ Generating…`).

### 6.6 `SettingsModal`

Centered over blurred canvas, serif title, left subnav when >1 settings group, `Save` → toast. The single shell for all §3.2 module-settings surfaces.

## 7. Sweep plan

Wave order follows the loop, not the nav. Hero screens (§5) land first, then:

- **Wave A — loop core:** Content, Sandbox, Calendar, Campaigns detail (PreviewCards + TopBar + module settings)
- **Wave B — intelligence:** Evidence, Resolver, Learning, Discovery, Inbox (DiagramKit + tone icons)
- **Wave C — reach:** Outbound, Lists, Launches, CRM, PR, Ads, Ad-launches, Insights (Charts + ConnectPrompts + empty states)
- **Wave D — workspace:** Team, Billing, Activity, Notifications, login/invite polish

**Per-screen recipe (mechanical):** TopBar with title icon + contextual actions (+ Settings where applicable) → counts/badges from the Badge family → replace text lists with PreviewCards/DocTiles where content is the substance → enrich the empty state → icons on section heads. No new primitives invented per-screen.

**Definition of done per screen:** no icon-less nav/section head · no raw text list where a preview belongs · no blank empty state · `npm run typecheck` + `npm test` green · screenshot reviewed against the hero-screen standard.

## 8. Non-goals

- No change to product shape, object model, or the 28-route IA (Blaze's Strategy→Campaign→Post spine is explicitly rejected).
- No pivot away from the Editorial identity; no token value edits.
- No stock photography or decorative imagery — every visual is the user's own content, the system's own structure, or the system's own data.
- No gamification badges (streaks/achievements) — badges here are counts + the guide dot only.
- No new backend features beyond the next-action contract and whatever counts/state the badges need exposed.

## 9. Testing & verification

- Next-action engine: pure priority function in `packages/contracts` (same pattern as `visibleNavItems`), unit-tested — given workspace state, exactly one next action. The api exposes the computed value; dot/landing/checklist all derive from it.
- Component tests where logic lives (Badge variants, PreviewCard renderer selection, EmptyState modes).
- Existing suites stay green per wave (`npm test`, `npm run typecheck`).
- Founder visual review per hero screen and per sweep wave (screenshots), per the sprint workflow's founder-acceptance convention.
