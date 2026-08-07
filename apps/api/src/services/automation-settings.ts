// Per-workspace social automation settings (mirrors ad_settings). Extracted
// from automation.ts so leaf modules (e.g. the list_channel_guardrails agent
// tool) can read settings without pulling in the automation run loop — which
// since Sprint 65 imports the pipeline engine, and the engine imports the
// agent tool registry. Importing automation.ts from a tool would close that
// cycle and leave READ_TOOLS half-initialized.

import { eq } from "drizzle-orm";
import {
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_PER_CAMPAIGN_DAILY_CAP,
  DEFAULT_PER_CONNECTION_DAILY_CAP,
  DEFAULT_PER_CONNECTION_REPLY_DAILY_CAP,
  type SocialAutomationSettings,
  type UpdateSocialAutomationSettingsInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { socialAutomationSettings } from "../db/schema";

export async function getSocialAutomationSettings(db: Db, workspaceId: string): Promise<SocialAutomationSettings> {
  const row = await db
    .select()
    .from(socialAutomationSettings)
    .where(eq(socialAutomationSettings.workspaceId, workspaceId))
    .get();
  return row
    ? {
        workspaceId,
        killSwitch: row.killSwitch === 1,
        perConnectionDailyCap: row.perConnectionDailyCap,
        perConnectionReplyDailyCap: row.perConnectionReplyDailyCap,
        perCampaignDailyCap: row.perCampaignDailyCap,
        autoReplyEnabled: row.autoReplyEnabled === 1,
        matchThreshold: row.matchThreshold,
        generationPath: row.generationPath as SocialAutomationSettings["generationPath"],
        updatedAt: row.updatedAt,
      }
    : {
        workspaceId,
        killSwitch: false,
        perConnectionDailyCap: DEFAULT_PER_CONNECTION_DAILY_CAP,
        perConnectionReplyDailyCap: DEFAULT_PER_CONNECTION_REPLY_DAILY_CAP,
        perCampaignDailyCap: DEFAULT_PER_CAMPAIGN_DAILY_CAP,
        autoReplyEnabled: false,
        matchThreshold: DEFAULT_MATCH_THRESHOLD,
        generationPath: "legacy",
        updatedAt: 0,
      };
}

export async function updateSocialAutomationSettings(
  db: Db,
  workspaceId: string,
  patch: UpdateSocialAutomationSettingsInput,
): Promise<SocialAutomationSettings> {
  const current = await getSocialAutomationSettings(db, workspaceId);
  const next: SocialAutomationSettings = {
    workspaceId,
    killSwitch: patch.killSwitch ?? current.killSwitch,
    perConnectionDailyCap: patch.perConnectionDailyCap ?? current.perConnectionDailyCap,
    perConnectionReplyDailyCap:
      patch.perConnectionReplyDailyCap ?? current.perConnectionReplyDailyCap,
    perCampaignDailyCap: patch.perCampaignDailyCap ?? current.perCampaignDailyCap,
    autoReplyEnabled: patch.autoReplyEnabled ?? current.autoReplyEnabled,
    matchThreshold: patch.matchThreshold ?? current.matchThreshold,
    generationPath: patch.generationPath ?? current.generationPath,
    updatedAt: Date.now(),
  };
  const columns = {
    killSwitch: next.killSwitch ? 1 : 0,
    perConnectionDailyCap: next.perConnectionDailyCap,
    perConnectionReplyDailyCap: next.perConnectionReplyDailyCap,
    perCampaignDailyCap: next.perCampaignDailyCap,
    autoReplyEnabled: next.autoReplyEnabled ? 1 : 0,
    matchThreshold: next.matchThreshold,
    generationPath: next.generationPath,
    updatedAt: next.updatedAt,
  };
  await db.insert(socialAutomationSettings)
    .values({ workspaceId, ...columns })
    .onConflictDoUpdate({ target: socialAutomationSettings.workspaceId, set: columns })
    .run();
  return next;
}
