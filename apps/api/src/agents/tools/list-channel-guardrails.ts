import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { getSocialAutomationSettings } from "../../services/automation-settings";
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
    "The rules in effect per channel: workspace voice/content guidance (with any persona- or campaign-scoped overrides) plus hard automation limits — kill switch, daily posting caps, auto-reply state. Optionally filter to one channel.",
  input,
  access: "read",
  async run(ctx, { channel }) {
    const guidance = listChannelGuidance(ctx.db, ctx.workspaceId)
      .filter((g) => !channel || g.channel === channel)
      .map((g) => ({
        channel: g.channel,
        source: g.source,
        content: compactText(g.content, GUIDANCE_CHARS),
        updatedAt: g.updatedAt,
      }));
    const scopedOverrides = listScopedGuidance(ctx.db, ctx.workspaceId)
      .filter((o) => !channel || o.channel === channel)
      .map((o) => ({
        channel: o.channel,
        personaName: o.personaName ?? null,
        campaignName: o.campaignName ?? null,
        content: compactText(o.content, OVERRIDE_CHARS),
      }));
    const settings = getSocialAutomationSettings(ctx.db, ctx.workspaceId);
    const compliance = getCompliance(ctx.db, ctx.workspaceId);
    return {
      guidance,
      scopedOverrides,
      precedence:
        "Most specific wins and replaces (never stacks): persona+campaign > persona > campaign > workspace override > built-in default.",
      limits: {
        killSwitch: settings.killSwitch,
        perConnectionDailyCap: settings.perConnectionDailyCap,
        perCampaignDailyCap: settings.perCampaignDailyCap,
        autoReplyEnabled: settings.autoReplyEnabled,
        postalAddressSet: compliance.postalAddress.trim().length > 0,
      },
    };
  },
};
