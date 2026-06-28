import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  Connection,
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

export type PersonaAccountRoutingError =
  | "persona_account_missing"
  | "persona_account_mismatch"
  | "persona_account_unavailable"
  | "persona_account_ambiguous"
  | "connection_not_found";

export type PersonaConnectionResolution =
  | { ok: true; connection: Connection; assignment: PersonaSocialAccount | null }
  | { ok: false; error: PersonaAccountRoutingError };

export function providerForSocialChannel(channel: string): string | null {
  if (channel === "linkedin") return "linkedin";
  if (channel === "instagram") return "instagram";
  if (channel === "x") return "twitter";
  if (channel === "reddit") return "reddit";
  return null;
}

export function resolvePersonaSocialConnection(
  db: Db,
  workspaceId: string,
  args: {
    personaId: string | null | undefined;
    providerKey?: string;
    channel: string;
    explicitConnectionId?: string;
  },
): PersonaConnectionResolution {
  const providerKey = args.providerKey ?? providerForSocialChannel(args.channel);
  if (!providerKey) return { ok: false, error: "persona_account_missing" };

  if (args.explicitConnectionId) {
    const connection = getConnection(db, workspaceId, args.explicitConnectionId);
    if (!connection) return { ok: false, error: "connection_not_found" };
    const provider = providerByKey(connection.providerKey);
    if (
      connection.status !== "connected" ||
      connection.providerKey !== providerKey ||
      !provider?.categories?.includes("social")
    ) {
      return { ok: false, error: "persona_account_unavailable" };
    }
    if (!args.personaId) return { ok: true, connection, assignment: null };
    const assignment = listPersonaSocialAccounts(db, workspaceId, args.personaId).find(
      (a) => a.connectionId === connection.id && a.providerKey === providerKey && a.channel === args.channel,
    );
    if (!assignment) return { ok: false, error: "persona_account_mismatch" };
    return { ok: true, connection, assignment };
  }

  if (!args.personaId) return { ok: false, error: "persona_account_missing" };
  const primaries = listPersonaSocialAccounts(db, workspaceId, args.personaId).filter(
    (a) => a.providerKey === providerKey && a.channel === args.channel && a.isPrimary,
  );
  if (primaries.length === 0) return { ok: false, error: "persona_account_missing" };
  if (primaries.length > 1) return { ok: false, error: "persona_account_ambiguous" };
  const connection = getConnection(db, workspaceId, primaries[0]!.connectionId);
  const provider = connection ? providerByKey(connection.providerKey) : undefined;
  if (
    !connection ||
    connection.status !== "connected" ||
    connection.providerKey !== providerKey ||
    !provider?.categories?.includes("social")
  ) {
    return { ok: false, error: "persona_account_unavailable" };
  }
  return { ok: true, connection, assignment: primaries[0]! };
}
