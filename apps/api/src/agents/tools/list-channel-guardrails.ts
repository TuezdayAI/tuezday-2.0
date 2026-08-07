import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { getSocialAutomationSettings } from "../../services/automation-settings";
import { listBannedClaims } from "../../services/banned-claims";
import { getCompliance } from "../../services/compliance";
import { listChannelGuidance, listScopedGuidance } from "../../services/guidance";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.list_channel_guardrails;
type Input = z.infer<typeof input>;

const GUIDANCE_CHARS = 800;
const OVERRIDE_CHARS = 400;

/**
 * "What are the rules?" — per-channel voice guidance (defaults included,
 * scoped overrides noted with their precedence) PLUS the hard automation
 * limits: kill switch, daily caps, compliance. An agent asking about a
 * channel needs both.
 */
export const listChannelGuardrailsTool: Tool<Input, unknown> = {
  name: "list_channel_guardrails",
  description:
    "The rules in effect per channel: workspace voice/content guidance (with any persona- or campaign-scoped overrides), the workspace's banned claims (exact phrases that must never be published), and hard automation limits — kill switch, daily posting caps, auto-reply state. Optionally filter to one channel.",
  input,
  access: "read",
  async run(ctx, { channel }) {
    const guidance = (await listChannelGuidance(ctx.db, ctx.workspaceId))
      .filter((g) => !channel || g.channel === channel)
      .map((g) => ({
        channel: g.channel,
        source: g.source,
        content: compactText(g.content, GUIDANCE_CHARS),
        updatedAt: g.updatedAt,
      }));
    const scopedOverrides = (await listScopedGuidance(ctx.db, ctx.workspaceId))
      .filter((o) => !channel || o.channel === channel)
      .map((o) => ({
        channel: o.channel,
        personaName: o.personaName ?? null,
        campaignName: o.campaignName ?? null,
        content: compactText(o.content, OVERRIDE_CHARS),
      }));
    const settings = await getSocialAutomationSettings(ctx.db, ctx.workspaceId);
    const compliance = await getCompliance(ctx.db, ctx.workspaceId);
    // Sprint 67 (D-67.5): the machine-checkable half of the rules. The eval
    // harness fails a draft on these, so a critic that reads them can cite the
    // exact phrase instead of paraphrasing prose guidance.
    const bannedClaims = (await listBannedClaims(ctx.db, ctx.workspaceId)).map((claim) => ({
      phrase: claim.phrase,
      note: claim.note,
    }));
    return {
      guidance,
      scopedOverrides,
      bannedClaims,
      precedence:
        "Most specific wins and replaces (never stacks): persona+campaign > persona > campaign > workspace override > built-in default.",
      limits: {
        killSwitch: settings.killSwitch,
        perConnectionDailyCap: settings.perConnectionDailyCap,
        perConnectionReplyDailyCap: settings.perConnectionReplyDailyCap,
        perCampaignDailyCap: settings.perCampaignDailyCap,
        autoReplyEnabled: settings.autoReplyEnabled,
        postalAddressSet: compliance.postalAddress.trim().length > 0,
      },
    };
  },
};
