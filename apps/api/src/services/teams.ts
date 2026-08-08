import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { User, WorkspaceInvite, WorkspaceMember, WorkspaceRole } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
  type WorkspaceInviteRow,
} from "../db/schema";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function membershipRole(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | undefined> {
  const row = (await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))))[0];
  return row?.role as WorkspaceRole | undefined;
}

export async function addMember(db: Db, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  await db.insert(workspaceMembers)
    .values({ id: randomUUID(), workspaceId, userId, role, createdAt: Date.now() });
}

/**
 * Legacy migration path: a workspace created before auth existed has no
 * members. The first authenticated user to touch it becomes its owner.
 * Returns true if the claim happened.
 */
export async function claimIfMemberless(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  const anyMember = (await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId)))[0];
  if (anyMember) return false;
  await addMember(db, workspaceId, userId, "owner");
  return true;
}

export async function listMembers(db: Db, workspaceId: string): Promise<WorkspaceMember[]> {
  return (await db
    .select({
      userId: workspaceMembers.userId,
      workspaceId: workspaceMembers.workspaceId,
      email: users.email,
      name: users.name,
      role: workspaceMembers.role,
      createdAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt)))
    .map((row) => ({ ...row, role: row.role as WorkspaceRole }));
}

export interface UserMembership {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
}

export async function listUserMemberships(db: Db, userId: string): Promise<UserMembership[]> {
  return (await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      workspaceName: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt)))
    .map((row) => ({ ...row, role: row.role as WorkspaceRole }));
}

export type RemoveMemberResult = "removed" | "not_found" | "last_owner";

export async function removeMember(db: Db, workspaceId: string, userId: string): Promise<RemoveMemberResult> {
  const role = await membershipRole(db, workspaceId, userId);
  if (!role) return "not_found";
  if (role === "owner") {
    const owners = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")));
    if (owners.length <= 1) return "last_owner";
  }
  await db.delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return "removed";
}

function rowToInvite(row: WorkspaceInviteRow): WorkspaceInvite {
  return {
    ...row,
    role: row.role as WorkspaceRole,
    status: row.status as WorkspaceInvite["status"],
  };
}

export class AlreadyMemberError extends Error {
  constructor() {
    super("That email already belongs to a member of this workspace.");
    this.name = "AlreadyMemberError";
  }
}

export class AlreadyInvitedError extends Error {
  constructor() {
    super("A pending invite for that email already exists.");
    this.name = "AlreadyInvitedError";
  }
}

export async function createInvite(
  db: Db,
  workspaceId: string,
  email: string,
  invitedBy: string,
): Promise<WorkspaceInvite> {
  const normalized = email.toLowerCase();
  const existingUser = (await db.select().from(users).where(eq(users.email, normalized)))[0];
  if (existingUser && await membershipRole(db, workspaceId, existingUser.id)) {
    throw new AlreadyMemberError();
  }
  const pending = (await db
    .select({ id: workspaceInvites.id, expiresAt: workspaceInvites.expiresAt })
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, workspaceId),
        eq(workspaceInvites.email, normalized),
        eq(workspaceInvites.status, "pending"),
      ),
    ))[0];
  if (pending && pending.expiresAt > Date.now()) throw new AlreadyInvitedError();

  const now = Date.now();
  const row: WorkspaceInviteRow = {
    id: randomUUID(),
    workspaceId,
    email: normalized,
    role: "member",
    token: randomBytes(24).toString("hex"),
    status: "pending",
    invitedBy,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    acceptedAt: null,
  };
  await db.insert(workspaceInvites).values(row);
  return rowToInvite(row);
}

export async function listPendingInvites(db: Db, workspaceId: string): Promise<WorkspaceInvite[]> {
  return (await db
    .select()
    .from(workspaceInvites)
    .where(
      and(eq(workspaceInvites.workspaceId, workspaceId), eq(workspaceInvites.status, "pending")),
    )
    .orderBy(asc(workspaceInvites.createdAt)))
    .map(rowToInvite);
}

export async function revokeInvite(db: Db, workspaceId: string, inviteId: string): Promise<boolean> {
  const row = (await db
    .select()
    .from(workspaceInvites)
    .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, workspaceId))))[0];
  if (!row || row.status !== "pending") return false;
  await db.update(workspaceInvites)
    .set({ status: "revoked" })
    .where(eq(workspaceInvites.id, inviteId));
  return true;
}

export async function getInviteByToken(db: Db, token: string): Promise<WorkspaceInvite | undefined> {
  const row = (await db.select().from(workspaceInvites).where(eq(workspaceInvites.token, token)))[0];
  return row ? rowToInvite(row) : undefined;
}

export type AcceptInviteResult =
  | { ok: true; workspaceId: string; role: WorkspaceRole }
  | { ok: false; error: "not_found" | "email_mismatch" | "gone" };

export async function acceptInvite(db: Db, token: string, user: User): Promise<AcceptInviteResult> {
  const invite = await getInviteByToken(db, token);
  if (!invite) return { ok: false, error: "not_found" };
  if (invite.status !== "pending" || invite.expiresAt <= Date.now()) {
    return { ok: false, error: "gone" };
  }
  if (invite.email !== user.email.toLowerCase()) return { ok: false, error: "email_mismatch" };

  if (!await membershipRole(db, invite.workspaceId, user.id)) {
    await addMember(db, invite.workspaceId, user.id, invite.role);
  }
  await db.update(workspaceInvites)
    .set({ status: "accepted", acceptedAt: Date.now() })
    .where(eq(workspaceInvites.id, invite.id));
  return { ok: true, workspaceId: invite.workspaceId, role: invite.role };
}
