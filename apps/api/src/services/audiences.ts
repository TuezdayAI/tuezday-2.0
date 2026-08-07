import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  evaluateSegment,
  type Audience,
  type AudienceKind,
  type AudienceMember,
  type AudienceMemberRef,
  type CampaignAudience,
  type Person,
  type SegmentRuleGroup,
  type UpsertAudienceInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  audienceMembers,
  audiences,
  campaignAudiences,
  crmContacts,
  leads,
  type AudienceRow,
} from "../db/schema";

// ---------------------------------------------------------------------------
// The people pool: all leads + CRM contacts not yet linked to a lead. The
// single source for the picker, dynamic-segment evaluation, and member
// resolution — so a linked contact is represented once, as its lead.
// ---------------------------------------------------------------------------

export async function loadPeople(db: Db, workspaceId: string): Promise<Person[]> {
  const leadRows = await db
    .select()
    .from(leads)
    .where(eq(leads.workspaceId, workspaceId))
    .orderBy(desc(leads.createdAt))
    .all();
  const contactRows = (await db
    .select()
    .from(crmContacts)
    .where(eq(crmContacts.workspaceId, workspaceId))
    .orderBy(desc(crmContacts.lastSyncedAt))
    .all())
    .filter((c) => !c.leadId);

  const people: Person[] = [];
  for (const l of leadRows) {
    people.push({
      type: "lead",
      id: l.id,
      name: l.name,
      email: l.email,
      company: l.company,
      role: l.role,
      xHandle: l.xHandle || undefined,
    });
  }
  for (const c of contactRows) {
    people.push({ type: "contact", id: c.id, name: c.name, email: c.email, company: c.company, role: c.role });
  }
  return people;
}

// ---------------------------------------------------------------------------
// Audiences
// ---------------------------------------------------------------------------

function parseRules(row: AudienceRow): SegmentRuleGroup | null {
  return row.rulesJson ? (JSON.parse(row.rulesJson) as SegmentRuleGroup) : null;
}

async function rowToAudience(db: Db, row: AudienceRow): Promise<Audience> {
  const rules = parseRules(row);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    kind: row.kind as AudienceKind,
    rules,
    memberCount: await countMembers(db, row.workspaceId, row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getAudienceRow(db: Db, workspaceId: string, audienceId: string): Promise<AudienceRow | undefined> {
  return await db
    .select()
    .from(audiences)
    .where(and(eq(audiences.workspaceId, workspaceId), eq(audiences.id, audienceId)))
    .get();
}

export async function createAudience(db: Db, workspaceId: string, input: UpsertAudienceInput): Promise<Audience> {
  const now = Date.now();
  const row: AudienceRow = {
    id: randomUUID(),
    workspaceId,
    name: input.name,
    description: input.description,
    kind: input.kind,
    rulesJson: input.rules ? JSON.stringify(input.rules) : null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(audiences).values(row).run();
  return await rowToAudience(db, row);
}

export async function listAudiences(db: Db, workspaceId: string): Promise<Audience[]> {
  return await Promise.all((await await db
      .select()
      .from(audiences)
      .where(eq(audiences.workspaceId, workspaceId))
      .orderBy(desc(audiences.createdAt))
      .all())
      .map(async (row) => await rowToAudience(db, row)));
}

export async function getAudience(db: Db, workspaceId: string, audienceId: string): Promise<Audience | undefined> {
  const row = await getAudienceRow(db, workspaceId, audienceId);
  return row ? await rowToAudience(db, row) : undefined;
}

export interface AudienceDetail {
  audience: Audience;
  members: AudienceMember[];
}

export async function getAudienceDetail(
  db: Db,
  workspaceId: string,
  audienceId: string,
): Promise<AudienceDetail | undefined> {
  const row = await getAudienceRow(db, workspaceId, audienceId);
  if (!row) return undefined;
  return { audience: await rowToAudience(db, row), members: await resolveAudienceMembers(db, workspaceId, row) };
}

export async function updateAudience(
  db: Db,
  workspaceId: string,
  audienceId: string,
  input: UpsertAudienceInput,
): Promise<Audience | undefined> {
  const existing = await getAudienceRow(db, workspaceId, audienceId);
  if (!existing) return undefined;
  await db.update(audiences)
    .set({
      name: input.name,
      description: input.description,
      kind: input.kind,
      rulesJson: input.rules ? JSON.stringify(input.rules) : null,
      updatedAt: Date.now(),
    })
    .where(eq(audiences.id, audienceId))
    .run();
  return await getAudience(db, workspaceId, audienceId);
}

export async function deleteAudience(db: Db, workspaceId: string, audienceId: string): Promise<boolean> {
  if (!await getAudienceRow(db, workspaceId, audienceId)) return false;
  await db.delete(audiences).where(eq(audiences.id, audienceId)).run();
  return true;
}

// ---------------------------------------------------------------------------
// Member resolution
// ---------------------------------------------------------------------------

/**
 * The live members of an audience drawn from the current people pool. Static:
 * the hand-picked rows, dangling members dropped. Dynamic: the pool filtered by
 * the rule tree. addedAt is the membership timestamp for static, null otherwise.
 */
export async function resolveAudienceMembers(
  db: Db,
  workspaceId: string,
  audience: AudienceRow,
): Promise<AudienceMember[]> {
  const pool = await loadPeople(db, workspaceId);
  const byKey = new Map(pool.map((p) => [`${p.type}:${p.id}`, p]));

  if (audience.kind === "static") {
    const rows = await db
      .select()
      .from(audienceMembers)
      .where(eq(audienceMembers.audienceId, audience.id))
      .orderBy(asc(audienceMembers.addedAt))
      .all();
    const members: AudienceMember[] = [];
    for (const row of rows) {
      const person = byKey.get(`${row.memberType}:${row.memberId}`);
      if (person) members.push({ ...person, addedAt: row.addedAt });
    }
    return members;
  }

  const rules = parseRules(audience);
  if (!rules) return [];
  return pool.filter((p) => evaluateSegment(p, rules)).map((p) => ({ ...p, addedAt: null }));
}

async function countMembers(db: Db, workspaceId: string, audience: AudienceRow): Promise<number> {
  return (await resolveAudienceMembers(db, workspaceId, audience)).length;
}

// ---------------------------------------------------------------------------
// Static-list membership
// ---------------------------------------------------------------------------

export type AddMembersResult =
  | { ok: true; added: number }
  | { ok: false; error: "not_a_static_list" | "member_not_found"; detail?: string };

export async function addAudienceMembers(
  db: Db,
  workspaceId: string,
  audienceId: string,
  refs: AudienceMemberRef[],
): Promise<AddMembersResult> {
  const audience = await getAudienceRow(db, workspaceId, audienceId);
  if (!audience) return { ok: false, error: "member_not_found", detail: "audience" };
  if (audience.kind !== "static") return { ok: false, error: "not_a_static_list" };

  const pool = new Set((await loadPeople(db, workspaceId)).map((p) => `${p.type}:${p.id}`));
  for (const ref of refs) {
    if (!pool.has(`${ref.type}:${ref.id}`)) {
      return { ok: false, error: "member_not_found", detail: ref.id };
    }
  }

  const existing = new Set(
    (await db
      .select()
      .from(audienceMembers)
      .where(eq(audienceMembers.audienceId, audienceId))
      .all())
      .map((r) => `${r.memberType}:${r.memberId}`),
  );

  const now = Date.now();
  let added = 0;
  for (const ref of refs) {
    if (existing.has(`${ref.type}:${ref.id}`)) continue;
    await db.insert(audienceMembers)
      .values({
        id: randomUUID(),
        workspaceId,
        audienceId,
        memberType: ref.type,
        memberId: ref.id,
        addedAt: now,
      })
      .run();
    existing.add(`${ref.type}:${ref.id}`);
    added++;
  }
  await db.update(audiences).set({ updatedAt: now }).where(eq(audiences.id, audienceId)).run();
  return { ok: true, added };
}

export async function removeAudienceMember(
  db: Db,
  workspaceId: string,
  audienceId: string,
  memberType: string,
  memberId: string,
): Promise<boolean> {
  const audience = await getAudienceRow(db, workspaceId, audienceId);
  if (!audience) return false;
  const result = await db
    .delete(audienceMembers)
    .where(
      and(
        eq(audienceMembers.audienceId, audienceId),
        eq(audienceMembers.memberType, memberType),
        eq(audienceMembers.memberId, memberId),
      ),
    )
    .run();
  if (result.changes > 0) {
    await db.update(audiences).set({ updatedAt: Date.now() }).where(eq(audiences.id, audienceId)).run();
  }
  return result.changes > 0;
}

/** Drop a lead from every static list it sits in — called when a lead is deleted. */
export async function removeLeadFromAudiences(db: Db, workspaceId: string, leadId: string): Promise<void> {
  await db.delete(audienceMembers)
    .where(
      and(
        eq(audienceMembers.workspaceId, workspaceId),
        eq(audienceMembers.memberType, "lead"),
        eq(audienceMembers.memberId, leadId),
      ),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Campaign ↔ audience attachment
// ---------------------------------------------------------------------------

export async function listCampaignAudiences(
  db: Db,
  workspaceId: string,
  campaignId: string,
): Promise<CampaignAudience[]> {
  const rows = await db
    .select({ audienceId: campaignAudiences.audienceId })
    .from(campaignAudiences)
    .where(
      and(eq(campaignAudiences.workspaceId, workspaceId), eq(campaignAudiences.campaignId, campaignId)),
    )
    .orderBy(asc(campaignAudiences.createdAt))
    .all();

  const result: CampaignAudience[] = [];
  for (const { audienceId } of rows) {
    const row = await getAudienceRow(db, workspaceId, audienceId);
    if (!row) continue;
    result.push({
      id: row.id,
      name: row.name,
      kind: row.kind as AudienceKind,
      memberCount: await countMembers(db, workspaceId, row),
    });
  }
  return result;
}

export type AttachResult = { ok: true } | { ok: false; error: "audience_not_found" };

export async function attachAudience(
  db: Db,
  workspaceId: string,
  campaignId: string,
  audienceId: string,
): Promise<AttachResult> {
  if (!await getAudienceRow(db, workspaceId, audienceId)) return { ok: false, error: "audience_not_found" };
  const already = await db
    .select()
    .from(campaignAudiences)
    .where(
      and(
        eq(campaignAudiences.campaignId, campaignId),
        eq(campaignAudiences.audienceId, audienceId),
      ),
    )
    .get();
  if (!already) {
    await db.insert(campaignAudiences)
      .values({
        id: randomUUID(),
        workspaceId,
        campaignId,
        audienceId,
        createdAt: Date.now(),
      })
      .run();
  }
  return { ok: true };
}

export async function detachAudience(
  db: Db,
  workspaceId: string,
  campaignId: string,
  audienceId: string,
): Promise<boolean> {
  const result = await db
    .delete(campaignAudiences)
    .where(
      and(
        eq(campaignAudiences.workspaceId, workspaceId),
        eq(campaignAudiences.campaignId, campaignId),
        eq(campaignAudiences.audienceId, audienceId),
      ),
    )
    .run();
  return result.changes > 0;
}
