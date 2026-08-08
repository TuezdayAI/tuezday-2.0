# Campaign Control Plane UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the expandable legacy campaign list with a campaign-first operating workspace that exposes overview, immutable plan history, and editable channel lanes through the merged orchestration APIs.

**Architecture:** Preserve the existing campaign and orchestration domain model. Add one contract-backed campaign-plan workspace read model, enrich lane reads with their stable name/key, and clone active lane configuration into new draft revisions. The web app keeps the inventory route at `/campaigns` and adds `/campaigns/[campaignId]`, with focused Overview, Plan history, and Channels components coordinated by one client data shell.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Fastify, Drizzle ORM with SQLite, Zod contracts, CSS Modules, Vitest.

## Global Constraints

- Implement only the Campaign Control Plane slice; Review, Calendar, execution results, and other journey waves remain separate plans.
- Do not modify login, authentication, onboarding, dev-admin bootstrap, or environment-loading files; those are owned by the parallel session.
- Preserve all existing campaign creation, editing, automation, cadence, insights export, audience, ad-performance, and archive behavior until an explicit replacement is available.
- Campaign is the user-facing context. Use `Campaign → Content set → Channel item`; keep backend terms such as lane and revision inside Plan history and Channels where they add value.
- Use only shared design tokens and UI primitives. Do not add raw brand or workflow colors to feature CSS.
- Every workflow status uses text, icon, and semantic color through `WorkflowStatusBadge`; color never carries meaning alone.
- Content approval and external-action authorization remain distinct; this slice links to Review but does not merge those states.
- Desktop and laptop layouts are fully functional. At narrow widths, planning panels stack and dense lane editing exposes a clear desktop-continuation note rather than silently hiding controls.
- Preserve keyboard order, visible focus, reduced-motion behavior, loading, empty, blocked, stale, partial, and error states applicable to this slice.
- Use TDD: observe each focused test fail before implementing its production change.
- Commit after every task. Do not mix parallel-session auth changes into this branch.

---

### Task 1: Define the campaign workspace read contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/campaign-workspace.test.ts`

**Interfaces:**
- Produces: `CampaignPlanIssue`, `CampaignLaneRevisionView`, `CampaignPlanDetail`, and `CampaignPlanWorkspace`.
- `CampaignPlanWorkspace.revisions` is ordered newest-first and contains lane details for every revision so draft revisions can be edited without another endpoint.

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from "vitest";
import {
  campaignLaneRevisionViewSchema,
  campaignPlanWorkspaceSchema,
} from "../src/index.js";

const plan = {
  id: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  campaignId: "10000000-0000-4000-8000-000000000003",
  revision: 2,
  status: "draft",
  objective: "Create qualified demand",
  kpi: "20 demos",
  timeframe: "Q3 2026",
  startAt: null,
  endAt: null,
  audienceIds: [],
  pillars: ["GTM memory"],
  offers: ["Demo"],
  ctas: ["Book a demo"],
  guidance: "Use evidence.",
  createdBy: null,
  createdAt: 1,
  activatedAt: null,
} as const;

const lane = {
  id: "20000000-0000-4000-8000-000000000001",
  workspaceId: plan.workspaceId,
  laneId: "20000000-0000-4000-8000-000000000002",
  planRevisionId: plan.id,
  key: "founder-linkedin",
  name: "Founder LinkedIn",
  personaId: "20000000-0000-4000-8000-000000000003",
  audienceId: null,
  channel: "linkedin",
  format: "linkedin_post",
  publishingConnectionId: null,
  providerTarget: "",
  deliveryMode: "planned",
  plannedQuantity: 3,
  schedule: { daysOfWeek: [1, 3, 5], timeOfDay: "09:30", timezone: "Asia/Kolkata" },
  reactivePeriod: null,
  reactiveCap: null,
  status: "active",
  createdAt: 1,
} as const;

describe("campaign workspace contracts", () => {
  it("adds stable lane identity to a lane revision", () => {
    expect(campaignLaneRevisionViewSchema.parse(lane)).toMatchObject({
      key: "founder-linkedin",
      name: "Founder LinkedIn",
    });
  });

  it("validates revision history and configuration issues", () => {
    const result = campaignPlanWorkspaceSchema.parse({
      currentPlanRevisionId: null,
      revisions: [{ plan, lanes: [lane] }],
      issues: [{
        path: "channels.email",
        code: "execution_mapping_missing",
        message: "Choose an execution mapping for email.",
      }],
    });
    expect(result.revisions[0]?.lanes[0]?.name).toBe("Founder LinkedIn");
    expect(result.issues[0]?.code).toBe("execution_mapping_missing");
  });
});
```

- [ ] **Step 2: Run the test and verify the missing exports fail**

Run: `npm test -w packages/contracts -- campaign-workspace.test.ts`

Expected: FAIL because `campaignLaneRevisionViewSchema` and `campaignPlanWorkspaceSchema` are not exported.

- [ ] **Step 3: Add the read contracts immediately after `CampaignLaneRevision`**

```ts
export const campaignPlanIssueSchema = z.object({
  path: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
});
export type CampaignPlanIssue = z.infer<typeof campaignPlanIssueSchema>;

export const campaignLaneRevisionViewSchema = campaignLaneRevisionSchema.extend({
  key: campaignLaneSchema.shape.key,
  name: campaignLaneSchema.shape.name,
});
export type CampaignLaneRevisionView = z.infer<typeof campaignLaneRevisionViewSchema>;

export const campaignPlanDetailSchema = z.object({
  plan: campaignPlanRevisionSchema,
  lanes: z.array(campaignLaneRevisionViewSchema),
});
export type CampaignPlanDetail = z.infer<typeof campaignPlanDetailSchema>;

export const campaignPlanWorkspaceSchema = z.object({
  currentPlanRevisionId: z.string().uuid().nullable(),
  revisions: z.array(campaignPlanDetailSchema),
  issues: z.array(campaignPlanIssueSchema),
});
export type CampaignPlanWorkspace = z.infer<typeof campaignPlanWorkspaceSchema>;
```

- [ ] **Step 4: Run the contract tests and typecheck**

Run: `npm test -w packages/contracts -- campaign-workspace.test.ts orchestration.test.ts`

Expected: PASS.

Run: `npm run typecheck -w packages/contracts`

Expected: PASS.

- [ ] **Step 5: Commit the contracts**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/campaign-workspace.test.ts
git commit -m "feat(contracts): define campaign workspace read model"
```

---

### Task 2: Expose named lanes and revision history through the API

**Files:**
- Modify: `apps/api/src/services/campaign-lanes.ts`
- Modify: `apps/api/src/services/campaign-plan-errors.ts`
- Modify: `apps/api/src/services/campaign-plans.ts`
- Modify: `apps/api/src/services/orchestration-backfill.ts`
- Modify: `apps/api/src/routes/campaign-plans.ts`
- Modify: `apps/api/test/orchestration-foundation.test.ts`

**Interfaces:**
- Produces: `getCampaignPlanWorkspace(db, workspaceId, campaignId): CampaignPlanWorkspace` from `orchestration-backfill.ts`, avoiding a `campaigns → orchestration-backfill → campaign-plans → campaigns` import cycle.
- Produces route: `GET /workspaces/:id/campaigns/:campaignId/plan/workspace`.
- Preserves route: `GET /workspaces/:id/campaigns/:campaignId/plan` and its existing flattened lane fields.

- [ ] **Step 1: Add a failing route test after the current-plan route test**

```ts
it("reads named lanes and newest-first plan history for the campaign workspace", async () => {
  const first = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
    payload: revisionPayload,
  });
  const firstPlan = first.json();
  await app.inject({
    method: "PUT",
    url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${firstPlan.id}/lanes`,
    payload: lanePayload(),
  });
  await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${firstPlan.id}/activate`,
  });

  const second = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
    payload: { ...revisionPayload, objective: "Refined objective" },
  });
  expect(second.statusCode).toBe(201);

  const response = await app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/workspace`,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    currentPlanRevisionId: firstPlan.id,
    revisions: [
      { plan: { revision: 2, status: "draft" } },
      {
        plan: { revision: 1, status: "active" },
        lanes: [{ key: "founder-linkedin", name: "Founder LinkedIn", channel: "linkedin" }],
      },
    ],
  });
});
```

- [ ] **Step 2: Run the API test and verify the new route returns 404**

Run: `npm test -w apps/api -- orchestration-foundation.test.ts`

Expected: FAIL because `/plan/workspace` is not registered.

- [ ] **Step 3: Enrich lane reads by joining stable lane identity**

Change `listLaneRevisionsForPlan` to return `CampaignLaneRevisionView[]` and join `campaignLanes`:

```ts
export function listLaneRevisionsForPlan(
  db: Db,
  workspaceId: string,
  planRevisionId: string,
): CampaignLaneRevisionView[] {
  return db
    .select({ revision: campaignLaneRevisions, key: campaignLanes.key, name: campaignLanes.name })
    .from(campaignLaneRevisions)
    .innerJoin(campaignLanes, eq(campaignLanes.id, campaignLaneRevisions.laneId))
    .where(
      and(
        eq(campaignLaneRevisions.workspaceId, workspaceId),
        eq(campaignLaneRevisions.planRevisionId, planRevisionId),
      ),
    )
    .all()
    .map(({ revision, key, name }) =>
      campaignLaneRevisionViewSchema.parse({ ...rowToLaneRevision(revision), key, name }),
    );
}
```

Replace the local `CampaignPlanIssue` interface in `campaign-plan-errors.ts` with the contract type so API validation errors and the read model cannot drift:

```ts
import type { CampaignPlanIssue } from "@tuezday/contracts";
```

- [ ] **Step 4: Add newest-first plan workspace assembly**

In `campaign-plans.ts`, import the contract `CampaignPlanDetail`, remove the existing local interface with that name, and add:

```ts
export function listCampaignPlanDetails(
  db: Db,
  workspaceId: string,
  campaignId: string,
): CampaignPlanDetail[] {
  return db
    .select()
    .from(campaignPlanRevisions)
    .where(
      and(
        eq(campaignPlanRevisions.workspaceId, workspaceId),
        eq(campaignPlanRevisions.campaignId, campaignId),
      ),
    )
    .orderBy(desc(campaignPlanRevisions.revision))
    .all()
    .map((row) => ({
      plan: rowToPlan(row),
      lanes: listLaneRevisionsForPlan(db, workspaceId, row.id),
    }));
}

```

In `orchestration-backfill.ts`, assemble the complete read model where `getCampaign` is already an established dependency:

```ts
export function getCampaignPlanWorkspace(
  db: Db,
  workspaceId: string,
  campaignId: string,
): CampaignPlanWorkspace {
  const campaign = getCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new CampaignPlanNotFoundError();
  const revisions = listCampaignPlanDetails(db, workspaceId, campaignId);
  const workingRevision = revisions.find(({ plan }) => plan.status === "draft")
    ?? revisions.find(({ plan }) => plan.id === campaign.currentPlanRevisionId)
    ?? null;
  return campaignPlanWorkspaceSchema.parse({
    currentPlanRevisionId: campaign.currentPlanRevisionId,
    revisions,
    issues: getCampaignConfigurationIssues(campaign, workingRevision?.lanes ?? []),
  });
}
```

Export `getCampaignConfigurationIssues` from `orchestration-backfill.ts`; accept lane views rather than a prebuilt set:

```ts
export function getCampaignConfigurationIssues(
  campaign: Campaign,
  lanes: readonly Pick<CampaignLaneRevisionView, "channel" | "status">[],
): CampaignPlanIssue[] {
  const activeChannels = new Set(
    lanes.filter((lane) => lane.status === "active").map((lane) => lane.channel),
  );
  return campaign.channels
    .filter((channel) => !activeChannels.has(channel))
    .map((channel) => ({
      path: `channels.${channel}`,
      code: "execution_mapping_missing",
      message: `Choose a persona, publishing account, format, and schedule for ${channel}.`,
    }));
}
```

Update the existing summary and backfill callers to use the exported helper.

- [ ] **Step 5: Register the contract-backed read route**

```ts
app.get<{ Params: CampaignParams }>(
  "/workspaces/:id/campaigns/:campaignId/plan/workspace",
  async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    try {
      return getCampaignPlanWorkspace(db, request.params.id, request.params.campaignId);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  },
);
```

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -w apps/api -- orchestration-foundation.test.ts`

Expected: PASS.

Run: `npm run typecheck -w apps/api`

Expected: PASS.

- [ ] **Step 7: Commit the read API**

```bash
git add apps/api/src/services/campaign-lanes.ts apps/api/src/services/campaign-plan-errors.ts apps/api/src/services/campaign-plans.ts apps/api/src/services/orchestration-backfill.ts apps/api/src/routes/campaign-plans.ts apps/api/test/orchestration-foundation.test.ts
git commit -m "feat(api): expose campaign plan workspace"
```

---

### Task 3: Clone active lanes into new draft revisions

**Files:**
- Modify: `apps/api/src/services/campaign-plans.ts`
- Modify: `apps/api/test/orchestration-foundation.test.ts`

**Interfaces:**
- Changes `createPlanRevision` so a revision created after an active plan starts with cloned lane revisions using the same stable `laneId` values.
- Does not mutate or delete lanes on the active or superseded revisions.

- [ ] **Step 1: Extend the history test with the cloning expectation**

```ts
expect(response.json().revisions[0]).toMatchObject({
  plan: { revision: 2, status: "draft" },
  lanes: [{
    laneId: response.json().revisions[1].lanes[0].laneId,
    key: "founder-linkedin",
    name: "Founder LinkedIn",
    channel: "linkedin",
  }],
});
```

- [ ] **Step 2: Run the API test and verify revision 2 has no lanes**

Run: `npm test -w apps/api -- orchestration-foundation.test.ts`

Expected: FAIL because the new draft currently starts with `lanes: []`.

- [ ] **Step 3: Clone current lane rows in the same transaction as plan creation**

Refactor `createPlanRevision` to insert the plan and cloned lanes in one transaction:

```ts
const sourcePlanId = campaign.currentPlanRevisionId;
db.transaction((tx) => {
  tx.insert(campaignPlanRevisions).values(row).run();
  if (!sourcePlanId) return;
  const sourceLanes = tx
    .select()
    .from(campaignLaneRevisions)
    .where(eq(campaignLaneRevisions.planRevisionId, sourcePlanId))
    .all();
  for (const source of sourceLanes) {
    tx.insert(campaignLaneRevisions)
      .values({
        ...source,
        id: randomUUID(),
        planRevisionId: row.id,
        createdAt: row.createdAt,
      })
      .run();
  }
});
```

Select `currentPlanRevisionId` with the campaign existence query. Keep revision numbering and `rowToPlan` unchanged.

- [ ] **Step 4: Verify cloning and immutability**

Run: `npm test -w apps/api -- orchestration-foundation.test.ts`

Expected: PASS, including the pre-existing immutable-active-plan assertions.

Run: `npm run typecheck -w apps/api`

Expected: PASS.

- [ ] **Step 5: Commit revision cloning**

```bash
git add apps/api/src/services/campaign-plans.ts apps/api/test/orchestration-foundation.test.ts
git commit -m "feat(api): clone lanes into campaign plan revisions"
```

---

### Task 4: Add pure campaign-control-plane presentation helpers

**Files:**
- Create: `apps/web/lib/campaign-control-plane.ts`
- Create: `apps/web/lib/campaign-control-plane.test.ts`

**Interfaces:**
- Produces `CampaignWorkspaceTab`, `campaignTab`, `campaignStatus`, `planStatus`, `laneStatus`, `editablePlan`, and `formatLaneSchedule`.
- UI components must use these helpers rather than defining local status labels.

- [ ] **Step 1: Write the failing helper tests**

```ts
import { describe, expect, it } from "vitest";
import {
  campaignStatus,
  campaignTab,
  editablePlan,
  formatLaneSchedule,
  laneStatus,
  planStatus,
} from "./campaign-control-plane";

describe("campaign control plane presentation", () => {
  it("normalizes route tabs", () => {
    expect(campaignTab("plan")).toBe("plan");
    expect(campaignTab("unknown")).toBe("overview");
    expect(campaignTab(null)).toBe("overview");
  });

  it("maps domain states to canonical workflow states", () => {
    expect(campaignStatus("active")).toBe("active");
    expect(campaignStatus("draft")).toBe("draft");
    expect(planStatus("superseded")).toBe("superseded");
    expect(laneStatus("paused")).toBe("paused");
    expect(laneStatus("retired")).toBe("archived");
  });

  it("selects only a draft plan for editing", () => {
    expect(editablePlan([{ plan: { status: "active" } }, { plan: { status: "draft" } }] as never)?.plan.status).toBe("draft");
    expect(editablePlan([{ plan: { status: "active" } }] as never)).toBeNull();
  });

  it("formats planned and reactive delivery without backend terminology", () => {
    expect(formatLaneSchedule({
      deliveryMode: "planned",
      plannedQuantity: 3,
      schedule: { daysOfWeek: [1, 3, 5], timeOfDay: "09:30", timezone: "Asia/Kolkata" },
      reactivePeriod: null,
      reactiveCap: null,
    })).toBe("3 planned · Mon, Wed, Fri · 09:30 · Asia/Kolkata");
    expect(formatLaneSchedule({
      deliveryMode: "reactive",
      plannedQuantity: 0,
      schedule: null,
      reactivePeriod: "week",
      reactiveCap: 2,
    })).toBe("Up to 2 reactive / week");
  });
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-control-plane.test.ts`

Expected: FAIL because `campaign-control-plane.ts` does not exist.

- [ ] **Step 3: Implement the pure helpers**

```ts
import type {
  CampaignLaneRevisionView,
  CampaignPlanDetail,
  CampaignStatus,
  LaneStatus,
  PlanRevisionStatus,
  WorkflowStatus,
} from "@tuezday/contracts";

export const CAMPAIGN_TABS = ["overview", "plan", "channels"] as const;
export type CampaignWorkspaceTab = (typeof CAMPAIGN_TABS)[number];

export function campaignTab(value: string | null): CampaignWorkspaceTab {
  return CAMPAIGN_TABS.includes(value as CampaignWorkspaceTab)
    ? (value as CampaignWorkspaceTab)
    : "overview";
}

export function campaignStatus(status: CampaignStatus): WorkflowStatus {
  return status;
}

export function planStatus(status: PlanRevisionStatus): WorkflowStatus {
  return status === "active" ? "active" : status;
}

export function laneStatus(status: LaneStatus): WorkflowStatus {
  return status === "retired" ? "archived" : status;
}

export function editablePlan(revisions: CampaignPlanDetail[]): CampaignPlanDetail | null {
  return revisions.find(({ plan }) => plan.status === "draft") ?? null;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function formatLaneSchedule(
  lane: Pick<
    CampaignLaneRevisionView,
    "deliveryMode" | "plannedQuantity" | "schedule" | "reactivePeriod" | "reactiveCap"
  >,
): string {
  if (lane.deliveryMode === "reactive") {
    return `Up to ${lane.reactiveCap ?? 0} reactive / ${lane.reactivePeriod ?? "period"}`;
  }
  const planned = `${lane.plannedQuantity} planned`;
  const schedule = lane.schedule
    ? `${lane.schedule.daysOfWeek.map((day) => DAY[day]).join(", ")} · ${lane.schedule.timeOfDay} · ${lane.schedule.timezone}`
    : "Schedule required";
  if (lane.deliveryMode === "planned") return `${planned} · ${schedule}`;
  return `${planned} · ${schedule} · up to ${lane.reactiveCap ?? 0} reactive / ${lane.reactivePeriod ?? "period"}`;
}
```

- [ ] **Step 4: Run focused tests and web typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-control-plane.test.ts lib/workflow-status.test.ts`

Expected: PASS.

Run: `npm run typecheck -w apps/web`

Expected: PASS.

- [ ] **Step 5: Commit the presentation model**

```bash
git add apps/web/lib/campaign-control-plane.ts apps/web/lib/campaign-control-plane.test.ts
git commit -m "feat(web): add campaign control plane view model"
```

---

### Task 5: Redesign the campaign inventory without capability loss

**Files:**
- Create: `apps/web/app/workspaces/[id]/campaigns/_components/campaign-card.tsx`
- Create: `apps/web/app/workspaces/[id]/campaigns/_components/campaign-form.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/page.tsx`
- Replace: `apps/web/app/workspaces/[id]/campaigns/campaigns.module.css`
- Create: `apps/web/lib/campaign-workspace-contract.test.ts`

**Interfaces:**
- `CampaignCard` consumes `{ workspaceId, campaign, summary }` and links to `/workspaces/${workspaceId}/campaigns/${campaign.id}`.
- `CampaignForm` preserves the existing three-step create/edit payload and calls `onSaved(campaign)`.
- The inventory continues to expose New campaign, Settings, archive/unarchive, automation mode, and cadence/guardrail settings.

- [ ] **Step 1: Write the failing source contract for the inventory and detail route**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("campaign workspace source contract", () => {
  it("links inventory cards into a campaign workspace", () => {
    const card = read("app/workspaces/[id]/campaigns/_components/campaign-card.tsx");
    expect(card).toContain("/campaigns/${campaign.id}");
    expect(card).toContain("WorkflowStatusBadge");
    expect(card).toContain("configurationIssueCount");
  });

  it("defines the focused campaign workspace tabs", () => {
    const page = read("app/workspaces/[id]/campaigns/[campaignId]/page.tsx");
    expect(page).toContain('"overview"');
    expect(page).toContain('"plan"');
    expect(page).toContain('"channels"');
    expect(page).toContain("/plan/workspace");
  });
});
```

- [ ] **Step 2: Run the source contract and verify missing files fail**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-workspace-contract.test.ts`

Expected: FAIL because the card and campaign detail route do not exist.

- [ ] **Step 3: Extract the existing form without changing its payload**

Move `EMPTY_FORM`, the three steps, `payloadFromForm`, and channel/persona selection into `CampaignForm`. Use this public prop shape:

```ts
interface CampaignFormProps {
  workspaceId: string;
  campaign?: Campaign;
  personas: Persona[];
  onCancel(): void;
  onSaved(campaign: Campaign): void;
}
```

After a successful POST or PUT, call `onSaved(body as Campaign)`. Keep validation (`name` required, ten pillar maximum), the original campaign purpose/status when editing, and the existing API error messages.

- [ ] **Step 4: Build the control-room campaign card**

The card must render:

```tsx
<article className={styles.campaignCard}>
  <div className={styles.cardTopline}>
    <WorkflowStatusBadge status={campaignStatus(campaign.status)} />
    <span className={styles.timeframe}>{campaign.timeframe || "No timeframe"}</span>
  </div>
  <h2><Link href={`/workspaces/${workspaceId}/campaigns/${campaign.id}`}>{campaign.name}</Link></h2>
  <p>{campaign.objective || "Define the campaign objective."}</p>
  <dl className={styles.metrics}>
    <div><dt>Plan</dt><dd>{summary.planRevision ? `v${summary.planRevision}` : "Not initialized"}</dd></div>
    <div><dt>Channels</dt><dd>{summary.laneCount}</dd></div>
    <div><dt>Needs setup</dt><dd>{summary.configurationIssueCount}</dd></div>
  </dl>
  <div className={styles.channelRow}>
    {campaign.channels.map((channel) => <Badge key={channel}>{channel}</Badge>)}
  </div>
  <Link className={styles.openCampaign} href={`/workspaces/${workspaceId}/campaigns/${campaign.id}`}>
    Open campaign <Icon name="chevron-right" size="sm" />
  </Link>
</article>
```

Use the existing `chevron-right` registry icon; do not import Lucide icons directly.

- [ ] **Step 5: Recompose the inventory page**

Keep the current top-bar actions and settings modal. Load campaigns and personas as today, then load each campaign summary from `/plan/summary` with a zeroed fallback when one request fails. Render:

- Active campaigns before paused/completed/archived campaigns.
- A compact filter row for `all`, `active`, and `archived`.
- `CampaignCard` grid using `minmax(280px, 1fr)`.
- The existing `EmptyState` when no campaigns exist.
- The extracted `CampaignForm` above the grid when creating or editing.

Do not remove archive/unarchive or automation controls; expose them from a compact card action menu or card footer.

- [ ] **Step 6: Add responsive feature CSS**

Use only semantic variables. Required breakpoints:

```css
.campaignGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.campaignCard { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-panel); background: var(--panel); padding: 18px; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 900px) { .campaignGrid { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .metrics { grid-template-columns: 1fr; } }
```

- [ ] **Step 7: Run the focused tests, typecheck, and build**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-workspace-contract.test.ts lib/icon-registry.test.ts`

Expected: the inventory assertion passes; the detail-route assertion may remain failing until Task 6. Temporarily split the test into two `it` blocks and run the inventory test by name:

`npm exec --prefix apps/web vitest -- run lib/campaign-workspace-contract.test.ts -t "links inventory"`

Expected: PASS.

Run: `npm run typecheck -w apps/web`

Expected: PASS.

Run: `npm run build -w apps/web`

Expected: PASS.

- [ ] **Step 8: Commit the inventory**

```bash
git add 'apps/web/app/workspaces/[id]/campaigns' apps/web/lib/campaign-workspace-contract.test.ts apps/web/src/components/ui/icon.tsx apps/web/lib/icon-registry.test.ts
git commit -m "feat(web): redesign campaign inventory"
```

---

### Task 6: Build the campaign workspace shell and Overview

**Files:**
- Create: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/page.tsx`
- Create: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/campaign-workspace.module.css`
- Create: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-overview.tsx`
- Modify: `apps/web/lib/campaign-workspace-contract.test.ts`

**Interfaces:**
- The page owns loading, refresh, active tab, mutation errors, and the shared `CampaignDetail`, `CampaignPlanWorkspace`, `Persona[]`, `Audience[]`, and `Connection[]` data.
- `CampaignOverview` is read-only and consumes campaign detail plus plan workspace.

- [ ] **Step 1: Keep the existing failing detail-route contract visible**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-workspace-contract.test.ts -t "focused campaign workspace"`

Expected: FAIL because `[campaignId]/page.tsx` does not exist.

- [ ] **Step 2: Implement parallel campaign workspace loading**

The client page loads these endpoints together:

```ts
const [campaignRes, planRes, personaRes, audienceRes, connectorRes] = await Promise.all([
  apiFetch(`/workspaces/${id}/campaigns/${campaignId}`),
  apiFetch(`/workspaces/${id}/campaigns/${campaignId}/plan/workspace`),
  apiFetch(`/workspaces/${id}/personas`),
  apiFetch(`/workspaces/${id}/audiences`),
  apiFetch(`/workspaces/${id}/connectors`),
]);
```

Treat campaign 404 as a full-page not-found error. Treat plan 404 as a full-page error. Connector failure degrades to an empty connections list and an inline setup prompt; it must not hide the campaign.

- [ ] **Step 3: Build the campaign header and URL-backed tabs**

Render a breadcrumb back to Campaigns, campaign status, name, objective, timeframe, active plan revision, and configuration issue count. Tabs use links so refresh/back navigation preserves context:

```tsx
const tab = campaignTab(searchParams.get("tab"));
const tabs = [
  ["overview", "Overview"],
  ["plan", "Plan history"],
  ["channels", "Channels"],
] as const;
```

Use `aria-current="page"` on the active tab and keep the tab order before tab content.

- [ ] **Step 4: Add plan initialization**

When `planWorkspace.revisions.length === 0`, show a blocked state explaining that existing campaign fields are preserved. The primary action POSTs to `/plan/backfill`, refreshes the read model, and reports structured issue messages without discarding campaign data.

```ts
async function initializePlan() {
  const response = await apiFetch(`/workspaces/${id}/campaigns/${campaignId}/plan/backfill`, {
    method: "POST",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? "Could not initialize the campaign plan.");
  await load();
}
```

- [ ] **Step 5: Build Overview around attention and next action**

`CampaignOverview` renders, in this order:

1. `Needs attention`: configuration issues, pending content review count, and missing plan state.
2. `Plan snapshot`: objective, KPI, timeframe, audience count, pillars, offers, and CTAs.
3. `Channels`: active/paused lane count with destination and schedule summaries.
4. `Work and results`: draft-state counts, paid metrics when present, and campaign insight totals.
5. Contextual links to Review, Calendar, Ads, and Insights with campaign query parameters.

Do not fabricate unavailable values; show `Not configured` or omit optional result modules.

- [ ] **Step 6: Add responsive and desktop-continuation behavior**

Use a two-column overview above `980px` and one column below. At `720px`, tabs become horizontally scrollable with visible focus. The page remains readable at `390px`; dense edits appear only in the Channels tab and are handled in Task 8.

- [ ] **Step 7: Run the full source contract, helper tests, typecheck, and build**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-workspace-contract.test.ts lib/campaign-control-plane.test.ts`

Expected: PASS.

Run: `npm run typecheck -w apps/web`

Expected: PASS.

Run: `npm run build -w apps/web`

Expected: PASS and includes `/workspaces/[id]/campaigns/[campaignId]`.

- [ ] **Step 8: Commit the workspace and Overview**

```bash
git add 'apps/web/app/workspaces/[id]/campaigns/[campaignId]' apps/web/lib/campaign-workspace-contract.test.ts
git commit -m "feat(web): add campaign control plane overview"
```

---

### Task 7: Add immutable Plan history and draft revision editing

**Files:**
- Create: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-history.tsx`
- Create: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-form.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/campaign-workspace.module.css`
- Modify: `apps/web/lib/campaign-workspace-contract.test.ts`

**Interfaces:**
- `CampaignPlanHistory` consumes revisions, audience names, busy state, `onCreateRevision`, and `onActivate`.
- `CampaignPlanForm` emits `CreateCampaignPlanRevisionInput` and never edits an active/superseded revision in place.

- [ ] **Step 1: Extend the source contract with plan mutations**

```ts
it("creates and activates immutable plan revisions", () => {
  const history = read("app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-history.tsx");
  const page = read("app/workspaces/[id]/campaigns/[campaignId]/page.tsx");
  expect(history).toContain("Plan history");
  expect(history).toContain("WorkflowStatusBadge");
  expect(page).toContain("/plan/revisions");
  expect(page).toContain("/activate");
});
```

- [ ] **Step 2: Run the new assertion and verify the component is missing**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-workspace-contract.test.ts -t "immutable plan revisions"`

Expected: FAIL.

- [ ] **Step 3: Implement `CampaignPlanForm` with exact plan fields**

The form includes objective, KPI, timeframe, optional start/end dates, audience multi-select, newline-delimited pillars/offers/CTAs, and guidance. Convert dates with local midnight timestamps and arrays with trimmed, non-empty, de-duplicated lines. Its public props are:

```ts
interface CampaignPlanFormProps {
  initial: CampaignPlanRevision | null;
  audiences: Audience[];
  busy: boolean;
  onCancel(): void;
  onSubmit(input: CreateCampaignPlanRevisionInput): Promise<void>;
}
```

The initial value is the current active revision so “Create revision” starts as a safe copy. Validation must reject an end date at or before the start date before sending.

- [ ] **Step 4: Implement history and selection**

Render revisions newest-first with status, version, creator/timestamps, objective, KPI, window, audience names, and lane count. Active and superseded revisions are read-only. A draft revision exposes `Activate revision`; activation errors render every structured issue with its recovery destination.

- [ ] **Step 5: Wire create and activate mutations**

```ts
async function createRevision(input: CreateCampaignPlanRevisionInput) {
  const response = await apiFetch(`/workspaces/${id}/campaigns/${campaignId}/plan/revisions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? "Could not create the plan revision.");
  await load();
}

async function activateRevision(revisionId: string) {
  const response = await apiFetch(
    `/workspaces/${id}/campaigns/${campaignId}/plan/revisions/${revisionId}/activate`,
    { method: "POST" },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    setPlanIssues(body?.issues ?? [{ path: "plan", code: body?.error ?? "activation_failed", message: body?.message ?? "Could not activate the revision." }]);
    return;
  }
  await load();
}
```

- [ ] **Step 6: Verify Plan history**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-workspace-contract.test.ts lib/campaign-control-plane.test.ts`

Expected: PASS.

Run: `npm run typecheck -w apps/web`

Expected: PASS.

Run: `npm run build -w apps/web`

Expected: PASS.

- [ ] **Step 7: Commit Plan history**

```bash
git add 'apps/web/app/workspaces/[id]/campaigns/[campaignId]' apps/web/lib/campaign-workspace-contract.test.ts
git commit -m "feat(web): add campaign plan history"
```

---

### Task 8: Add Channels lane configuration for draft revisions

**Files:**
- Create: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-channels.tsx`
- Create: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-lane-form.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/campaign-workspace.module.css`
- Modify: `apps/web/lib/campaign-workspace-contract.test.ts`

**Interfaces:**
- `CampaignChannels` shows all lane revisions for the selected revision and chooses the draft revision when one exists, otherwise the active revision.
- `CampaignLaneForm` emits `UpsertCampaignLaneRevisionInput` and is enabled only for draft plan revisions.

- [ ] **Step 1: Add a failing Channels contract**

```ts
it("configures campaign channels only through draft lane revisions", () => {
  const channels = read("app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-channels.tsx");
  const laneForm = read("app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-lane-form.tsx");
  expect(channels).toContain("formatLaneSchedule");
  expect(channels).toContain("Create a plan revision to edit channels");
  expect(laneForm).toContain("UpsertCampaignLaneRevisionInput");
  expect(laneForm).toContain("publishingConnectionId");
});
```

- [ ] **Step 2: Run the assertion and verify missing components fail**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-workspace-contract.test.ts -t "draft lane revisions"`

Expected: FAIL.

- [ ] **Step 3: Build the channel summary cards**

Each card renders channel, format, persona, audience, publishing account, provider target, planned/reactive schedule, and workflow status. Resolve IDs from the already-loaded persona/audience/connection arrays. Missing references render `Setup required` and link to Brain, Audience, or Integrations rather than displaying raw UUIDs.

When no draft exists, show the active configuration read-only and the exact message `Create a plan revision to edit channels` with a button switching to Plan history.

- [ ] **Step 4: Implement the lane form**

Public props:

```ts
interface CampaignLaneFormProps {
  initial: CampaignLaneRevisionView | null;
  campaignChannels: Channel[];
  personas: Persona[];
  audiences: Audience[];
  connections: Connection[];
  busy: boolean;
  onCancel(): void;
  onSubmit(input: UpsertCampaignLaneRevisionInput): Promise<void>;
}
```

Fields: lane name/key, persona, audience, channel, format, publishing connection, provider target, delivery mode, planned quantity, days of week, time, timezone, reactive period/cap, and active/paused state. Derive a kebab-case key only for new lanes; preserve the stable key when editing. Filter publishing connections to `connected` status while retaining a selected disconnected connection so the user can see and recover it.

- [ ] **Step 5: Wire the lane mutation to the selected draft**

```ts
async function saveLane(planRevisionId: string, input: UpsertCampaignLaneRevisionInput) {
  const response = await apiFetch(
    `/workspaces/${id}/campaigns/${campaignId}/plan/revisions/${planRevisionId}/lanes`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? "Could not save the channel configuration.");
  await load();
}
```

Do not offer mutation controls for active or superseded revisions.

- [ ] **Step 6: Add the narrow-screen boundary**

Below `720px`, cards remain readable and actions remain available. The full lane form displays a notice: `Channel planning is easier on a wider screen. Your place and current values are preserved.` It may stack fields, but it must not discard input, block saving, or hide validation.

- [ ] **Step 7: Verify Channels**

Run: `npm exec --prefix apps/web vitest -- run lib/campaign-workspace-contract.test.ts lib/campaign-control-plane.test.ts lib/icon-registry.test.ts`

Expected: PASS.

Run: `npm run typecheck -w apps/web`

Expected: PASS.

Run: `npm run build -w apps/web`

Expected: PASS.

- [ ] **Step 8: Commit Channels**

```bash
git add 'apps/web/app/workspaces/[id]/campaigns/[campaignId]' apps/web/lib/campaign-workspace-contract.test.ts
git commit -m "feat(web): configure campaign channel lanes"
```

---

### Task 9: Run campaign-control-plane acceptance and document the handoff

**Files:**
- Modify: `docs/ui-ux/capability-registry.md`
- Create: `docs/ui-ux/campaign-control-plane-acceptance.md`

**Interfaces:**
- Marks Campaign control plane, Plan revisions, and Campaign lanes as implemented only after all verification passes.
- Records remaining golden-loop dependencies without claiming Review, Calendar, or execution results are complete.

- [ ] **Step 1: Run focused contract and API verification**

Run:

```bash
npm test -w packages/contracts -- campaign-workspace.test.ts orchestration.test.ts workflow-status.test.ts
npm test -w apps/api -- orchestration-foundation.test.ts campaigns.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused web verification**

Run:

```bash
npm exec --prefix apps/web vitest -- run \
  lib/campaign-control-plane.test.ts \
  lib/campaign-workspace-contract.test.ts \
  lib/design-tokens.test.ts \
  lib/workflow-status.test.ts \
  lib/icon-registry.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full repository gate**

Run:

```bash
npm test -- --maxWorkers=2
npm run typecheck
npm run build -w apps/web
git diff --check
```

Expected: all commands exit 0. Record exact test counts and the known multiple-lockfile warning in the acceptance document.

- [ ] **Step 4: Perform authenticated responsive acceptance**

With representative campaign data, inspect `/workspaces/{workspaceId}/campaigns` and `/workspaces/{workspaceId}/campaigns/{campaignId}` at:

- `1440px`: two-column inventory, full campaign workspace, no clipped actions.
- `1024px`: readable two-column overview and stable tabs.
- `768px`: one-column inventory, horizontally safe tabs, usable plan editor.
- `390px`: triage and read states remain complete; lane editor displays its continuation notice and preserves entered values.

Verify keyboard focus through breadcrumb, tabs, actions, forms, validation, and mutation results. Record any unperformed visual check explicitly; do not mark it passed from source inspection alone.

- [ ] **Step 5: Update capability status and write acceptance evidence**

Update these rows:

- Campaign control plane → `Implemented: campaign workspace overview`
- Plan revisions → `Implemented: immutable history and draft activation`
- Campaign lanes → `Implemented: draft channel configuration`

Keep Review authorization, Calendar rebuild, and unified execution results as `Golden-loop plan`.

The acceptance document must list delivered routes, preserved legacy capabilities, verification commands/results, responsive evidence, known warnings, and the next slice (`Unified Review workspace`).

- [ ] **Step 6: Commit acceptance**

```bash
git add docs/ui-ux/capability-registry.md docs/ui-ux/campaign-control-plane-acceptance.md
git commit -m "docs: accept campaign control plane UI"
```
