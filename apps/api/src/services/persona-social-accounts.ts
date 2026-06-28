import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  PersonaSocialAccount,
  SocialAccountChannel,
  UpsertPersonaSocialAccountInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { personaSocialAccounts, type PersonaSocialAccountRow } from "../db/schema";
import { getConnection, providerByKey } from "./connections";

function rowToAssignment(row: PersonaSocialAccountRow): PersonaSocialAccount {
  return {
    ...row,
    channel: row.channel as SocialAccountChannel,
    isPrimary: Boolean(row.isPrimary),
  };
}

export function listPersonaSocialAccounts(
  db: Db,
  workspaceId: string,
  personaId: string,
): PersonaSocialAccount[] {
  return db
    .select()
    .from(personaSocialAccounts)
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
      ),
    )
    .all()
    .map(rowToAssignment);
}

function demotePrimary(
  db: Db,
  workspaceId: string,
  personaId: string,
  providerKey: string,
  channel: string,
): void {
  db.update(personaSocialAccounts)
    .set({ isPrimary: false, updatedAt: Date.now() })
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
        eq(personaSocialAccounts.providerKey, providerKey),
        eq(personaSocialAccounts.channel, channel),
      ),
    )
    .run();
}

export type AssignmentResult =
  | { ok: true; assignment: PersonaSocialAccount }
  | { ok: false; error: "connection_not_found" | "not_social" };

export function createPersonaSocialAccount(
  db: Db,
  workspaceId: string,
  personaId: string,
  input: UpsertPersonaSocialAccountInput,
): AssignmentResult {
  const connection = getConnection(db, workspaceId, input.connectionId);
  if (!connection) return { ok: false, error: "connection_not_found" };
  const provider = providerByKey(connection.providerKey);
  if (!provider?.categories?.includes("social")) return { ok: false, error: "not_social" };
  if (input.isPrimary) {
    demotePrimary(db, workspaceId, personaId, connection.providerKey, input.channel);
  }
  const now = Date.now();
  const row: PersonaSocialAccountRow = {
    id: randomUUID(),
    workspaceId,
    personaId,
    connectionId: connection.id,
    providerKey: connection.providerKey,
    channel: input.channel,
    isPrimary: input.isPrimary,
    defaultTarget: input.defaultTarget,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(personaSocialAccounts).values(row).run();
  return { ok: true, assignment: rowToAssignment(row) };
}

export function updatePersonaSocialAccount(
  db: Db,
  workspaceId: string,
  personaId: string,
  assignmentId: string,
  input: UpsertPersonaSocialAccountInput,
): AssignmentResult | { ok: false; error: "assignment_not_found" } {
  const existing = db
    .select()
    .from(personaSocialAccounts)
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
        eq(personaSocialAccounts.id, assignmentId),
      ),
    )
    .get();
  if (!existing) return { ok: false, error: "assignment_not_found" };
  const connection = getConnection(db, workspaceId, input.connectionId);
  if (!connection) return { ok: false, error: "connection_not_found" };
  const provider = providerByKey(connection.providerKey);
  if (!provider?.categories?.includes("social")) return { ok: false, error: "not_social" };
  if (input.isPrimary) {
    demotePrimary(db, workspaceId, personaId, connection.providerKey, input.channel);
  }
  db.update(personaSocialAccounts)
    .set({
      connectionId: connection.id,
      providerKey: connection.providerKey,
      channel: input.channel,
      isPrimary: input.isPrimary,
      defaultTarget: input.defaultTarget,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
        eq(personaSocialAccounts.id, assignmentId),
      ),
    )
    .run();
  return {
    ok: true,
    assignment: listPersonaSocialAccounts(db, workspaceId, personaId).find((a) => a.id === assignmentId)!,
  };
}

export function deletePersonaSocialAccount(
  db: Db,
  workspaceId: string,
  personaId: string,
  assignmentId: string,
): boolean {
  const existing = db
    .select()
    .from(personaSocialAccounts)
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
        eq(personaSocialAccounts.id, assignmentId),
      ),
    )
    .get();
  if (!existing) return false;
  db.delete(personaSocialAccounts)
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
        eq(personaSocialAccounts.id, assignmentId),
      ),
    )
    .run();
  return true;
}
