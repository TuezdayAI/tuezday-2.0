import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  adLaunchTransitionTo,
  parseAdCreative,
  type AdLaunch,
  type AdLaunchAction,
  type AdLaunchDecision,
  type AdLaunchDecisionAction,
  type AdLaunchObjective,
  type AdLaunchStatus,
  type AdSettings,
  type CreateAdLaunchInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  adAccounts,
  adCampaigns,
  adLaunchDecisions,
  adLaunches,
  adSettings,
  drafts,
  type AdCampaignRow,
  type AdLaunchRow,
} from "../db/schema";
import type { AdsExecutionAdapter } from "../connectors/ads";
import type { DraftActor } from "./drafts";

export class InvalidLaunchTransitionError extends Error {
  constructor(from: AdLaunchStatus, action: AdLaunchAction) {
    super(`Cannot ${action} a launch in state "${from}".`);
    this.name = "InvalidLaunchTransitionError";
  }
}

function rowToLaunch(row: AdLaunchRow): AdLaunch {
  return {
    ...row,
    objective: row.objective as AdLaunchObjective,
    status: row.status as AdLaunchStatus,
    countries: JSON.parse(row.countriesJson) as string[],
  };
}

/** The approved variant's copy, in the shape the platform creative needs. */
export interface LaunchCreativeFields {
  primaryText: string;
  headline: string;
  description: string;
}

export function creativeFieldsFrom(content: string): LaunchCreativeFields | null {
  const parsed = parseAdCreative("meta_ad_creative", content);
  if (!parsed) return null;
  const value = (key: string) => parsed.fields.find((f) => f.key === key)?.value ?? "";
  const fields = {
    primaryText: value("primary_text"),
    headline: value("headline"),
    description: value("description"),
  };
  return fields.primaryText && fields.headline ? fields : null;
}

export interface AdLaunchWithContext extends AdLaunch {
  account: { name: string; currency: string } | null;
  creative: LaunchCreativeFields | null;
}

function withContext(
  row: AdLaunchRow,
  account: { name: string; currency: string } | undefined,
  draftContent: string | undefined,
): AdLaunchWithContext {
  return {
    ...rowToLaunch(row),
    account: account ?? null,
    creative: draftContent !== undefined ? creativeFieldsFrom(draftContent) : null,
  };
}

export function listLaunches(db: Db, workspaceId: string): AdLaunchWithContext[] {
  const rows = db
    .select({ launch: adLaunches, account: adAccounts, draft: drafts })
    .from(adLaunches)
    .leftJoin(adAccounts, eq(adLaunches.adAccountId, adAccounts.id))
    .leftJoin(drafts, eq(adLaunches.creativeDraftId, drafts.id))
    .where(eq(adLaunches.workspaceId, workspaceId))
    .orderBy(desc(adLaunches.createdAt))
    .all();
  return rows.map(({ launch, account, draft }) =>
    withContext(launch, account ?? undefined, draft?.content),
  );
}

export function getLaunch(db: Db, workspaceId: string, launchId: string): AdLaunch | undefined {
  const row = db
    .select()
    .from(adLaunches)
    .where(and(eq(adLaunches.workspaceId, workspaceId), eq(adLaunches.id, launchId)))
    .get();
  return row ? rowToLaunch(row) : undefined;
}

export function getLaunchWithContext(
  db: Db,
  workspaceId: string,
  launchId: string,
): AdLaunchWithContext | undefined {
  const row = db
    .select({ launch: adLaunches, account: adAccounts, draft: drafts })
    .from(adLaunches)
    .leftJoin(adAccounts, eq(adLaunches.adAccountId, adAccounts.id))
    .leftJoin(drafts, eq(adLaunches.creativeDraftId, drafts.id))
    .where(and(eq(adLaunches.workspaceId, workspaceId), eq(adLaunches.id, launchId)))
    .get();
  return row ? withContext(row.launch, row.account ?? undefined, row.draft?.content) : undefined;
}

export function createLaunch(
  db: Db,
  workspaceId: string,
  input: CreateAdLaunchInput,
  campaignId: string | null,
): AdLaunch {
  const now = Date.now();
  const row: AdLaunchRow = {
    id: randomUUID(),
    workspaceId,
    adAccountId: input.adAccountId,
    campaignId,
    creativeDraftId: input.creativeDraftId,
    name: input.name,
    objective: input.objective,
    pageId: input.pageId,
    linkUrl: input.linkUrl,
    dailyBudgetCents: input.dailyBudgetCents,
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    countriesJson: JSON.stringify(input.countries),
    ageMin: input.ageMin,
    ageMax: input.ageMax,
    status: "draft",
    externalCampaignId: null,
    externalAdSetId: null,
    externalCreativeId: null,
    externalAdId: null,
    metaImageHash: null,
    adCampaignId: null,
    platformStatus: null,
    launchedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(adLaunches).values(row).run();
  return rowToLaunch(row);
}

export function updateLaunch(
  db: Db,
  launch: AdLaunch,
  patch: Partial<CreateAdLaunchInput>,
  campaignId: string | null,
): AdLaunch {
  const set: Partial<AdLaunchRow> = { updatedAt: Date.now() };
  if (patch.adAccountId !== undefined) set.adAccountId = patch.adAccountId;
  if (patch.creativeDraftId !== undefined) {
    set.creativeDraftId = patch.creativeDraftId;
    set.campaignId = campaignId;
  }
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.objective !== undefined) set.objective = patch.objective;
  if (patch.pageId !== undefined) set.pageId = patch.pageId;
  if (patch.linkUrl !== undefined) set.linkUrl = patch.linkUrl;
  if (patch.dailyBudgetCents !== undefined) set.dailyBudgetCents = patch.dailyBudgetCents;
  if (patch.startAt !== undefined) set.startAt = patch.startAt;
  if (patch.endAt !== undefined) set.endAt = patch.endAt;
  if (patch.countries !== undefined) set.countriesJson = JSON.stringify(patch.countries);
  if (patch.ageMin !== undefined) set.ageMin = patch.ageMin;
  if (patch.ageMax !== undefined) set.ageMax = patch.ageMax;
  db.update(adLaunches).set(set).where(eq(adLaunches.id, launch.id)).run();
  return getLaunch(db, launch.workspaceId, launch.id)!;
}

export function deleteLaunch(db: Db, launchId: string): void {
  db.delete(adLaunches).where(eq(adLaunches.id, launchId)).run();
}

export function logLaunchDecision(
  db: Db,
  launch: { id: string; workspaceId: string },
  actor: DraftActor,
  action: AdLaunchDecisionAction,
  fromState: AdLaunchStatus,
  toState: AdLaunchStatus,
): void {
  db.insert(adLaunchDecisions)
    .values({
      id: randomUUID(),
      launchId: launch.id,
      workspaceId: launch.workspaceId,
      action,
      fromState,
      toState,
      actor: actor.label,
      actorId: actor.userId,
      createdAt: Date.now(),
    })
    .run();
}

export function listLaunchDecisions(db: Db, launchId: string): AdLaunchDecision[] {
  return db
    .select()
    .from(adLaunchDecisions)
    .where(eq(adLaunchDecisions.launchId, launchId))
    .orderBy(asc(adLaunchDecisions.createdAt))
    .all()
    .map((row) => ({
      ...row,
      action: row.action as AdLaunchDecisionAction,
      fromState: row.fromState as AdLaunchStatus,
      toState: row.toState as AdLaunchStatus,
    }));
}

/** Apply a gate action; throws InvalidLaunchTransitionError when illegal. */
export function applyLaunchAction(
  db: Db,
  launch: AdLaunch,
  action: AdLaunchAction,
  actor: DraftActor,
): AdLaunch {
  const toState = adLaunchTransitionTo(launch.status, action);
  if (!toState) throw new InvalidLaunchTransitionError(launch.status, action);
  db.update(adLaunches)
    .set({ status: toState, updatedAt: Date.now() })
    .where(eq(adLaunches.id, launch.id))
    .run();
  logLaunchDecision(db, launch, actor, action, launch.status, toState);
  return { ...launch, status: toState };
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export function getAdSettings(db: Db, workspaceId: string): AdSettings {
  const row = db.select().from(adSettings).where(eq(adSettings.workspaceId, workspaceId)).get();
  return row
    ? { workspaceId, dailyCapCents: row.dailyCapCents, killSwitch: row.killSwitch === 1, updatedAt: row.updatedAt }
    : { workspaceId, dailyCapCents: 5000, killSwitch: false, updatedAt: 0 };
}

export function updateAdSettings(
  db: Db,
  workspaceId: string,
  patch: { dailyCapCents?: number; killSwitch?: boolean },
): AdSettings {
  const current = getAdSettings(db, workspaceId);
  const next: AdSettings = {
    workspaceId,
    dailyCapCents: patch.dailyCapCents ?? current.dailyCapCents,
    killSwitch: patch.killSwitch ?? current.killSwitch,
    updatedAt: Date.now(),
  };
  db.insert(adSettings)
    .values({ ...next, killSwitch: next.killSwitch ? 1 : 0 })
    .onConflictDoUpdate({
      target: adSettings.workspaceId,
      set: {
        dailyCapCents: next.dailyCapCents,
        killSwitch: next.killSwitch ? 1 : 0,
        updatedAt: next.updatedAt,
      },
    })
    .run();
  return next;
}

/** Platform statuses under which a launched campaign is not spending. */
const NOT_SPENDING = new Set(["PAUSED", "CAMPAIGN_PAUSED", "ARCHIVED", "DELETED", "DISAPPROVED"]);

export function isSpending(launch: AdLaunch): boolean {
  // An unknown status counts as spending — benefit of the doubt goes to the cap.
  return launch.status === "launched" && !NOT_SPENDING.has(launch.platformStatus ?? "ACTIVE");
}

export function listSpendingLaunches(db: Db, workspaceId: string): AdLaunch[] {
  return db
    .select()
    .from(adLaunches)
    .where(and(eq(adLaunches.workspaceId, workspaceId), eq(adLaunches.status, "launched")))
    .all()
    .map(rowToLaunch)
    .filter(isSpending);
}

export type GuardrailCheck =
  | { ok: true }
  | { ok: false; error: "kill_switch_on" | "daily_cap_exceeded"; message: string };

/**
 * The check run at the moments money can start flowing — launch and resume.
 * The cap bounds committed daily budgets, not observed spend.
 */
export function checkSpendGuardrails(db: Db, launch: AdLaunch): GuardrailCheck {
  const settings = getAdSettings(db, launch.workspaceId);
  if (settings.killSwitch) {
    return {
      ok: false,
      error: "kill_switch_on",
      message: "The workspace kill switch is on — turn it off in Ads settings before spending.",
    };
  }
  const committed = listSpendingLaunches(db, launch.workspaceId)
    .filter((other) => other.id !== launch.id)
    .reduce((sum, other) => sum + other.dailyBudgetCents, 0);
  if (committed + launch.dailyBudgetCents > settings.dailyCapCents) {
    return {
      ok: false,
      error: "daily_cap_exceeded",
      message: `This launch commits ${committed + launch.dailyBudgetCents} cents/day against a workspace cap of ${settings.dailyCapCents} (${committed} already committed). Raise the cap in Ads settings or pause something first.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Launch + platform status
// ---------------------------------------------------------------------------

function persist(db: Db, launchId: string, set: Partial<AdLaunchRow>): void {
  db.update(adLaunches)
    .set({ ...set, updatedAt: Date.now() })
    .where(eq(adLaunches.id, launchId))
    .run();
}

/**
 * Run the platform object chain: campaign (PAUSED) → ad set → creative → ad,
 * then activate the campaign. Each external id is persisted as it lands, so
 * a failed launch keeps its progress and a retry resumes instead of
 * duplicating objects. Adapter failures set lastError and rethrow.
 */
export async function performLaunch(
  db: Db,
  adapter: AdsExecutionAdapter,
  launch: AdLaunch,
  externalAccountId: string,
  creative: LaunchCreativeFields,
  actor: DraftActor,
  /** The creative draft's rendered image URL (Sprint 41 Part 5), if any. */
  imageUrl?: string | null,
): Promise<AdLaunch> {
  let { externalCampaignId, externalAdSetId, externalCreativeId, externalAdId, metaImageHash } =
    launch;
  try {
    if (!externalCampaignId) {
      externalCampaignId = (
        await adapter.createCampaign(externalAccountId, {
          name: launch.name,
          objective: launch.objective,
        })
      ).externalId;
      persist(db, launch.id, { externalCampaignId });
    }
    if (!externalAdSetId) {
      externalAdSetId = (
        await adapter.createAdSet(externalAccountId, {
          campaignExternalId: externalCampaignId,
          name: `${launch.name} — ad set`,
          objective: launch.objective,
          dailyBudgetCents: launch.dailyBudgetCents,
          countries: launch.countries,
          ageMin: launch.ageMin,
          ageMax: launch.ageMax,
          startAt: launch.startAt,
          endAt: launch.endAt,
        })
      ).externalId;
      persist(db, launch.id, { externalAdSetId });
    }
    if (!externalCreativeId) {
      // Generated ad image (Sprint 41): upload once, persist the hash so a
      // resumed launch never re-uploads, then attach it to the creative.
      if (imageUrl && !metaImageHash) {
        metaImageHash = (await adapter.uploadAdImage(externalAccountId, { url: imageUrl }))
          .imageHash;
        persist(db, launch.id, { metaImageHash });
      }
      externalCreativeId = (
        await adapter.createAdCreative(externalAccountId, {
          name: `${launch.name} — creative`,
          pageId: launch.pageId,
          linkUrl: launch.linkUrl,
          ...creative,
          ...(metaImageHash ? { imageHash: metaImageHash } : {}),
        })
      ).externalId;
      persist(db, launch.id, { externalCreativeId });
    }
    if (!externalAdId) {
      externalAdId = (
        await adapter.createAd(externalAccountId, {
          name: `${launch.name} — ad`,
          adSetExternalId: externalAdSetId,
          creativeExternalId: externalCreativeId,
        })
      ).externalId;
      persist(db, launch.id, { externalAdId });
    }
    // The chain is whole — this is the moment spend becomes possible.
    await adapter.setCampaignStatus(externalCampaignId, "ACTIVE");
  } catch (err) {
    persist(db, launch.id, {
      lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
    throw err;
  }

  const adCampaignId = mirrorAdCampaign(db, launch, externalCampaignId);
  persist(db, launch.id, {
    status: "launched",
    platformStatus: "ACTIVE",
    launchedAt: Date.now(),
    adCampaignId,
    lastError: null,
  });
  logLaunchDecision(db, launch, actor, "launch", "approved", "launched");
  return getLaunch(db, launch.workspaceId, launch.id)!;
}

/** Register the launched campaign in the Sprint 14 reporting mirror, linked
 * to the launch's Tuezday campaign — spend shows up with zero new plumbing. */
function mirrorAdCampaign(db: Db, launch: AdLaunch, externalCampaignId: string): string {
  const existing = db
    .select()
    .from(adCampaigns)
    .where(
      and(
        eq(adCampaigns.adAccountId, launch.adAccountId),
        eq(adCampaigns.externalId, externalCampaignId),
      ),
    )
    .get();
  if (existing) {
    if (!existing.campaignId && launch.campaignId) {
      db.update(adCampaigns)
        .set({ campaignId: launch.campaignId })
        .where(eq(adCampaigns.id, existing.id))
        .run();
    }
    return existing.id;
  }
  const fresh: AdCampaignRow = {
    id: randomUUID(),
    workspaceId: launch.workspaceId,
    adAccountId: launch.adAccountId,
    externalId: externalCampaignId,
    name: launch.name,
    campaignId: launch.campaignId,
    lastSyncedAt: Date.now(),
    createdAt: Date.now(),
  };
  db.insert(adCampaigns).values(fresh).run();
  return fresh.id;
}

export function recordLaunchError(db: Db, launchId: string, message: string): void {
  persist(db, launchId, { lastError: message.slice(0, 500) });
}

export async function setLaunchPlatformStatus(
  db: Db,
  adapter: AdsExecutionAdapter,
  launch: AdLaunch,
  status: "ACTIVE" | "PAUSED",
): Promise<AdLaunch> {
  await adapter.setCampaignStatus(launch.externalCampaignId!, status);
  persist(db, launch.id, { platformStatus: status });
  return getLaunch(db, launch.workspaceId, launch.id)!;
}

/**
 * Stamp the platform's effective status on this account's launched launches.
 * Skips the wire call entirely when nothing was launched from this account.
 */
export async function syncLaunchStatuses(
  db: Db,
  adapter: AdsExecutionAdapter,
  workspaceId: string,
  adAccountId: string,
  externalAccountId: string,
): Promise<void> {
  const launched = db
    .select()
    .from(adLaunches)
    .where(
      and(
        eq(adLaunches.workspaceId, workspaceId),
        eq(adLaunches.adAccountId, adAccountId),
        eq(adLaunches.status, "launched"),
      ),
    )
    .all();
  if (launched.length === 0) return;

  const statuses = await adapter.listCampaignStatuses(externalAccountId);
  const byExternalId = new Map(statuses.map((s) => [s.externalCampaignId, s.status]));
  for (const row of launched) {
    const status = row.externalCampaignId ? byExternalId.get(row.externalCampaignId) : undefined;
    if (status && status !== row.platformStatus) {
      persist(db, row.id, { platformStatus: status });
    }
  }
}
