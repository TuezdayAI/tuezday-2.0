import { randomUUID } from "node:crypto";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import {
  DEFAULT_DESIGN_SYSTEM_CONTENT,
  type Channel,
  type DesignOverlay,
  type DesignSystem,
  type DesignTraceSource,
  type ResolvedDesignSystem,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { campaigns, designOverlays, designSystems, personas, type DesignSystemRow } from "../db/schema";

/** Optional persona/campaign scope for an overlay; both null = channel-only. */
export interface DesignOverlayScope {
  personaId?: string | null;
  campaignId?: string | null;
}

function toDesignSystem(row: DesignSystemRow): DesignSystem {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    isDefault: row.isDefault === 1,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Seed the org-level default system if the workspace has none. Called from
 * workspace creation (next to ensureBrainDocs) and lazily by reads, so
 * pre-existing workspaces get one on first touch.
 */
export async function ensureDefaultDesignSystem(db: Db, workspaceId: string): Promise<DesignSystem> {
  const existing = await db
    .select()
    .from(designSystems)
    .where(and(eq(designSystems.workspaceId, workspaceId), eq(designSystems.isDefault, 1)))
    .get();
  if (existing) return toDesignSystem(existing);

  const now = Date.now();
  const row: DesignSystemRow = {
    id: randomUUID(),
    workspaceId,
    name: "Default",
    isDefault: 1,
    content: DEFAULT_DESIGN_SYSTEM_CONTENT,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(designSystems).values(row).run();
  return toDesignSystem(row);
}

/** All named systems for the workspace (v1 UI shows only the default). */
export async function listDesignSystems(db: Db, workspaceId: string): Promise<DesignSystem[]> {
  return (await db
    .select()
    .from(designSystems)
    .where(eq(designSystems.workspaceId, workspaceId))
    .orderBy(designSystems.createdAt)
    .all())
    .map(toDesignSystem);
}

export async function getDesignSystem(db: Db, workspaceId: string, id: string): Promise<DesignSystem | undefined> {
  const row = await db
    .select()
    .from(designSystems)
    .where(and(eq(designSystems.workspaceId, workspaceId), eq(designSystems.id, id)))
    .get();
  return row ? toDesignSystem(row) : undefined;
}

/**
 * Create an additional named system (multi-system readiness; no v1 UI). Never
 * default — the seeded org default keeps that role until setDefaultDesignSystem.
 */
export async function createDesignSystem(
  db: Db,
  workspaceId: string,
  input: { name: string; content?: string },
): Promise<DesignSystem> {
  await ensureDefaultDesignSystem(db, workspaceId);
  const now = Date.now();
  const row: DesignSystemRow = {
    id: randomUUID(),
    workspaceId,
    name: input.name,
    isDefault: 0,
    content: input.content ?? DEFAULT_DESIGN_SYSTEM_CONTENT,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(designSystems).values(row).run(); // (workspaceId, name) unique index rejects dupes
  return toDesignSystem(row);
}

/** Flip the workspace default atomically — exactly one isDefault survives. */
export async function setDefaultDesignSystem(db: Db, workspaceId: string, id: string): Promise<DesignSystem> {
  const target = await getDesignSystem(db, workspaceId, id);
  if (!target) throw new Error(`design system ${id} not found in workspace ${workspaceId}`);
  await db.update(designSystems)
    .set({ isDefault: 0 })
    .where(eq(designSystems.workspaceId, workspaceId))
    .run();
  await db.update(designSystems).set({ isDefault: 1 }).where(eq(designSystems.id, id)).run();
  return { ...target, isDefault: true };
}

/** Update a system's content; defaults to the workspace default system. */
export async function updateDesignSystem(
  db: Db,
  workspaceId: string,
  content: string,
  designSystemId?: string,
): Promise<DesignSystem> {
  const system = designSystemId
    ? await getDesignSystem(db, workspaceId, designSystemId)
    : await ensureDefaultDesignSystem(db, workspaceId);
  if (!system) throw new Error(`design system ${designSystemId} not found`);
  const now = Date.now();
  await db.update(designSystems)
    .set({ content, updatedAt: now })
    .where(eq(designSystems.id, system.id))
    .run();
  return { ...system, content, updatedAt: now };
}

/** All overlay rows for the workspace's systems, scope names joined in. */
export async function listDesignOverlays(
  db: Db,
  workspaceId: string,
  designSystemId?: string,
): Promise<DesignOverlay[]> {
  const conditions = [eq(designOverlays.workspaceId, workspaceId)];
  if (designSystemId) conditions.push(eq(designOverlays.designSystemId, designSystemId));
  return (await db
    .select({ row: designOverlays, personaName: personas.name, campaignName: campaigns.name })
    .from(designOverlays)
    .leftJoin(personas, eq(designOverlays.personaId, personas.id))
    .leftJoin(campaigns, eq(designOverlays.campaignId, campaigns.id))
    .where(and(...conditions))
    .orderBy(designOverlays.channel, designOverlays.updatedAt)
    .all())
    .map(({ row, personaName, campaignName }) => ({
      id: row.id,
      designSystemId: row.designSystemId,
      channel: row.channel as Channel,
      content: row.content,
      personaId: row.personaId,
      campaignId: row.campaignId,
      personaName,
      campaignName,
      updatedAt: row.updatedAt,
    }));
}

/** WHERE clause matching exactly one scope row (NULLs need isNull, as in guidance). */
function exactScopeWhere(designSystemId: string, channel: Channel, scope?: DesignOverlayScope): SQL {
  const personaId = scope?.personaId ?? null;
  const campaignId = scope?.campaignId ?? null;
  return and(
    eq(designOverlays.designSystemId, designSystemId),
    eq(designOverlays.channel, channel),
    personaId === null ? isNull(designOverlays.personaId) : eq(designOverlays.personaId, personaId),
    campaignId === null
      ? isNull(designOverlays.campaignId)
      : eq(designOverlays.campaignId, campaignId),
  )!;
}

/** Create or update the overlay at exactly that scope on the given (or default) system. */
export async function upsertDesignOverlay(
  db: Db,
  workspaceId: string,
  input: {
    channel: Channel;
    content: string;
    designSystemId?: string;
  } & DesignOverlayScope,
): Promise<DesignOverlay> {
  const system = input.designSystemId
    ? await getDesignSystem(db, workspaceId, input.designSystemId)
    : await ensureDefaultDesignSystem(db, workspaceId);
  if (!system) throw new Error(`design system ${input.designSystemId} not found`);

  const now = Date.now();
  const personaId = input.personaId ?? null;
  const campaignId = input.campaignId ?? null;
  const existing = await db
    .select({ id: designOverlays.id })
    .from(designOverlays)
    .where(exactScopeWhere(system.id, input.channel, input))
    .get();

  let id: string;
  if (existing) {
    id = existing.id;
    await db.update(designOverlays)
      .set({ content: input.content, updatedAt: now })
      .where(eq(designOverlays.id, id))
      .run();
  } else {
    id = randomUUID();
    await db.insert(designOverlays)
      .values({
        id,
        workspaceId,
        designSystemId: system.id,
        channel: input.channel,
        personaId,
        campaignId,
        content: input.content,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  return {
    id,
    designSystemId: system.id,
    channel: input.channel,
    content: input.content,
    personaId,
    campaignId,
    personaName: null,
    campaignName: null,
    updatedAt: now,
  };
}

/** Delete one overlay by id; false when it doesn't exist in this workspace. */
export async function deleteDesignOverlay(db: Db, workspaceId: string, overlayId: string): Promise<boolean> {
  const existing = await db
    .select({ id: designOverlays.id })
    .from(designOverlays)
    .where(and(eq(designOverlays.workspaceId, workspaceId), eq(designOverlays.id, overlayId)))
    .get();
  if (!existing) return false;
  await db.delete(designOverlays).where(eq(designOverlays.id, overlayId)).run();
  return true;
}

/**
 * The design context for a visual task: base system content plus (at most)
 * the single winning overlay appended as an addendum. Winner chain identical
 * to resolveChannelGuidance: persona+campaign > persona > campaign >
 * channel-only > base. Called only by the design pipeline — never wired into
 * packages/brain's resolver.
 */
export async function resolveDesignSystem(
  db: Db,
  workspaceId: string,
  input: {
    channel: Channel;
    personaId?: string | null;
    campaignId?: string | null;
    designSystemId?: string;
  },
): Promise<ResolvedDesignSystem> {
  const system = input.designSystemId
    ? await getDesignSystem(db, workspaceId, input.designSystemId)
    : await ensureDefaultDesignSystem(db, workspaceId);
  if (!system) throw new Error(`design system ${input.designSystemId} not found`);

  const rows = await db
    .select()
    .from(designOverlays)
    .where(
      and(
        eq(designOverlays.designSystemId, system.id),
        eq(designOverlays.channel, input.channel),
      ),
    )
    .all();

  const personaId = input.personaId ?? null;
  const campaignId = input.campaignId ?? null;
  const candidates: Array<{ source: DesignTraceSource; row: (typeof rows)[number] | undefined }> = [
    {
      source: "persona+campaign",
      row:
        personaId && campaignId
          ? rows.find((r) => r.personaId === personaId && r.campaignId === campaignId)
          : undefined,
    },
    {
      source: "persona",
      row: personaId
        ? rows.find((r) => r.personaId === personaId && r.campaignId === null)
        : undefined,
    },
    {
      source: "campaign",
      row: campaignId
        ? rows.find((r) => r.campaignId === campaignId && r.personaId === null)
        : undefined,
    },
    { source: "channel", row: rows.find((r) => r.personaId === null && r.campaignId === null) },
  ];
  const winner = candidates.find((c) => c.row !== undefined);

  if (winner?.row) {
    return {
      content: `${system.content}\n\n## Overlay (${winner.source})\n\n${winner.row.content}`,
      trace: { source: winner.source, overlayId: winner.row.id, designSystemId: system.id },
    };
  }
  return {
    content: system.content,
    trace: { source: "base", overlayId: null, designSystemId: system.id },
  };
}
