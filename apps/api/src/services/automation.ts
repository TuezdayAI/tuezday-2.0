import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import {
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_PER_CAMPAIGN_DAILY_CAP,
  DEFAULT_PER_CONNECTION_DAILY_CAP,
  type AutomationCampaignResult,
  type AutomationRunResult,
  type Campaign,
  type Channel,
  type Signal,
  type SignalSource,
  type SocialAutomationSettings,
  type UpdateSocialAutomationSettingsInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  drafts,
  externalActions,
  postingCadences,
  publications,
  signals as signalsTable,
  socialAutomationSettings,
} from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { listAutomatedCampaigns } from "./campaigns";
import { applyDraftAction, type DraftActor } from "./drafts";
import { getBestSignalMatchForCampaign } from "./matching";
import { listPersonas } from "./personas";
import { generateSignalDraft } from "./signal-drafting";
import { getWorkspace } from "./workspaces";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Automation always acts as the system identity — the gate transition for an
 * auto-approval is attributed to `system` no matter who triggered the run. */
const SYSTEM_ACTOR: DraftActor = { userId: null, label: "system" };

// ---------------------------------------------------------------------------
// Settings (per workspace; mirrors ad_settings)
// ---------------------------------------------------------------------------

export function getSocialAutomationSettings(db: Db, workspaceId: string): SocialAutomationSettings {
  const row = db
    .select()
    .from(socialAutomationSettings)
    .where(eq(socialAutomationSettings.workspaceId, workspaceId))
    .get();
  return row
    ? {
        workspaceId,
        killSwitch: row.killSwitch === 1,
        perConnectionDailyCap: row.perConnectionDailyCap,
        perCampaignDailyCap: row.perCampaignDailyCap,
        autoReplyEnabled: row.autoReplyEnabled === 1,
        matchThreshold: row.matchThreshold,
        updatedAt: row.updatedAt,
      }
    : {
        workspaceId,
        killSwitch: false,
        perConnectionDailyCap: DEFAULT_PER_CONNECTION_DAILY_CAP,
        perCampaignDailyCap: DEFAULT_PER_CAMPAIGN_DAILY_CAP,
        autoReplyEnabled: false,
        matchThreshold: DEFAULT_MATCH_THRESHOLD,
        updatedAt: 0,
      };
}

export function updateSocialAutomationSettings(
  db: Db,
  workspaceId: string,
  patch: UpdateSocialAutomationSettingsInput,
): SocialAutomationSettings {
  const current = getSocialAutomationSettings(db, workspaceId);
  const next: SocialAutomationSettings = {
    workspaceId,
    killSwitch: patch.killSwitch ?? current.killSwitch,
    perConnectionDailyCap: patch.perConnectionDailyCap ?? current.perConnectionDailyCap,
    perCampaignDailyCap: patch.perCampaignDailyCap ?? current.perCampaignDailyCap,
    autoReplyEnabled: patch.autoReplyEnabled ?? current.autoReplyEnabled,
    matchThreshold: patch.matchThreshold ?? current.matchThreshold,
    updatedAt: Date.now(),
  };
  const columns = {
    killSwitch: next.killSwitch ? 1 : 0,
    perConnectionDailyCap: next.perConnectionDailyCap,
    perCampaignDailyCap: next.perCampaignDailyCap,
    autoReplyEnabled: next.autoReplyEnabled ? 1 : 0,
    matchThreshold: next.matchThreshold,
    updatedAt: next.updatedAt,
  };
  db.insert(socialAutomationSettings)
    .values({ workspaceId, ...columns })
    .onConflictDoUpdate({ target: socialAutomationSettings.workspaceId, set: columns })
    .run();
  return next;
}

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

  for (const campaign of campaigns) {
    const base = {
      campaignId: campaign.id,
      campaignName: campaign.name,
      mode: campaign.automationMode,
    };

    // The kill switch halts auto-posting only (scheduled_auto); human-in-the-loop
    // still drafts to the gate, where a human is the control.
    if (campaign.automationMode === "scheduled_auto" && settings.killSwitch) {
      results.push({ ...base, generated: 0, autoApproved: 0, skipped: 0, blocked: "kill_switch_on" });
      continue;
    }

    let generated = 0;
    let autoApproved = 0;
    let skipped = 0;

    for (const signal of signals) {
      // Sprint 45: a signal only reaches this campaign when discovery (or a
      // human) matched it above the workspace threshold — no more blind fan-out.
      const match = getBestSignalMatchForCampaign(db, signal.id, campaign.id);
      if (!match || match.score < settings.matchThreshold) continue;
      const persona = match.personaId ? personasById.get(match.personaId) : undefined;
      for (const channel of campaign.channels) {
        if (hasDraftFor(db, signal.id, campaign.id, channel)) continue;
        try {
          const draft = await generateSignalDraft(
            db,
            llm,
            evidence,
            workspace,
            signal,
            { channel, campaign, persona, useEvidence: true },
            SYSTEM_ACTOR,
          );
          generated += 1;
          if (campaign.automationMode === "scheduled_auto") {
            applyDraftAction(db, draft, "approve", SYSTEM_ACTOR);
            autoApproved += 1;
          }
        } catch {
          // One bad signal never aborts the run; it's counted and retried next tick.
          skipped += 1;
        }
      }
    }

    results.push({ ...base, generated, autoApproved, skipped, blocked: null });
  }

  return { results, ranAt: nowMs };
}
