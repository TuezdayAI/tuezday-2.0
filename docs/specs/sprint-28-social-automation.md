# Sprint 28 — Campaign-configured social automation (modes)

> Phase C, item **U10** in `docs/plans/sprint-guide-21-onward.md` (that doc still uses the pre-reorg
> numbering, where this is "Sprint 27"; the 2026-06-21 no-compromise reorg inserted `connect-social`
> as S25, shifting everything +1, so this is **Sprint 28**).
> **Branch:** `sprint-28-social-automation`.
> **Base / required merge order:** this sprint needs BOTH unmerged predecessors —
> **S26 `sprint-26-targeted-launch`** (social `publishPost` adapters for LinkedIn/X/Instagram, which
> already contains S25 `connect-social`) **and S27 `sprint-27-cadence-calendar-mailer`** (the recurring
> cadence + calendar + mailer). They are parallel branches off `main` that both used migration `0018`.
> This branch was created off S26 and S27 was **merged in** (first commit on the branch), with S27's
> hand-written `0018` cadence migration dropped and the cadence delta regenerated as **`0020`** on top
> of S26's `0019`. **The founder must merge into `main` in the order: S25 → S26, and S27, before S28.**
> This spec stands alone: the founder resets the session between sprints.

## Goal

Make social distribution **driven by the campaign**, not by hand. Each campaign gets an **automation
mode**, and the platform turns discovery signals into channel-appropriate posts according to that mode:

1. **`manual`** *(default — today's behavior)*. Nothing automatic. The founder generates, approves, and
   publishes by hand.
2. **`human_in_the_loop`**. A new discovery **signal** auto-generates a brain-resolved draft for **each
   of the campaign's channels** (campaign + persona overlay, signal injected). The draft lands at the
   **approval gate** (`pending_review`) and waits. Once the founder approves it, any **cadence** (S27)
   on that campaign/channel slots and publishes it. The gate is fully enforced.
3. **`scheduled_auto`**. Same fan-out, but the system **auto-approves** the generated draft (a real
   `approve` transition through the gate, attributed to the **system** actor, so it's logged + audited +
   reversible). The campaign's **cadence** (S27) then slots and publishes it automatically. The human
   gate is replaced by **guardrails** — a workspace **kill switch** plus **per-connection** and
   **per-campaign daily post caps**, the same shape as the ads guardrails (`ad_settings`).

**Founder acceptance (roadmap):** "Connect LinkedIn → set a campaign to scheduled-auto on a cadence →
approved content posts automatically; flip to human-in-the-loop → posts wait at the gate."

This sprint reuses, end to end: the **signal→draft** generation pipeline (S9), the **approval gate**
(S5), the **cadence + publish** machinery (S27/S17), and the **ads-guardrail pattern** (S20). The only
genuinely new machinery is the **automation orchestrator** (mode-routed fan-out + auto-approval) and the
**social-automation guardrails**.

## Founder decisions captured (2026-06-22)

1. **`scheduled_auto` = auto-approve, then post.** The system approves (logged as a `system` approval
   decision, reversible at the gate) and posts on the cadence; guardrails are the safety net. Truly
   hands-off. (Human-approval-still-required option declined.)
2. **Signal routing = simple fan-out.** A new signal generates a draft for each channel of campaigns
   already in an automated mode — **no relevance scoring**. The smart "which signal fits which
   campaign/persona" triage stays in **Sprint 29**. (Build-relevance-now and cadence-only options
   declined.)
3. **Guardrails = workspace kill switch + per-connection cap + per-campaign cap.** Per-campaign cap is a
   workspace default that a campaign can override.
4. **Build base = a merge of S26 + S27** with the colliding migration renumbered (done as the branch's
   first commit). (Merge-to-main-first option declined.)

## What already exists (foundation — read before building)

- **Signal→draft pipeline (S9, `routes/signals.ts` `POST /signals/:signalId/draft`).** Resolves context
  (`getBrain` → `resolveContext` with the **signal injected**, persona + campaign overlays, evidence),
  calls `llm.generate`, `storeGeneration`, then `submitDraft` linked to `sourceSignalId` + `campaignId`.
  We **extract this into a shared service helper** (`generateSignalDraft`) and call it from both the
  route and the orchestrator.
- **Approval gate (S5, `services/drafts.ts`).** `submitDraft(db, input, actor)` creates a draft at
  `pending_review`; `applyDraftAction(db, draft, "approve", actor)` → `approved`, logging an
  `approvalDecisions` row with the actor. Auto-approval = `applyDraftAction(..., "approve", systemActor)`.
- **Cadence + publish (S27/S17, `services/cadences.ts`, `services/publications.ts`).** A cadence binds
  campaign + channel + connection + recurrence; `fillCadence` slots **approved** matching drafts as
  `scheduled` publications; the publish worker fires them. We **reuse fill unchanged for manual/HITL**,
  and **add a guardrail gate inside fill for `scheduled_auto` cadences only**.
- **Ads guardrails (S20, `services/ad-launches.ts`).** `getAdSettings`/`updateAdSettings`
  (`ad_settings`: `dailyCapCents` + `killSwitch`) and `checkSpendGuardrails`. We mirror the shape for
  social: `social_automation_settings` + `checkPostGuardrails`.
- **Campaigns (S7/S8, `services/campaigns.ts`).** `automationMode` + `autoDailyCap` are new columns;
  `composeCampaignOverlay` already feeds the resolver.
- **Actor model (`auth/guard.ts` `actorOf`).** The worker token resolves to the **system** actor; routes
  pass `actorOf(request)` so auto-approval is attributed to `system`.
- **`buildApp` composition root.** We register one new route group and reuse the existing `llm`,
  `evidence`, `connectors`, `fetcher` deps — no new external dependency.

## Contracts (`packages/contracts/src/index.ts`) — additive only

- **Automation mode:**
  - `AUTOMATION_MODES = ["manual", "human_in_the_loop", "scheduled_auto"] as const`; `AutomationMode`.
  - Extend `campaignSchema` + `upsertCampaignInputSchema` with:
    - `automationMode: z.enum(AUTOMATION_MODES)` (schema) / `.default("manual")` (input).
    - `autoDailyCap: z.number().int().positive().max(1000).nullable()` (schema) / `.default(null)`
      (input) — per-campaign override of the daily auto-post cap; null = use the workspace default.
  - `updateCampaignAutomationInputSchema` — `{ automationMode: z.enum(AUTOMATION_MODES), autoDailyCap:
    z.number().int().positive().max(1000).nullable().default(null) }` (the focused toggle endpoint).
- **Settings:**
  - `socialAutomationSettingsSchema` — `{ workspaceId, killSwitch: z.boolean(), perConnectionDailyCap:
    z.number().int().positive(), perCampaignDailyCap: z.number().int().positive(), updatedAt: int }`.
  - `updateSocialAutomationSettingsInputSchema` — all three editable fields `.partial()` (killSwitch +
    the two caps).
- **Run result:**
  - `automationCampaignResultSchema` — `{ campaignId, campaignName, mode: z.enum(AUTOMATION_MODES),
    generated: int, autoApproved: int, skipped: int, blocked: z.string().nullable() }`.
  - `automationRunResultSchema` — `{ results: automationCampaignResultSchema[], ranAt: int }`.
- **Defaults:** `DEFAULT_PER_CONNECTION_DAILY_CAP = 10`, `DEFAULT_PER_CAMPAIGN_DAILY_CAP = 5`.

No existing vocabulary changes; the pinned campaign fixture in `contracts.test.ts` gains
`automationMode: "manual"` + `autoDailyCap: null`.

## Data model (migration `0021`, off `0020`)

Edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w apps/api` (commit the generated SQL).
Postgres-portable (text ids, integer epoch-ms, integer 0/1 booleans).

### `campaigns` (alter)
- `automation_mode text NOT NULL DEFAULT 'manual'` — an `AutomationMode`.
- `auto_daily_cap integer` (nullable) — per-campaign override; null = workspace default.

### `social_automation_settings` (new — one row per workspace, like `ad_settings`)
| column | type | notes |
|---|---|---|
| `workspaceId` | text PK → workspaces (cascade) | |
| `killSwitch` | integer NOT NULL default 0 | 1 = stop all auto-posting |
| `perConnectionDailyCap` | integer NOT NULL default 10 | max posts/connection/UTC-day (gates `scheduled_auto` fills) |
| `perCampaignDailyCap` | integer NOT NULL default 5 | default cap; campaign `auto_daily_cap` overrides |
| `updatedAt` | integer NOT NULL | |

(`db:generate` may emit the ALTERs via SQLite table-recreate; that's fine. Verify the new columns +
table land and `npm test` is green.)

## Services

### `services/signal-drafting.ts` — extracted shared generator
```ts
export async function generateSignalDraft(
  db, llm, evidence, workspace, signal,
  opts: { channel: Channel; persona?: Persona; campaign?: Campaign; useEvidence?: boolean; tokenBudget?: number },
  actor: DraftActor,
): Promise<Draft>   // resolves context (signal injected) → llm.generate → storeGeneration → submitDraft (pending_review)
```
`routes/signals.ts` is refactored to call this (behavior identical — its tests stay green).

### `services/automation.ts` — settings, guardrails, orchestrator
- **Settings** (mirror `getAdSettings`/`updateAdSettings`): `getSocialAutomationSettings(db, ws)` (returns
  defaults when no row), `updateSocialAutomationSettings(db, ws, patch)`.
- **Day window:** `utcDayBounds(ms) → { start, end }` (floor to UTC midnight; end exclusive). The cap is a
  coarse safety net measured per **UTC day** (documented deferred improvement: it ignores the cadence's
  own timezone).
- **Guardrails:** `checkPostGuardrails(db, settings, { campaign, connectionId, slotMs }) → GuardrailCheck`
  (`{ ok:true } | { ok:false, error:"kill_switch_on"|"connection_cap"|"campaign_cap", message }`):
  - `settings.killSwitch` → `kill_switch_on`.
  - `countPublicationsOnConnectionForDay(connectionId, slotMs) >= perConnectionDailyCap` →
    `connection_cap` (counts **all** non-`failed` publications on that connection that day — the platform
    limit is per account regardless of source).
  - `countAutoPublicationsForCampaignForDay(campaign.id, slotMs) >= (campaign.autoDailyCap ??
    perCampaignDailyCap)` → `campaign_cap` (counts publications whose cadence belongs to this campaign).
- **Orchestrator:** `runAutomation(db, llm, evidence, ws, actor, nowMs) → AutomationRunResult`. For each
  campaign with `status === "active"` and `automationMode !== "manual"`:
  - If `killSwitch` is on → record `blocked: "kill_switch_on"`, generate nothing.
  - For each `channel` in `campaign.channels`, for each **unprocessed** signal (a signal with **no**
    existing draft for this `sourceSignalId` + `campaignId` + `channel` — idempotent, like cadence fill):
    `generateSignalDraft(...)`. Then route by mode:
    - `human_in_the_loop`: leave at `pending_review` (`generated++`).
    - `scheduled_auto`: `applyDraftAction(approve, systemActor)` (`generated++`, `autoApproved++`).
  - Process signals **oldest-first**; a campaign with no channels or no new signals is a no-op.
  - Returns per-campaign counts. (Generation failures from the gateway are caught per item and counted
    as `skipped` with the reason logged — one bad signal never aborts the run.)
- The orchestrator does **not** cap generation; the **rate caps live at the posting commit point**
  (cadence fill), exactly like ads cap committed spend at launch — see below.

### `services/cadences.ts` — guardrail gate for `scheduled_auto` fills (modify `fillCadence`)
`fillCadence` is unchanged for `manual`/`human_in_the_loop` campaigns (so every S27 test still passes —
their campaigns default to `manual`). When the cadence's campaign is **`scheduled_auto`**:
- Load `getSocialAutomationSettings`. If `killSwitch` is on → **fill 0 and cancel this cadence's future
  `scheduled` publications** (delete them) so flipping the switch stops the pending queue — the instant
  "stop," matching the ads kill switch. (Deferred: instant cancel at fire time, not on the 5-min tick.)
- Otherwise, before creating each slot's publication, run `checkPostGuardrails`; **skip** any slot that
  would breach a cap (continue evaluating later slots, which may fall on a less-busy day). Count is
  re-derived per slot so multiple slots in one run respect the same cap.

### `services/campaigns.ts` — carry the new fields
`rowToCampaign`/`inputToColumns` map `automationMode` + `autoDailyCap`; add
`setCampaignAutomation(db, ws, campaignId, { automationMode, autoDailyCap })`.

## API routes (`routes/automation.ts` → `registerAutomationRoutes(app, db, llm, evidence)`)
Thin; `workspaceOr404` like siblings; register in `app.ts`.
- `GET   /workspaces/:id/automation/settings` — current settings (defaults when unset).
- `PATCH /workspaces/:id/automation/settings` — update killSwitch / caps.
- `POST  /workspaces/:id/automation/run` — run the orchestrator now (worker entry + a manual "Run now")
  → `AutomationRunResult`. Uses `actorOf(request)` (system when the worker calls).
- `PATCH /workspaces/:id/campaigns/:campaignId/automation` — set a campaign's mode + per-campaign cap
  (registered here to keep the campaign route untouched; 404 `campaign_not_found`).

Error vocabulary: `workspace_not_found`, `campaign_not_found`, `invalid_input`.

## `buildApp` wiring & worker
- `app.ts`: `registerAutomationRoutes(app, db, llm, evidence)`.
- `apps/worker/src/index.ts`: add **`automationTick`** (`AUTOMATION_INTERVAL_MIN`, default **5**):
  `POST /workspaces/:id/automation/run` for every workspace, logging `{ generated, autoApproved }`
  totals, quiet when nothing happens. Order in the loop: **automationTick → cadenceTick → publishTick**
  so a signal can generate → auto-approve → slot → fire within one cycle. Same per-workspace try/catch
  resilience as the other ticks.

## Web (`apps/web`)
- **Campaign page** (`app/workspaces/[id]/campaigns/page.tsx`): an **Automation** control per campaign —
  a mode selector (Manual / Human-in-the-loop / Scheduled-auto) and, when scheduled-auto, a per-campaign
  daily-cap input; hits `PATCH .../campaigns/:id/automation`. A one-line explainer per mode.
- **Automation settings** (`app/workspaces/[id]/automation/page.tsx`, linked under the Calendar/Cadence
  nav group): the **kill switch** (prominent), per-connection + default per-campaign caps, a **Run
  automation now** button showing the run result, and a short "how modes work" note.
- **Approvals page**: badge drafts whose latest decision actor is `system` as **"Auto-approved"** so the
  founder can see what automation did (and can still reject/re-edit — the gate is real).

## Boundary
- **Reuse, don't rebuild.** Automation = orchestrator (fan-out + auto-approval) + guardrails only; all
  generation goes through the existing brain-resolved pipeline, all posting through S27 cadence + S17
  publish. Never build sending/deliverability infra.
- **Gate is always real.** `scheduled_auto` performs a true `approve` transition attributed to `system`,
  logged in `approvalDecisions`; a human can still reject/edit. `human_in_the_loop` blocks at the gate.
- **No smart signal triage** (which signal → which campaign by relevance) — that's Sprint 29. S28 is the
  explicit, mode-driven fan-out.
- **Caps are a coarse per-UTC-day safety net**, not a precise scheduler; the kill switch is the hard stop.
- Official APIs via Nango only (inherited from S25/S26); secrets stay in `.env`/Nango.

## Deferred-improvements entries to add (`docs/deferred-improvements.md`)
8. **Automation runs synchronously on a worker tick** (one LLM call per signal×channel inline), bounded
   by new-signal volume; large fan-out wants a queue.
9. **Guardrail caps are per UTC day**, ignoring the cadence's own timezone; a tz-aware window would be
   more precise.
10. **Kill switch cancels pending auto-posts on the next cadence tick, not instantly at fire time** — a
    publish-path check would make it instant.
11. **No relevance triage** — every new signal fans out to every automated campaign's channels;
    Sprint 29 adds scoring/mapping.

## Tests (`apps/api/test/automation.test.ts`)
Model on `cadences.test.ts`: `buildAuthedApp` + `createTestDb`, the fake Reddit `ConnectorFabric`,
`fakeLlm`, `vi.useFakeTimers` + a fixed Monday clock, and `connectReddit()` helper. A signal is created
via `POST /signals`; a campaign via `POST /campaigns` then `PATCH .../automation`.

1. **Contracts:** `AUTOMATION_MODES`; `campaignSchema`/`upsertCampaignInputSchema` round-trip with
   `automationMode` + `autoDailyCap`; `socialAutomationSettingsSchema`,
   `updateCampaignAutomationInputSchema`, `automationRunResultSchema` parse; pinned campaign fixture.
2. **Settings:** GET returns defaults (`killSwitch:false`, caps 10/5); PATCH persists killSwitch + caps;
   bad cap (0, negative) → 400.
3. **Mode = manual:** a signal + a manual campaign → `POST /automation/run` generates **0** drafts.
4. **Mode = HITL:** a 2-channel campaign + a signal → run → **2** drafts at `pending_review`, each linked
   to the signal + campaign, one per channel; **not** approved. Idempotent — a second run adds 0. A new
   signal adds 2 more.
5. **Mode = scheduled_auto end-to-end:** scheduled-auto campaign (channel `linkedin`) + a Reddit cadence
   on it + a signal → run → 1 draft **auto-approved** (its latest `approvalDecisions` actor is `system`);
   `POST /cadences/:id/fill` slots it; advance the clock past the slot; `POST /publish/run` posts it to
   the fake Reddit (published + url). The approval decision log shows submit→approve by `system`.
6. **Guardrail — kill switch:** killSwitch on → `run` auto-approves nothing (blocked
   `kill_switch_on`); a scheduled-auto cadence `fill` creates 0 and cancels its pending scheduled
   auto-posts; a **manual** campaign's cadence still fills normally (human-gated path unaffected).
7. **Guardrail — per-campaign cap:** set `autoDailyCap: 1`; with 2 approved auto-drafts and a cadence
   with ≥2 same-day slots → fill creates only **1** publication that day (campaign cap), the rest skipped.
8. **Guardrail — per-connection cap:** `perConnectionDailyCap: 1` → a second same-day slot on that
   connection is skipped even across cadences.

`npm test` + `npm run typecheck` green across all workspaces.

## Founder acceptance (append to `docs/founder-acceptance-tests.md`)
With a social account connected (S25/S26; Reddit works today, LinkedIn/X/Instagram once their creds are
set), a campaign with one or more channels, and at least one discovery signal:
1. **Campaign → Automation = Human-in-the-loop.** Add a signal (Discovery) → **Automation → Run now** (or
   wait for the worker) → a draft per campaign channel appears in **Approvals** at `pending_review`.
   Approve one → with a cadence on that campaign/channel it slots on the **Calendar** and publishes.
2. **Switch the campaign to Scheduled-auto.** Add a new signal → **Run now** → the draft is
   **auto-approved** (badged "Auto-approved" in Approvals, the decision log shows `system`) → the cadence
   slots it → it publishes automatically with a working link.
3. **Automation settings → flip the Kill switch.** Run again → nothing new auto-posts and pending
   auto-slots clear; manual publishing and manually-approved cadences keep working. Flip it back → auto
   resumes.
4. **Caps.** Set a low per-campaign or per-connection daily cap → confirm auto-posts stop at the cap for
   the day while manual posting is never blocked.

## Step plan
1. Branch off S26, merge S27, renumber cadence migration → `0020`, verify the merged base green. ✅
2. Spec (this file).
3. Contracts: `AUTOMATION_MODES`, campaign fields, settings + run-result schemas, defaults.
4. Schema + migration `0021`: `campaigns.automation_mode` + `auto_daily_cap`; `social_automation_settings`.
5. `services/signal-drafting.ts` (extract); refactor `routes/signals.ts` to use it.
6. `services/automation.ts` (settings + guardrails + orchestrator); `services/campaigns.ts` field wiring
   + `setCampaignAutomation`; guardrail gate in `services/cadences.ts` `fillCadence`.
7. `routes/automation.ts`; register in `app.ts`; worker `automationTick`.
8. Web: campaign automation control, automation settings page + nav, auto-approved badge.
9. Tests (`automation.test.ts`) + contracts assertions; `npm test` + `npm run typecheck` green.
10. Deferred-improvements #8–#11 + Sprint 28 acceptance section.
11. Commit to `sprint-28-social-automation`, push. **Do NOT merge into `main`.**

## Progress log
- 2026-06-22 — Branch `sprint-28-social-automation` created off S26; **S27 merged in** (commit
  `2accff8`) as the integration base — conflicts resolved (publications `media?`+`cadenceId?`,
  schema.ts both columns, app.ts exporter+mailer, deferred-improvements unified, acceptance-tests
  concatenated), S27's `0018` cadence migration dropped, cadence delta regenerated as **`0020`**
  (re-added `ON DELETE set null` on `publications.cadence_id`). Merged base verified: typecheck clean,
  **590 tests pass (34 files)**. Founder decisions captured (auto-approve; simple fan-out; kill switch +
  per-connection + per-campaign caps; build on the S26+S27 merge). Spec written.
- 2026-06-22 — **Built and verified green.** Implemented to spec:
  - **Contracts** — `AUTOMATION_MODES` + `AutomationMode`; `campaignSchema`/`upsertCampaignInputSchema`
    gain `automationMode` (default `manual`) + `autoDailyCap` (nullable);
    `updateCampaignAutomationInputSchema`; `socialAutomationSettingsSchema` +
    `updateSocialAutomationSettingsInputSchema`; `automationCampaignResultSchema` /
    `automationRunResultSchema`; `DEFAULT_PER_CONNECTION_DAILY_CAP` (10) / `DEFAULT_PER_CAMPAIGN_DAILY_CAP` (5).
  - **Schema + migration `0021`** — `campaigns.automation_mode` + `auto_daily_cap`;
    `social_automation_settings` table.
  - **`services/signal-drafting.ts`** — extracted the brain-resolved signal→draft pipeline;
    `routes/signals.ts` refactored to use it (behavior identical, its tests stay green).
  - **`services/automation.ts`** — settings get/update (mirrors `ad_settings`); `utcDayBounds` +
    per-connection / per-campaign day counts; `checkPostGuardrails` (kill switch / connection cap /
    campaign cap); `runAutomation` orchestrator (mode-routed fan-out; auto-approve via the gate as
    `system`; idempotent per signal+campaign+channel).
  - **`services/campaigns.ts`** — `automationMode`/`autoDailyCap` mapped (kept out of the general
    upsert so an edit never resets automation); `setCampaignAutomation`, `listAutomatedCampaigns`.
  - **`services/cadences.ts`** — `fillCadence` enforces guardrails for `scheduled_auto` campaigns only
    (per-slot cap re-check; kill switch cancels pending scheduled auto-posts); manual/HITL fill
    unchanged so all S27 tests pass.
  - **Routes** — `routes/automation.ts` (settings GET/PATCH, `/automation/run`, campaign
    `/automation` toggle); registered in `app.ts`.
  - **Worker** — `automationTick` (`AUTOMATION_INTERVAL_MIN`, default 5) runs before cadence + publish.
  - **Web** — campaign-card automation control (mode + per-campaign cap), Automation settings page
    (kill switch + caps + Run-now) under the Calendar nav group, "Auto-approved" badge in Review.
  - **Tests** — `apps/api/test/automation.test.ts` (10): contracts, settings defaults/validation, the
    three modes (manual no-op; HITL drafts-to-gate idempotent; scheduled_auto auto-approve + cadence +
    publish e2e with `system` decision log), kill switch (blocks auto, cancels pending, manual cadence
    unaffected), per-campaign + per-connection daily caps.
  - **Verified:** full suite **600 passed (35 files)**; `npm run typecheck` clean across all
    workspaces. Deferred-improvements #8–#11 added; Sprint 28 acceptance section appended.
  - **Not merged into `main`** — founder reviews + merges (order: S25 → S26, S27, then S28).
