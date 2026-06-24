import { eq } from "drizzle-orm";
import {
  DEFAULT_ANGLE_COUNT,
  DEFAULT_REVIEW_FLAG_THRESHOLD,
  type GenerationSettings,
  type UpdateGenerationSettingsInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { generationSettings } from "../db/schema";

/**
 * Per-workspace generation-quality settings. Like ad_settings, a missing row
 * means "use the defaults" — review ON, angle step OFF (founder decision,
 * 2026-06-17). Booleans map to/from the 0/1 integer columns.
 */
export function getGenerationSettings(db: Db, workspaceId: string): GenerationSettings {
  const row = db
    .select()
    .from(generationSettings)
    .where(eq(generationSettings.workspaceId, workspaceId))
    .get();
  return row
    ? {
        workspaceId,
        reviewEnabled: row.reviewEnabled === 1,
        angleEnabled: row.angleEnabled === 1,
        angleCount: row.angleCount,
        flagThreshold: row.flagThreshold,
        updatedAt: row.updatedAt,
      }
    : {
        workspaceId,
        reviewEnabled: true,
        angleEnabled: false,
        angleCount: DEFAULT_ANGLE_COUNT,
        flagThreshold: DEFAULT_REVIEW_FLAG_THRESHOLD,
        updatedAt: 0,
      };
}

export function updateGenerationSettings(
  db: Db,
  workspaceId: string,
  patch: UpdateGenerationSettingsInput,
): GenerationSettings {
  const current = getGenerationSettings(db, workspaceId);
  const next: GenerationSettings = {
    workspaceId,
    reviewEnabled: patch.reviewEnabled ?? current.reviewEnabled,
    angleEnabled: patch.angleEnabled ?? current.angleEnabled,
    angleCount: patch.angleCount ?? current.angleCount,
    flagThreshold: patch.flagThreshold ?? current.flagThreshold,
    updatedAt: Date.now(),
  };
  db.insert(generationSettings)
    .values({
      workspaceId,
      reviewEnabled: next.reviewEnabled ? 1 : 0,
      angleEnabled: next.angleEnabled ? 1 : 0,
      angleCount: next.angleCount,
      flagThreshold: next.flagThreshold,
      updatedAt: next.updatedAt,
    })
    .onConflictDoUpdate({
      target: generationSettings.workspaceId,
      set: {
        reviewEnabled: next.reviewEnabled ? 1 : 0,
        angleEnabled: next.angleEnabled ? 1 : 0,
        angleCount: next.angleCount,
        flagThreshold: next.flagThreshold,
        updatedAt: next.updatedAt,
      },
    })
    .run();
  return next;
}
