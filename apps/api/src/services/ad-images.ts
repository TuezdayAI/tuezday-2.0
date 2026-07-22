import { AD_IMAGE_SLIDE_SHAPE, type Draft } from "@tuezday/contracts";
import { estimateTokens, type ContextSection, type ResolvedContext } from "@tuezday/brain";
import type { Db } from "../db";
import type { DesignProvider } from "../design/provider";
import type { AssetStorage } from "../design/storage";
import type { RenderInput } from "../design/render";
import { getOrAuthorTemplate } from "../design/templates";
import { creativeFieldsFrom } from "./ad-launches";
import { resolveDesignSystem } from "./design-systems";
import { getDraft, setDraftMedia, type DraftActor } from "./drafts";
import { assertWithinLimit, getUsage } from "./entitlements";
import { storeGeneration } from "./generations";

// Ad image generation (Sprint 41 Part 5): approved meta_ad_creative copy ->
// resolved design system -> cached ad template -> deterministic 1080x1080
// render -> hosted PNG on the SAME draft's media. Identical cost model and
// metering to the carousel pipeline; the launch chain later uploads the image
// to Meta and attaches its hash to the creative.

export class AdImageSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdImageSourceError";
  }
}

export interface AdImageDeps {
  db: Db;
  design: DesignProvider;
  assetStorage: AssetStorage;
  render: (input: RenderInput) => Promise<Uint8Array>;
}

const AD_BRIEF =
  "A 1080x1080 static Meta ad image template as template.html + template.css. " +
  "Follow the design system exactly (semantic color roles, typography, spacing). " +
  "Leave {{title}} (the headline, dominant type) and {{body}} (primary text, secondary) placeholder tokens in place — " +
  "never fill them with sample copy. Keep text coverage visually under ~20% of the canvas and the layout uncluttered. " +
  "Include the logo/brand mark if the design system defines one.";

/**
 * Render the branded static image for an approved ad-copy draft and attach it
 * as the draft's media. Metered as one plan generation, only after the upload
 * succeeded — a failure writes nothing anywhere.
 */
export async function generateAdImage(
  deps: AdImageDeps,
  { workspaceId, draftId, actor }: { workspaceId: string; draftId: string; actor: DraftActor },
): Promise<Draft> {
  const { db } = deps;
  const started = Date.now();

  assertWithinLimit(db, workspaceId, "monthlyGenerations", getUsage(db, workspaceId).monthlyGenerations);

  const draft = getDraft(db, workspaceId, draftId);
  if (!draft) throw new AdImageSourceError("draft_not_found");
  if (draft.taskType !== "meta_ad_creative") {
    throw new AdImageSourceError("Only a meta_ad_creative draft can get an ad image.");
  }
  if (draft.state !== "approved") {
    throw new AdImageSourceError("Only an approved ad creative can get an ad image.");
  }
  const fields = creativeFieldsFrom(draft.content);
  if (!fields) {
    throw new AdImageSourceError("The ad creative no longer parses into headline/primary text.");
  }

  // Spec says channel "meta_ads"; the contracts channel vocabulary has "ads"
  // (import, never redeclare) — so the ads channel scopes design overlays here.
  const resolved = resolveDesignSystem(db, workspaceId, {
    channel: "ads",
    personaId: draft.personaId,
    campaignId: draft.campaignId,
  });

  const template = await getOrAuthorTemplate(db, deps.design, {
    workspaceId,
    designSystemId: resolved.trace.designSystemId,
    skillId: "social-carousel",
    slideShape: AD_IMAGE_SLIDE_SHAPE,
    resolvedDesignMarkdown: resolved.content,
    brief: AD_BRIEF,
  });

  const png = await deps.render({
    template: {
      html: template.html,
      css: template.css,
      placeholders: JSON.parse(template.placeholders) as string[],
    },
    values: {
      title: fields.headline,
      body: fields.primaryText,
      page: "1/1", // ignored unless the template declares it
    },
    width: 1080,
    height: 1080,
  });
  const { url } = await deps.assetStorage.put(png, "image/png");

  const designSection: ContextSection = {
    key: "design:resolution",
    layer: "org",
    title: `Design system (${resolved.trace.source})`,
    content: resolved.content,
    included: true,
    reason: `resolveDesignSystem picked "${resolved.trace.source}" for channel ads`,
    tokens: estimateTokens(resolved.content),
  };
  const resolvedContext: ResolvedContext = {
    sections: [designSection],
    includedTokens: designSection.tokens,
    tokenBudget: 0,
    overBudget: false,
    prompt: `Deterministic ad-image render (${AD_IMAGE_SLIDE_SHAPE}) for creative draft ${draftId}. No LLM call on this path.`,
    resolveMode: "draft",
  };
  storeGeneration(db, {
    workspaceId,
    taskType: "meta_ad_creative",
    channel: "ads",
    personaId: draft.personaId,
    campaignId: draft.campaignId,
    resolved: resolvedContext,
    output: `Ad image rendered for: ${fields.headline}\n${url}`,
    model: "deterministic-render",
    provider: "design-pipeline",
    durationMs: Date.now() - started,
  });

  const updated = setDraftMedia(db, workspaceId, draftId, [{ url, type: "image" }]);
  void actor; // media attach is not a state transition; nothing to log yet
  return updated!;
}
