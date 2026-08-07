import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { pipelineRuns } from "../db/schema";
import { getSocialAutomationSettings } from "./automation";
import { getCampaign } from "./campaigns";
import { applyDraftAction, getDraft, type DraftActor } from "./drafts";
import {
  executePipelineRun,
  type PipelineEngineDeps,
} from "./pipeline-engine";

/** How many queued runs one tick drives to a resting state (D-65.3). Each run
 * is bounded by RUN_MAX_DURATION_MS, so this also bounds tick duration. */
export const PIPELINE_TICK_BATCH = 3;

const SYSTEM_ACTOR: DraftActor = { userId: null, label: "system", human: false };

export interface PipelinesTickResult {
  processed: number;
  succeeded: number;
  failed: number;
  escalated: number;
  blocked: number;
  autoApproved: number;
}

/**
 * The Sprint 65 worker loop: claim queued live/shadow runs oldest-first and
 * execute each (executePipelineRun owns the claim fence, lease, budget check,
 * and resume-from-cache — a crash mid-run is just a re-call here next tick).
 * Dry runs execute synchronously in their route and are never picked up.
 *
 * D-65.4: scheduled_auto semantics survive the path flip — after a live
 * automation run succeeds, this tick (never the engine) applies the system
 * approval, re-checking the kill switch at approve time.
 */
export async function runPipelinesTick(
  db: Db,
  deps: PipelineEngineDeps,
  options: { batch?: number } = {},
): Promise<PipelinesTickResult> {
  const queued = db
    .select({
      id: pipelineRuns.id,
      workspaceId: pipelineRuns.workspaceId,
      mode: pipelineRuns.mode,
      campaignId: pipelineRuns.campaignId,
      createdBy: pipelineRuns.createdBy,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.status, "queued"),
        inArray(pipelineRuns.mode, ["live", "shadow"]),
      ),
    )
    .orderBy(asc(pipelineRuns.createdAt))
    .limit(options.batch ?? PIPELINE_TICK_BATCH)
    .all();

  const result: PipelinesTickResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    escalated: 0,
    blocked: 0,
    autoApproved: 0,
  };

  for (const queuedRun of queued) {
    const executed = await executePipelineRun(
      db,
      deps,
      queuedRun.workspaceId,
      queuedRun.id,
    );
    result.processed += 1;
    if (executed.blocked) {
      result.blocked += 1;
      continue;
    }
    if (executed.run.status === "succeeded") result.succeeded += 1;
    if (executed.run.status === "failed") result.failed += 1;
    if (executed.run.status === "escalated") result.escalated += 1;

    if (
      executed.run.status === "succeeded" &&
      queuedRun.mode === "live" &&
      queuedRun.createdBy === "automation" &&
      executed.run.draftId
    ) {
      const campaign = queuedRun.campaignId
        ? getCampaign(db, queuedRun.workspaceId, queuedRun.campaignId)
        : undefined;
      const settings = getSocialAutomationSettings(db, queuedRun.workspaceId);
      if (campaign?.automationMode === "scheduled_auto" && !settings.killSwitch) {
        const draft = getDraft(db, queuedRun.workspaceId, executed.run.draftId);
        if (draft && draft.state === "pending_review") {
          applyDraftAction(db, draft, "approve", SYSTEM_ACTOR);
          result.autoApproved += 1;
        }
      }
    }
  }

  return result;
}
