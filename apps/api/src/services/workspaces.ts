import { randomUUID } from "node:crypto";
import { desc, eq, inArray, notInArray, or } from "drizzle-orm";
import type { CreateWorkspaceInput, OnboardingCursor, Workspace } from "@tuezday/contracts";
import type { Db } from "../db";
import { workspaceMembers, workspaces } from "../db/schema";
import { ensureBrainDocs } from "./brain";
import { ensureDefaultDesignSystem } from "./design-systems";

/** DB stores the cursor as plain text; narrow it back to the contract enum. */
function rowToWorkspace<T extends { onboardingStep: string | null }>(
  row: T,
): Omit<T, "onboardingStep"> & { onboardingStep: OnboardingCursor | null } {
  return { ...row, onboardingStep: row.onboardingStep as OnboardingCursor | null };
}

export async function createWorkspace(
  db: Db,
  input: CreateWorkspaceInput,
  ownerId?: string | null,
): Promise<Workspace> {
  const now = Date.now();
  const row = {
    id: randomUUID(),
    name: input.name,
    websiteUrl: input.websiteUrl ?? null,
    onboardingStep: input.onboardingStep ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(workspaces).values(row).run();
  // Every workspace owns its five brain docs from the moment it exists.
  await ensureBrainDocs(db, row.id);
  // ...and its org-level default design system (Sprint 41 Part 2).
  await ensureDefaultDesignSystem(db, row.id);
  if (ownerId) {
    await db.insert(workspaceMembers)
      .values({ id: randomUUID(), workspaceId: row.id, userId: ownerId, role: "owner", createdAt: now })
      .run();
  }
  return row;
}

export async function listWorkspaces(db: Db): Promise<Workspace[]> {
  return (await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      websiteUrl: workspaces.websiteUrl,
      onboardingStep: workspaces.onboardingStep,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .orderBy(desc(workspaces.createdAt))
    .all())
    .map(rowToWorkspace);
}

/**
 * Workspaces the user can see on the home page, newest first: ones they belong
 * to, plus legacy memberless workspaces created before auth existed. Surfacing
 * the legacy ones is what lets the founder reach (and silently claim, via
 * `claimIfMemberless`) dev data that predates the membership model.
 */
export async function listWorkspacesForUser(db: Db, userId: string): Promise<Workspace[]> {
  const memberOf = db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const everyMemberedWorkspace = db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers);
  return (await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      websiteUrl: workspaces.websiteUrl,
      onboardingStep: workspaces.onboardingStep,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(or(inArray(workspaces.id, memberOf), notInArray(workspaces.id, everyMemberedWorkspace)))
    .orderBy(desc(workspaces.createdAt))
    .all())
    .map(rowToWorkspace);
}

export async function getWorkspace(db: Db, id: string): Promise<Workspace | undefined> {
  const row = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      websiteUrl: workspaces.websiteUrl,
      onboardingStep: workspaces.onboardingStep,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .get();
  return row ? rowToWorkspace(row) : undefined;
}

export async function getAnalyticsOptOut(db: Db, workspaceId: string): Promise<boolean> {
  const row = await db
    .select({ analyticsOptOut: workspaces.analyticsOptOut })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get();
  return row?.analyticsOptOut ?? false;
}

export async function setAnalyticsOptOut(db: Db, workspaceId: string, optOut: boolean): Promise<void> {
  await db.update(workspaces)
    .set({ analyticsOptOut: optOut, updatedAt: Date.now() })
    .where(eq(workspaces.id, workspaceId))
    .run();
}

/** Move a workspace's onboarding cursor. Returns undefined if it doesn't exist. */
export async function advanceOnboarding(
  db: Db,
  id: string,
  step: OnboardingCursor,
): Promise<Workspace | undefined> {
  await db.update(workspaces)
    .set({ onboardingStep: step, updatedAt: Date.now() })
    .where(eq(workspaces.id, id))
    .run();
  return await getWorkspace(db, id);
}
