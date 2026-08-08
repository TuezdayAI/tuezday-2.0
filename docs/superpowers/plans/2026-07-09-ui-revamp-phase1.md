# Tuezday UI Revamp — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repaint the entire app onto the Editorial design direction via one token change, then build a real React primitive library (Button, Card, Badge, Input/Textarea/Select, Tabs, Meter, plus restyled PageHeader/EmptyState) and re-skin the app's highest-traffic surfaces (shell/nav, onboarding, home, workspace home, Brain, Review/Approvals, Billing) to use it.

**Architecture:** `apps/web/app/tokens.css` (new token layer) → `apps/web/src/components/ui/**` (primitives, each a `.tsx` + scoped `.module.css` reading only tokens) → screens (import primitives, page-level CSS is layout-only). Existing CSS custom-property **names** are kept (`--bg`, `--panel`, `--accent`, `--radius`, etc.) and only their **values** change — this means Task 1 alone re-themes every screen in the app immediately, including the ~26 screens Phase 1 doesn't touch, because they already read these variables.

**Tech Stack:** Next.js 15 (App Router), React 19, native CSS custom properties + CSS Modules (Next.js ships CSS Modules support with zero config — none is used in the app yet, this plan introduces the first `.module.css` files). No Tailwind, no CSS-in-JS, no component library.

## Global Constraints

**Deliberate scope narrowing vs. the design spec (flagged, not silent):** the
approved spec's Phase 1 description says it "builds the entire token layer
and primitive library (all rows in the inventory table)" — 16 components.
This plan builds only the **7 primitives the 7 target screens actually
consume**: `Button`/`IconButton`, `Card`, `Badge`, `Input`/`Textarea`/`Select`,
`Tabs`, `Meter`, plus restyled `PageHeader`/`EmptyState`. `Toggle`, `ListRow`,
`Table`, `Modal`, `Toast`, `Tooltip`, `Avatar` have **no consumer among this
plan's 7 screens** (checked against a full className audit) — building them
now would be speculative, unconsumed code, which cuts against both the
token-budget constraint that capped this to 2 phases and this repo's own
YAGNI convention. They move to Phase 2, built alongside the first screen that
actually needs each one (e.g. `Avatar`/`ListRow` with Team, `Table` with CRM,
`Toggle` with Automation).

- Editorial direction, locked palette/type/shape from `docs/superpowers/specs/2026-07-09-ui-revamp-design.md`: warm paper canvas, ink text, single muted-teal accent (`--accent`), `Fraunces` display serif + existing `Inter` body, **8px card radius / 6px control radius, no pill buttons**, hairline borders (not shadows) for elevation, 160ms/220ms restrained motion, **no font weight above 500 anywhere**.
- No dark mode shipped — tokens stay light-only; do not add `[data-theme="dark"]` overrides in this plan.
- No new features, no new API calls, no copy rewrite beyond what a touched screen's header/labels need for sentence-case consistency.
- Primitives live under `apps/web/src/components/ui/` (new directory), imported via the existing `@/src/components/...` path alias (see `apps/web/tsconfig.json` `"@/*": ["./*"]`).
- Every task ends with `npm run build -w apps/web` green plus a manual dev-server visual check of the screen(s) touched — this codebase has no visual-regression tooling and none is being added (per spec, Testing section).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` on every commit (repo convention).
- **Do not merge to `main`.** Push the branch; the founder reviews and merges (repo-wide convention observed throughout this project).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `apps/web/app/tokens.css` | Create | The full token layer — same variable names as today, Editorial values, two additions (`--dur-fast`, `--dur-base`). |
| `apps/web/app/globals.css` | Modify | `:root` block (lines 1–56) replaced by `@import "./tokens.css";`; everything else unchanged in Task 1, progressively trimmed as later tasks migrate sections. |
| `apps/web/app/layout.tsx` | Modify | Swap unused `Instrument_Serif` for `Fraunces` (weights 400/500), wire `--font-fraunces`. |
| `apps/web/src/components/ui/button.tsx` + `.module.css` | Create | `Button` (variant × size) + `IconButton`. |
| `apps/web/src/components/ui/card.tsx` + `.module.css` | Create | `Card` + `CardHeader`. |
| `apps/web/src/components/ui/badge.tsx` + `.module.css` | Create | `Badge` (tone-based state chip). |
| `apps/web/src/components/ui/input.tsx` + `.module.css` | Create | `Input`, `Textarea`, `Select`. |
| `apps/web/src/components/ui/tabs.tsx` + `.module.css` | Create | `Tabs` (filter-tab replacement). |
| `apps/web/src/components/ui/meter.tsx` + `.module.css` | Create | `Meter` (generalized from billing's usage bars). |
| `apps/web/src/components/page-header.tsx` + `.module.css` | Modify | Restyle only — props unchanged. |
| `apps/web/src/components/empty-state.tsx` + `.module.css` | Modify | Restyle only — props unchanged. |
| `apps/web/app/workspaces/[id]/layout.tsx` | Modify (CSS only, in `globals.css`) | Sidebar/shell restyle — JSX class names unchanged, only CSS values. |
| `apps/web/app/onboarding/**` | Modify | Onboarding wizard re-skin onto primitives. |
| `apps/web/app/page.tsx` | Modify | Home re-skin. |
| `apps/web/app/workspaces/[id]/page.tsx` | Modify | Workspace home re-skin. |
| `apps/web/app/workspaces/[id]/brain/page.tsx` | Modify | Brain editor re-skin. |
| `apps/web/app/workspaces/[id]/approvals/page.tsx` | Modify | Approval queue re-skin. |
| `apps/web/app/workspaces/[id]/billing/page.tsx` | Modify | Billing re-skin onto `Meter`. |

---

## Task 1: Token repaint + font swap (foundation — do first, sequentially)

**Files:**
- Create: `apps/web/app/tokens.css`
- Modify: `apps/web/app/globals.css:1-56`
- Modify: `apps/web/app/layout.tsx`

**Interfaces produced:** every CSS custom property listed below, at their new Editorial values. All later tasks (primitives and screens) consume these by name — no new names are introduced except `--dur-fast` and `--dur-base`.

**Why this task alone matters:** because every existing class in `globals.css` already reads these variables (`.panel { background: var(--panel); }`, `.button-secondary { background: var(--panel); border-color: var(--border-strong); }`, etc.), this one task re-themes the *entire app* — all ~32 nav-registered screens, not just the 7 this plan re-skins — with zero `.tsx` changes. This is deliberate leverage for the token-budget constraint.

- [ ] **Step 1: Create the token file**

```css
/* apps/web/app/tokens.css */
/* Tuezday design system — "Editorial" direction (2026-07-09 revamp).
   Warm paper canvas, ink text, one muted-teal accent, Fraunces display
   serif + Inter body, hairline-bordered cards, no pill buttons. */

:root {
  /* Surfaces */
  --bg: oklch(0.965 0.012 85);
  --panel: oklch(0.98 0.008 85);
  --panel-2: oklch(0.95 0.014 82);

  /* Borders */
  --border: oklch(0.87 0.015 75);
  --border-strong: oklch(0.79 0.02 75);

  /* Ink */
  --text: oklch(0.22 0.012 60);
  --muted: oklch(0.47 0.014 60);
  --muted-2: oklch(0.62 0.012 65);

  /* Accent — the one primary-action / positive-state color */
  --accent: oklch(0.46 0.055 165);
  --accent-deep: oklch(0.36 0.05 165);
  --accent-soft: oklch(0.93 0.025 165);
  --accent-ink: oklch(0.99 0.004 165);

  /* Categorical tones (nav groups, layer badges) — desaturated, paper-safe */
  --c1: oklch(0.62 0.10 35);
  --c2: oklch(0.65 0.09 75);
  --c3: oklch(0.63 0.07 130);
  --c4: oklch(0.62 0.06 205);
  --c5: var(--accent);
  --c6: oklch(0.58 0.07 350);
  --c1-deep: oklch(0.48 0.11 32);
  --c2-deep: oklch(0.50 0.09 70);
  --c3-deep: oklch(0.48 0.07 128);
  --c4-deep: oklch(0.47 0.06 205);
  --c5-deep: var(--accent-deep);
  --c6-deep: oklch(0.44 0.07 350);
  --c1-wash: oklch(0.94 0.03 40);
  --c2-wash: oklch(0.94 0.03 78);
  --c3-wash: oklch(0.94 0.025 132);
  --c4-wash: oklch(0.94 0.02 205);
  --c5-wash: var(--accent-soft);
  --c6-wash: oklch(0.94 0.025 350);

  /* Semantic aliases used directly by state-chip CSS — unchanged names */
  --lavender: var(--c5-wash);
  --lavender-ink: var(--c5-deep);
  --mint: var(--c4-wash);
  --mint-ink: var(--c4-deep);
  --amber: var(--c2-wash);
  --amber-ink: var(--c2-deep);
  --peach: var(--c1-wash);
  --peach-ink: var(--c1-deep);
  --rose: var(--c6-wash);
  --rose-ink: var(--c6-deep);

  --danger: oklch(0.48 0.14 30);
  --ok: oklch(0.52 0.10 150);

  /* Shape */
  --radius: 8px;
  --radius-sm: 6px;
  --radius-lg: 12px;

  /* Elevation — reserved for popovers/modals/toasts only; cards use borders */
  --shadow-low: 0 1px 2px oklch(0.22 0.02 60 / 0.06), 0 3px 10px oklch(0.22 0.02 60 / 0.05);
  --shadow-modal: 0 16px 50px oklch(0.22 0.03 60 / 0.16);

  /* Motion */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --dur-fast: 160ms;
  --dur-base: 220ms;

  /* Type */
  --font-display: var(--font-fraunces, Georgia, serif);
  --font-body: var(--font-inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif);
}
```

- [ ] **Step 2: Point `globals.css` at it**

Replace `apps/web/app/globals.css` lines 1–56 (the header comment + entire `:root { ... }` block) with:

```css
/* Tuezday design system — token values live in ./tokens.css (Editorial
   direction, 2026-07-09 revamp). This file holds true globals (reset, body
   base styles) plus not-yet-migrated component classes. */
@import "./tokens.css";
```

Leave everything from the current line 57 onward (`* { box-sizing: border-box; }` and all component sections) untouched for this task.

- [ ] **Step 3: Swap the display font**

In `apps/web/app/layout.tsx`, replace:

```tsx
import { Inter, Instrument_Serif } from "next/font/google";
```
```tsx
const instrumentSerif = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-instrument-serif",
});
```
```tsx
<html lang="en" className={`${inter.variable} ${instrumentSerif.variable}`}>
```

with:

```tsx
import { Inter, Fraunces } from "next/font/google";
```
```tsx
const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-fraunces",
});
```
```tsx
<html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
```

(`Instrument_Serif` was imported but never referenced by any CSS — confirmed via repo-wide search — so this is a pure swap, not a removal of live behavior.)

- [ ] **Step 4: Verify**

```bash
npm run build -w apps/web
```
Expected: succeeds. Then `npm run dev` and open `/`, a workspace home, and `/workspaces/:id/brain` — confirm the whole app now renders in the warm-paper/teal palette with serif page titles, with **zero other files changed**. This is the proof that the token-name-preservation strategy worked.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/tokens.css apps/web/app/globals.css apps/web/app/layout.tsx
git commit -m "UI revamp: Editorial token repaint + Fraunces display font

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `Button` + `IconButton` primitive

**Files:**
- Create: `apps/web/src/components/ui/button.tsx`
- Create: `apps/web/src/components/ui/button.module.css`

**Interfaces produced:**
```ts
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";
function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }): JSX.Element;
function IconButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): JSX.Element;
```
Screens import: `import { Button, IconButton } from "@/src/components/ui/button";`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/button.tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./button.module.css";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [styles.button, styles[variant], styles[size], className]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, className, children, ...rest }: IconButtonProps) {
  const classes = [styles.iconButton, className].filter(Boolean).join(" ");
  return (
    <button className={classes} aria-label={label} {...rest}>
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Write the styles**

```css
/* apps/web/src/components/ui/button.module.css */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: var(--font-body);
  font-weight: 500;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
  text-decoration: none;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.button:disabled {
  opacity: 0.5;
  cursor: default;
}

.md {
  padding: 9px 18px;
  font-size: 14px;
}

.sm {
  padding: 6px 12px;
  font-size: 13px;
}

.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

.primary:hover:not(:disabled) {
  background: var(--accent-deep);
  border-color: var(--accent-deep);
}

.secondary {
  background: var(--panel);
  border-color: var(--border-strong);
  color: var(--text);
}

.secondary:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent-deep);
}

.ghost {
  background: none;
  border-color: transparent;
  color: var(--text);
  padding-left: 0;
  padding-right: 0;
  text-decoration: underline;
  text-decoration-color: var(--border-strong);
  text-underline-offset: 3px;
}

.ghost:hover:not(:disabled) {
  color: var(--accent-deep);
}

.danger {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

.danger:hover:not(:disabled) {
  filter: brightness(0.92);
}

.iconButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.iconButton:hover {
  border-color: var(--accent);
  color: var(--accent-deep);
}
```

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```
Expected: succeeds (component is unused so far — build passing proves no syntax/type errors).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/button.tsx apps/web/src/components/ui/button.module.css
git commit -m "UI revamp: Button + IconButton primitive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `Card` + `CardHeader` primitive

**Files:**
- Create: `apps/web/src/components/ui/card.tsx`
- Create: `apps/web/src/components/ui/card.module.css`
- Modify: `apps/web/app/globals.css` (one small addition, Step 3 below)

**Interfaces produced:**
```ts
function Card(props: HTMLAttributes<HTMLDivElement>): JSX.Element;
function CardHeader(props: { title: ReactNode; actions?: ReactNode }): JSX.Element;
```

**Important — animation bridge:** the existing `.module-in .panel, .module-in .page-header` selector in `globals.css` (around line 1651) drives the per-route fade-in. `Card` will render CSS-Modules-scoped class names (e.g. `Card_card__a1b2c`), which that selector cannot match. `Card` therefore also stamps a stable, unscoped `ui-card` class alongside its module class, and this task extends the global selector to include it — this is the only place a primitive intentionally carries a second, non-module class name, and it exists solely to keep the existing fade-in working across the migration.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/card.tsx
import type { HTMLAttributes, ReactNode } from "react";
import styles from "./card.module.css";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ className, children, ...rest }: CardProps) {
  const classes = [styles.card, "ui-card", className].filter(Boolean).join(" ");
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({ title, actions }: CardHeaderProps) {
  return (
    <div className={styles.header}>
      <h2 className={styles.title}>{title}</h2>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Write the styles**

```css
/* apps/web/src/components/ui/card.module.css */
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 20px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 500;
  margin: 0;
  color: var(--text);
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
```

- [ ] **Step 3: Bridge the module-in animation**

In `apps/web/app/globals.css`, find:

```css
  .module-in .panel,
  .module-in .page-header {
    animation: module-in 0.45s var(--ease-out) backwards;
  }
```

Replace with:

```css
  .module-in .panel,
  .module-in .page-header,
  .module-in .ui-card,
  .module-in .ui-page-header {
    animation: module-in 0.45s var(--ease-out) backwards;
  }
```

(`.ui-page-header` is added by Task 9 below — adding it now means Task 9 needs no further edit to this selector.)

- [ ] **Step 4: Verify**

```bash
npm run build -w apps/web
```
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/card.tsx apps/web/src/components/ui/card.module.css apps/web/app/globals.css
git commit -m "UI revamp: Card + CardHeader primitive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `Badge` primitive

**Files:**
- Create: `apps/web/src/components/ui/badge.tsx`
- Create: `apps/web/src/components/ui/badge.module.css`

**Interfaces produced:**
```ts
type BadgeTone = "neutral" | "approved" | "pending" | "edited" | "rejected" | "draft" | "danger";
function Badge(props: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }): JSX.Element;
```

**Design note (deliberate, not an oversight):** the current `.layer-badge` sets `text-transform: uppercase`. `Badge` removes it — Editorial's restraint reads uppercase pills as loud/SaaS-badge rather than document-like. Every current call site already passes sentence-case label text (e.g. `"Pending review"`, `"Approved"`), so this is a pure visual change with no text-content updates needed at any call site.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/badge.tsx
import type { HTMLAttributes, ReactNode } from "react";
import styles from "./badge.module.css";

type BadgeTone = "neutral" | "approved" | "pending" | "edited" | "rejected" | "draft" | "danger";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children: ReactNode;
}

export function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  const classes = [styles.badge, styles[tone], className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Write the styles**

```css
/* apps/web/src/components/ui/badge.module.css */
.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 500;
  border-radius: 999px;
  padding: 2px 9px;
  border: 1px solid transparent;
  line-height: 1.5;
}

.neutral {
  color: var(--muted);
  background: var(--panel-2);
}

.approved {
  color: var(--mint-ink);
  background: var(--mint);
}

.pending {
  color: var(--lavender-ink);
  background: var(--lavender);
}

.edited {
  color: var(--amber-ink);
  background: var(--amber);
}

.rejected {
  color: var(--rose-ink);
  background: var(--rose);
}

.draft {
  color: var(--muted);
  background: var(--panel-2);
}

.danger {
  color: var(--rose-ink);
  background: var(--rose);
}
```

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/badge.tsx apps/web/src/components/ui/badge.module.css
git commit -m "UI revamp: Badge primitive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `Input` / `Textarea` / `Select` primitives

**Files:**
- Create: `apps/web/src/components/ui/input.tsx`
- Create: `apps/web/src/components/ui/input.module.css`

**Interfaces produced:**
```ts
function Input(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element;
function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element;
function Select(props: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element;
```

- [ ] **Step 1: Write the components**

```tsx
// apps/web/src/components/ui/input.tsx
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import styles from "./input.module.css";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const classes = [styles.field, className].filter(Boolean).join(" ");
  return <input className={classes} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const classes = [styles.field, styles.textarea, className].filter(Boolean).join(" ");
  return <textarea className={classes} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const classes = [styles.field, styles.select, className].filter(Boolean).join(" ");
  return (
    <select className={classes} {...rest}>
      {children}
    </select>
  );
}
```

- [ ] **Step 2: Write the styles**

```css
/* apps/web/src/components/ui/input.module.css */
.field {
  width: 100%;
  padding: 9px 12px;
  min-height: 36px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--panel);
  color: var(--text);
  font-size: 14px;
  font-family: var(--font-body);
}

.field:focus-visible {
  outline: 2px solid var(--accent-soft);
  outline-offset: 1px;
  border-color: var(--accent);
}

.field::placeholder {
  color: var(--muted-2);
}

.textarea {
  min-height: 96px;
  resize: vertical;
  line-height: 1.6;
}

.select {
  cursor: pointer;
}
```

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/input.tsx apps/web/src/components/ui/input.module.css
git commit -m "UI revamp: Input/Textarea/Select primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `Tabs` primitive

**Files:**
- Create: `apps/web/src/components/ui/tabs.tsx`
- Create: `apps/web/src/components/ui/tabs.module.css`

**Interfaces produced:**
```ts
interface Tab { key: string; label: ReactNode; }
function Tabs(props: { tabs: Tab[]; active: string; onChange: (key: string) => void }): JSX.Element;
```

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/tabs.tsx
import styles from "./tabs.module.css";
import type { ReactNode } from "react";

interface Tab {
  key: string;
  label: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (key: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div className={styles.tabs} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          className={`${styles.tab} ${tab.key === active ? styles.active : ""}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Write the styles**

```css
/* apps/web/src/components/ui/tabs.module.css */
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.tab {
  padding: 7px 15px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--panel);
  color: var(--muted);
  font-size: 13px;
  font-family: var(--font-body);
  cursor: pointer;
}

.active {
  background: var(--text);
  border-color: var(--text);
  color: var(--bg);
}
```

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/tabs.tsx apps/web/src/components/ui/tabs.module.css
git commit -m "UI revamp: Tabs primitive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `Meter` primitive (generalized from Billing's usage bars)

**Files:**
- Create: `apps/web/src/components/ui/meter.tsx`
- Create: `apps/web/src/components/ui/meter.module.css`

**Interfaces:**
- Consumes: `packages/contracts`' existing `usageMeter(used, limit): { percent: number; state: "ok" | "near" | "over" | "unlimited" }` (already shipped, Billing already calls it — no contract changes).
- Produces:
```ts
type MeterState = "ok" | "near" | "over" | "unlimited";
function Meter(props: { label: string; figure: string; percent: number; state: MeterState }): JSX.Element;
```

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/ui/meter.tsx
import styles from "./meter.module.css";

export type MeterState = "ok" | "near" | "over" | "unlimited";

interface MeterProps {
  label: string;
  figure: string;
  percent: number;
  state: MeterState;
}

export function Meter({ label, figure, percent, state }: MeterProps) {
  return (
    <div>
      <div className={styles.head}>
        <span className={styles.title}>{label}</span>
        <span className={styles.figure}>{figure}</span>
      </div>
      <div className={styles.track}>
        <div
          className={`${styles.fill} ${styles[state]}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the styles**

```css
/* apps/web/src/components/ui/meter.module.css */
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}

.title {
  font-weight: 500;
  color: var(--text);
  font-size: 14px;
}

.figure {
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
}

.track {
  height: 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  border: 1px solid var(--border);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.4s var(--ease-out);
}

.near {
  background: var(--c2-deep);
}

.over {
  background: var(--danger);
}

.unlimited {
  background: var(--accent);
  opacity: 0.35;
}
```

(Pills are acceptable here — this is a progress *track*, not a button; the spec's "no pill buttons" rule targets buttons specifically.)

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/meter.tsx apps/web/src/components/ui/meter.module.css
git commit -m "UI revamp: Meter primitive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `EmptyState` restyle (props unchanged)

**Files:**
- Modify: `apps/web/src/components/empty-state.tsx`
- Create: `apps/web/src/components/empty-state.module.css`

**Interfaces:** unchanged — `{ title?: string; description: string | ReactNode; icon?: ReactNode; primaryAction?: ReactNode }`. Every existing call site (`apps/web/app/workspaces/[id]/page.tsx`, `.../ads/page.tsx`, `.../connectors/page.tsx`, `.../insights/page.tsx`, `.../launches/page.tsx`, and others) needs **zero changes** — this task only touches the component's internals.

- [ ] **Step 1: Update the component to use the module**

```tsx
// apps/web/src/components/empty-state.tsx
import React from "react";
import styles from "./empty-state.module.css";

interface EmptyStateProps {
  title?: string;
  description: string | React.ReactNode;
  icon?: React.ReactNode;
  primaryAction?: React.ReactNode;
}

export function EmptyState({ title, description, icon, primaryAction }: EmptyStateProps) {
  return (
    <div className={styles.wrap}>
      {icon && <div className={styles.icon}>{icon}</div>}
      {title && <h3 className={styles.title}>{title}</h3>}
      <div className={styles.description}>{description}</div>
      {primaryAction && <div className={styles.action}>{primaryAction}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Write the styles**

```css
/* apps/web/src/components/empty-state.module.css */
.wrap {
  display: grid;
  gap: 10px;
  color: var(--muted);
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: 32px 24px;
  text-align: center;
  font-size: 14px;
  line-height: 1.6;
  background: var(--panel);
}

.icon {
  font-size: 24px;
  color: var(--muted-2);
}

.title {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 16px;
  color: var(--text);
}

.description {
  color: var(--muted);
}

.action {
  display: flex;
  justify-content: center;
}
```

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```
Then open any screen using `EmptyState` in an empty account (e.g. `/workspaces/:id/connectors` with no connections) and confirm it still renders correctly with the new visual style.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/empty-state.tsx apps/web/src/components/empty-state.module.css
git commit -m "UI revamp: restyle EmptyState (props unchanged)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: `PageHeader` restyle (props unchanged)

**Files:**
- Modify: `apps/web/src/components/page-header.tsx`
- Create: `apps/web/src/components/page-header.module.css`

**Interfaces:** unchanged — `{ title: string; subtitle?: string | ReactNode; actions?: ReactNode }`. Every current call site across the app keeps working with zero changes.

**Depends on:** Task 3 (the `.ui-page-header` bridge class it needs was already added to `globals.css`'s `.module-in` selector in that task).

- [ ] **Step 1: Update the component to use the module**

```tsx
// apps/web/src/components/page-header.tsx
import React from "react";
import styles from "./page-header.module.css";

interface PageHeaderProps {
  title: string;
  subtitle?: string | React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className={`${styles.header} ui-page-header`}>
      <div>
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Write the styles**

```css
/* apps/web/src/components/page-header.module.css */
.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 26px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}

.title {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 500;
  margin: 0;
  color: var(--text);
  letter-spacing: -0.01em;
}

.subtitle {
  margin-top: 4px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.5;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
```

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```
Open a couple of screens that already use `PageHeader` (e.g. `/workspaces/:id/insights`, `/workspaces/:id/launches`) — confirm the title now renders in the Fraunces serif at 28px and the fade-in-on-route-change animation still fires (proves the `.ui-page-header` bridge works).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/page-header.tsx apps/web/src/components/page-header.module.css
git commit -m "UI revamp: restyle PageHeader with Fraunces titles (props unchanged)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Sidebar / workspace shell restyle (CSS only — JSX unchanged)

**Files:**
- Modify: `apps/web/app/globals.css` (the `/* ---------- Workspace shell: sidebar + content ---------- */` section, currently lines 125–438)

**Interfaces:** none — `apps/web/app/workspaces/[id]/layout.tsx`'s JSX and class names (`ws-shell`, `ws-sidebar`, `ws-nav-item`, etc.) are untouched. This task is a pure CSS restyle because the shell's markup was already clean/semantic — there's no duplication to fix, only visual values.

**Deliberate simplifications from current CSS** (both align with Editorial's restraint, called out so the diff isn't a surprise):
1. `.ws-mark`'s 4-color striped inset `box-shadow` (a decorative "confetti" flourish) is dropped for a flat ink-on-panel square — matches the spec's "no gradients/decorative confetti" posture.
2. All `font-weight` values above 500 (780, 680, 650, 560) are capped at 500, per the global constraint.

- [ ] **Step 1: Replace the shell CSS section**

In `apps/web/app/globals.css`, replace the entire block from `.ws-shell {` through the closing `}` of the `@media (max-width: 860px)` rule (the whole "Workspace shell" section) with:

```css
/* ---------- Workspace shell: sidebar + content ---------- */

.ws-shell {
  display: grid;
  grid-template-columns: 272px 1fr;
  min-height: 100vh;
  background: var(--bg);
}

.ws-sidebar {
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.ws-brand-block {
  display: grid;
  gap: 4px;
  padding: 2px 2px 4px;
}

.ws-logo {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 9px;
}

.ws-mark {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  display: inline-grid;
  place-items: center;
  background: var(--text);
  color: var(--panel);
  font-family: var(--font-display);
  font-weight: 500;
  line-height: 1;
}

.ws-kicker,
.ws-workspace-label {
  color: var(--muted-2);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.ws-workspace-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  display: grid;
  gap: 8px;
}

.ws-name {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-health-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ws-health-row span {
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  background: var(--panel);
  padding: 3px 7px;
  font-size: 11.5px;
  line-height: 1.2;
}

.ws-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ws-nav-group,
.ws-nav-child {
  --nav-tone: var(--c5);
  --nav-deep: var(--c5-deep);
  --nav-wash: var(--c5-wash);
}

.ws-nav-group[data-tone="belief"],
.ws-nav-child[data-tone="belief"] {
  --nav-tone: var(--c1);
  --nav-deep: var(--c1-deep);
  --nav-wash: var(--c1-wash);
}

.ws-nav-group[data-tone="voice"],
.ws-nav-child[data-tone="voice"] {
  --nav-tone: var(--c2);
  --nav-deep: var(--c2-deep);
  --nav-wash: var(--c2-wash);
}

.ws-nav-group[data-tone="history"],
.ws-nav-child[data-tone="history"] {
  --nav-tone: var(--c3);
  --nav-deep: var(--c3-deep);
  --nav-wash: var(--c3-wash);
}

.ws-nav-group[data-tone="icp"],
.ws-nav-child[data-tone="icp"] {
  --nav-tone: var(--c4);
  --nav-deep: var(--c4-deep);
  --nav-wash: var(--c4-wash);
}

.ws-nav-group[data-tone="system"],
.ws-nav-child[data-tone="system"] {
  --nav-tone: var(--c5);
  --nav-deep: var(--c5-deep);
  --nav-wash: var(--c5-wash);
}

.ws-nav-group[data-tone="signal"],
.ws-nav-child[data-tone="signal"] {
  --nav-tone: var(--c6);
  --nav-deep: var(--c6-deep);
  --nav-wash: var(--c6-wash);
}

.ws-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  color: var(--text);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid transparent;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.ws-nav-item:hover {
  background: var(--bg);
}

.ws-nav-item.active {
  background: var(--bg);
  border-color: var(--border);
  box-shadow: inset 3px 0 0 var(--nav-tone);
}

.ws-nav-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.ws-nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-nav-summary {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 400;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-nav-children {
  display: grid;
  gap: 2px;
  margin: 4px 0 6px 12px;
  padding-left: 9px;
  border-left: 1px solid color-mix(in oklch, var(--nav-tone) 36%, var(--border));
}

.ws-nav-child {
  color: var(--muted);
  font-weight: 500;
  font-size: 12.5px;
  min-height: 28px;
  padding: 6px 9px;
  background: transparent;
}

.ws-nav-child.active {
  color: var(--nav-deep);
  background: var(--nav-wash);
  border-color: color-mix(in oklch, var(--nav-tone) 26%, var(--border));
  box-shadow: none;
}

.ws-nav-child:hover {
  color: var(--nav-deep);
  background: var(--nav-wash);
}

.ws-nav-child::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--border-strong);
  flex: 0 0 auto;
}

.ws-nav-child.active::before {
  background: var(--nav-tone);
}

.ws-nav-child span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-nav-hint {
  font-size: 11px;
  background: var(--accent-soft);
  color: var(--accent-deep);
  border-radius: 999px;
  padding: 1px 8px;
}

.ws-sidebar-foot {
  margin-top: auto;
  padding: 12px 2px 0;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  display: grid;
  gap: 10px;
}

.ws-sidebar-foot a {
  color: var(--muted);
  text-decoration: none;
  font-weight: 500;
}

.ws-sidebar-foot a:hover {
  color: var(--text);
}

.ws-content {
  padding: 34px 42px 72px;
  max-width: 1180px;
  width: 100%;
}

@media (max-width: 860px) {
  .ws-shell {
    grid-template-columns: 1fr;
  }

  .ws-sidebar {
    position: static;
    height: auto;
    max-height: none;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }

  .ws-nav {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }

  .ws-nav-children {
    margin-left: 8px;
  }

  .ws-content {
    padding: 26px 18px 56px;
  }
}
```

- [ ] **Step 2: Verify**

```bash
npm run build -w apps/web
```
Open any workspace page and confirm: sidebar background is now the panel tone (not the old darker panel-2), nav items no longer have heavy font weights, the logo mark is a flat square (no rainbow stripe), everything else (active states, tone-colored left rails on nav groups, collapsible children) behaves identically to before.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "UI revamp: restyle workspace shell/sidebar (markup unchanged)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Home re-skin (`apps/web/app/page.tsx`)

**Files:**
- Modify: `apps/web/app/page.tsx`

**Depends on:** Tasks 2 (Button), 3 (Card — via `.stat-card`/`.workspace-card` pattern, though this screen doesn't use `.panel` directly), 9 (PageHeader, if adopted here — this screen currently uses a raw `<h1>`, left as-is per Step 1 note below).

**Current classNames in this file** (confirmed via audit): `create-form`, `error`, `empty`, `workspace-list`, `workspace-card` (as `<Link>`), `.name`, `.meta`, `link-button` (Resume setup).

- [ ] **Step 1: Replace the "New workspace" button and workspace-card rows**

Find:
```tsx
        <div className="create-form">
          <button type="button" onClick={() => router.push("/onboarding")}>
            New workspace
          </button>
        </div>
```
Replace with:
```tsx
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => router.push("/onboarding")}>
            New workspace
          </Button>
        </div>
```

Find the `Resume setup →` span:
```tsx
                  {w.onboardingStep && w.onboardingStep !== "done" && (
                    <span
                      className="link-button"
                      role="link"
                      onClick={(e) => {
                        e.preventDefault();
                        router.push(`/onboarding?workspace=${w.id}`);
                      }}
                    >
                      Resume setup →
                    </span>
                  )}
```
Replace the `<span className="link-button" ...>` with a `<Button variant="ghost" size="sm" ...>` using the same `onClick`/text — same event-handler pattern, so no other logic changes.

Add the import at the top of the file:
```tsx
import { Button } from "@/src/components/ui/button";
```

Add a tiny local module for the one layout-only class this file needs (`styles.actions`):
```css
/* apps/web/app/home.module.css */
.actions {
  margin-bottom: 24px;
}
```
```tsx
import styles from "./home.module.css";
```

- [ ] **Step 2: Leave everything else** — `.workspace-list`/`.workspace-card`/`.name`/`.meta`/`.empty`/`.error` stay as global classes for now (they're Home-specific list styling, not duplicated elsewhere, and `globals.css` already repainted their colors via Task 1 — no primitive needed for a one-off list).

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```
Then `npm run dev`, open `/`, confirm: "New workspace" is now a solid teal `Button`, workspace cards render in the new palette, "Resume setup →" still navigates correctly.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/home.module.css
git commit -m "UI revamp: re-skin home page onto Button primitive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Workspace home re-skin (`apps/web/app/workspaces/[id]/page.tsx`)

**Files:**
- Modify: `apps/web/app/workspaces/[id]/page.tsx`

**Depends on:** Tasks 2 (Button), 3 (Card), 9 (PageHeader — already used here per the className audit).

**Current classNames in this file:** `page-header` (via `PageHeader` component — no change needed, Task 9 already restyled it), `panel`, `panel-title-row`, `home-grid`, `stat-card`, `stat-label`, `stat-hint`, `stat-number`, `section-card`, `section-head`, `section-list`, `section-reason`, `section-title`, `section-tokens`, `button-secondary`, `error`.

**Mapping (mechanical — apply to every occurrence in the file):**

| Old | New |
|---|---|
| `<div className="panel">...</div>` | `<Card>...</Card>` |
| `<div className="panel-title-row"><h2>X</h2>...</div>` | `<CardHeader title="X" actions={...} />` inside the `Card` |
| `<button className="button-secondary" ...>` | `<Button variant="secondary" size="sm" ...>` |
| `<a className="button-secondary" ...>` (if any) | keep as `<a>`; wrap its visual style by rendering a `Button`-styled `<Link>` — if this pattern occurs, use `<Button asChild>`-style is NOT supported by this primitive (no `asChild` prop was built), so instead apply `import buttonStyles from "@/src/components/ui/button.module.css"` and `className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.sm}`}` directly on the `<Link>`/`<a>`. |

`home-grid` / `stat-card` / `stat-label` / `stat-hint` / `stat-number` and `section-card` / `section-head` / `section-list` / `section-reason` / `section-title` / `section-tokens` are **left as global classes** — they're this screen's own grid/list layout (not duplicated on other screens per the codebase audit), already repainted by Task 1's token change. Only the generic `panel`/`panel-title-row`/`button-secondary` trio — which exist on *every* screen — get replaced with primitives.

- [ ] **Step 1: Add imports**

```tsx
import { Card, CardHeader } from "@/src/components/ui/card";
import { Button } from "@/src/components/ui/button";
```

- [ ] **Step 2: Apply the mapping above** to every `panel` / `panel-title-row` / `button-secondary` occurrence in the file, per the table.

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```
Open a workspace home page — confirm every card-like section (stat grid stays as-is, any `.panel`-wrapped sections now render via `Card`) looks correct, buttons inside them are the new `Button` component.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/workspaces/[id]/page.tsx
git commit -m "UI revamp: re-skin workspace home onto Card/Button primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: Brain editor re-skin (`apps/web/app/workspaces/[id]/brain/page.tsx`)

**Files:**
- Modify: `apps/web/app/workspaces/[id]/brain/page.tsx`

**Depends on:** Tasks 2 (Button), 4 (Badge), 5 (Input/Textarea), 9 (PageHeader).

**Current classNames:** `brain-layout`, `button-secondary danger`, `button-secondary`, `doc-description`, `doc-editor`, `doc-nav`, `doc-title`, `editor-actions`, `error`, `guidance-head`, `guidance-item`, `guidance-list`, `guidance-section`, `history`, `layer-badge layer-campaign`, `layer-badge layer-channel`, `layer-badge layer-persona`, `link-button`, `meta`, `outline-heading`, plus a `<textarea>` for the doc body.

**Mapping:**

| Old | New |
|---|---|
| `className="button-secondary"` | `<Button variant="secondary" size="sm">` |
| `className="button-secondary danger"` | `<Button variant="danger" size="sm">` |
| `className="link-button"` | `<Button variant="ghost" size="sm">` |
| `className="layer-badge layer-campaign"` (and `layer-channel`, `layer-persona`) | These are the *category* layer badges (org/channel/campaign/persona/task/zoom), distinct from *approval-state* badges — `Badge`'s `tone` union (Task 4) covers approval states only. **Leave `layer-badge layer-*` classes as-is** (global CSS, already repainted by Task 1); do not force them into the `Badge` component this task, since `Badge`'s tone set doesn't model these six categorical tones. Note this as a Phase 2 follow-up (extend `Badge` with a `category` tone set, or accept two badge systems). |
| the doc-body `<textarea>` | `<Textarea>` from Task 5, same `value`/`onChange`/other props passed through. |
| `doc-title` (an `<input>`, if the title is editable) | `<Input>` from Task 5. |

`brain-layout`, `doc-nav`, `doc-editor`, `guidance-*`, `history`, `outline-heading`, `meta` stay as global layout classes (Brain-editor-specific structure, not duplicated elsewhere).

- [ ] **Step 1: Add imports**

```tsx
import { Button } from "@/src/components/ui/button";
import { Textarea, Input } from "@/src/components/ui/input";
```

- [ ] **Step 2: Apply the button/textarea/input mapping above.** Leave `layer-badge layer-*` category chips untouched per the table.

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```
Open `/workspaces/:id/brain`, confirm: doc editor textarea still works (typing, saving), Save/Cancel/Delete-style buttons render via `Button`, layer badges (org/channel/campaign/persona) are visually unchanged (still the old pill style — expected, not migrated this task).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/workspaces/[id]/brain/page.tsx"
git commit -m "UI revamp: re-skin Brain editor onto Button/Input primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 14: Approval queue re-skin (`apps/web/app/workspaces/[id]/approvals/page.tsx`)

**Files:**
- Modify: `apps/web/app/workspaces/[id]/approvals/page.tsx`

**Depends on:** Tasks 2 (Button), 4 (Badge), 6 (Tabs), 9 (PageHeader — already used here).

**Current classNames:** `page-header`, `button-secondary rating-accepted`, `button-secondary rating-rejected`, `button-secondary`, `decision-log`, `doc-editor`, `editor-actions`, `error`, `filter-tabs`, `layer-badge layer-campaign`, `layer-badge state-approved` (and by extension the other `state-*` modifiers — `state-pending_review`, `state-edited`, `state-rejected`, `state-draft`), `link-button`, `meta`, `original-content`, `output-text`, `rating-row`, `section-card`, `section-content`, `section-head`, `section-list`.

**This is the primary screen where `Badge`'s state-tone system (Task 4) applies directly** — `layer-badge state-approved` etc. map one-to-one onto `Badge`'s `approved`/`pending`/`edited`/`rejected`/`draft` tones.

**Mapping:**

| Old | New |
|---|---|
| `<span className="layer-badge state-approved">Approved</span>` | `<Badge tone="approved">Approved</Badge>` (and correspondingly `tone="pending"` for `state-pending_review`, `tone="edited"` for `state-edited`, `tone="rejected"` for `state-rejected`, `tone="draft"` for `state-draft`) |
| `className="button-secondary"` | `<Button variant="secondary" size="sm">` |
| `className="button-secondary rating-accepted"` (an active-state modifier on an approve button) | `<Button variant="primary" size="sm">` when the rating is active, `<Button variant="secondary" size="sm">` otherwise — preserve the existing conditional logic that decides "is this the active rating," just swap which `variant` it maps to. |
| `className="button-secondary rating-rejected"` (active reject) | `<Button variant="danger" size="sm">` when active, `variant="secondary"` otherwise. |
| `className="link-button"` | `<Button variant="ghost" size="sm">` |
| `<div className="filter-tabs">...<button className="filter-tab ...">` | `<Tabs tabs={[...]} active={...} onChange={...} />` — construct the `tabs` array from whatever the current filter options are (state filter, e.g. "All" / "Pending" / "Approved" / "Rejected"), passing the existing filter state variable as `active` and the existing filter-setter function as `onChange`. |
| `layer-badge layer-campaign` | Leave as-is (categorical badge, same reasoning as Task 13). |

`decision-log`, `doc-editor`, `original-content`, `output-text`, `rating-row`, `section-card`, `section-content`, `section-head`, `section-list`, `meta` stay as global layout classes.

- [ ] **Step 1: Add imports**

```tsx
import { Button } from "@/src/components/ui/button";
import { Badge } from "@/src/components/ui/badge";
import { Tabs } from "@/src/components/ui/tabs";
```

- [ ] **Step 2: Apply the mapping above**, including reconstructing the filter row as a `Tabs` call.

- [ ] **Step 3: Verify**

```bash
npm run build -w apps/web
```
Open `/workspaces/:id/approvals`, confirm: filter tabs still filter correctly, approval-state badges show the right teal/amber/rose tone per state, accept/reject buttons still submit ratings correctly (test at least one approve and one reject action end-to-end against a real draft in the dev DB).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/workspaces/[id]/approvals/page.tsx"
git commit -m "UI revamp: re-skin approval queue onto Badge/Tabs/Button primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 15: Billing re-skin (`apps/web/app/workspaces/[id]/billing/page.tsx`)

**Files:**
- Modify: `apps/web/app/workspaces/[id]/billing/page.tsx`
- Modify: `apps/web/app/globals.css` (remove the now-superseded `.plan-hero`/`.usage-meter*`/`.meter-track`/`.meter-fill` block — Step 3 below)

**Depends on:** Tasks 3 (Card), 7 (Meter), 9 (PageHeader — already used here).

**Current classNames:** `page-header`, `editor-actions`, `error`, `layer-badge state-approved` (plan-active badge), `meter-track`, `meta`, `panel`, `plan-hero`, `plan-hero-amount`, `plan-hero-name`, `plan-hero-price`, `subtitle`, `usage-alert`, `usage-heading`, `usage-meter`, `usage-meter-figure`, `usage-meter-head`, `usage-meter-title`, `usage-meters`.

This screen already calls the contracts' `usageMeter(used, limit)` helper (confirmed shipped) and loops over entitlements to render one usage row per entitlement. Each row currently builds `.usage-meter-head` / `.usage-meter-title` / `.usage-meter-figure` / `.meter-track` / `.meter-fill` by hand — **this entire per-row block becomes one `<Meter>` call.**

**Mapping:**

| Old | New |
|---|---|
| The whole per-entitlement block (`.usage-meter` wrapper containing `.usage-meter-head` + `.meter-track`/`.meter-fill`) | `<Meter label={entitlementLabel} figure={`${used} / ${limit}`} percent={usageMeter(used, limit).percent} state={usageMeter(used, limit).state} />` |
| `className="panel"` (the plan-hero and usage-section wrappers) | `<Card>` |
| `className="usage-alert"` (the pulsing over-limit warning text) | **Keep as a global class** — it's a one-off text-alert pattern with its own `usage-pulse` keyframe animation, not a primitive-worthy pattern. Its color already repaints via Task 1 (`var(--danger)`). |
| `plan-hero`, `plan-hero-name`, `plan-hero-amount`, `plan-hero-price` | Leave as global classes — Billing-specific hero layout, not duplicated elsewhere. |

- [ ] **Step 1: Add imports**

```tsx
import { Card } from "@/src/components/ui/card";
import { Meter } from "@/src/components/ui/meter";
```

- [ ] **Step 2: Replace each per-entitlement usage block** with a single `<Meter>` call per the mapping table, and wrap the plan-hero / usage-section containers in `<Card>`.

- [ ] **Step 3: Remove the now-dead CSS.** In `apps/web/app/globals.css`, delete the `.usage-meters`, `.usage-meter-head`, `.usage-meter-title`, `.usage-meter-figure`, `.meter-track`, `.meter-fill` (and its `.near`/`.over`/`.unlimited` modifiers) rules — everything from the "UI polish (2026-07-03): billing meters" comment through the `.meter-fill.unlimited` rule, **except** keep `.plan-hero`, `.plan-hero-name`, `.plan-hero-price`, `.plan-hero-amount`, `.usage-heading`, `.usage-alert`, and the `@keyframes usage-pulse` block (still in use).

- [ ] **Step 4: Verify**

```bash
npm run build -w apps/web
```
Open `/workspaces/:id/billing`, confirm: plan hero card renders, each usage bar (generations/connectors/seats) shows correct percent/color (test with a workspace near or over a limit if one exists in the dev DB to confirm the `near`/`over` color states still trigger), the over-limit pulse animation still runs.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/workspaces/[id]/billing/page.tsx" apps/web/app/globals.css
git commit -m "UI revamp: re-skin billing onto Card/Meter primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 16: Onboarding wizard re-skin (`apps/web/app/onboarding/**`)

**Files:**
- Modify: `apps/web/app/onboarding/page.tsx`
- Modify: `apps/web/app/onboarding/_components/*.tsx` (name-panel, website-panel, connect-panel, verify-panel, brain-panel, campaign-panel, draft-panel — all seven wizard step panels)
- Modify: `apps/web/app/onboarding/onboarding.css` and its per-panel companions (`connect-panel.css`, `verify-panel.css`, `brain-panel.css`, `campaign-panel.css`, `draft-panel.css`)

**Depends on:** Tasks 2 (Button), 3 (Card), 5 (Input).

**This is the biggest single task in Phase 1** — the wizard is the app's most-tested, most-recently-built surface (Sprints 36.1–36.7), and per the design spec is the highest-visibility Editorial showcase. It is also the one place `.ob-panel`/`.ob-input`/`.ob-actions` classes (defined in `onboarding.css`) currently hand-roll card/input/button-row styling independently of `globals.css`'s `.panel`/`.button-secondary` — this task retires that parallel system in favor of the shared primitives.

**Mapping (apply across every panel file):**

| Old (`onboarding.css` classes) | New |
|---|---|
| `<section className="panel ob-panel">` | `<Card className={styles.obPanel}>` — keep a slim `obPanel` layout-only modifier class (max-width, animation-delay stagger) if the current `.ob-panel` rules include anything beyond what `Card` already provides; otherwise drop the wrapper class entirely. |
| `<input className="ob-input" ...>` | `<Input ...>` (same props) |
| `<button>Continue</button>` (styled implicitly by the browser default, or via ad-hoc inline classes per panel) | `<Button variant="primary">Continue</Button>` |
| `<button type="button" className="link-button" onClick={...}>Back</button>` | `<Button variant="ghost" size="sm" onClick={...}>Back</Button>` |
| `<div className="ob-actions">` | Keep as a layout-only flex-row wrapper class (it's purely `display: flex; justify-content: space-between;` — no color/radius/shadow — so it doesn't violate the "no bespoke styling" rule and needs no primitive). |
| Per-panel bespoke card/progress-bar/badge markup (the reading-progress bar in `connect-panel.tsx`, the doc-reveal cards in `brain-panel.tsx`, the channel chips in `campaign-panel.tsx`) | These are wizard-specific compound widgets, not reusable primitives — leave their internal structure as-is, but any plain `<div className="...">` acting as a bordered card wrapper inside them becomes `<Card>`, and any button inside them becomes `<Button>`, per the same rules as above. |

- [ ] **Step 1: Add imports to `apps/web/app/onboarding/page.tsx` and each `_components/*-panel.tsx` file that renders a button, input, or bare bordered wrapper**

```tsx
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
```

- [ ] **Step 2: Apply the mapping table above** to `page.tsx` and all seven panel files.

- [ ] **Step 3: Trim `onboarding.css` and its companions.** Once a panel's markup no longer references `.ob-panel`/`.ob-input` for anything beyond layout, remove the now-dead color/radius/shadow declarations from that class in the corresponding `.css` file, keeping only true layout rules (flex/grid arrangement, gap, max-width). Do this per-file as each panel is migrated — don't do a blanket delete until all seven are done.

- [ ] **Step 4: Verify — full manual walkthrough**

```bash
npm run build -w apps/web
```
Then `npm run dev` and walk the entire 7-step flow end-to-end for a fresh workspace: name → website (bare-domain input still works, per the 36.7 fix) → connect a social → verify the extracted profile → Meet your Brain reveal → campaign quick-setup → first draft lands in Review. Confirm every button/input/card renders via the new primitives and no interaction regressed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/onboarding
git commit -m "UI revamp: re-skin onboarding wizard onto Button/Card/Input primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 17: Final integration verify + push

**Files:** none (verification only)

- [ ] **Step 1: Full automated verification**

```bash
npm test
npm run typecheck
npm run build -w apps/web
```
Expected: all green (this UI work touches no API/contracts code, so `npm test`/`typecheck` should be unaffected — this step exists to *prove* that, not because CSS/component changes are expected to break them).

- [ ] **Step 2: Spot-check un-migrated (Phase 2) screens still render correctly**

`npm run dev`, open 2–3 screens *not* touched by this plan (e.g. `/workspaces/:id/campaigns`, `/workspaces/:id/crm`, `/workspaces/:id/connectors`) — confirm they render in the new Editorial palette (proving Task 1's leverage claim held) with no visual breakage, even though their JSX still uses the old global classes untouched.

- [ ] **Step 3: Grep check for accidental bespoke styling** (the spec's enforcement rule)

```bash
grep -rnE "color:\s*#|background:\s*#|border-radius:\s*[0-9]" apps/web/src/components/ui apps/web/app/tokens.css
```
Expected: no matches in `components/ui/**` (all primitives read tokens only) — matches inside `tokens.css` itself are fine (that's where literals belong).

- [ ] **Step 4: Update the design spec's progress log**

Append to `docs/superpowers/specs/2026-07-09-ui-revamp-design.md`:
```markdown
## Progress log

- 2026-07-09 — Spec drafted...
- <today's date> — Phase 1 implemented: tokens.css + 7 primitives (Button,
  Card, Badge, Input/Textarea/Select, Tabs, Meter, plus restyled
  PageHeader/EmptyState) + shell/onboarding/home/workspace-home/brain/
  approvals/billing re-skinned. Full suite green, typecheck green, web
  build green. Phase 2 (remaining ~26 screens) not started.
```

- [ ] **Step 5: Push the branch**

```bash
git add docs/superpowers/specs/2026-07-09-ui-revamp-design.md
git commit -m "UI revamp: Phase 1 progress log

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push -u origin ui-revamp-design
```

Do NOT open a PR into `main` or merge — the founder reviews and merges, per repo convention.

---

## Out of scope (Phase 2 — separately scoped, not started here)

Every other `WORKSPACE_NAV` entry: Content, Playground, Ad creatives (Create group); Campaign home, Calendar, Cadence, Automation, Ads, Launch ads, Insights (Campaigns group); Discover; Outbound, Lists & segments, Launches, CRM, PR & media (Audience group); Integrations, Team, Activity (remaining Settings); Evidence library, Learning, Inbox (remaining Review group). These already inherit the new palette/type from Task 1 but keep their old global-class markup until a Phase 2 plan re-skins them onto the now-existing primitive library — expected to be mechanical, per the design spec.

## Progress log

- 2026-07-09 — Plan written on branch `ui-revamp-design`, grounded in a direct read of `globals.css`, the workspace shell, `PageHeader`/`EmptyState`, and a className audit of all 7 target screens (no research-agent dependency after an earlier background-agent dispatch was reported as not running). Not yet implemented.
