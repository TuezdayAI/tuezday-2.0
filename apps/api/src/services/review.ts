import { and, eq } from "drizzle-orm";
import {
  GENERATION_REVIEW_CHECKS,
  isReviewFlagged,
  reviewCheckResponseSchema,
  type BrainDocType,
  type Channel,
  type DocOutline,
  type GenerationReview,
  type GenerationReviewCheck,
  type ResolvedTaskDocMatrix,
  type ReviewCheckResult,
  type TaskType,
} from "@tuezday/contracts";
import {
  composeBrandVoiceReviewInstruction,
  composeChannelFitReviewInstruction,
  resolveContext,
  type BrainContents,
  type ResolveCampaign,
  type ResolveCampaignPlan,
  type ResolvePersona,
} from "@tuezday/brain";
import type { GuidanceSource } from "@tuezday/contracts";
import type { Db } from "../db";
import { drafts, generations } from "../db/schema";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { generateStructured, StructuredOutputError } from "../llm/structured";

/**
 * The brain context a reviewer pass needs. Deliberately omits lead / signal /
 * media-contact / evidence: the reviewer judges the draft against the company's
 * voice and the channel, not against the target it was personalized for.
 */
export interface ReviewContext {
  workspaceName: string;
  docs: BrainContents;
  taskType: TaskType;
  channel: Channel;
  /** The channel guidance in effect (Sprint 21 override or default) — the channel-fit check judges against this, not always the built-in default. */
  channelGuidance?: { content: string; source: GuidanceSource };
  persona?: ResolvePersona;
  campaign?: ResolveCampaign;
  /** Sprint 53: the campaign's active plan revision, loaded by the caller (the resolver never touches the DB). */
  campaignPlan?: ResolveCampaignPlan;
  /** Sprint 43 selective-context inputs — reviewers resolve in brief mode. */
  matrix?: ResolvedTaskDocMatrix;
  outlines?: Partial<Record<BrainDocType, DocOutline>>;
}

function instructionFor(check: GenerationReviewCheck, channel: Channel): string {
  return check === "brand_voice"
    ? composeBrandVoiceReviewInstruction()
    : composeChannelFitReviewInstruction(channel);
}

/** Run one reviewer pass through the resolver + gateway. Never throws. */
async function runCheck(
  llm: LlmGateway,
  ctx: ReviewContext,
  output: string,
  check: GenerationReviewCheck,
): Promise<ReviewCheckResult> {
  // Sprint 43: reviewers judge voice + channel fit, so they get the brief
  // bundle — identity docs full, informational docs as outlines, no zoom.
  const resolved = resolveContext({
    workspaceName: ctx.workspaceName,
    docs: ctx.docs,
    taskType: ctx.taskType,
    channel: ctx.channel,
    channelGuidance: ctx.channelGuidance,
    persona: ctx.persona,
    campaign: ctx.campaign,
    campaignPlan: ctx.campaignPlan,
    matrix: ctx.matrix,
    outlines: ctx.outlines,
    resolveMode: "brief",
    reviewSubject: output,
    taskInstruction: instructionFor(check, ctx.channel),
  });

  try {
    const result = await generateStructured(llm, reviewCheckResponseSchema, {
      prompt: resolved.prompt,
    });
    return {
      check,
      score: Math.max(0, Math.min(100, Math.round(result.value.score))),
      issues: result.value.issues
        .map((issue) => issue.trim())
        .filter((issue) => issue.length > 0 && issue.toLowerCase() !== "none")
        .slice(0, 5),
      prompt: resolved.prompt,
      model: result.model,
      provider: result.provider,
      durationMs: result.durationMs,
    };
  } catch (err) {
    // Best-effort: a reviewer failure — provider down or post-repair
    // malformed output — must never block a generation.
    const message =
      err instanceof GatewayError || err instanceof StructuredOutputError
        ? err.message
        : String(err);
    return {
      check,
      score: null,
      issues: [`Review unavailable: ${message}`],
      prompt: resolved.prompt,
      model: "",
      provider: "",
      durationMs: 0,
    };
  }
}

/**
 * Run both reviewer passes over an output and assemble the GenerationReview.
 * Best-effort end to end — returns a review with null scores rather than
 * throwing when the provider is down.
 */
export async function runPreReview(
  llm: LlmGateway,
  ctx: ReviewContext,
  output: string,
  threshold: number,
): Promise<GenerationReview> {
  const checks: ReviewCheckResult[] = [];
  for (const check of GENERATION_REVIEW_CHECKS) {
    checks.push(await runCheck(llm, ctx, output, check));
  }
  return {
    checks,
    threshold,
    flagged: isReviewFlagged(checks, threshold),
    createdAt: Date.now(),
  };
}

export async function setGenerationReview(
  db: Db,
  workspaceId: string,
  generationId: string,
  review: GenerationReview,
): Promise<void> {
  await db.update(generations)
    .set({ reviewJson: JSON.stringify(review) })
    .where(and(eq(generations.workspaceId, workspaceId), eq(generations.id, generationId)))
    .run();
}

export async function setDraftReview(
  db: Db,
  workspaceId: string,
  draftId: string,
  review: GenerationReview,
): Promise<void> {
  await db.update(drafts)
    .set({ reviewJson: JSON.stringify(review) })
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId)))
    .run();
}
