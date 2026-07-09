# Phase 2 screen re-skin — shared mapping brief

You are re-skinning ONE Next.js screen (`page.tsx`) onto the already-built UI
primitive library. This is a purely presentational swap — **change no logic,
state, hooks, API calls, data shapes, or conditional behavior.** Only swap
bespoke-classed HTML elements for the primitive components.

## Worktree
`/Users/aditya/Downloads/tuezday-2.0.1/.claude/worktrees/ui-revamp-design` — run all commands here.

## Primitives (import from these exact paths, only the ones you use)
```ts
import { Button } from "@/src/components/ui/button";          // variant: "primary"|"secondary"|"ghost"|"danger"; size: "sm"|"md"
import { Card, CardHeader } from "@/src/components/ui/card";  // CardHeader: { title, actions? }
import { Badge } from "@/src/components/ui/badge";            // tone: "neutral"|"approved"|"pending"|"edited"|"rejected"|"draft"|"danger"
import { Tabs } from "@/src/components/ui/tabs";              // { tabs: {key,label}[], active: string, onChange: (key)=>void }
import { Input, Textarea, Select } from "@/src/components/ui/input";
```

## Mapping — apply to every occurrence in the target file
| Old markup | New |
|---|---|
| `<div className="panel">…</div>` or `<section className="panel">` | `<Card>…</Card>` |
| a `<div className="panel-title-row"><h2>TITLE</h2> …actions… </div>` at the top of a panel | `<CardHeader title="TITLE" actions={…} />` inside the `Card` |
| `<button className="button-secondary" …>` | `<Button variant="secondary" size="sm" …>` (keep all props: onClick/disabled/type) |
| `<button className="button-secondary danger">` or `className="button-danger"` | `<Button variant="danger" size="sm">` |
| a plain primary/submit/create `<button>` (no `button-secondary`) | `<Button variant="primary">` (keep type="submit" if present) |
| `<button className="link-button" …>` or `<span className="link-button" role="link">` | `<Button variant="ghost" size="sm" …>` |
| `<div className="filter-tabs">` + `<button className="filter-tab …">` children | one `<Tabs tabs={ARR} active={STATE} onChange={SETTER} />` — build `ARR` as `{key,label}[]` from the existing filter options/labels; wire `active`/`onChange` to the existing filter state + setter |
| `<span className="layer-badge state-pending_review">` | `<Badge tone="pending">` |
| `<span className="layer-badge state-edited">` | `<Badge tone="edited">` |
| `<span className="layer-badge state-approved">` | `<Badge tone="approved">` |
| `<span className="layer-badge state-rejected">` | `<Badge tone="rejected">` |
| `<span className="layer-badge state-draft">` | `<Badge tone="draft">` |
| `<input …>` (text/number/etc.) | `<Input …>` |
| `<textarea …>` | `<Textarea …>` |
| `<select …>…</select>` | `<Select …>…</Select>` (keep `<option>` children) |

## LEAVE ALONE (do not convert)
- **Categorical** `layer-badge layer-*` chips (`layer-org`, `layer-channel`, `layer-campaign`, `layer-persona`, `layer-task`, `layer-zoom`, `layer-account`) — the `Badge` tone set only models approval/completeness states, not these six category tones. Keep them as raw `<span className="layer-badge layer-…">`.
- Any other `layer-badge …` variants not in the state-map above (e.g. `rating-*`, `source-badge`, `badge-active`, `tier-badge`, `mode-badge`) — leave as raw spans.
- Screen-local layout classes (grids, lists, `section-*`, `*-row`, `*-list`, `*-card` that are page-specific, `meta`, `subtitle`, `error`, `empty`) — they already inherit the new palette from the token layer; don't touch them.
- The `PageHeader` and `EmptyState` components (imported from `@/src/components/...`) — already restyled; leave their usage as-is.
- Checkbox `<input type="checkbox">` — leave as native (no Checkbox primitive exists).
- `<a>`/`<Link>` elements that aren't styled as buttons — leave as-is.

## Notes
- If a `<button>`'s role is ambiguous, default to `variant="secondary" size="sm"`. Reserve `variant="primary"` for the single main action of a form/section (submit, create, run, generate, save).
- Don't invent new classNames or inline color/border/radius styles. If something doesn't map to a primitive, leave the original markup.
- Keep imports tidy — only import the primitives you actually use (an unused import is a defect).

## Verify + commit
1. `npx tsc --noEmit -p apps/web` — must pass. **Ignore errors in files other than your target** (concurrent agents may have in-flight edits elsewhere); only your target file must be error-free.
2. Do NOT run `npm run build` (concurrent agents collide on `.next`).
3. Commit ONLY your one target file:
   ```
   git add <your target page.tsx>
   git commit -m "UI revamp (Phase 2): re-skin <screen> onto primitives

   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
   ```
Report: DONE (commit hash + your file's tsc status) or BLOCKED (why).
