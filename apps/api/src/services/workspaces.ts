import { randomUUID } from "node:crypto";
import { desc, eq, inArray, notInArray, or } from "drizzle-orm";
import type { CreateWorkspaceInput, Workspace } from "@tuezday/contracts";
import type { Db } from "../db";
import { workspaceMembers, workspaces } from "../db/schema";
import { ensureBrainDocs } from "./brain";

export function createWorkspace(
  db: Db,
  input: CreateWorkspaceInput,
  ownerId?: string | null,
): Workspace {
  const now = Date.now();
  const row = {
    id: randomUUID(),
    name: input.name,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workspaces).values(row).run();
  // Every workspace owns its five brain docs from the moment it exists.
  ensureBrainDocs(db, row.id);
  if (ownerId) {
    db.insert(workspaceMembers)
      .values({ id: randomUUID(), workspaceId: row.id, userId: ownerId, role: "owner", createdAt: now })
      .run();
  }
  return row;
}

export function listWorkspaces(db: Db): Workspace[] {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .orderBy(desc(workspaces.createdAt))
    .all();
}

/**
 * Workspaces the user can see on the home page, newest first: ones they belong
 * to, plus legacy memberless workspaces created before auth existed. Surfacing
 * the legacy ones is what lets the founder reach (and silently claim, via
 * `claimIfMemberless`) dev data that predates the membership model.
 */
export function listWorkspacesForUser(db: Db, userId: string): Workspace[] {
  const memberOf = db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const everyMemberedWorkspace = db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers);
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(or(inArray(workspaces.id, memberOf), notInArray(workspaces.id, everyMemberedWorkspace)))
    .orderBy(desc(workspaces.createdAt))
    .all();
}

export function getWorkspace(db: Db, id: string): Workspace | undefined {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .get();
}

export function getAnalyticsOptOut(db: Db, workspaceId: string): boolean {
  const row = db
    .select({ analyticsOptOut: workspaces.analyticsOptOut })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get();
  return row?.analyticsOptOut ?? false;
}

export function setAnalyticsOptOut(db: Db, workspaceId: string, optOut: boolean): void {
  db.update(workspaces)
    .set({ analyticsOptOut: optOut, updatedAt: Date.now() })
    .where(eq(workspaces.id, workspaceId))
    .run();
}
