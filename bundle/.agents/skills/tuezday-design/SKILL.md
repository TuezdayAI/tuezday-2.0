---
name: tuezday-design
description: Tuezday's design language. Read before building or changing any UI in apps/web — tokens, typography, spacing, component patterns, and required states. Use when creating pages, components, forms, tables, dashboards, or empty/loading/error states.
---

# Tuezday design language

> **FOUNDER: fill the TODO blocks before the first UI sprint.** Until then this file
> still enforces the structural rules below, which matter more than the palette.

## Non-negotiables (apply even before the TODOs are filled)

1. **Every async view ships four states**: loading (skeleton, not a spinner-on-blank-page),
   empty (explains what will appear here and how to create it), error (says what failed and
   offers a retry), and success. A view with only the happy path is unfinished.
2. **The brain is inspectable.** Anywhere generated output appears, the user can see which
   context produced it. Never render an LLM output with no path back to its trace.
3. **Approval state is always visible** and always uses the vocabulary from
   `packages/contracts` — `draft`, `pending_review`, `approved`, `rejected`, `edited`.
   Never invent a label like "In progress" for a state the contract already names.
4. **Destructive and irreversible actions confirm.** Sending, launching an ad, rejecting.
5. **Keyboard reachable, visible focus ring, labelled inputs.** No `div` with an onClick.
6. **No new component library, CSS framework, or icon set** without asking.

## Tokens

TODO — replace with the real values. Define them once as CSS variables / Tailwind theme
extensions and import; never hardcode a hex value in a component.

```
Background      TODO
Surface         TODO
Border          TODO
Text primary    TODO
Text muted      TODO
Accent          TODO
Success         TODO
Warning         TODO
Danger          TODO
```

Semantic naming only. `--color-danger`, never `--color-red-500`.

## Typography

TODO — pick two families max (one display, one text) and list the scale.

Banned because every AI-generated interface uses them: Inter, Roboto, Arial, Space Grotesk.
Pick something with a point of view and use it consistently.

## Spacing and layout

- 4px base scale: 4, 8, 12, 16, 24, 32, 48, 64. Nothing in between.
- Max content width TODO. Dashboard density: TODO (compact / comfortable).
- Related things are closer together than unrelated things. Most layout problems are
  spacing problems, not alignment problems.

## Component patterns

TODO — as each is built, record the canonical version here so the next agent copies it
instead of inventing a second one:

- Page shell / nav
- Card
- Table (sorting, pagination, empty state)
- Form (labels, validation, error text, submit states)
- Approval gate control
- Toast / inline feedback
- Modal / confirmation

## Copy

- Sentence case for buttons and headings. Not Title Case.
- Buttons name the action: "Approve draft", not "Submit" or "OK".
- Errors say what happened and what to do next. Never "Something went wrong."
- No exclamation marks. No "Oops". This is a tool professionals use daily.

## Before you call UI work done

- Rendered it and looked at it — not just compiled.
- All four states exist.
- Audited against the Web Interface Guidelines (AGENTS.md §6).
- Keyboard-navigated the whole flow once.
