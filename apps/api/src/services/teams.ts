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

export function membershipRole(
  db: Db,
  workspaceId: string,
  userId: string,
): WorkspaceRole | undefined {
  const row = db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .get();
  return row?.role as WorkspaceRole | undefined;
}

export function addMember(db: Db, workspaceId: string, userId: string, role: WorkspaceRole): void {
  db.insert(workspaceMembers)
    .values({ id: randomUUID(), workspaceId, userId, role, createdAt: Date.now() })
    .run();
}

/**
 * Legacy migration path: a workspace created before auth existed has no
 * members. The first authenticated user to touch it becomes its owner.
 * Returns true if the claim happened.
 */
export function claimIfMemberless(db: Db, workspaceId: string, userId: string): boolean {
  const anyMember = db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .get();
  if (anyMember) return false;
  addMember(db, workspaceId, userId, "owner");
  return true;
}

export function listMembers(db: Db, workspaceId: string): WorkspaceMember[] {
  return db
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
    .orderBy(asc(workspaceMembers.createdAt))
    .all()
    .map((row) => ({ ...row, role: row.role as WorkspaceRole }));
}

export interface UserMembership {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
}

export function listUserMemberships(db: Db, userId: string): UserMembership[] {
  return db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      workspaceName: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt))
    .all()
    .map((row) => ({ ...row, role: row.role as WorkspaceRole }));
}

export type RemoveMemberResult = "removed" | "not_found" | "last_owner";

export function removeMember(db: Db, workspaceId: string, userId: string): RemoveMemberResult {
  const role = membershipRole(db, workspaceId, userId);
  if (!role) return "not_found";
  if (role === "owner") {
    const owners = db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")))
      .all();
    if (owners.length <= 1) return "last_owner";
  }
  db.delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .run();
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

export function createInvite(
  db: Db,
  workspaceId: string,
  email: string,
  invitedBy: string,
): WorkspaceInvite {
  const normalized = email.toLowerCase();
  const existingUser = db.select().from(users).where(eq(users.email, normalized)).get();
  if (existingUser && membershipRole(db, workspaceId, existingUser.id)) {
    throw new AlreadyMemberError();
  }
  const pending = db
    .select({ id: workspaceInvites.id, expiresAt: workspaceInvites.expiresAt })
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, workspaceId),
        eq(workspaceInvites.email, normalized),
        eq(workspaceInvites.status, "pending"),
      ),
    )
    .get();
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
  db.insert(workspaceInvites).values(row).run();
  return rowToInvite(row);
}

export function listPendingInvites(db: Db, workspaceId: string): WorkspaceInvite[] {
  return db
    .select()
    .from(workspaceInvites)
    .where(
      and(eq(workspaceInvites.workspaceId, workspaceId), eq(workspaceInvites.status, "pending")),
    )
    .orderBy(asc(workspaceInvites.createdAt))
    .all()
    .map(rowToInvite);
}

export function revokeInvite(db: Db, workspaceId: string, inviteId: string): boolean {
  const row = db
    .select()
    .from(workspaceInvites)
    .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, workspaceId)))
    .get();
  if (!row || row.status !== "pending") return false;
  db.update(workspaceInvites)
    .set({ status: "revoked" })
    .where(eq(workspaceInvites.id, inviteId))
    .run();
  return true;
}

export function getInviteByToken(db: Db, token: string): WorkspaceInvite | undefined {
  const row = db.select().from(workspaceInvites).where(eq(workspaceInvites.token, token)).get();
  return row ? rowToInvite(row) : undefined;
}

export type AcceptInviteResult =
  | { ok: true; workspaceId: string; role: WorkspaceRole }
  | { ok: false; error: "not_found" | "email_mismatch" | "gone" };

export function acceptInvite(db: Db, token: string, user: User): AcceptInviteResult {
  const invite = getInviteByToken(db, token);
  if (!invite) return { ok: false, error: "not_found" };
  if (invite.status !== "pending" || invite.expiresAt <= Date.now()) {
    return { ok: false, error: "gone" };
  }
  if (invite.email !== user.email.toLowerCase()) return { ok: false, error: "email_mismatch" };

  if (!membershipRole(db, invite.workspaceId, user.id)) {
    addMember(db, invite.workspaceId, user.id, invite.role);
  }
  db.update(workspaceInvites)
    .set({ status: "accepted", acceptedAt: Date.now() })
    .where(eq(workspaceInvites.id, invite.id))
    .run();
  return { ok: true, workspaceId: invite.workspaceId, role: invite.role };
}
