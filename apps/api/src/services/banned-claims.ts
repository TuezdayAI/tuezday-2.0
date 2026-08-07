import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { BannedClaim, BannedClaimInput } from "@tuezday/contracts";
import type { Db } from "../db";
import { workspaceBannedClaims } from "../db/schema";

/**
 * D-67.5 — the workspace's machine-checkable "never say this" list.
 *
 * Deliberately a leaf (contracts + drizzle only): `list_channel_guardrails`
 * reads it, and that tool is loaded while the agent registry is still building
 * its TOOLS_BY_NAME map. Anything this module imported would be pulled into
 * that half-initialized graph — the Sprint 65 cycle, again.
 */
export async function listBannedClaims(db: Db, workspaceId: string): Promise<BannedClaim[]> {
  return await db
    .select()
    .from(workspaceBannedClaims)
    .where(eq(workspaceBannedClaims.workspaceId, workspaceId))
    .orderBy(asc(workspaceBannedClaims.createdAt))
    .all();
}

/** Adding a phrase that already exists is a no-op returning the existing row. */
export async function addBannedClaim(
  db: Db,
  workspaceId: string,
  input: BannedClaimInput,
): Promise<BannedClaim> {
  const existing = await db
    .select()
    .from(workspaceBannedClaims)
    .where(
      and(
        eq(workspaceBannedClaims.workspaceId, workspaceId),
        eq(workspaceBannedClaims.phrase, input.phrase),
      ),
    )
    .get();
  if (existing) return existing;
  const row: BannedClaim = {
    id: randomUUID(),
    workspaceId,
    phrase: input.phrase,
    note: input.note,
    createdAt: Date.now(),
  };
  await db.insert(workspaceBannedClaims).values(row).run();
  return row;
}

/** True when a row was removed — the route turns a false into a 404. */
export async function removeBannedClaim(db: Db, workspaceId: string, claimId: string): Promise<boolean> {
  const result = await db
    .delete(workspaceBannedClaims)
    .where(
      and(
        eq(workspaceBannedClaims.workspaceId, workspaceId),
        eq(workspaceBannedClaims.id, claimId),
      ),
    )
    .run();
  return result.changes > 0;
}
