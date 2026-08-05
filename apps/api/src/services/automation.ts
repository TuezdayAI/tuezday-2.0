import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import {
  type AutomationCampaignResult,
  type AutomationRunResult,
  type Campaign,
  type Channel,
  type Signal,
  type SignalSource,
  type SocialAutomationSettings,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  drafts,
  externalActions,
  postingCadences,
  publications,
  signals as signalsTable,
} from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { getSocialAutomationSettings } from "./automation-settings";
import { listAutomatedCampaigns } from "./campaigns";
import { llmBudgetExhausted } from "./entitlements";
import {
  automaticDraftKey,
  type DraftActor,
} from "./drafts";
import { getBestSignalMatchForCampaign } from "./matching";
import { listPersonas } from "./personas";
import { resolvePipelineDefinition } from "./pipeline-definitions";
import {
  DuplicatePipelineRunError,
  startPipelineRun,
} from "./pipeline-runs";
import { createShadowPair, shadowPairKey } from "./pipeline-shadow";
import { generateSignalDraft } from "./signal-drafting";
import { withTaskLease } from "./task-leases";
import { getWorkspace } from "./workspaces";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Automation always acts as the system identity — the gate transition for an
 * auto-approval is attributed to `system` no matter who triggered the run. */
const SYSTEM_ACTOR: DraftActor = { userId: null, label: "system", human: false };

// ---------------------------------------------------------------------------
// Settings (per workspace; mirrors ad_settings) — implementation lives in
// automation-settings.ts so agent tools can read settings without importing
// this module (which reaches the pipeline engine, and through it the tool
// registry — a cycle). Re-exported here for the existing call sites.
// ---------------------------------------------------------------------------

export {
  getSocialAutomationSettings,
  updateSocialAutomationSettings,
} from "./automation-settings";

// ---------------------------------------------------------------------------
// Guardrails (the safety net for scheduled_auto posting)
// ---------------------------------------------------------------------------

/** UTC-day window containing `ms` — [start, end). The cap is a coarse safety net
 * measured per UTC day (it ignores the cadence's own timezone — see deferred #9). */
export function utcDayBounds(ms: number): { start: number; end: number } {
  const start = Math.floor(ms / DAY_MS) * DAY_MS;
  return { start, end: start + DAY_MS };
}

/** Non-failed publications already on this connection on the slot's UTC day —
 * the platform posting limit is per account, regardless of who created the post. */
export function countConnectionPublicationsForDay(
  db: Db,
  connectionId: string,
  dayMs: number,
  excludeActionId?: string,
): number {
  const { start, end } = utcDayBounds(dayMs);
  const receipts = db
    .select({ id: publications.id })
    .from(publications)
    .where(
      and(
        eq(publications.connectionId, connectionId),
        ne(publications.status, "failed"),
        gte(publications.scheduledFor, start),
        lt(publications.scheduledFor, end),
      ),
    )
    .all().length;
  const pendingActions = db
    .select({ id: externalActions.id })
    .from(externalActions)
    .where(
      and(
        eq(externalActions.kind, "publish"),
        eq(externalActions.connectionId, connectionId),
        inArray(externalActions.status, [
          "proposed",
          "authorization_required",
          "authorized",
          "scheduled",
          "dispatching",
        ]),
        excludeActionId ? ne(externalActions.id, excludeActionId) : undefined,
        gte(externalActions.requestedFor, start),
        lt(externalActions.requestedFor, end),
      ),
    )
    .all().length;
  return receipts + pendingActions;
}

/** Non-failed publications for this campaign (via its cadences) on the slot's UTC day. */
export function countCampaignPublicationsForDay(
  db: Db,
  campaignId: string,
  dayMs: number,
  excludeActionId?: string,
): number {
  const { start, end } = utcDayBounds(dayMs);
  const receipts = db
    .select({ id: publications.id })
    .from(publications)
    .innerJoin(postingCadences, eq(publications.cadenceId, postingCadences.id))
    .where(
      and(
        eq(postingCadences.campaignId, campaignId),
        ne(publications.status, "failed"),
        gte(publications.scheduledFor, start),
        lt(publications.scheduledFor, end),
      ),
    )
    .all().length;
  const pendingActions = db
    .select({ id: externalActions.id })
    .from(externalActions)
    .where(
      and(
        eq(externalActions.kind, "publish"),
        eq(externalActions.campaignId, campaignId),
        inArray(externalActions.status, [
          "proposed",
          "authorization_required",
          "authorized",
          "scheduled",
          "dispatching",
        ]),
        excludeActionId ? ne(externalActions.id, excludeActionId) : undefined,
        gte(externalActions.requestedFor, start),
        lt(externalActions.requestedFor, end),
      ),
    )
    .all().length;
  return receipts + pendingActions;
}

export type PostGuardrailCheck =
  | { ok: true }
  | { ok: false; error: "kill_switch_on" | "connection_cap" | "campaign_cap"; message: string };

/**
 * The guardrail run before committing each auto-post (a scheduled_auto cadence
 * slot). The kill switch is the hard stop; the caps bound posts per UTC day.
 */
export function checkPostGuardrails(
  db: Db,
  settings: SocialAutomationSettings,
  args: { campaign: Campaign; connectionId: string; slotMs: number; excludeActionId?: string },
): PostGuardrailCheck {
  if (settings.killSwitch) {
    return {
      ok: false,
      error: "kill_switch_on",
      message: "The workspace kill switch is on — turn it off in Automation settings to auto-post.",
    };
  }
  const connCount = countConnectionPublicationsForDay(
    db,
    args.connectionId,
    args.slotMs,
    args.excludeActionId,
  );
  if (connCount >= settings.perConnectionDailyCap) {
    return {
      ok: false,
      error: "connection_cap",
      message: `This connection already has ${connCount} post(s) on this day against a cap of ${settings.perConnectionDailyCap}.`,
    };
  }
  const campCap = args.campaign.autoDailyCap ?? settings.perCampaignDailyCap;
  const campCount = countCampaignPublicationsForDay(
    db,
    args.campaign.id,
    args.slotMs,
    args.excludeActionId,
  );
  if (campCount >= campCap) {
    return {
      ok: false,
      error: "campaign_cap",
      message: `Campaign "${args.campaign.name}" already has ${campCount} auto-post(s) on this day against a cap of ${campCap}.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Orchestrator (mode-routed fan-out + auto-approval)
// ---------------------------------------------------------------------------

function signalsOldestFirst(db: Db, workspaceId: string): Signal[] {
  return db
    .select()
    .from(signalsTable)
    .where(eq(signalsTable.workspaceId, workspaceId))
    .orderBy(asc(signalsTable.createdAt))
    .all()
    // `matches` stays empty on these internal objects — routing reads the
    // signal_matches table directly via getBestSignalMatchForCampaign.
    .map((row) => ({ ...row, source: row.source as SignalSource, matches: [] }));
}

function hasDraftFor(
  db: Db,
  workspaceId: string,
  signalId: string,
  campaignId: string,
  channel: Channel,
): boolean {
  return (
    db
      .select({ id: drafts.id })
      .from(drafts)
      .where(
        and(
          eq(drafts.workspaceId, workspaceId),
          eq(drafts.sourceSignalId, signalId),
          eq(drafts.campaignId, campaignId),
          eq(drafts.channel, channel),
        ),
      )
      .get() !== undefined
  );
}

/**
 * Turn new discovery signals into channel posts per the campaign's automation
 * mode (Sprint 28, match-routed since Sprint 45). For each active automated
 * campaign, a signal fans out to the campaign's channels only when it carries a
 * `signal_matches` row for that campaign scoring at or above the workspace's
 * `matchThreshold` — and the draft is generated as that match's persona.
 * human_in_the_loop leaves the draft at the gate; scheduled_auto auto-approves
 * it (a logged `system` approval) so the cadence can post it. Idempotent — a
 * signal already drafted for a campaign+channel is skipped.
 */
export async function runAutomation(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<AutomationRunResult> {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace) return { results: [], ranAt: nowMs };

  const settings = getSocialAutomationSettings(db, workspaceId);
  const campaigns = listAutomatedCampaigns(db, workspaceId);
  const signals = signalsOldestFirst(db, workspaceId);
  const personasById = new Map(listPersonas(db, workspaceId).map((p) => [p.id, p]));
  const results: AutomationCampaignResult[] = [];

  // Budget degradation (Sprint 59): an over-budget workspace generates nothing
  // this tick; unmatched work stays pending and a later tick resumes once the
  // rolling spend frees up or the plan changes. Structured refusal, no throw.
  const budgetExhausted = llmBudgetExhausted(db, workspaceId);

  for (const campaign of campaigns) {
    const base = {
      campaignId: campaign.id,
      campaignName: campaign.name,
      mode: campaign.automationMode,
    };

    if (budgetExhausted) {
      results.push({
        ...base,
        generated: 0,
        autoApproved: 0,
        skipped: 0,
        engineQueued: 0,
        shadowQueued: 0,
        blocked: "llm_budget_exhausted",
      });
      continue;
    }

    // The kill switch halts auto-posting only (scheduled_auto); human-in-the-loop
    // still drafts to the gate, where a human is the control.
    if (campaign.automationMode === "scheduled_auto" && settings.killSwitch) {
      results.push({
        ...base,
        generated: 0,
        autoApproved: 0,
        skipped: 0,
        engineQueued: 0,
        shadowQueued: 0,
        blocked: "kill_switch_on",
      });
      continue;
    }

    let generated = 0;
    let autoApproved = 0;
    let skipped = 0;
    let engineQueued = 0;
    let shadowQueued = 0;

    // Sprint 65 (D-65.1/D-65.6): the engine path needs an ACTIVE definition
    // resolving for this campaign. None resolving means the live path falls
    // back to legacy generation — flipping the flag must never halt automation.
    const definition =
      settings.generationPath === "legacy"
        ? undefined
        : resolvePipelineDefinition(db, {
            workspaceId,
            taskKey: "signal_social_post",
            campaignId: campaign.id,
          });

    for (const signal of signals) {
      // Sprint 45: a signal only reaches this campaign when discovery (or a
      // human) matched it above the workspace threshold — no more blind fan-out.
      const match = getBestSignalMatchForCampaign(
        db,
        workspaceId,
        signal.id,
        campaign.id,
      );
      if (!match || match.score < settings.matchThreshold) continue;
      const persona = match.personaId ? personasById.get(match.personaId) : undefined;
      for (const channel of campaign.channels) {
        if (
          hasDraftFor(
            db,
            workspaceId,
            signal.id,
            campaign.id,
            channel,
          )
        ) {
          continue;
        }

        // Sprint 65 pipeline path (D-65.3): queue a live engine run instead of
        // generating here — the pipelines tick executes it. The run's
        // idempotency key is the exact legacy draft key, so run identity
        // mirrors draft identity and a rerun dedupes (D-65.5: a failed run is
        // terminal for this work item, visibly, not silently retried).
        if (settings.generationPath === "pipeline" && definition) {
          try {
            startPipelineRun(db, {
              workspaceId,
              definition,
              signalId: signal.id,
              channel,
              campaignId: campaign.id,
              personaId: persona?.id ?? null,
              mode: "live",
              idempotencyKey: automaticDraftKey({
                workspaceId,
                signalId: signal.id,
                campaignId: campaign.id,
                channel,
              }),
              createdBy: "automation",
            });
            engineQueued += 1;
          } catch (err) {
            if (!(err instanceof DuplicatePipelineRunError)) skipped += 1;
          }
          continue;
        }

        try {
          const committed = await generateSignalDraft(
            db,
            llm,
            evidence,
            workspace,
            signal,
            {
              channel,
              campaign,
              persona,
              useEvidence: true,
              automation: {
                key: automaticDraftKey({
                  workspaceId,
                  signalId: signal.id,
                  campaignId: campaign.id,
                  channel,
                }),
                autoApprove:
                  campaign.automationMode === "scheduled_auto",
              },
            },
            SYSTEM_ACTOR,
          );
          if (committed.created) generated += 1;
          if (committed.autoApproved) autoApproved += 1;

          // Sprint 65 shadow path (D-65.7): replay the same work item through
          // the engine as a paired shadow run — simulated proposal, no draft,
          // reviewed side by side on the Automation page.
          if (
            settings.generationPath === "shadow" &&
            definition &&
            committed.created
          ) {
            const pairKey = shadowPairKey({
              workspaceId,
              signalId: signal.id,
              campaignId: campaign.id,
              channel,
            });
            try {
              const run = startPipelineRun(db, {
                workspaceId,
                definition,
                signalId: signal.id,
                channel,
                campaignId: campaign.id,
                personaId: persona?.id ?? null,
                mode: "shadow",
                idempotencyKey: pairKey,
                createdBy: "automation",
              });
              createShadowPair(db, {
                workspaceId,
                pairKey,
                signalId: signal.id,
                campaignId: campaign.id,
                channel,
                draftId: committed.draft.id,
                runId: run.id,
              });
              shadowQueued += 1;
            } catch (err) {
              if (!(err instanceof DuplicatePipelineRunError)) throw err;
            }
          }
        } catch {
          // One bad signal never aborts the run; it's counted and retried next tick.
          skipped += 1;
        }
      }
    }

    results.push({
      ...base,
      generated,
      autoApproved,
      skipped,
      engineQueued,
      shadowQueued,
      blocked: null,
    });
  }

  return { results, ranAt: nowMs };
}

export interface AutomationDependencies {
  db: Db;
  llm: LlmGateway;
  evidence: EvidenceStore;
  leaseMs: number;
  heartbeatMs: number;
}

export async function runAutomationWithLease(
  deps: AutomationDependencies,
  workspaceId: string,
  owner: string,
): Promise<AutomationRunResult & { busy: boolean }> {
  const leased = await withTaskLease(
    deps.db,
    {
      key: `automation:${workspaceId}`,
      owner,
      leaseMs: deps.leaseMs,
      heartbeatMs: deps.heartbeatMs,
    },
    () =>
      runAutomation(
        deps.db,
        deps.llm,
        deps.evidence,
        workspaceId,
      ),
  );
  return leased.busy
    ? { results: [], ranAt: Date.now(), busy: true }
    : { ...leased.value, busy: false };
}
