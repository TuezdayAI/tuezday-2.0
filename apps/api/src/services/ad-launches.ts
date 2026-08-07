import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  isAdLaunchEditable,
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

export async function listLaunches(db: Db, workspaceId: string): Promise<AdLaunchWithContext[]> {
  const rows = await db
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

export async function getLaunch(db: Db, workspaceId: string, launchId: string): Promise<AdLaunch | undefined> {
  const row = await db
    .select()
    .from(adLaunches)
    .where(and(eq(adLaunches.workspaceId, workspaceId), eq(adLaunches.id, launchId)))
    .get();
  return row ? rowToLaunch(row) : undefined;
}

export async function getLaunchWithContext(
  db: Db,
  workspaceId: string,
  launchId: string,
): Promise<AdLaunchWithContext | undefined> {
  const row = await db
    .select({ launch: adLaunches, account: adAccounts, draft: drafts })
    .from(adLaunches)
    .leftJoin(adAccounts, eq(adLaunches.adAccountId, adAccounts.id))
    .leftJoin(drafts, eq(adLaunches.creativeDraftId, drafts.id))
    .where(and(eq(adLaunches.workspaceId, workspaceId), eq(adLaunches.id, launchId)))
    .get();
  return row ? withContext(row.launch, row.account ?? undefined, row.draft?.content) : undefined;
}

export async function createLaunch(
  db: Db,
  workspaceId: string,
  input: CreateAdLaunchInput,
  campaignId: string | null,
): Promise<AdLaunch> {
  const now = Date.now();
  const row: AdLaunchRow = {
    id: randomUUID(),
    workspaceId,
    adAccountId: input.adAccountId,
    campaignId,
    creativeDraftId: input.creativeDraftId,
    externalActionId: null,
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
  await db.insert(adLaunches).values(row).run();
  return rowToLaunch(row);
}

export async function updateLaunch(
  db: Db,
  launch: AdLaunch,
  patch: Partial<CreateAdLaunchInput>,
  campaignId: string | null,
): Promise<AdLaunch> {
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
  await db.update(adLaunches).set(set).where(eq(adLaunches.id, launch.id)).run();
  return (await getLaunch(db, launch.workspaceId, launch.id))!;
}

/** Persist a provider-confirmed targeting mutation on the local launch projection. */
export async function persistLaunchTargeting(
  db: Db,
  launchId: string,
  targeting: { countries: string[]; ageMin: number; ageMax: number },
): Promise<void> {
  await db.update(adLaunches)
    .set({
      countriesJson: JSON.stringify(targeting.countries),
      ageMin: targeting.ageMin,
      ageMax: targeting.ageMax,
      updatedAt: Date.now(),
    })
    .where(eq(adLaunches.id, launchId))
    .run();
}

export async function deleteLaunch(db: Db, launchId: string): Promise<void> {
  await db.delete(adLaunches).where(eq(adLaunches.id, launchId)).run();
}

/**
 * The **setup-approval** trail — not spend governance (Sprint 54 Task 2).
 *
 * This answers one question: *who approved this ad's setup?* It records the
 * four gate verbs (`submit`/`approve`/`reject`/`revise`), which are
 * pre-conditions on editability and readiness, and nothing else.
 *
 * *Who authorized this spend?* is a different question with a different,
 * single answer: the external-action decision log
 * (`external_action_decisions`, written by the coordinator's authorize/deny
 * paths against the `paid_launch` action that `adLaunches.externalActionId`
 * points at). `performLaunch` used to append a synthetic `approved → launched`
 * row here too, which read like a spend authorization but was fabricated — the
 * transition never happened as a gate move and the actor was reconstructed
 * with `human: false`. It is gone; do not reintroduce a launch/authorization
 * verb into this table.
 */
export async function recordSetupGateDecision(
  db: Db,
  launch: { id: string; workspaceId: string },
  actor: DraftActor,
  action: AdLaunchAction,
  fromState: AdLaunchStatus,
  toState: AdLaunchStatus,
): Promise<void> {
  await db.insert(adLaunchDecisions)
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

/**
 * Read the setup-approval trail, oldest first. Rows written before Sprint 54
 * may still carry the retired `launch` verb with a synthetic
 * `approved → launched` transition; they are history and are surfaced as such,
 * never as an answer to who authorized spend.
 */
export async function listSetupGateDecisions(db: Db, launchId: string): Promise<AdLaunchDecision[]> {
  return (await db
    .select()
    .from(adLaunchDecisions)
    .where(eq(adLaunchDecisions.launchId, launchId))
    .orderBy(asc(adLaunchDecisions.createdAt))
    .all())
    .map((row) => ({
      ...row,
      action: row.action as AdLaunchDecisionAction,
      fromState: row.fromState as AdLaunchStatus,
      toState: row.toState as AdLaunchStatus,
    }));
}

/**
 * Where each setup-gate verb leaves the launch, or `undefined` when it does not
 * apply. Sprint 54 Task 4 replaced `adLaunchTransitionTo` — a second bespoke
 * state machine exported from contracts beside the canonical `transitionTo` —
 * with these four preconditions, stated where the rest of the launch's business
 * logic already lives. The only rule with reach beyond this function is
 * editability (`isAdLaunchEditable`), which the PATCH route enforces too.
 */
export function nextGateState(
  status: AdLaunchStatus,
  action: AdLaunchAction,
): AdLaunchStatus | undefined {
  switch (action) {
    // Hand an editable draft over for review; it stops being editable.
    case "submit":
      return isAdLaunchEditable(status) ? "pending_review" : undefined;
    case "approve":
      return status === "pending_review" ? "approved" : undefined;
    case "reject":
      return status === "pending_review" ? "rejected" : undefined;
    // The door back to editable, from the three states the gate can park a
    // launch in. Stated as an allow-list rather than "anything that is not
    // launched or already editable": the two agree across today's five
    // statuses, but the negative form would make `revise` legal from a sixth
    // the day it is added. Reopening a launch for editing is not a default.
    case "revise":
      return status === "pending_review" || status === "rejected" || status === "approved"
        ? "draft"
        : undefined;
  }
}

/** Apply a gate action; throws InvalidLaunchTransitionError when illegal. */
export async function applyLaunchAction(
  db: Db,
  launch: AdLaunch,
  action: AdLaunchAction,
  actor: DraftActor,
): Promise<AdLaunch> {
  const toState = nextGateState(launch.status, action);
  if (!toState) throw new InvalidLaunchTransitionError(launch.status, action);
  await db.update(adLaunches)
    .set({ status: toState, updatedAt: Date.now() })
    .where(eq(adLaunches.id, launch.id))
    .run();
  await recordSetupGateDecision(db, launch, actor, action, launch.status, toState);
  return { ...launch, status: toState };
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export async function getAdSettings(db: Db, workspaceId: string): Promise<AdSettings> {
  const row = await db.select().from(adSettings).where(eq(adSettings.workspaceId, workspaceId)).get();
  return row
    ? { workspaceId, dailyCapCents: row.dailyCapCents, killSwitch: row.killSwitch === 1, updatedAt: row.updatedAt }
    : { workspaceId, dailyCapCents: 5000, killSwitch: false, updatedAt: 0 };
}

export async function updateAdSettings(
  db: Db,
  workspaceId: string,
  patch: { dailyCapCents?: number; killSwitch?: boolean },
): Promise<AdSettings> {
  const current = await getAdSettings(db, workspaceId);
  const next: AdSettings = {
    workspaceId,
    dailyCapCents: patch.dailyCapCents ?? current.dailyCapCents,
    killSwitch: patch.killSwitch ?? current.killSwitch,
    updatedAt: Date.now(),
  };
  await db.insert(adSettings)
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

export async function listSpendingLaunches(db: Db, workspaceId: string): Promise<AdLaunch[]> {
  return (await db
    .select()
    .from(adLaunches)
    .where(and(eq(adLaunches.workspaceId, workspaceId), eq(adLaunches.status, "launched")))
    .all())
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
export async function checkSpendGuardrails(db: Db, launch: AdLaunch): Promise<GuardrailCheck> {
  const settings = await getAdSettings(db, launch.workspaceId);
  if (settings.killSwitch) {
    return {
      ok: false,
      error: "kill_switch_on",
      message: "The workspace kill switch is on — turn it off in Ads settings before spending.",
    };
  }
  const committed = (await listSpendingLaunches(db, launch.workspaceId))
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

async function persist(db: Db, launchId: string, set: Partial<AdLaunchRow>): Promise<void> {
  await db.update(adLaunches)
    .set({ ...set, updatedAt: Date.now() })
    .where(eq(adLaunches.id, launchId))
    .run();
}

/**
 * Run the platform object chain: campaign (PAUSED) → ad set → creative → ad,
 * then activate the campaign. Each external id is persisted as it lands, so
 * a failed launch keeps its progress and a retry resumes instead of
 * duplicating objects. Adapter failures set lastError and rethrow.
 *
 * It takes no actor (Sprint 54 Task 2). It used to, purely to attribute a
 * synthetic `approved → launched` row in the setup-approval trail — an actor
 * the caller had to reconstruct as non-human because the persisted proposer
 * does not record humanity. Who authorized this spend is answered by the
 * external-action decision log against `launch.externalActionId`, so there is
 * nothing here left to attribute.
 */
export async function performLaunch(
  db: Db,
  adapter: AdsExecutionAdapter,
  launch: AdLaunch,
  externalAccountId: string,
  creative: LaunchCreativeFields,
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
      await persist(db, launch.id, { externalCampaignId });
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
      await persist(db, launch.id, { externalAdSetId });
    }
    if (!externalCreativeId) {
      // Generated ad image (Sprint 41): upload once, persist the hash so a
      // resumed launch never re-uploads, then attach it to the creative.
      if (imageUrl && !metaImageHash) {
        metaImageHash = (await adapter.uploadAdImage(externalAccountId, { url: imageUrl }))
          .imageHash;
        await persist(db, launch.id, { metaImageHash });
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
      await persist(db, launch.id, { externalCreativeId });
    }
    if (!externalAdId) {
      externalAdId = (
        await adapter.createAd(externalAccountId, {
          name: `${launch.name} — ad`,
          adSetExternalId: externalAdSetId,
          creativeExternalId: externalCreativeId,
        })
      ).externalId;
      await persist(db, launch.id, { externalAdId });
    }
    // The chain is whole — this is the moment spend becomes possible.
    await adapter.setCampaignStatus(externalCampaignId, "ACTIVE");
  } catch (err) {
    await persist(db, launch.id, {
      lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
    throw err;
  }

  const adCampaignId = await mirrorAdCampaign(db, launch, externalCampaignId);
  await persist(db, launch.id, {
    status: "launched",
    platformStatus: "ACTIVE",
    launchedAt: Date.now(),
    adCampaignId,
    lastError: null,
  });
  // No decision row is written here. The launch record itself carries "it
  // launched" (`status`, `launchedAt`, `externalActionId`), and the action it
  // links to carries who authorized the spend.
  return (await getLaunch(db, launch.workspaceId, launch.id))!;
}

/** Register the launched campaign in the Sprint 14 reporting mirror, linked
 * to the launch's Tuezday campaign — spend shows up with zero new plumbing. */
async function mirrorAdCampaign(db: Db, launch: AdLaunch, externalCampaignId: string): Promise<string> {
  const existing = await db
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
      await db.update(adCampaigns)
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
  await db.insert(adCampaigns).values(fresh).run();
  return fresh.id;
}

export async function recordLaunchError(db: Db, launchId: string, message: string): Promise<void> {
  await persist(db, launchId, { lastError: message.slice(0, 500) });
}

export async function setLaunchPlatformStatus(
  db: Db,
  adapter: AdsExecutionAdapter,
  launch: AdLaunch,
  status: "ACTIVE" | "PAUSED",
): Promise<AdLaunch> {
  await adapter.setCampaignStatus(launch.externalCampaignId!, status);
  await persist(db, launch.id, { platformStatus: status });
  return (await getLaunch(db, launch.workspaceId, launch.id))!;
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
  const launched = await db
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
      await persist(db, row.id, { platformStatus: status });
    }
  }
}
