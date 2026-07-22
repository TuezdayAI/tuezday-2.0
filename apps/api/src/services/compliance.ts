import { eq } from "drizzle-orm";
import type { UpdateComplianceInput, WorkspaceCompliance } from "@tuezday/contracts";
import type { Db } from "../db";
import { workspaceCompliance } from "../db/schema";

/**
 * A workspace's CAN-SPAM postal address (Sprint 49). Required before an
 * outreach sequence can activate, and appended to every send's footer.
 */
export function getCompliance(db: Db, workspaceId: string): WorkspaceCompliance {
  const row = db
    .select()
    .from(workspaceCompliance)
    .where(eq(workspaceCompliance.workspaceId, workspaceId))
    .get();
  if (row) return row;
  const now = Date.now();
  return { workspaceId, postalAddress: "", createdAt: now, updatedAt: now };
}

/** The postal address, or empty string when unset — the send-time footer source. */
export function getPostalAddress(db: Db, workspaceId: string): string {
  return getCompliance(db, workspaceId).postalAddress;
}

export function updateCompliance(
  db: Db,
  workspaceId: string,
  input: UpdateComplianceInput,
): WorkspaceCompliance {
  const now = Date.now();
  db.insert(workspaceCompliance)
    .values({ workspaceId, postalAddress: input.postalAddress, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: workspaceCompliance.workspaceId,
      set: { postalAddress: input.postalAddress, updatedAt: now },
    })
    .run();
  return getCompliance(db, workspaceId);
}
