# UI Polish — Billing, Activity, Scroll & Motion (design)

- **Date:** 2026-07-03
- **Branch:** `ui-polish-billing-activity-motion`, cut from `main` (a47fcd6)
- **Status:** approved by founder in chat (2026-07-03)
- **Do NOT merge into `main`.** Push the branch; the founder reviews and merges.

## Why

Four founder requests, bundled into one UI-polish slice:

1. The billing page (Sprint 37) was written with Tailwind utility classes, but **Tailwind is not installed** in `apps/web` — the page renders as unstyled HTML and is off-palette from the rest of the app.
2. The raw **Event log** on the Integrations page is backend plumbing on a settings surface. Founder wants it out of the way; counter-perspective (audit trail = trust story for autonomous publishing) was accepted in the form of a **dedicated Activity page** rather than deletion.
3. Scrolling "feels laggy". Root cause is rendering cost of long unvirtualized lists, not missing smooth-scroll. No scroll-hijack libraries.
4. Founder wants a **fade-in animation** whenever a module loads.

## Design

### 1. Billing page rebuild (native design system)

`apps/web/app/workspaces/[id]/billing/page.tsx` is rewritten on the app's
oklch token system (`globals.css`) — zero Tailwind classes. One `panel` card:

- **Current Plan** section: plan label ("Free Plan" / "Pro Plan" / "Scale Plan")
  with an `Active` badge (accent-soft/accent-deep, like `layer-badge`), the
  tagline "Upgrade to Pro for more generations and features." on free, price
  block on the right for paid plans ($29.99/mo Pro — display only, checkout
  price comes from Stripe), and the **Upgrade to Pro** button (existing
  `POST /billing/checkout` flow, accent button).
- **Usage** section, below a divider in the same card: one meter row per
  entitlement (Monthly generations, Connectors, Seats). Each row: label +
  `used / limit` figure, a rounded track with an accent fill.
  - **over** (used ≥ limit): fill turns `--danger`, and a red
    **"Upgrade for more usage"** text pulses gently (~1.2s CSS pulse, not a
    hard blink; disabled under `prefers-reduced-motion`).
  - **near** (≥ 80%): fill turns amber (`--c2-deep`).
  - **unlimited** (limit −1, Scale): shows "Unlimited", soft full bar, never pulses.

Meter logic is a pure function in `packages/contracts`:
`usageMeter(used, limit)` → `{ percent: number, state: "ok" | "near" | "over" | "unlimited" }`,
Vitest-tested (web workspace has no test runner).

### 2. Event log → Activity page

- New page `apps/web/app/workspaces/[id]/activity/page.tsx`: renders the
  event log (same `GET /workspaces/{id}/events` API, same badges + delivery
  statuses as today) with a page header and empty state.
- The Event log section is **removed** from `connectors/page.tsx`.
- Nav: add `{ label: "Activity", path: "/activity", summary: "Event log and audit trail", tone: "system" }`
  to the **Settings** group in `WORKSPACE_NAV` (`packages/contracts`).
- No API/schema changes.

### 3. Scroll: fix the lag, then smooth

- **Cap long lists**: shared `useShowMore(items, 50)` hook + "Show more"
  button applied to the heaviest lists (Inbox page list, Discovery inbox
  list). Rendering 50 rows instead of unbounded arrays is what removes
  wheel stutter.
- `html { scroll-behavior: smooth }` for anchor/programmatic jumps only,
  inside `@media (prefers-reduced-motion: no-preference)`.
- No scroll-hijacking library (Lenis/Locomotive rejected by design).

### 4. Module fade-in

- `apps/web/app/workspaces/[id]/template.tsx` — App Router re-mounts a
  template on every route change, so one file animates every module.
  It wraps children in `<div className="module-in">`.
- `@keyframes module-in`: opacity 0→1 + translateY(4px)→0, 200ms,
  `var(--ease-out)`; wrapped in `@media (prefers-reduced-motion: no-preference)`.

## Out of scope (YAGNI)

- Stripe plan-change/cancel UI (checkout flow stays as is).
- Virtualized list library; pagination API changes.
- Skeleton `loading.tsx` per module (fade-in covers perceived load).
- Dashboard "human-readable activity summaries".

## Verification

- `npm test` (contracts + api + brain) and `npm run typecheck` green.
- `npm run build -w apps/web` (Next build) green.
- Manual walkthrough: billing card states (free/over-limit pulse/unlimited),
  Activity page shows events, connectors page has no log, route changes fade in,
  inbox/discovery capped with Show more.
