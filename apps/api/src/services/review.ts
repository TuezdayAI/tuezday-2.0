import { and, eq } from "drizzle-orm";
import {
  GENERATION_REVIEW_CHECKS,
  isReviewFlagged,
  type Channel,
  type GenerationReview,
  type GenerationReviewCheck,
  type ReviewCheckResult,
  type TaskType,
} from "@tuezday/contracts";
import {
  composeBrandVoiceReviewInstruction,
  composeChannelFitReviewInstruction,
  resolveContext,
  type BrainContents,
  type ResolveCampaign,
  type ResolvePersona,
} from "@tuezday/brain";
import type { Db } from "../db";
import { drafts, generations } from "../db/schema";
import { GatewayError, type LlmGateway } from "../llm/gateway";

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
  persona?: ResolvePersona;
  campaign?: ResolveCampaign;
}

/**
 * Parse a reviewer pass's raw text into a score + issues. Best-effort:
 * a missing/garbled SCORE line yields a null score (which never flags).
 */
export function parseReviewOutput(text: string): { score: number | null; issues: string[] } {
  const scoreMatch = text.match(/SCORE:\s*(\d{1,3})/i);
  let score: number | null = null;
  if (scoreMatch) {
    const n = Number.parseInt(scoreMatch[1]!, 10);
    if (Number.isFinite(n)) score = Math.max(0, Math.min(100, n));
  }

  // Issues = bullet lines after an ISSUES: marker (or anywhere, if no marker).
  const issuesIdx = text.search(/ISSUES:/i);
  const issuesBlock = issuesIdx >= 0 ? text.slice(issuesIdx) : text;
  const issues = issuesBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== "none");

  return { score, issues };
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
  const resolved = resolveContext({
    workspaceName: ctx.workspaceName,
    docs: ctx.docs,
    taskType: ctx.taskType,
    channel: ctx.channel,
    persona: ctx.persona,
    campaign: ctx.campaign,
    reviewSubject: output,
    taskInstruction: instructionFor(check, ctx.channel),
  });

  try {
    const result = await llm.generate({ prompt: resolved.prompt });
    const { score, issues } = parseReviewOutput(result.text);
    return {
      check,
      score,
      issues,
      prompt: resolved.prompt,
      model: result.model,
      provider: result.provider,
      durationMs: result.durationMs,
    };
  } catch (err) {
    // Best-effort: a reviewer failure must never block a generation.
    const message = err instanceof GatewayError ? err.message : String(err);
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

export function setGenerationReview(
  db: Db,
  workspaceId: string,
  generationId: string,
  review: GenerationReview,
): void {
  db.update(generations)
    .set({ reviewJson: JSON.stringify(review) })
    .where(and(eq(generations.workspaceId, workspaceId), eq(generations.id, generationId)))
    .run();
}

export function setDraftReview(
  db: Db,
  workspaceId: string,
  draftId: string,
  review: GenerationReview,
): void {
  db.update(drafts)
    .set({ reviewJson: JSON.stringify(review) })
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId)))
    .run();
}
