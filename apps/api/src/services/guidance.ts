import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import {
  CHANNELS,
  CHANNEL_GUIDANCE_DEFAULTS,
  type Channel,
  type ChannelGuidance,
  type GuidanceOverride,
  type GuidanceSource,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import { campaigns, guidanceOverrides, personas, type GuidanceOverrideRow } from "../db/schema";

/**
 * Optional persona/campaign scope for a guidance override (Sprint 44). Both
 * absent/null means the workspace-level override — the only kind before this
 * sprint.
 */
export interface GuidanceScope {
  personaId?: string | null;
  campaignId?: string | null;
}

export interface ResolvedGuidance {
  content: string;
  source: GuidanceSource;
  /** Scope of the winning row; both null for workspace-level and default guidance. */
  personaId: string | null;
  campaignId: string | null;
  /** Preformatted label naming the winning scope, e.g. `persona "Field CTO"`. */
  scopeLabel?: string;
  updatedAt: number | null;
}

/** Human label for a scoped row, folded into the resolver trace reason. */
async function scopeLabelFor(
  db: Db,
  row: Pick<GuidanceOverrideRow, "personaId" | "campaignId">,
): Promise<string | undefined> {
  const parts: string[] = [];
  if (row.personaId) {
    const persona = await db
      .select({ name: personas.name })
      .from(personas)
      .where(eq(personas.id, row.personaId))
      .get();
    parts.push(`persona "${persona?.name ?? row.personaId}"`);
  }
  if (row.campaignId) {
    const campaign = await db
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.id, row.campaignId))
      .get();
    parts.push(`campaign "${campaign?.name ?? row.campaignId}"`);
  }
  return parts.length > 0 ? parts.join(" + ") : undefined;
}

/**
 * The channel guidance in effect for a workspace + optional persona/campaign
 * scope. Most-specific-wins (it replaces, never stacks):
 * persona+campaign > persona > campaign > workspace override > built-in default.
 */
export async function resolveChannelGuidance(
  db: Db,
  workspaceId: string,
  channel: Channel,
  scope?: GuidanceScope,
): Promise<ResolvedGuidance> {
  const rows = await db
    .select()
    .from(guidanceOverrides)
    .where(
      and(eq(guidanceOverrides.workspaceId, workspaceId), eq(guidanceOverrides.channel, channel)),
    )
    .all();

  const personaId = scope?.personaId ?? null;
  const campaignId = scope?.campaignId ?? null;
  const winner =
    (personaId && campaignId
      ? rows.find((r) => r.personaId === personaId && r.campaignId === campaignId)
      : undefined) ??
    (personaId
      ? rows.find((r) => r.personaId === personaId && r.campaignId === null)
      : undefined) ??
    (campaignId
      ? rows.find((r) => r.campaignId === campaignId && r.personaId === null)
      : undefined) ??
    rows.find((r) => r.personaId === null && r.campaignId === null);

  if (winner) {
    return {
      content: winner.content,
      source: "workspace",
      personaId: winner.personaId,
      campaignId: winner.campaignId,
      scopeLabel: await scopeLabelFor(db, winner),
      updatedAt: winner.updatedAt,
    };
  }
  return {
    content: CHANNEL_GUIDANCE_DEFAULTS[channel],
    source: "default",
    personaId: null,
    campaignId: null,
    updatedAt: null,
  };
}

function toChannelGuidance(channel: Channel, resolved: ResolvedGuidance): ChannelGuidance {
  return {
    channel,
    content: resolved.content,
    source: resolved.source,
    personaId: resolved.personaId,
    campaignId: resolved.campaignId,
    updatedAt: resolved.updatedAt,
  };
}

/** Every channel's workspace-level guidance — always one row per channel, defaults included. */
export function listChannelGuidance(db: Db, workspaceId: string): Promise<ChannelGuidance[]> {
  return Promise.all(CHANNELS.map(async (channel) =>
      toChannelGuidance(channel, await resolveChannelGuidance(db, workspaceId, channel)),
    ));
}

/** All persona-/campaign-scoped override rows for the management UI, names joined in. */
export async function listScopedGuidance(db: Db, workspaceId: string): Promise<GuidanceOverride[]> {
  return (await db
    .select({
      row: guidanceOverrides,
      personaName: personas.name,
      campaignName: campaigns.name,
    })
    .from(guidanceOverrides)
    .leftJoin(personas, eq(guidanceOverrides.personaId, personas.id))
    .leftJoin(campaigns, eq(guidanceOverrides.campaignId, campaigns.id))
    .where(
      and(
        eq(guidanceOverrides.workspaceId, workspaceId),
        or(isNotNull(guidanceOverrides.personaId), isNotNull(guidanceOverrides.campaignId)),
      ),
    )
    .orderBy(guidanceOverrides.channel, guidanceOverrides.updatedAt)
    .all())
    .map(({ row, personaName, campaignName }) => ({
      id: row.id,
      channel: row.channel as Channel,
      content: row.content,
      personaId: row.personaId,
      campaignId: row.campaignId,
      personaName,
      campaignName,
      updatedAt: row.updatedAt,
    }));
}

/**
 * WHERE clause matching exactly one scope row. NULL scope columns need isNull
 * (SQL NULL never equals anything), which is also why the unique index alone
 * can't dedupe unscoped rows — this select-first pattern does.
 */
function exactScopeWhere(workspaceId: string, channel: Channel, scope?: GuidanceScope): SQL {
  const personaId = scope?.personaId ?? null;
  const campaignId = scope?.campaignId ?? null;
  return and(
    eq(guidanceOverrides.workspaceId, workspaceId),
    eq(guidanceOverrides.channel, channel),
    personaId === null
      ? isNull(guidanceOverrides.personaId)
      : eq(guidanceOverrides.personaId, personaId),
    campaignId === null
      ? isNull(guidanceOverrides.campaignId)
      : eq(guidanceOverrides.campaignId, campaignId),
  )!;
}

/** Create or update the override at exactly that scope; returns the resolved row. */
export async function setChannelGuidance(
  db: Db,
  workspaceId: string,
  channel: Channel,
  content: string,
  scope?: GuidanceScope,
): Promise<ChannelGuidance> {
  const now = Date.now();
  const personaId = scope?.personaId ?? null;
  const campaignId = scope?.campaignId ?? null;
  const existing = await db
    .select({ id: guidanceOverrides.id })
    .from(guidanceOverrides)
    .where(exactScopeWhere(workspaceId, channel, scope))
    .get();

  if (existing) {
    await db.update(guidanceOverrides)
      .set({ content, updatedAt: now })
      .where(eq(guidanceOverrides.id, existing.id))
      .run();
  } else {
    await db.insert(guidanceOverrides)
      .values({
        id: randomUUID(),
        workspaceId,
        channel,
        personaId,
        campaignId,
        content,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  return { channel, content, source: "workspace", personaId, campaignId, updatedAt: now };
}

/** Delete the override at exactly that scope; returns the now-effective guidance for it. */
export async function resetChannelGuidance(
  db: Db,
  workspaceId: string,
  channel: Channel,
  scope?: GuidanceScope,
): Promise<ChannelGuidance> {
  await db.delete(guidanceOverrides).where(exactScopeWhere(workspaceId, channel, scope)).run();
  return toChannelGuidance(channel, await resolveChannelGuidance(db, workspaceId, channel, scope));
}

/**
 * Remove every scoped override for a persona/campaign about to be deleted.
 * SQLite ALTER TABLE ADD COLUMN drops the ON DELETE action (same drizzle-kit
 * gap as publications.cadence_id in 0021), so the service cleans up explicitly;
 * the schema still declares cascade for the eventual Postgres swap.
 */
export async function deleteGuidanceForScope(
  db: DbExecutor,
  workspaceId: string,
  scope: { personaId?: string; campaignId?: string },
): Promise<void> {
  const conditions: SQL[] = [];
  if (scope.personaId) conditions.push(eq(guidanceOverrides.personaId, scope.personaId)!);
  if (scope.campaignId) conditions.push(eq(guidanceOverrides.campaignId, scope.campaignId)!);
  if (conditions.length === 0) return;
  await db.delete(guidanceOverrides)
    .where(and(eq(guidanceOverrides.workspaceId, workspaceId), or(...conditions)))
    .run();
}

/** Narrow an arbitrary string to a Channel, or undefined. */
export function asChannel(value: string): Channel | undefined {
  return (CHANNELS as readonly string[]).includes(value) ? (value as Channel) : undefined;
}
