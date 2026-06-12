# Sprint 18 — Dashboard UX Redesign

> Date: 2026-06-11. Pulled forward by founder decision (design reference arrived; competitive research done first — see `docs/research/ui-audit.md`, which is the IA rationale for everything here).
> Visual reference: **tavus.io** (founder-provided). Frontend only — no API or schema changes.

## Goal

A user with zero context opens Tuezday and can say what each section does. Internal vocabulary (resolver, signals, connectors, sandbox) leaves the navigation; the GTM loop becomes the navigation.

## Visual language (derived from tavus.io's actual CSS)

- **Palette:** warm cream background `#f7f4ef`; warm white panels `#fffdfb`; warm borders `#eae5de` / `#c9bdaa`; near-black ink `#140206`; coral accent `#ff6183` (primary actions); pastel chips — pink `#ffb4c5`, lavender `#e4e0f2`, mint `#acffbe`/green `#38f261`, amber `#ffda95`, peach `#f6c1a8`.
- **Type:** serif display for page titles (Instrument Serif — free analog of Tavus's "Perfectly Nineties"), clean sans for UI (Inter — analog of "Suisse Intl"). Loaded via `next/font/google`.
- **Shape:** generous radii (12–16px cards), pill buttons (999px), light borders over shadows, generous whitespace.

## Information architecture

Persistent left sidebar inside a workspace (replaces breadcrumbs and the button-pile on the brain page). Existing routes are kept — only labels and grouping change:

| Nav item | Route | Children (indented, same sidebar) |
|---|---|---|
| Home | `/workspaces/[id]` (NEW page) | — |
| Brain | `/workspaces/[id]/brain` (moved from `[id]`) | Evidence → `/evidence`, Context inspector → `/resolver` |
| Discover | `/discovery` | — |
| Create | `/content` | Playground → `/sandbox` |
| Review | `/approvals` | Learning → `/learning` |
| Campaigns | `/campaigns` | — |
| Audience | `/outbound` | CRM → `/crm` |
| Integrations | `/connectors` | — |

One route change only: brain editor moves `[id]` → `[id]/brain` so Home can live at the workspace root.

## Page header pattern

Every page: plain-language `h1` (serif) + one-line "what this is for" subtitle + primary action on the right. No breadcrumbs (sidebar carries location). Renames: Signal Discovery → "Discover", Generation Sandbox → "Playground", Approval Queue → "Review", Content → "Create", Context Resolver → "Context inspector", Evidence Corpus → "Evidence library", Connector Fabric → "Integrations", Outbound → "Audience".

## Home page (new)

Data comes only from existing endpoints.

1. **Setup checklist** (hidden once all four complete): fill the brain (completeness ≥ 60% or all five docs non-empty), add a voice (≥1 persona), generate a first draft (≥1 generation), make a first decision (≥1 draft beyond `pending_review`/`draft`). Each step links to the right page.
2. **Attention cards:** Waiting for review (`drafts?state=pending_review`), New signals (`discovery/items?status=new`), Proposed brain updates (`learning/syntheses` with `status === "proposed"`), Active campaigns (`campaigns` count). Card → page.
3. **Recent drafts:** latest 5 drafts with state chips.

## Out of scope

Auth, teams, calendar view, route renames beyond `/brain`, API changes, mobile layout polish (desktop-first), dark mode.

## Acceptance (founder)

- Open a workspace: sidebar shows the eight plain-language items; every page has an understandable title + description; no "resolver/connector/sandbox" words at nav level.
- New empty workspace lands on Home with the checklist; completing steps checks them off.
- The dashboard visibly matches the tavus.io feel (cream, serif headings, coral accents, pills).
- `npm run typecheck` and `npm test` pass.
