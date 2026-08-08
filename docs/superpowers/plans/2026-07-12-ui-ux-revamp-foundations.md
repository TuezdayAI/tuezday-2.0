# Tuezday UI/UX Revamp Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the verified, Tuezday-branded experience contract and shared shell foundations required to build the golden operating loop on top of the merged GTM orchestration architecture.

**Architecture:** Begin from integration commit `1e38c14`, where `main`'s UI implementation and the `gtm-orchestration-foundation` behavior have already been reconciled. Put product-wide vocabulary and navigation metadata in `@tuezday/contracts`, put deterministic display adapters in `apps/web/lib`, and keep visual implementation in tokenized CSS Modules and shared UI components. This plan intentionally stops before rebuilding the complete Home → Campaign → Review → Editor → Calendar loop.

**Tech Stack:** TypeScript 5.7, Next.js 15 App Router, React 19, CSS Modules and plain CSS, `next/font/google`, zod, Vitest 3, lucide-react.

## Global Constraints

- Base all implementation on `integration/gtm-foundation` commit `1e38c14` or the exact descendant merged into `main` after verification.
- Do not begin Task 1 until `npm test -- --maxWorkers=2`, `npm run typecheck`, and `npm run build -w apps/web` all exit `0` on that baseline.
- Preserve migrations `0037` through `0042`, all campaign plan/lane contracts, the carousel flow in Approvals, and image generation in Ad Creatives.
- Preserve `main`'s existing shared UI components and CSS Module screen migrations; evolve them instead of restoring the pre-merge monolithic UI.
- Use no Tailwind and add no runtime UI dependency.
- Use Tuezday's live website tokens and fonts: Archivo display, Inter body, JetBrains Mono metadata.
- Brand/category colors and semantic workflow colors remain separate systems.
- Color is never the sole state indicator; workflow badges always render text and an icon.
- Keep legacy CSS aliases during this plan so unmigrated routes remain visually functional.
- `npm test -- --maxWorkers=2`, `npm run typecheck`, and `npm run build -w apps/web` must pass before the plan is considered complete.

---

### Task 1: Golden-loop experience contract artifacts

**Files:**
- Create: `docs/ui-ux/capability-registry.md`
- Create: `docs/ui-ux/route-migration-map.md`
- Create: `docs/ui-ux/golden-loop-state-map.md`

**Interfaces:**
- Produces: the source-of-truth mapping used by every later revamp plan.
- Consumes: merged routes and contracts at `integration/gtm-foundation@1e38c14`.

- [ ] **Step 1: Create the scoped capability registry**

Write `docs/ui-ux/capability-registry.md` with this exact opening and table:

```markdown
# UI/UX Revamp Capability Registry

> Baseline: `integration/gtm-foundation@1e38c14`
> Scope: golden operating loop plus placement of every current workspace route

| Capability | Existing API/contract | Current route | Target surface | Treatment | Required states | Migration |
|---|---|---|---|---|---|---|
| Ranked next action | `GET /workspaces/:id/next-action`, `NextAction` | workspace Home | Home / Up next | Tuezday extension | loading, all-clear, actionable, system-working, error | retain and restyle |
| Campaign inventory | `GET/POST /workspaces/:id/campaigns` | `/campaigns` | Campaigns | Blaze extension | empty, loading, active, paused, error | retain |
| Campaign control plane | `GET /workspaces/:id/campaigns/:campaignId/plan/summary` | API only | Campaign / Overview | Tuezday exclusive | missing-plan, ready, blocked, partial, error | add UI in golden-loop plan |
| Plan revisions | campaign plan revision contracts and routes | API only | Campaign / Plan history | Tuezday exclusive | current, draft revision, invalid, immutable, activated | add UI in campaign plan |
| Campaign lanes | lane revision contracts and routes | API only | Campaign / Channels | Tuezday exclusive | empty, configured, generating, blocked, stale | add UI in campaign plan |
| Review queue | draft list/detail/decision routes | `/approvals` | Review / Approvals | Blaze extension | empty, loading, review required, approved, rejected, partial, error | retain and migrate to canonical status |
| Carousel rendering | `POST /workspaces/:id/drafts/:draftId/carousel` | `/approvals` | Review editor / Quick edits | Tuezday extension | eligible, rendering, rendered, failed | retain merged behavior |
| Destination preview | `Draft`, `LaunchMedia`, `PreviewCard` | Home, Approvals, Calendar | Shared preview | Blaze extension | text-only, image, carousel, unsupported, loading | extend in golden-loop plan |
| Content approval | draft approve/reject/edit routes | `/approvals` | Review / Approvals | direct match plus audit | review required, edited, approved, rejected, error | retain behavior |
| External-action authorization | action policy and orchestration contracts | automation and execution routes | Review / Authorization | Tuezday exclusive | authorization required, authorized, policy blocked, stale | add UI in golden-loop plan |
| Calendar | draft/publication/cadence APIs | `/calendar` | Calendar | Blaze extension | empty, planned, review required, scheduled, executing, partial, failed | retain route, rebuild anatomy later |
| Publication execution | publication routes | Calendar and channel pages | Editor / Execution plus Calendar | Tuezday extension | scheduling, scheduled, publishing, completed, partially failed, failed | expose consistently later |
| Connection recovery | connector routes and capability view | `/connectors` and inline prompts | Integrations plus contextual recovery | direct match | setup required, connecting, connected, connection lost, failed | retain and standardize later |
| Brain evidence disclosure | resolver/evidence contracts | `/brain`, `/evidence`, `/resolver` | Editor / Why Tuezday made this | Tuezday exclusive | available, partial evidence, unavailable, error | retain APIs, move disclosure into editor later |
| Learning suggestions | synthesis routes | `/learning` | Insights / Learning | Tuezday extension | empty, proposed, accepted, rejected, error | move navigation; retain route |
```

- [ ] **Step 2: Add the complete current-route migration map**

Write `docs/ui-ux/route-migration-map.md`:

```markdown
# Workspace Route Migration Map

| Current route | Target area | Target surface | Treatment in first foundation plan |
|---|---|---|---|
| workspace root | Operate | Home | retain |
| `/calendar` | Operate | Calendar | elevate to primary navigation |
| `/campaigns` | Operate | Campaigns | retain |
| `/cadence` | Operate | Campaign / Schedule | retain as Campaign child |
| `/automation` | Operate | Campaign / Automation | retain as Campaign child |
| `/approvals` | Operate | Review / Approvals | retain |
| `/inbox` | Operate | Review / Inbox | retain as Review child |
| `/discovery` | Grow | Discover | retain |
| `/outbound` | Grow | Audience / Outbound | retain |
| `/lists` | Grow | Audience / Lists and segments | retain |
| `/launches` | Grow | Audience / Sequences | retain |
| `/crm` | Grow | Audience / CRM | retain |
| `/pr` | Grow | Audience / PR and media | retain |
| `/ads` | Grow | Ads / Overview | elevate when capability is present |
| `/ad-creatives` | Grow | Ads / Creative | move under Ads |
| `/ad-launches` | Grow | Ads / Launch and spend | move under Ads |
| `/insights` | Grow | Insights / Performance | elevate when capability is present |
| `/learning` | Grow | Insights / Learning | move under Insights |
| `/brain` | Foundations | Brain | retain |
| `/brain#content-preferences` | Foundations | Content Preferences | add stable anchor |
| `/evidence` | Foundations | Brain / Source materials | retain as Brain child |
| `/resolver` | Foundations | Brain / Advanced context | retain as Brain child |
| `/connectors` | Foundations | Integrations | elevate to primary navigation |
| `/content` | Work | Create New | retain |
| `/sandbox` | Work | Create New / Advanced | retain as Create child |
| `/team` | Workspace | Settings / Team | retain |
| `/billing` | Workspace | Settings / Billing | retain |
| `/notifications` | Workspace | Settings / Notifications | restore to Settings navigation |
| `/activity` | Workspace | Settings / Activity | retain |

Search, Recent, Projects, Media Library, and Developer are explicit later-wave routes because no complete route currently exists. No current capability is removed to create empty navigation destinations.
```

- [ ] **Step 3: Define the golden-loop state and analytics contract**

Write `docs/ui-ux/golden-loop-state-map.md`:

```markdown
# Golden Operating Loop State Map

| Step | Entry | Primary action | Completion | Recovery | Analytics event |
|---|---|---|---|---|---|
| Home priority | workspace open | Open ranked item | relevant context opens | retry Home data; link to affected surface | `home.next_action_opened` |
| Campaign context | Home or Campaigns | Open work requiring action | campaign, plan, and lane context visible | create/backfill plan or open blocker | `campaign.context_opened` |
| Review queue | Home, Campaign, Calendar | Open next review item | editor opens in filtered queue | preserve filter and retry item | `review.item_opened` |
| Revision | review editor | Request or make change | preview updates and decision remains pending | preserve prior version and explain failure | `review.revision_requested` |
| Content decision | review editor | Approve or reject content | decision recorded | preserve item and show API error | `review.content_decided` |
| Authorization | review editor | Authorize external action | authorization recorded separately | explain policy/setup blocker | `review.action_authorized` |
| Scheduling | review editor or Calendar | Set destination and time | item becomes Scheduled | preserve approved content and retry scheduling | `calendar.item_scheduled` |
| Execution | Calendar | Inspect active or completed action | per-destination result visible | retry safe failures; link setup for blocked destinations | `execution.result_viewed` |

Required cross-cutting states: loading, sample, empty, review required, authorization required, generating, scheduled, active, completed, setup required, policy blocked, partially failed, failed, stale, and all-clear.
```

- [ ] **Step 4: Validate coverage**

Run:

```bash
test $(rg -c '^\| (workspace root|`/)' docs/ui-ux/route-migration-map.md) -eq 29
rg -n 'campaign plan|carousel|authorization|partially failed|stale' docs/ui-ux/*.md
```

Expected: the route count command exits `0`; the second command finds each required concept.

- [ ] **Step 5: Commit**

```bash
git add docs/ui-ux/capability-registry.md docs/ui-ux/route-migration-map.md docs/ui-ux/golden-loop-state-map.md
git commit -m "docs: lock UI revamp experience contract"
```

---

### Task 2: Replace the inherited editorial theme with Tuezday website tokens

**Files:**
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/tokens.css`
- Modify: `apps/web/DESIGN.md`
- Create: `apps/web/lib/design-tokens.test.ts`

**Interfaces:**
- Produces: `--font-display`, `--font-body`, `--font-mono`, semantic surface aliases, semantic status colors, geometry, and motion durations.
- Preserves: `--bg`, `--panel`, `--panel-2`, `--text`, `--muted`, `--accent`, spectrum variables, and legacy state aliases for current screens.

- [ ] **Step 1: Write the failing token-source test**

Create `apps/web/lib/design-tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app/tokens.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");

describe("Tuezday application tokens", () => {
  it("uses the live-site neutral and spectrum foundations", () => {
    expect(css).toContain("--bg: oklch(0.966 0.005 256)");
    expect(css).toContain("--surface: oklch(0.995 0.003 256)");
    expect(css).toContain("--ink: oklch(0.205 0.013 264)");
    expect(css).toContain("--c1: oklch(0.635 0.190 27)");
    expect(css).toContain("--c6: oklch(0.585 0.175 350)");
  });

  it("separates semantic workflow colors from spectrum categories", () => {
    for (const token of [
      "--status-attention",
      "--status-progress",
      "--status-ready",
      "--status-blocked",
      "--status-info",
    ]) {
      expect(css).toContain(token);
    }
  });

  it("uses Archivo, Inter, and JetBrains Mono without Fraunces", () => {
    expect(layout).toContain("Archivo");
    expect(layout).toContain("Inter");
    expect(layout).toContain("JetBrains_Mono");
    expect(layout).not.toContain("Fraunces");
    expect(css).not.toContain("--font-fraunces");
  });
});
```

- [ ] **Step 2: Run the test and confirm the inherited theme fails**

Run: `npm exec --prefix apps/web vitest -- run lib/design-tokens.test.ts`

Expected: FAIL because the merged baseline still contains Fraunces and warm-paper tokens.

- [ ] **Step 3: Replace the font setup**

Replace the font imports and declarations in `apps/web/app/layout.tsx` with:

```tsx
import type { Metadata } from "next";
import { Archivo, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-archivo",
});
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "Tuezday",
  description: "GTM that remembers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${inter.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 4: Replace `tokens.css` with the Tuezday source system and compatibility aliases**

Use this token block as the complete `:root` content:

```css
:root {
  --bg: oklch(0.966 0.005 256);
  --bg-sunk: oklch(0.944 0.006 256);
  --surface: oklch(0.995 0.003 256);
  --ink: oklch(0.205 0.013 264);
  --ink-2: oklch(0.405 0.012 264);
  --ink-3: oklch(0.535 0.010 264);
  --line: oklch(0.855 0.008 264);
  --line-soft: oklch(0.905 0.006 264);

  --c1: oklch(0.635 0.190 27);
  --c2: oklch(0.760 0.150 66);
  --c3: oklch(0.775 0.135 132);
  --c4: oklch(0.715 0.105 205);
  --c5: oklch(0.555 0.150 256);
  --c6: oklch(0.585 0.175 350);
  --c1-deep: oklch(0.520 0.180 27);
  --c2-deep: oklch(0.515 0.130 64);
  --c3-deep: oklch(0.500 0.120 134);
  --c4-deep: oklch(0.480 0.092 205);
  --c5-deep: oklch(0.485 0.150 256);
  --c6-deep: oklch(0.495 0.165 350);
  --c1-wash: oklch(0.945 0.040 30);
  --c2-wash: oklch(0.950 0.045 75);
  --c3-wash: oklch(0.952 0.045 130);
  --c4-wash: oklch(0.950 0.030 205);
  --c5-wash: oklch(0.945 0.035 256);
  --c6-wash: oklch(0.948 0.038 350);

  --accent: var(--c5);
  --accent-deep: var(--c5-deep);
  --accent-soft: var(--c5-wash);
  --accent-ink: oklch(0.985 0.005 256);
  --focus: oklch(0.550 0.160 256);
  --danger: oklch(0.550 0.200 27);
  --ok: oklch(0.550 0.130 150);

  --status-attention: oklch(0.730 0.145 66);
  --status-attention-ink: oklch(0.430 0.110 64);
  --status-attention-wash: oklch(0.955 0.045 75);
  --status-progress: oklch(0.620 0.120 230);
  --status-progress-ink: oklch(0.420 0.105 230);
  --status-progress-wash: oklch(0.950 0.030 230);
  --status-ready: var(--ok);
  --status-ready-ink: oklch(0.390 0.100 150);
  --status-ready-wash: oklch(0.950 0.035 150);
  --status-blocked: var(--danger);
  --status-blocked-ink: oklch(0.430 0.170 27);
  --status-blocked-wash: oklch(0.950 0.035 27);
  --status-info: oklch(0.580 0.020 264);
  --status-info-ink: var(--ink-2);
  --status-info-wash: var(--bg-sunk);

  --panel: var(--surface);
  --panel-2: var(--bg-sunk);
  --border: var(--line);
  --border-strong: oklch(0.735 0.014 264);
  --text: var(--ink);
  --muted: var(--ink-2);
  --muted-2: var(--ink-3);
  --lavender: var(--c5-wash);
  --lavender-ink: var(--c5-deep);
  --mint: var(--status-ready-wash);
  --mint-ink: var(--status-ready-ink);
  --amber: var(--status-attention-wash);
  --amber-ink: var(--status-attention-ink);
  --peach: var(--c1-wash);
  --peach-ink: var(--c1-deep);
  --rose: var(--status-blocked-wash);
  --rose-ink: var(--status-blocked-ink);

  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius: 9px;
  --radius-lg: 16px;
  --radius-pill: 999px;
  --shadow-low: 0 1px 2px oklch(0.205 0.020 264 / 0.07), 0 3px 10px oklch(0.205 0.020 264 / 0.05);
  --shadow-modal: 0 16px 50px oklch(0.205 0.030 264 / 0.14);
  --shadow-preview: 0 1px 3px oklch(0.205 0.020 264 / 0.08), 0 6px 18px oklch(0.205 0.020 264 / 0.07);

  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
  --dur-press: 130ms;
  --dur-fast: 180ms;
  --dur-base: 240ms;
  --dur-slow: 420ms;

  --font-display: var(--font-archivo, ui-sans-serif, system-ui, sans-serif);
  --font-body: var(--font-inter, ui-sans-serif, system-ui, sans-serif);
  --font-mono: var(--font-jetbrains, ui-monospace, "SFMono-Regular", monospace);

  --icon-sm: 16px;
  --icon-md: 20px;
  --icon-lg: 24px;
  --icon-stroke: 1.75;
}
```

- [ ] **Step 5: Update the design-system documentation**

Change `apps/web/DESIGN.md` so its front matter and Typography section name Archivo, Inter, and JetBrains Mono, its canvas values match the token block above, and its north star reads `Editorial GTM Control Room`. Remove every Fraunces, serif, warm-paper, and muted-teal reference.

- [ ] **Step 6: Run tests and build**

Run:

```bash
npm exec --prefix apps/web vitest -- run lib/design-tokens.test.ts
npm run typecheck -w apps/web
npm run build -w apps/web
```

Expected: all commands exit `0`; the Next build downloads no runtime font dependency because fonts are compiled by `next/font`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/layout.tsx apps/web/app/tokens.css apps/web/DESIGN.md apps/web/lib/design-tokens.test.ts
git commit -m "feat(web): align UI tokens with Tuezday brand"
```

---

### Task 3: Canonical workflow status contract

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/workflow-status.test.ts`
- Modify: `packages/contracts/src/index.ts` (`ANALYTICS_EVENTS`)

**Interfaces:**
- Produces: `WorkflowStatusFamily`, `WorkflowStatus`, `workflowStatusSchema`, and `WORKFLOW_STATUS_META`.
- Produces analytics vocabulary consumed by later Home, Review, Calendar, and execution work.

- [ ] **Step 1: Write the failing status-contract test**

Create `packages/contracts/test/workflow-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENTS,
  WORKFLOW_STATUSES,
  WORKFLOW_STATUS_META,
  workflowStatusSchema,
} from "../src/index.js";

describe("workflow status contract", () => {
  it("defines every approved status exactly once", () => {
    expect(WORKFLOW_STATUSES).toEqual([
      "draft", "review_required", "authorization_required", "changes_requested",
      "generating", "regenerating", "scheduling", "publishing", "sending", "launching",
      "approved", "rejected", "authorized", "scheduled", "active", "connected", "completed",
      "setup_required", "connection_lost", "policy_blocked", "partially_failed", "failed", "stale",
      "paused", "superseded", "archived", "experimental",
    ]);
    expect(Object.keys(WORKFLOW_STATUS_META)).toEqual([...WORKFLOW_STATUSES]);
  });

  it("gives every status a human label and approved family", () => {
    for (const status of WORKFLOW_STATUSES) {
      expect(workflowStatusSchema.parse(status)).toBe(status);
      expect(WORKFLOW_STATUS_META[status].label.length).toBeGreaterThan(2);
      expect(["attention", "progress", "ready", "blocked", "informational"])
        .toContain(WORKFLOW_STATUS_META[status].family);
    }
  });

  it("keeps partial failure blocked and scheduled ready", () => {
    expect(WORKFLOW_STATUS_META.partially_failed.family).toBe("blocked");
    expect(WORKFLOW_STATUS_META.scheduled.family).toBe("ready");
  });

  it("registers the golden-loop analytics vocabulary", () => {
    expect(ANALYTICS_EVENTS).toEqual(expect.arrayContaining([
      "home.next_action_opened",
      "campaign.context_opened",
      "review.item_opened",
      "review.revision_requested",
      "review.content_decided",
      "review.action_authorized",
      "calendar.item_scheduled",
      "execution.result_viewed",
    ]));
  });
});
```

- [ ] **Step 2: Run the contract test and confirm failure**

Run: `npm test -w packages/contracts -- workflow-status.test.ts`

Expected: FAIL because the workflow exports do not exist.

- [ ] **Step 3: Implement the status contract**

Add this block before Product Analytics in `packages/contracts/src/index.ts`:

```ts
export const WORKFLOW_STATUS_FAMILIES = [
  "attention",
  "progress",
  "ready",
  "blocked",
  "informational",
] as const;
export type WorkflowStatusFamily = (typeof WORKFLOW_STATUS_FAMILIES)[number];

export const WORKFLOW_STATUSES = [
  "draft",
  "review_required",
  "authorization_required",
  "changes_requested",
  "generating",
  "regenerating",
  "scheduling",
  "publishing",
  "sending",
  "launching",
  "approved",
  "rejected",
  "authorized",
  "scheduled",
  "active",
  "connected",
  "completed",
  "setup_required",
  "connection_lost",
  "policy_blocked",
  "partially_failed",
  "failed",
  "stale",
  "paused",
  "superseded",
  "archived",
  "experimental",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const workflowStatusSchema = z.enum(WORKFLOW_STATUSES);

export const WORKFLOW_STATUS_META: Record<
  WorkflowStatus,
  { label: string; family: WorkflowStatusFamily }
> = {
  draft: { label: "Draft", family: "attention" },
  review_required: { label: "Review required", family: "attention" },
  authorization_required: { label: "Authorization required", family: "attention" },
  changes_requested: { label: "Changes requested", family: "attention" },
  generating: { label: "Generating", family: "progress" },
  regenerating: { label: "Regenerating", family: "progress" },
  scheduling: { label: "Scheduling", family: "progress" },
  publishing: { label: "Publishing", family: "progress" },
  sending: { label: "Sending", family: "progress" },
  launching: { label: "Launching", family: "progress" },
  approved: { label: "Approved", family: "ready" },
  rejected: { label: "Rejected", family: "informational" },
  authorized: { label: "Authorized", family: "ready" },
  scheduled: { label: "Scheduled", family: "ready" },
  active: { label: "Active", family: "ready" },
  connected: { label: "Connected", family: "ready" },
  completed: { label: "Completed", family: "ready" },
  setup_required: { label: "Setup required", family: "blocked" },
  connection_lost: { label: "Connection lost", family: "blocked" },
  policy_blocked: { label: "Policy blocked", family: "blocked" },
  partially_failed: { label: "Partially failed", family: "blocked" },
  failed: { label: "Failed", family: "blocked" },
  stale: { label: "Stale", family: "blocked" },
  paused: { label: "Paused", family: "informational" },
  superseded: { label: "Superseded", family: "informational" },
  archived: { label: "Archived", family: "informational" },
  experimental: { label: "Experimental", family: "informational" },
};
```

- [ ] **Step 4: Extend `ANALYTICS_EVENTS`**

Append these strings to the existing tuple without removing current events:

```ts
"home.next_action_opened",
"campaign.context_opened",
"review.item_opened",
"review.revision_requested",
"review.content_decided",
"review.action_authorized",
"calendar.item_scheduled",
"execution.result_viewed",
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -w packages/contracts -- workflow-status.test.ts
npm run typecheck -w packages/contracts
```

Expected: both exit `0`.

```bash
git add packages/contracts/src/index.ts packages/contracts/test/workflow-status.test.ts
git commit -m "feat(contracts): define canonical workflow statuses"
```

---

### Task 4: Shared workflow status badge and first consumers

**Files:**
- Create: `apps/web/lib/workflow-status.ts`
- Create: `apps/web/lib/workflow-status.test.ts`
- Modify: `apps/web/src/components/ui/badge.tsx`
- Modify: `apps/web/src/components/ui/badge.module.css`
- Modify: `apps/web/src/components/ui/preview-card.tsx`
- Modify: `apps/web/app/workspaces/[id]/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/approvals/page.tsx`

**Interfaces:**
- Consumes: `WorkflowStatus`, `WORKFLOW_STATUS_META` from `@tuezday/contracts`.
- Produces: `workflowStatusView(status)` and `<WorkflowStatusBadge status />`.
- Extends: `PreviewCard` with `workflowStatus?: WorkflowStatus`; existing `status` and `statusTone` remain temporarily compatible.

- [ ] **Step 1: Write the failing display-adapter test**

Create `apps/web/lib/workflow-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { workflowStatusView } from "./workflow-status";

describe("workflowStatusView", () => {
  it("combines contract metadata with a family icon", () => {
    expect(workflowStatusView("review_required")).toEqual({
      label: "Review required",
      family: "attention",
      icon: "warning",
    });
    expect(workflowStatusView("publishing")).toEqual({
      label: "Publishing",
      family: "progress",
      icon: "status-generating",
    });
    expect(workflowStatusView("approved")).toEqual({
      label: "Approved",
      family: "ready",
      icon: "status-approved",
    });
    expect(workflowStatusView("failed")).toEqual({
      label: "Failed",
      family: "blocked",
      icon: "status-rejected",
    });
    expect(workflowStatusView("paused")).toEqual({
      label: "Paused",
      family: "informational",
      icon: "info",
    });
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npm exec --prefix apps/web vitest -- run lib/workflow-status.test.ts`

Expected: FAIL because `workflow-status.ts` does not exist.

- [ ] **Step 3: Implement the display adapter**

Create `apps/web/lib/workflow-status.ts`:

```ts
import {
  WORKFLOW_STATUS_META,
  type WorkflowStatus,
  type WorkflowStatusFamily,
} from "@tuezday/contracts";
import type { IconName } from "@/src/components/ui/icon";

const FAMILY_ICON: Record<WorkflowStatusFamily, IconName> = {
  attention: "warning",
  progress: "status-generating",
  ready: "status-approved",
  blocked: "status-rejected",
  informational: "info",
};

export function workflowStatusView(status: WorkflowStatus) {
  const meta = WORKFLOW_STATUS_META[status];
  return { ...meta, icon: FAMILY_ICON[meta.family] };
}
```

- [ ] **Step 4: Add `WorkflowStatusBadge`**

Append this component to `apps/web/src/components/ui/badge.tsx` and add the imports:

```tsx
import type { WorkflowStatus } from "@tuezday/contracts";
import { workflowStatusView } from "@/lib/workflow-status";
import { Icon } from "./icon";

interface WorkflowStatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  status: WorkflowStatus;
  label?: string;
}

export function WorkflowStatusBadge({ status, label, className, ...rest }: WorkflowStatusBadgeProps) {
  const view = workflowStatusView(status);
  const classes = [styles.badge, styles.workflow, styles[view.family], className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} data-workflow-status={status} {...rest}>
      <Icon name={view.icon} size="sm" />
      <span>{label ?? view.label}</span>
    </span>
  );
}
```

Append to `badge.module.css`:

```css
.workflow {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  border-color: currentColor;
}
.attention { color: var(--status-attention-ink); background: var(--status-attention-wash); }
.progress { color: var(--status-progress-ink); background: var(--status-progress-wash); }
.ready { color: var(--status-ready-ink); background: var(--status-ready-wash); }
.blocked { color: var(--status-blocked-ink); background: var(--status-blocked-wash); }
.informational { color: var(--status-info-ink); background: var(--status-info-wash); }
```

- [ ] **Step 5: Extend `PreviewCard` without breaking legacy consumers**

Add `workflowStatus?: WorkflowStatus` to `PreviewCardProps`. Render `WorkflowStatusBadge` when present; otherwise retain the existing `Badge` rendering:

```tsx
{workflowStatus ? (
  <WorkflowStatusBadge status={workflowStatus} />
) : (
  status && <Badge tone={statusTone}>{status}</Badge>
)}
```

- [ ] **Step 6: Migrate Home and Approvals to the canonical badge**

On Home, replace `status="Review" statusTone="pending"` with:

```tsx
workflowStatus="review_required"
```

In Approvals, replace `STATE_BADGE_TONE` with this adapter:

```ts
const APPROVAL_WORKFLOW_STATUS: Record<ApprovalState, WorkflowStatus> = {
  draft: "draft",
  pending_review: "review_required",
  edited: "changes_requested",
  approved: "approved",
  rejected: "rejected",
};
```

Pass `workflowStatus={APPROVAL_WORKFLOW_STATUS[d.state]}` to `PreviewCard`. This replaces only the two legacy status props; do not edit `decide`, `approveAll`, `generateCarousel`, the carousel media strip, or the card action rail in this step.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npm exec --prefix apps/web vitest -- run lib/workflow-status.test.ts
npm run typecheck -w apps/web
npm run build -w apps/web
```

Expected: all exit `0`; Home and Approvals render icon + text workflow badges.

```bash
git add apps/web/lib/workflow-status.ts apps/web/lib/workflow-status.test.ts apps/web/src/components/ui/badge.tsx apps/web/src/components/ui/badge.module.css apps/web/src/components/ui/preview-card.tsx 'apps/web/app/workspaces/[id]/page.tsx' 'apps/web/app/workspaces/[id]/approvals/page.tsx'
git commit -m "feat(web): introduce shared workflow status badges"
```

---

### Task 5: Approved navigation hierarchy in contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/nav-visibility.test.ts`
- Modify: `packages/contracts/test/nav-entry.test.ts`
- Modify: `packages/contracts/test/nav-icons.test.ts`

**Interfaces:**
- Produces: `NavSection`, `NAV_SECTIONS`, and `NavItem.section`.
- Preserves: capability filtering and `navEntryForPath` behavior.

- [ ] **Step 1: Replace nav assertions with the approved hierarchy**

Update `nav-visibility.test.ts` to assert:

```ts
expect(WORKSPACE_NAV.map((item) => [item.section, item.label, item.path])).toEqual([
  ["operate", "Home", ""],
  ["operate", "Calendar", "/calendar"],
  ["operate", "Campaigns", "/campaigns"],
  ["operate", "Review", "/approvals"],
  ["grow", "Discover", "/discovery"],
  ["grow", "Audience", "/outbound"],
  ["grow", "Ads", "/ads"],
  ["grow", "Insights", "/insights"],
  ["foundations", "Brain", "/brain"],
  ["foundations", "Integrations", "/connectors"],
  ["library", "Create New", "/content"],
  ["workspace", "Settings", "/team"],
]);
```

Update gated expectations so Ads and Insights disappear when unavailable while Integrations always remains visible. Update `nav-entry.test.ts` so `/calendar` resolves to `Calendar` without a parent and `/learning` resolves to `Learning` with parent `Insights`.

- [ ] **Step 2: Run nav tests and confirm failure**

Run:

```bash
npm test -w packages/contracts -- nav-visibility.test.ts nav-entry.test.ts nav-icons.test.ts
```

Expected: FAIL against the previous eight-group hierarchy.

- [ ] **Step 3: Add navigation sections**

Add:

```ts
export const NAV_SECTIONS = [
  { id: "operate", label: "Operate" },
  { id: "grow", label: "Grow" },
  { id: "foundations", label: "Foundations" },
  { id: "library", label: "Work" },
  { id: "workspace", label: "Workspace" },
] as const;
export type NavSection = (typeof NAV_SECTIONS)[number]["id"];
```

Add `section: NavSection` to `NavItem`.

Update the local `CORE_NAV` fixture in `nav-visibility.test.ts` so every top-level fixture item includes `section: "operate"`. Child items do not receive a section.

- [ ] **Step 4: Replace `WORKSPACE_NAV` with the approved, existing-route-safe structure**

Use this exact ordering and placement:

```ts
export const WORKSPACE_NAV: NavItem[] = [
  { label: "Home", path: "", summary: "What needs attention now", tone: "system", icon: "home", section: "operate" },
  { label: "Calendar", path: "/calendar", summary: "Planned, scheduled, and completed work", tone: "history", icon: "calendar", section: "operate" },
  {
    label: "Campaigns", path: "/campaigns", summary: "Plans, work, channels, and results", tone: "voice", icon: "campaigns", section: "operate",
    children: [
      { label: "Campaign home", path: "/campaigns", summary: "Goals and GTM pushes", tone: "voice", icon: "campaigns" },
      { label: "Schedule", path: "/cadence", summary: "Publishing rhythm", tone: "history", icon: "calendar" },
      { label: "Automation", path: "/automation", summary: "Human-in-the-loop rules", tone: "signal", icon: "regenerate" },
    ],
  },
  {
    label: "Review", path: "/approvals", summary: "Approve, authorize, and respond", tone: "icp", icon: "review", section: "operate",
    children: [
      { label: "Approvals", path: "/approvals", summary: "Nothing ships without review", tone: "icp", icon: "review" },
      { label: "Inbox", path: "/inbox", summary: "Replies and engagement", tone: "signal", icon: "email" },
    ],
  },
  { label: "Discover", path: "/discovery", summary: "Market signals worth acting on", tone: "signal", icon: "discover", section: "grow" },
  {
    label: "Audience", path: "/outbound", summary: "Recipients, lists, sequences, CRM, and media", tone: "icp", icon: "audience", section: "grow",
    children: [
      { label: "Outbound", path: "/outbound", summary: "Lead-driven drafts", tone: "icp", icon: "external" },
      { label: "Lists & segments", path: "/lists", summary: "Reusable audiences", tone: "icp", icon: "audience" },
      { label: "Sequences", path: "/launches", summary: "Targeted campaign sends", tone: "voice", icon: "campaigns" },
      { label: "CRM", path: "/crm", summary: "Contacts and account context", tone: "icp", icon: "user" },
      { label: "PR & media", path: "/pr", summary: "Media contacts and pitches", tone: "belief", icon: "notification" },
    ],
  },
  {
    label: "Ads", path: "/ads", summary: "Creative, launch, spend, and results", tone: "belief", icon: "ad", section: "grow", requires: "ads",
    children: [
      { label: "Overview", path: "/ads", summary: "Paid channel performance", tone: "belief", icon: "ad" },
      { label: "Creative", path: "/ad-creatives", summary: "Platform-ready variants", tone: "voice", icon: "post" },
      { label: "Launch & spend", path: "/ad-launches", summary: "Spend-controlled launches", tone: "belief", icon: "status-live" },
    ],
  },
  {
    label: "Insights", path: "/insights", summary: "Performance and accepted learning", tone: "history", icon: "status-learning", section: "grow", requires: "insights",
    children: [
      { label: "Performance", path: "/insights", summary: "What worked and why", tone: "icp", icon: "status-learning" },
      { label: "Learning", path: "/learning", summary: "Brain updates from decisions", tone: "history", icon: "doc-history" },
    ],
  },
  {
    label: "Brain", path: "/brain", summary: "Brand, voice, evidence, and context", tone: "system", icon: "brain", section: "foundations",
    children: [
      { label: "Brain docs", path: "/brain", summary: "The editable GTM memory", tone: "system", icon: "brain" },
      { label: "Content Preferences", path: "/brain#content-preferences", summary: "Channel and scoped guidance", tone: "voice", icon: "edit" },
      { label: "Source materials", path: "/evidence", summary: "Proof and evidence", tone: "history", icon: "doc-history" },
      { label: "Advanced context", path: "/resolver", summary: "Inspect what Tuezday will use", tone: "icp", icon: "search" },
    ],
  },
  { label: "Integrations", path: "/connectors", summary: "Connect the GTM stack", tone: "system", icon: "connect", section: "foundations" },
  {
    label: "Create New", path: "/content", summary: "Draft cross-channel work", tone: "belief", icon: "create", section: "library",
    children: [
      { label: "Create", path: "/content", summary: "Posts and signal responses", tone: "belief", icon: "post" },
      { label: "Advanced", path: "/sandbox", summary: "Generate directly from the Brain", tone: "system", icon: "status-generating" },
    ],
  },
  {
    label: "Settings", path: "/team", summary: "Workspace administration", tone: "system", icon: "settings", section: "workspace",
    children: [
      { label: "Team", path: "/team", summary: "Members and invites", tone: "icp", icon: "audience" },
      { label: "Billing", path: "/billing", summary: "Plan and usage", tone: "history", icon: "doc-history" },
      { label: "Notifications", path: "/notifications", summary: "Email and Telegram alerts", tone: "signal", icon: "notification" },
      { label: "Activity", path: "/activity", summary: "Event log and audit trail", tone: "system", icon: "info" },
    ],
  },
];
```

- [ ] **Step 5: Make `navEntryForPath` ignore hash-only aliases**

At the start of its internal `consider` function, skip configured deep links whose distinction exists only in the browser hash:

```ts
if (path.includes("#")) return;
```

Keep the existing comparisons unchanged after this guard. This lets `/brain#content-preferences` navigate correctly while `navEntryForPath(WORKSPACE_NAV, "/brain")` continues to resolve to `Brain docs`, because URL hashes are not present in `usePathname()`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm test -w packages/contracts -- nav-visibility.test.ts nav-entry.test.ts nav-icons.test.ts
npm run typecheck -w packages/contracts
```

Expected: all exit `0`.

```bash
git add packages/contracts/src/index.ts packages/contracts/test/nav-visibility.test.ts packages/contracts/test/nav-entry.test.ts packages/contracts/test/nav-icons.test.ts
git commit -m "feat(contracts): align navigation with approved IA"
```

---

### Task 6: Sectioned shell, global Create, and Content Preferences anchor

**Files:**
- Modify: `apps/web/app/workspaces/[id]/layout.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/src/components/top-bar.tsx`
- Modify: `apps/web/src/components/top-bar.module.css`
- Modify: `apps/web/app/workspaces/[id]/brain/page.tsx`
- Modify: `apps/web/lib/icon-registry.test.ts`

**Interfaces:**
- Consumes: `NAV_SECTIONS`, sectioned `WORKSPACE_NAV`, `visibleNavItems`.
- Produces: visible nav region labels, a global Create New link, stable Content Preferences deep link, and narrow-screen shell behavior.

- [ ] **Step 1: Update icon coverage for the new top-level vocabulary**

In `apps/web/lib/icon-registry.test.ts`, change the required nav list to:

```ts
"home", "calendar", "campaigns", "review", "discover", "audience", "ad",
"status-learning", "brain", "connect", "create", "settings",
```

Run: `npm exec --prefix apps/web vitest -- run lib/icon-registry.test.ts`

Expected: PASS because the new IA reuses existing registered icons.

- [ ] **Step 2: Mark section boundaries without rewriting nav-item behavior**

Import `NAV_SECTIONS` in the workspace layout. Change the existing `navItems.map((item) => {` callback to receive `itemIndex`, then add these declarations immediately after `groupActive`:

```ts
const previousItem = navItems[itemIndex - 1];
const startsSection = previousItem?.section !== item.section;
const sectionLabel = NAV_SECTIONS.find((section) => section.id === item.section)?.label ?? item.section;
```

Add these attributes to the existing `<section className="ws-nav-group ...">` element:

```tsx
data-section-start={startsSection ? "true" : undefined}
data-section-label={startsSection ? sectionLabel : undefined}
```

Do not replace the existing item JSX. These two data attributes allow CSS to render section labels while preserving the guide dot, child navigation, integration progress, capability filtering, and active-route logic byte-for-byte.

- [ ] **Step 3: Add section and responsive shell styles**

Append or update these rules in `globals.css`:

```css
.ws-nav { gap: 3px; }
.ws-nav-group[data-section-start="true"] { margin-top: 11px; }
.ws-nav-group[data-section-start="true"]::before {
  content: attr(data-section-label);
  display: block;
  padding: 0 10px 5px;
  color: var(--muted-2);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.ws-kicker,
.ws-workspace-label { font-family: var(--font-mono); }

@media (max-width: 860px) {
  .ws-sidebar { max-height: 46vh; overflow-y: auto; }
  .ws-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 8px; }
  .ws-nav-group { min-width: 0; }
}

@media (max-width: 560px) {
  .ws-nav { grid-template-columns: 1fr; }
  .ws-sidebar { max-height: 54vh; }
}
```

- [ ] **Step 4: Add global Create New to the top bar**

In `top-bar.tsx`, import `Link` and `buttonStyles`. Add this link before the actions portal:

```tsx
<Link
  href={`/workspaces/${id}/content`}
  className={`${buttonStyles.button} ${buttonStyles.primary} ${buttonStyles.sm} ${styles.create}`}
>
  <Icon name="add" size="sm" />
  Create New
</Link>
```

Keep page-specific `TopBarActions` after this global action. In `top-bar.module.css`, add:

```css
.create { margin-left: auto; }
.actions { margin-left: 0; }
@media (max-width: 720px) {
  .workspace { display: none; }
  .create { padding-inline: 9px; }
}
```

- [ ] **Step 5: Add the Content Preferences anchor**

Add `id="content-preferences"` to the Brain page section whose heading is `Channel guidance`. Add `scroll-margin-top: 72px` to the corresponding global `.guidance-section` rule.

- [ ] **Step 6: Verify shell behavior**

Run:

```bash
npm exec --prefix apps/web vitest -- run lib/icon-registry.test.ts
npm run typecheck -w apps/web
npm run build -w apps/web
```

Manual checks at 1440px, 1024px, 768px, and 390px:

- Section labels render in the approved order.
- Calendar, Ads, Insights, Brain, and Integrations appear in their target areas.
- Ads and Insights remain capability-gated.
- The guide dot still appears at most once.
- `Create New` opens `/content` from every workspace route.
- `/brain#content-preferences` lands on Channel guidance.
- Carousel rendering and ad image generation remain reachable.

- [ ] **Step 7: Commit**

```bash
git add 'apps/web/app/workspaces/[id]/layout.tsx' apps/web/app/globals.css apps/web/src/components/top-bar.tsx apps/web/src/components/top-bar.module.css 'apps/web/app/workspaces/[id]/brain/page.tsx' apps/web/lib/icon-registry.test.ts
git commit -m "feat(web): establish sectioned control-room shell"
```

---

### Task 7: Foundation acceptance and handoff to the golden-loop plan

**Files:**
- Modify: `docs/ui-ux/capability-registry.md`
- Create: `docs/ui-ux/foundation-acceptance.md`

**Interfaces:**
- Produces: evidence that the shared foundation is safe for the next implementation plan.

- [ ] **Step 1: Run focused tests**

```bash
npm test -w packages/contracts -- workflow-status.test.ts nav-visibility.test.ts nav-entry.test.ts nav-icons.test.ts
npm exec --prefix apps/web vitest -- run lib/design-tokens.test.ts lib/workflow-status.test.ts lib/icon-registry.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the full repository gate with bounded workers**

```bash
npm test -- --maxWorkers=2
npm run typecheck
npm run build -w apps/web
```

Expected: every command exits `0`. A hook timeout is a failed gate until the affected file passes in the bounded full run; an isolated pass alone is not sufficient.

- [ ] **Step 3: Create the acceptance record**

Write `docs/ui-ux/foundation-acceptance.md` with:

```markdown
# UI/UX Revamp Foundation Acceptance

Baseline: `integration/gtm-foundation@1e38c14`

## Automated gates

- Full Vitest suite with two workers: passed
- Workspace type checking: passed
- Web production build: passed
- Workflow status contract: passed
- Navigation and icon coverage: passed
- Website-derived token contract: passed

## Manual gates

- Sectioned navigation verified at 1440px, 1024px, 768px, and 390px
- One guide dot maximum verified
- Global Create New verified from Home, Campaigns, Review, Calendar, and Brain
- Content Preferences deep link verified
- Workflow badges show icon and text
- Ads and Insights capability gating verified
- Approvals carousel generation preserved
- Ad Creative image generation preserved

## Next plan boundary

The next implementation plan may build the golden loop:

`Home → Campaign → Review → Conversational editor → Approval/authorization → Calendar → Execution result`

It must consume the exact navigation sections, workflow statuses, analytics names, and visual tokens established here.
```

- [ ] **Step 4: Mark the registry foundation rows implemented**

Add an `Implementation status` column to `capability-registry.md`. Mark ranked next action, campaign inventory, review queue, carousel rendering, content approval, calendar, connection recovery, Brain disclosure APIs, and learning suggestions as `existing behavior preserved`; mark canonical status and navigation placement as `foundation complete`; keep campaign control plane UI, plan history UI, lane UI, authorization UI, and unified execution results as `golden-loop plan`.

- [ ] **Step 5: Commit**

```bash
git add docs/ui-ux/capability-registry.md docs/ui-ux/foundation-acceptance.md
git commit -m "docs: accept UI revamp foundations"
```
