# Unified Review Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Approvals page and the Inbox page into one unified Review workspace at `/workspaces/:id/review`, with Approvals and Inbox as sibling tabs that share campaign context, canonical workflow-status language, filters, and queue navigation — per §5.2 and §6.2 of `docs/superpowers/specs/2026-07-12-consolidated-ui-ux-revamp-design.md`.

**Branch:** `ui-revamp/review-workspace`, branched from `ui-revamp/campaign-control-plane@500c13f` (required merge order: foundations → campaign control plane → this branch).

**Architecture:** No API changes. The web app adds `/review` with URL-addressable tabs (`?tab=approvals|inbox`), coordinated by a pure view-model module (`apps/web/lib/review-workspace.ts`) following the `campaign-control-plane.ts` pattern. The existing Approvals and Inbox page bodies move into `_components/approvals-queue.tsx` and `_components/inbox-queue.tsx` with behavior preserved, then gain: campaign/channel filters (Approvals), previous/next queue navigation, and canonical `WorkflowStatusBadge` statuses (Inbox currently uses ad-hoc tone badges). `/approvals` and `/inbox` become param-preserving redirects. Navigation and GTM-checklist contracts repoint to `/review`.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Zod contracts, CSS Modules, Vitest.

## Scope decisions (from the codebase survey, 2026-07-13)

- **External-action authorization stays out.** `EXTERNAL_ACTION_STATUSES` / `canTransitionExternalAction` exist in contracts, but there is no external-actions route, service, or table. The capability registry already assigns that UI to the golden-loop plan; this slice keeps content approval and external-action authorization distinct and does not fake an authorization queue. The Review shell is built so an Authorizations tab can be added later without restructuring.
- **Assignment, comments, owner/risk/due-time filters stay out.** No API support exists; the design's filter list is implemented for the dimensions the API and data model support today: status, campaign, channel (Approvals) and status (Inbox).
- **Batch approval stays as-is.** The existing per-group "Approve all" (equivalent, same-group items) is preserved; no new batch endpoint.
- **Filtering stays client-side.** Both pages already load full lists (`GET /drafts`, `GET /inbox`); counts across filters require the full list anyway. Server-side `state`/`campaignId`/`status` query params remain available for later scale work.
- **Inbox → canonical status mapping:** `unread` and `read` both map to `review_required` (both await a human decision; the status filter still distinguishes them), `replied` → `completed`, `dismissed` → `archived`. Reply-draft chips reuse the draft mapping.

## Global Constraints

- Implement only the Review workspace slice; Calendar, unified execution results, authorization queue, and conversational editor remain separate plans.
- Do not modify login, authentication, onboarding-flow, dev-admin bootstrap, or environment-loading files.
- Preserve all existing approvals behavior: approve/edit/reject/resubmit, focus-advance after approve, group "Approve all", carousel generation, re-run review, decision history, "Posting to" rail with inline OAuth connect, copy/download actions, media strips, `WhyThisOutput`.
- Preserve all existing inbox behavior: run-now, mark read/dismiss, draft reply, approve-and-post, posted-reply links, empty-state preview cards, show-more pagination.
- Enum vocabularies come from `@tuezday/contracts` only; approval transitions via `canTransition` only.
- Every workflow status uses text, icon, and semantic color through `WorkflowStatusBadge`; color never carries meaning alone. The Inbox tab must stop using ad-hoc `Badge` tones for item status.
- Use only shared design tokens and UI primitives; no raw brand/workflow colors in feature CSS.
- Old deep links must keep working: `/approvals` and `/inbox` redirect to the matching `/review` tab and preserve query params (`?campaign=` in particular — the campaign workspace links to `/approvals?campaign=<id>`).
- Desktop and laptop layouts fully functional; at narrow widths filter rows wrap and the gallery stacks (already responsive). Keyboard order, visible focus, and the approve focus-advance behavior are preserved.
- Use TDD: observe each focused test fail before implementing its production change.
- Commit after every task with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 1: Review workspace view model

**Files:**
- Create: `apps/web/lib/review-workspace.ts`
- Create: `apps/web/lib/review-workspace.test.ts`

**Interfaces:**
- `REVIEW_TABS = ["approvals", "inbox"] as const`, `type ReviewTab`, `reviewTab(value: string | null): ReviewTab` (default `"approvals"`).
- `reviewHref(workspaceId: string, opts?: { tab?: ReviewTab; campaign?: string }): string` — canonical link builder used by redirects and cross-links.
- `draftWorkflowStatus(state: ApprovalState): WorkflowStatus` — moves the mapping currently local to `approvals/page.tsx` (`draft→draft`, `pending_review→review_required`, `edited→changes_requested`, `approved→approved`, `rejected→rejected`).
- `inboxWorkflowStatus(status: InboxItemStatus): WorkflowStatus` — `unread→review_required`, `read→review_required`, `replied→completed`, `dismissed→archived`.
- `type DraftFilters = { state: ApprovalState | "all"; campaignId: string | "all"; channel: Channel | "all" }`
- `filterDrafts(drafts: Draft[], filters: DraftFilters): Draft[]` — applies all three dimensions.
- `draftChannels(drafts: Draft[]): Channel[]` — distinct channels present, stable order, for the channel select.
- `queueNeighbors(orderedIds: string[], currentId: string): { prev: string | null; next: string | null }`.

- [x] **Step 1: Write the failing test** (`apps/web/lib/review-workspace.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import type { Draft } from "@tuezday/contracts";
import {
  draftChannels,
  draftWorkflowStatus,
  filterDrafts,
  inboxWorkflowStatus,
  queueNeighbors,
  reviewHref,
  reviewTab,
} from "./review-workspace";

function draft(overrides: Partial<Draft>): Draft {
  return {
    id: "d1",
    workspaceId: "w1",
    sourceGenerationId: null,
    sourceSignalId: null,
    campaignId: null,
    leadId: null,
    mediaContactId: null,
    taskType: "linkedin_post",
    channel: "linkedin",
    personaId: null,
    originalContent: "x",
    content: "x",
    state: "pending_review",
    media: null,
    createdAt: 1,
    updatedAt: 1,
    review: null,
    ...overrides,
  } as Draft;
}

describe("review workspace view model", () => {
  it("parses the tab param with a safe default", () => {
    expect(reviewTab("inbox")).toBe("inbox");
    expect(reviewTab("approvals")).toBe("approvals");
    expect(reviewTab("nonsense")).toBe("approvals");
    expect(reviewTab(null)).toBe("approvals");
  });

  it("builds canonical review links", () => {
    expect(reviewHref("w1")).toBe("/workspaces/w1/review");
    expect(reviewHref("w1", { tab: "inbox" })).toBe("/workspaces/w1/review?tab=inbox");
    expect(reviewHref("w1", { tab: "approvals", campaign: "c9" })).toBe(
      "/workspaces/w1/review?tab=approvals&campaign=c9",
    );
  });

  it("maps approval states onto the canonical workflow vocabulary", () => {
    expect(draftWorkflowStatus("pending_review")).toBe("review_required");
    expect(draftWorkflowStatus("edited")).toBe("changes_requested");
    expect(draftWorkflowStatus("approved")).toBe("approved");
  });

  it("maps inbox statuses onto the canonical workflow vocabulary", () => {
    expect(inboxWorkflowStatus("unread")).toBe("review_required");
    expect(inboxWorkflowStatus("read")).toBe("review_required");
    expect(inboxWorkflowStatus("replied")).toBe("completed");
    expect(inboxWorkflowStatus("dismissed")).toBe("archived");
  });

  it("filters drafts by state, campaign, and channel together", () => {
    const drafts = [
      draft({ id: "a", campaignId: "c1", channel: "linkedin" }),
      draft({ id: "b", campaignId: "c1", channel: "email", state: "approved" }),
      draft({ id: "c", campaignId: null, channel: "linkedin" }),
    ];
    expect(
      filterDrafts(drafts, { state: "pending_review", campaignId: "c1", channel: "all" }).map((d) => d.id),
    ).toEqual(["a"]);
    expect(
      filterDrafts(drafts, { state: "all", campaignId: "all", channel: "linkedin" }).map((d) => d.id),
    ).toEqual(["a", "c"]);
    expect(filterDrafts(drafts, { state: "all", campaignId: "all", channel: "all" })).toHaveLength(3);
  });

  it("lists distinct channels in first-seen order", () => {
    const drafts = [
      draft({ id: "a", channel: "linkedin" }),
      draft({ id: "b", channel: "email" }),
      draft({ id: "c", channel: "linkedin" }),
    ];
    expect(draftChannels(drafts)).toEqual(["linkedin", "email"]);
  });

  it("finds queue neighbors and handles the edges", () => {
    expect(queueNeighbors(["a", "b", "c"], "b")).toEqual({ prev: "a", next: "c" });
    expect(queueNeighbors(["a", "b", "c"], "a")).toEqual({ prev: null, next: "b" });
    expect(queueNeighbors(["a", "b", "c"], "c")).toEqual({ prev: "b", next: null });
    expect(queueNeighbors(["a"], "missing")).toEqual({ prev: null, next: null });
  });
});
```

- [x] **Step 2: Run and verify failure**: `npm exec --prefix apps/web vitest -- run lib/review-workspace.test.ts` — FAIL (module missing).
- [x] **Step 3: Implement `apps/web/lib/review-workspace.ts`** as pure functions with no React imports.
- [x] **Step 4: Verify green**, then commit: `feat(web): define review workspace view model`.

---

### Task 2: Repoint navigation and checklist contracts at `/review`

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/nav-visibility.test.ts`
- Modify: `packages/contracts/test/nav-entry.test.ts`
- Modify: `packages/contracts/test/next-action.test.ts` (only if it asserts `/approvals` module paths)

**Changes:**
- `WORKSPACE_NAV` Review item becomes a single entry: `{ label: "Review", path: "/review", summary: "Approve, authorize, and respond", tone: "icp", icon: "review", section: "operate" }` — **children removed** (Approvals and Inbox are in-page tabs now; `navEntryForPath` matches on pathname only, so `?tab=` children would never resolve).
- GTM checklist / next-action module paths that point at `/approvals` (e.g. `first_approval`) change to `/review`.
- `navEntryForPath` itself is untouched — `/review` resolves via the normal longest-path rule.

- [x] **Step 1: Update the tests first** — nav-visibility: Review tuple becomes `["operate", "Review", "/review"]` and the children assertion is removed/emptied; nav-entry: `/review` resolves to `{ label: "Review" }` with no `parentLabel`, and add a case that `/review` sub-paths resolve to Review; next-action: `first_approval.module === "/review"`.
- [x] **Step 2: Run and verify failure**: `npm test -w packages/contracts -- nav-visibility.test.ts nav-entry.test.ts next-action.test.ts`.
- [x] **Step 3: Apply the contract changes.**
- [x] **Step 4: Verify green** (including `nav-icons.test.ts` and `npm exec --prefix apps/web vitest -- run lib/shell-contract.test.ts`), then commit: `feat(contracts): point Review navigation at the unified workspace`.

---

### Task 3: `/review` route shell with Approvals and Inbox tabs

**Files:**
- Create: `apps/web/app/workspaces/[id]/review/page.tsx`
- Create: `apps/web/app/workspaces/[id]/review/review.module.css`
- Create: `apps/web/app/workspaces/[id]/review/_components/approvals-queue.tsx` (moved body of `approvals/page.tsx`)
- Create: `apps/web/app/workspaces/[id]/review/_components/inbox-queue.tsx` (moved body of `inbox/page.tsx`)
- Move: `approvals/approvals.module.css` → `review/_components/approvals-queue.module.css`; `inbox/inbox.module.css` → `review/_components/inbox-queue.module.css`

**Shape:**
- `page.tsx` is a thin client shell: reads `?tab=` via `useSearchParams` + `reviewTab()`, renders the page header ("Review" / decision-focused subtitle), a `Link`-based tab nav (`?tab=approvals` / `?tab=inbox`, `aria-current="page"` on the active tab — same pattern as the campaign workspace), with live counts (pending-review drafts; unread inbox items) fetched once in the shell and passed down or fetched within each queue (keep each queue self-loading as today; the shell shows counts from lightweight parallel fetches of `/drafts` and `/inbox`). Prefer the simplest correct structure: the shell owns nothing but the tab switch; each queue component keeps its own data loading exactly as the old pages did.
- `approvals-queue.tsx` / `inbox-queue.tsx`: the existing page components renamed, receiving `workspaceId` as a prop instead of `useParams`. Behavior preserved verbatim in this task (state filters, groups, detail, actions). Both continue to use `draftWorkflowStatus` from the new lib (approvals drops its local `APPROVAL_WORKFLOW_STATUS`).
- Keep `TopBarActions` ("Run inbox now") mounted only when the Inbox tab is active.

- [x] **Step 1: Write the failing contract test** — extend `apps/web/lib/review-workspace.test.ts` is already done; for the route, add a small structural test `apps/web/lib/review-shell-contract.test.ts` that reads `app/workspaces/[id]/review/page.tsx` source (same technique as `shell-contract.test.ts`) and asserts it references `reviewTab`, both `?tab=` links, and both queue components.
- [x] **Step 2: Verify failure**, implement the shell and the two moved components, delete `approvals/page.tsx` and `inbox/page.tsx` bodies (the routes themselves are replaced in Task 5 with redirects — until then keep temporary re-export pages rendering the queues to avoid a broken interim commit, or fold Task 5's redirects into this commit if smaller).
- [x] **Step 3: Verify green**: review tests + `npm run typecheck`. Commit: `feat(web): unify approvals and inbox under the review workspace`.

---

### Task 4: Campaign and channel filters plus queue navigation (Approvals tab)

**Files:**
- Modify: `apps/web/app/workspaces/[id]/review/_components/approvals-queue.tsx`
- Modify: `apps/web/app/workspaces/[id]/review/page.tsx` (pass initial `?campaign=` through)
- Modify: `apps/web/lib/review-workspace.ts` / test only if gaps surface

**Changes:**
- The approvals queue reads the initial campaign filter from `?campaign=` (the campaign workspace already links to Review with that param) and renders a filter row: existing state `Tabs` (unchanged) plus a campaign `<select>` (from loaded campaigns, "All campaigns") and a channel `<select>` (`draftChannels`, "All channels"). Filtering goes through `filterDrafts`; group building and counts operate on the filtered list. Changing campaign updates the URL param via `router.replace` so the filter is shareable; state/channel remain local state.
- Detail panel gains Previous/Next buttons driven by `queueNeighbors` over the visible (filtered, grouped, flattened) draft order, so a reviewer can walk the queue without closing the panel. Keyboard focus moves with the navigation; the existing approve focus-advance is untouched.
- An active filter with zero matches shows the existing `EmptyState` with a "Clear filters" action.

- [x] **Step 1: Any new pure logic goes into `review-workspace.ts` with failing tests first** (e.g. visible-order flattening helper `visibleDraftOrder(groups)` if extracted).
- [x] **Step 2: Implement the filter row and prev/next navigation.**
- [x] **Step 3: Verify green** (`review-workspace.test.ts`, typecheck), then commit: `feat(web): add campaign and channel filters with queue navigation to review`.

---

### Task 5: Canonical statuses on the Inbox tab and cross-link migration

**Files:**
- Modify: `apps/web/app/workspaces/[id]/review/_components/inbox-queue.tsx`
- Replace: `apps/web/app/workspaces/[id]/approvals/page.tsx` → redirect
- Replace: `apps/web/app/workspaces/[id]/inbox/page.tsx` → redirect
- Modify: in-app links to `/approvals` and `/inbox` across `apps/web` (campaign workspace pages, home page, activity, content, crm, learning, outbound, pr, sandbox, team, onboarding draft panel, diagram-kit copy)

**Changes:**
- Inbox item status chips switch from tone `Badge` to `WorkflowStatusBadge` via `inboxWorkflowStatus`; the reply-draft chip uses `draftWorkflowStatus`. The status filter `Tabs` keep the domain labels (Unread/Read/Replied/Dismissed) — filters are domain-level, badges are canonical.
- "review on Review" and similar links point to `/review?tab=approvals`.
- `/approvals` and `/inbox` become tiny client redirect pages: on mount, `router.replace(reviewHref(id, { tab, campaign }))` preserving known params (`campaign`). (Client redirect because the routes live under the authenticated client layout; a server `redirect()` in a page component is also acceptable if it composes with the layout — implementer's choice, but params must survive.)
- Sweep every `href` containing `/approvals` or `/inbox` in `apps/web` to the `reviewHref` equivalents.

- [x] **Step 1: Extend `review-workspace.test.ts`** with a redirect-mapping test if a pure helper is used (e.g. `legacyReviewRedirect(pathname, searchParams)` → target URL) — write failing, implement.
- [x] **Step 2: Implement badges, redirects, and the link sweep.**
- [x] **Step 3: Verify green** and grep that no stale `/approvals` / `/inbox` hrefs remain outside the redirect pages. Commit: `feat(web): canonical inbox statuses and review redirects`.

---

### Task 6: Full verification, capability registry, acceptance

**Files:**
- Modify: `docs/ui-ux/capability-registry.md` (Review queue row → Implemented: unified review workspace; note authorization remains golden-loop)
- Create: `docs/ui-ux/review-workspace-acceptance.md`

- [x] **Step 1:** `npm test -- --maxWorkers=2` — all suites green.
- [x] **Step 2:** `npm run typecheck` — green.
- [x] **Step 3:** `npm run build -w apps/web` — production build green, `/review` route compiled.
- [x] **Step 4:** Update the capability registry row and write the acceptance doc (delivered surface, preserved behavior, verification evidence table, responsive acceptance, known non-blocking notes, next slice pointer → Calendar).
- [x] **Step 5:** Commit `docs: accept unified review workspace UI` and push `ui-revamp/review-workspace` to origin.

## Progress log

- 2026-07-13: Plan written after codebase survey (drafts/inbox APIs, nav contracts, workflow-status foundation, campaign control-plane patterns). External-action authorization confirmed contract-only — kept out of scope.
- 2026-07-13: Tasks 1–5 implemented TDD-first, one commit each. Legacy-route redirects were folded into Task 3 so no interim commit shipped duplicate pages. `chevron-left` added to the shared icon registry for queue navigation. Task 6 verification in progress.
