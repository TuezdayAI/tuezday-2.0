/**
 * Pipeline engine schema invariants (Sprints 64–65).
 *
 * Ported from sprint64/65-migrations.test.ts, which built a database by
 * replaying migrations up to a numbered file. The squashed Sprint 74 baseline
 * removed that history; the constraints below are the part that was never
 * about history — idempotency dedupe, attempt identity, and which references
 * survive a delete.
 */
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import { PG_ERROR, expectPgError } from "./schema-introspection";
import {
  drafts,
  pipelineDefinitionVersions,
  pipelineDefinitions,
  pipelineRolloutDecisions,
  pipelineRunSteps,
  pipelineRuns,
  pipelineShadowPairs,
  signals,
  socialAutomationSettings,
  workspaces,
} from "../src/db/schema";

const WS = "ws-1";
const DEFINITION = "def-1";

async function seeded() {
  const db = await createTestDb();
  await db.insert(workspaces).values({ id: WS, name: "Workspace", createdAt: 1, updatedAt: 1 });
  await db.insert(pipelineDefinitions).values({
    id: DEFINITION,
    workspaceId: WS,
    taskKey: "signal_social_post",
    name: "Reference",
    specJson: "{}",
    createdAt: 1,
    updatedAt: 1,
  });
  return db;
}

function insertRun(db: Awaited<ReturnType<typeof seeded>>, id: string, idempotencyKey: string | null) {
  return db.insert(pipelineRuns).values({
    id,
    workspaceId: WS,
    definitionId: DEFINITION,
    definitionVersion: 1,
    taskKey: "signal_social_post",
    channel: "linkedin",
    idempotencyKey,
    createdBy: "test",
    createdAt: 1,
  });
}

describe("pipeline schema", () => {
  it("applies defaults on definitions and runs", async () => {
    const db = await seeded();

    const [definition] = await db
      .select({
        status: pipelineDefinitions.status,
        currentVersion: pipelineDefinitions.currentVersion,
        description: pipelineDefinitions.description,
      })
      .from(pipelineDefinitions);
    expect(definition).toEqual({ status: "draft", currentVersion: 1, description: "" });

    await insertRun(db, "run-1", null);
    const [run] = await db
      .select({
        status: pipelineRuns.status,
        mode: pipelineRuns.mode,
        checklistJson: pipelineRuns.checklistJson,
      })
      .from(pipelineRuns);
    expect(run).toEqual({ status: "queued", mode: "live", checklistJson: "[]" });
  });

  it("enforces one version row per (definition, version)", async () => {
    const db = await seeded();
    const insert = (id: string, version: number) =>
      db.insert(pipelineDefinitionVersions).values({
        id,
        definitionId: DEFINITION,
        version,
        specJson: "{}",
        actorLabel: "system",
        createdAt: 1,
      });

    await insert("v-1", 1);
    await expectPgError(insert("v-2", 1), PG_ERROR.uniqueViolation);
    await insert("v-3", 2);
  });

  it("dedupes runs only when an idempotency key is present", async () => {
    const db = await seeded();
    await insertRun(db, "run-1", null);
    await insertRun(db, "run-2", null); // null keys never collide
    await insertRun(db, "run-3", "signal:abc");
    await expectPgError(insertRun(db, "run-4", "signal:abc"), PG_ERROR.uniqueViolation);
  });

  it("enforces unique step attempts and cascades them with the run", async () => {
    const db = await seeded();
    await insertRun(db, "run-1", null);
    const insert = (id: string, iteration: number, attempt: number) =>
      db.insert(pipelineRunSteps).values({
        id,
        runId: "run-1",
        stepKey: "draft",
        iteration,
        attempt,
        createdAt: 1,
      });

    await insert("s-1", 1, 1);
    await expectPgError(insert("s-2", 1, 1), PG_ERROR.uniqueViolation);
    await insert("s-3", 1, 2);
    await insert("s-4", 2, 1);

    await db.delete(pipelineRuns).where(eq(pipelineRuns.id, "run-1"));
    expect(await db.select({ n: count() }).from(pipelineRunSteps)).toEqual([{ n: 0 }]);
  });

  it("keeps runs when the signal they reference is deleted", async () => {
    const db = await seeded();
    await db
      .insert(signals)
      .values({ id: "sig-1", workspaceId: WS, content: "A signal", source: "manual", createdAt: 1 });
    await db.insert(pipelineRuns).values({
      id: "run-1",
      workspaceId: WS,
      definitionId: DEFINITION,
      definitionVersion: 1,
      taskKey: "signal_social_post",
      signalId: "sig-1",
      channel: "linkedin",
      createdBy: "test",
      createdAt: 1,
    });

    await db.delete(signals).where(eq(signals.id, "sig-1"));
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, "run-1"));
    expect(run?.signalId).toBeNull();
  });
});

describe("shadow A/B schema", () => {
  it("defaults generation_path to legacy so merging changes nothing", async () => {
    const db = await seeded();
    await db.insert(socialAutomationSettings).values({ workspaceId: WS, updatedAt: 1 });

    const [row] = await db
      .select({ generationPath: socialAutomationSettings.generationPath })
      .from(socialAutomationSettings)
      .where(eq(socialAutomationSettings.workspaceId, WS));
    expect(row?.generationPath).toBe("legacy");
  });

  it("enforces one shadow pair per pair_key", async () => {
    const db = await seeded();
    await insertRun(db, "run-1", null);
    const insertPair = (id: string, pairKey: string) =>
      db.insert(pipelineShadowPairs).values({
        id,
        workspaceId: WS,
        pairKey,
        channel: "linkedin",
        runId: "run-1",
        createdAt: 1,
      });

    await insertPair("pair-1", "shadow:v1:ws:sig:camp:linkedin");
    await expectPgError(insertPair("pair-2", "shadow:v1:ws:sig:camp:linkedin"), PG_ERROR.uniqueViolation);
    await insertPair("pair-3", "shadow:v1:ws:sig:camp:x");
  });

  it("cascades pair deletion from the run and survives draft deletion", async () => {
    const db = await seeded();
    await insertRun(db, "run-1", null);
    await db.insert(drafts).values({
      id: "draft-1",
      workspaceId: WS,
      taskType: "signal_response",
      channel: "linkedin",
      originalContent: "a",
      content: "a",
      state: "pending_review",
      createdAt: 1,
      updatedAt: 1,
    });
    await db.insert(pipelineShadowPairs).values({
      id: "pair-1",
      workspaceId: WS,
      pairKey: "k1",
      channel: "linkedin",
      draftId: "draft-1",
      runId: "run-1",
      createdAt: 1,
    });

    await db.delete(drafts).where(eq(drafts.id, "draft-1"));
    const [afterDraft] = await db
      .select()
      .from(pipelineShadowPairs)
      .where(eq(pipelineShadowPairs.id, "pair-1"));
    expect(afterDraft?.draftId).toBeNull();

    await db.delete(pipelineRuns).where(eq(pipelineRuns.id, "run-1"));
    expect(await db.select({ n: count() }).from(pipelineShadowPairs)).toEqual([{ n: 0 }]);
  });

  it("stores rollout decisions and cascades them with the workspace", async () => {
    const db = await seeded();
    await db.insert(pipelineRolloutDecisions).values({
      id: "dec-1",
      workspaceId: WS,
      taskKey: "signal_social_post",
      decision: "adopt_engine",
      rationale: "It wins.",
      metricsJson: "{}",
      createdAt: 1,
    });

    await db.delete(workspaces).where(eq(workspaces.id, WS));
    expect(await db.select({ n: count() }).from(pipelineRolloutDecisions)).toEqual([{ n: 0 }]);
  });
});
