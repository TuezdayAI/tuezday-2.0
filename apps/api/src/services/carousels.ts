import {
  SLIDE_WORD_BUDGETS,
  type Draft,
  type LaunchMedia,
  type SlideArchetype,
} from "@tuezday/contracts";
import { estimateTokens, type ContextSection, type ResolvedContext } from "@tuezday/brain";
import type { Db } from "../db";
import type { DesignProvider } from "../design/provider";
import type { AssetStorage } from "../design/storage";
import type { RenderInput } from "../design/render";
import { getOrAuthorTemplate } from "../design/templates";
import { resolveDesignSystem } from "./design-systems";
import { getDraft, submitDraft, type DraftActor } from "./drafts";
import { storeGeneration } from "./generations";
import { assertWithinLimit, getUsage } from "./entitlements";

// Carousel pipeline (Sprint 41 Part 4): approved content draft -> archetyped
// slide copy -> cached template per archetype -> deterministic render ->
// hosted PNGs -> a derived draft in the normal approval gate. Metered as one
// unit of the plan's included generations (umbrella Decision 10) — no user
// API key exists anywhere in this flow.

export class CarouselSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarouselSourceError";
  }
}

export interface CarouselSlide {
  archetype: SlideArchetype;
  title: string;
  body: string;
}

const MAX_MIDDLE_SLIDES = 8; // hook + 8 + cta = Instagram's 10-item ceiling

function clampWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function firstSentence(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const match = line.match(/^.*?[.!?](?:\s|$)/);
  return (match ? match[0] : line).trim().replace(/[.!?]+$/, "");
}

/**
 * Split approved content into 2-10 archetyped slides: hook -> body/list ->
 * CTA (the structure every carousel tool teaches; see the Sprint 41 competitor
 * scan). An explicit `---` line is an author override for slide breaks
 * (ContentDrips' escape hatch); otherwise paragraphs are merged into at most
 * MAX_MIDDLE_SLIDES bodies. Word budgets are enforced here, at write time —
 * deliberately no text-fitting at render.
 */
export function splitIntoSlides(content: string): CarouselSlide[] {
  const trimmed = content.trim();
  const explicit = /\n\s*---\s*\n/.test(trimmed);
  let chunks = (explicit ? trimmed.split(/\n\s*---\s*\n/) : trimmed.split(/\n\s*\n/))
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length === 0) chunks = [trimmed];

  // The first chunk feeds the hook; the rest become middles (merged if long).
  const [hookSource, ...rest] = chunks as [string, ...string[]];
  let middles = rest;
  if (!explicit && middles.length > MAX_MIDDLE_SLIDES) {
    const merged: string[] = [];
    const per = Math.ceil(middles.length / MAX_MIDDLE_SLIDES);
    for (let i = 0; i < middles.length; i += per) {
      merged.push(middles.slice(i, i + per).join("\n\n"));
    }
    middles = merged;
  }
  middles = middles.slice(0, MAX_MIDDLE_SLIDES);

  const slides: CarouselSlide[] = [];
  slides.push({
    archetype: "hook",
    title: clampWords(firstSentence(hookSource), SLIDE_WORD_BUDGETS.hook.title),
    body: clampWords(
      hookSource.split("\n").slice(1).join(" ").trim() || "Swipe →",
      SLIDE_WORD_BUDGETS.hook.body,
    ),
  });

  // Numbered list look when the deck has enough middles to read as a list.
  const middleArchetype: SlideArchetype = middles.length >= 3 ? "list_item" : "body";
  for (const chunk of middles) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = firstSentence(chunk);
    const body = lines.slice(1).join(" ").trim() || lines[0] || "";
    slides.push({
      archetype: middleArchetype,
      title: clampWords(title, SLIDE_WORD_BUDGETS[middleArchetype].title),
      body: clampWords(body, SLIDE_WORD_BUDGETS[middleArchetype].body),
    });
  }

  slides.push({
    archetype: "cta",
    title: clampWords("Found this useful?", SLIDE_WORD_BUDGETS.cta.title),
    body: clampWords("Save this post and follow for more.", SLIDE_WORD_BUDGETS.cta.body),
  });

  return slides; // hook + ≥0 middles + cta => always within Instagram's 2-10
}

/** Per-archetype authoring brief — hook/CTA conventions and cross-slide
 * furniture (counter, author strip) baked in per the competitor scan. */
function briefFor(archetype: SlideArchetype): string {
  const shared =
    "A 1080x1080 Instagram carousel slide template as template.html + template.css. " +
    "Follow the design system exactly (semantic color roles, typography, spacing). " +
    "Leave {{title}}, {{body}} and {{page}} placeholder tokens in place — never fill them with sample copy. " +
    "Include a small slide counter rendering {{page}} and, if the design system defines an author strip, render it small. ";
  const byArchetype: Record<SlideArchetype, string> = {
    hook: "This is the HOOK/cover slide: {{title}} is a 5-8 word headline, the largest type on the deck; {{body}} is a short kicker. Add a subtle swipe cue (arrow).",
    body: "This is a BODY slide: {{title}} as a heading, {{body}} as 15-30 words of supporting copy.",
    list_item: "This is a LIST-ITEM slide: a big index number derived from {{page}}, {{title}} as the item, {{body}} as one supporting idea.",
    stat: "This is a STAT slide: {{title}} is one oversized metric, {{body}} one line of context.",
    quote: "This is a QUOTE slide: {{title}} is the quotation in large type, {{body}} the attribution.",
    tldr: "This is a TL;DR recap slide: {{title}} says 'tl;dr'-style recap, {{body}} summarizes the deck.",
    cta: "This is the CTA/outro slide: {{title}} is the ask headline, {{body}} the save/follow ask. Strongest branding on the deck — logo and author strip prominent.",
  };
  return shared + byArchetype[archetype];
}

export interface CarouselDeps {
  db: Db;
  design: DesignProvider;
  assetStorage: AssetStorage;
  render: (input: RenderInput) => Promise<Uint8Array>;
}

export interface GenerateCarouselInput {
  workspaceId: string;
  draftId: string;
  actor: DraftActor;
}

/**
 * The founder-visible loop: approved draft in, derived carousel draft (copy +
 * rendered slide URLs) out, sitting in the approval gate. Throws before any
 * side effect on gate/source problems; the generation is metered only after
 * every slide rendered and uploaded (a failed render never burns a credit and
 * never creates a partial draft).
 */
export async function generateCarousel(
  deps: CarouselDeps,
  { workspaceId, draftId, actor }: GenerateCarouselInput,
): Promise<Draft> {
  const { db } = deps;
  const started = Date.now();

  // Entitlement gate (umbrella Decision 10) — the exact seam text generations use.
  assertWithinLimit(db, workspaceId, "monthlyGenerations", getUsage(db, workspaceId).monthlyGenerations);

  const source = getDraft(db, workspaceId, draftId);
  if (!source) throw new CarouselSourceError("draft_not_found");
  if (source.state !== "approved") {
    throw new CarouselSourceError("Only an approved draft can become a carousel.");
  }

  const slides = splitIntoSlides(source.content);

  const resolved = resolveDesignSystem(db, workspaceId, {
    channel: "instagram",
    personaId: source.personaId,
    campaignId: source.campaignId,
  });

  // One cached template per distinct archetype in this deck (authored only on
  // first use or brand change — Part 3's guarantee).
  const archetypes = [...new Set(slides.map((s) => s.archetype))];
  const templates = new Map<string, { html: string; css: string; placeholders: string[] }>();
  for (const archetype of archetypes) {
    const row = await getOrAuthorTemplate(db, deps.design, {
      workspaceId,
      designSystemId: resolved.trace.designSystemId,
      skillId: "social-carousel",
      slideShape: archetype,
      resolvedDesignMarkdown: resolved.content,
      brief: briefFor(archetype),
    });
    templates.set(archetype, {
      html: row.html,
      css: row.css,
      placeholders: JSON.parse(row.placeholders) as string[],
    });
  }

  // Render + upload every slide before touching the drafts table — any
  // failure aborts the whole request with no partial media anywhere.
  const media: LaunchMedia[] = [];
  for (const [index, slide] of slides.entries()) {
    const template = templates.get(slide.archetype)!;
    const png = await deps.render({
      template,
      values: {
        title: slide.title,
        body: slide.body,
        page: `${index + 1}/${slides.length}`,
      },
      width: 1080,
      height: 1080,
    });
    const { url } = await deps.assetStorage.put(png, "image/png");
    media.push({ url, type: "image" });
  }

  // What the reviewer reads, slide by slide.
  const slideCopy = slides
    .map((s, i) => `Slide ${i + 1}/${slides.length} [${s.archetype}]\n${s.title}\n${s.body}`)
    .join("\n\n");

  // Meter the successful run through the same generations ledger text
  // generations use, with an inspectable design trace instead of an LLM prompt.
  const designSection: ContextSection = {
    key: "design:resolution",
    layer: "org",
    title: `Design system (${resolved.trace.source})`,
    content: resolved.content,
    included: true,
    reason: `resolveDesignSystem picked "${resolved.trace.source}" for channel instagram`,
    tokens: estimateTokens(resolved.content),
  };
  const resolvedContext: ResolvedContext = {
    sections: [designSection],
    includedTokens: designSection.tokens,
    tokenBudget: 0,
    overBudget: false,
    prompt: `Deterministic carousel render for draft ${draftId}: ${slides.length} slides (${slides.map((s) => s.archetype).join(", ")}). No LLM call on this path.`,
    resolveMode: "draft",
  };
  const generation = storeGeneration(db, {
    workspaceId,
    taskType: "instagram_carousel",
    channel: "instagram",
    personaId: source.personaId,
    campaignId: source.campaignId,
    resolved: resolvedContext,
    output: slideCopy,
    model: "deterministic-render",
    provider: "design-pipeline",
    durationMs: Date.now() - started,
  });

  return submitDraft(
    db,
    {
      workspaceId,
      sourceGenerationId: generation.id,
      campaignId: source.campaignId,
      taskType: "instagram_carousel",
      channel: "instagram",
      personaId: source.personaId,
      content: slideCopy,
      media,
    },
    actor,
  );
}
