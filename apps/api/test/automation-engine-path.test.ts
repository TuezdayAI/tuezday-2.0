import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PipelineSpec } from "@tuezday/contracts";
import { pipelineSpecSchema } from "@tuezday/contracts";
import type { Db } from "../src/db";
import {
  campaigns,
  drafts,
  pipelineRuns,
  pipelineShadowPairs,
  signals,
  workspaces,
} from "../src/db/schema";
import type { EvidenceStore } from "../src/evidence/store";
import type { GenerateResult } from "../src/llm/gateway";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import type { SafeFetchService } from "../src/safe-fetch/index";
import {
  getSocialAutomationSettings,
  runAutomation,
  updateSocialAutomationSettings,
} from "../src/services/automation";
import { automaticDraftKey, listDecisions, listDrafts } from "../src/services/drafts";
import { insertSignalMatch } from "../src/services/matching";
import { updateGenerationSettings } from "../src/services/generation-settings";
import {
  createPipelineDefinition,
  setPipelineStatus,
} from "../src/services/pipeline-definitions";
import { runPipelinesTick } from "../src/services/pipeline-tick";
import type { PipelineEngineDeps } from "../src/services/pipeline-engine";
import { listShadowPairs, shadowPairKey } from "../src/services/pipeline-shadow";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const SIGNAL_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR = { userId: null, label: "founder" };

/** Legacy generation + review use generate(); engine steps use the script. */
class HybridGateway extends ScriptedGateway {
  override async generate(): Promise<GenerateResult> {
    return {
      text: "Legacy headline\nThe legacy body.",
      model: "fake",
      provider: "fake",
      durationMs: 1,
    };
  }
}

const noEvidence: EvidenceStore = {
  async health() {
    return { healthy: true };
  },
  async createCollection() {
    return "unused";
  },
  async addDocument() {
    return "unused";
  },
  async attachDocument() {},
  async deleteDocument() {},
  async search() {
    return [];
  },
};

/** draft + critique + revise-loop + propose — two agent steps per clean run. */
function miniSpec(): PipelineSpec {
  return pipelineSpecSchema.parse({
    steps: [
      {
        key: "draft",
        title: "Draft",
        goal: "Write the post.",
        kind: "agent",
        tools: [],
        tier: "cheap",
        output: "draft",
        maxSteps: 2,
        maxTokens: 8_000,
      },
      {
        key: "critique",
        title: "Critique",
        goal: "Judge the draft.",
        kind: "agent",
        tools: [],
        tier: "cheap",
        output: "findings",
        maxSteps: 2,
        maxTokens: 8_000,
      },
      {
        key: "revise",
        title: "Revise",
        goal: "Fix the findings.",
        kind: "agent",
        tools: [],
        tier: "cheap",
        output: "draft",
        maxSteps: 2,
        maxTokens: 8_000,
        loop: { scoreFrom: "critique", threshold: 70, maxIterations: 2 },
      },
      { key: "propose", title: "Propose", goal: "Submit.", kind: "propose", output: "proposal" },
    ],
    budget: { maxTokens: 100_000 },
  });
}

const draftStep = (content: string): ScriptedStep => ({
  text: JSON.stringify({ content, confidence: 90 }),
});
const critiqueStep = (score = 90): ScriptedStep => ({
  text: JSON.stringify({ score, findings: [], guardrailUncertain: false, confidence: 90 }),
});
/** One clean engine run of the mini spec (revise skipped at score 90). */
const cleanRun = (content = "Engine draft."): ScriptedStep[] => [
  draftStep(content),
  critiqueStep(),
];

async function fixture(script: ScriptedStep[], automationMode = "human_in_the_loop") {
  const db = createTestDb();
  await db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "AB", createdAt: 1, updatedAt: 1 })
    .run();
  await db.insert(campaigns)
    .values({
      id: CAMPAIGN_ID,
      workspaceId: WORKSPACE_ID,
      name: "Launch",
      channelsJson: '["linkedin"]',
      status: "active",
      automationMode,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await db.insert(signals)
    .values({
      id: SIGNAL_ID,
      workspaceId: WORKSPACE_ID,
      content: "Competitor raised a Series B.",
      source: "manual",
      sourceUrl: null,
      createdAt: 2,
    })
    .run();
  await insertSignalMatch(db, WORKSPACE_ID, SIGNAL_ID, {
    personaId: null,
    campaignId: CAMPAIGN_ID,
    score: 80,
    reason: "test match",
  });
  // Pre-review's structured calls prefer agentStep and would consume the
  // engine's script — the legacy generation under test is the draft, not the
  // reviewer.
  await updateGenerationSettings(db, WORKSPACE_ID, { reviewEnabled: false });
  const gateway = new HybridGateway(script);
  const deps: PipelineEngineDeps = {
    llm: gateway,
    evidence: noEvidence,
    safeFetch: {} as unknown as SafeFetchService,
  };
  return { db, gateway, deps };
}

async function activeDefinition(db: Db) {
  const definition = await createPipelineDefinition(
    db,
    WORKSPACE_ID,
    { taskKey: "signal_social_post", name: "Mini", description: "", spec: miniSpec() },
    ACTOR,
  );
  await setPipelineStatus(db, WORKSPACE_ID, definition.id, "active");
  return definition;
}

async function allRuns(db: Db) {
  return await db
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.workspaceId, WORKSPACE_ID))
    .all();
}

describe("automation on the pipeline path (D-65.1/D-65.3)", () => {
  it("queues a live engine run instead of generating, idempotently", async () => {
    const { db, gateway, deps } = await fixture(cleanRun());
    await activeDefinition(db);
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "pipeline" });

    const first = await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);
    expect(first.results[0]).toMatchObject({
      generated: 0,
      engineQueued: 1,
      shadowQueued: 0,
      skipped: 0,
      blocked: null,
    });
    expect(await listDrafts(db, WORKSPACE_ID)).toHaveLength(0);

    const runs = await allRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      mode: "live",
      status: "queued",
      createdBy: "automation",
      idempotencyKey: automaticDraftKey({
        workspaceId: WORKSPACE_ID,
        signalId: SIGNAL_ID,
        campaignId: CAMPAIGN_ID,
        channel: "linkedin",
      }),
    });

    // A rerun dedupes on the key — no duplicate run, nothing skipped.
    const second = await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);
    expect(second.results[0]).toMatchObject({ engineQueued: 0, skipped: 0 });
    expect(await allRuns(db)).toHaveLength(1);
  });

  it("falls back to legacy generation when no active definition resolves (D-65.6)", async () => {
    const { db, gateway, deps } = await fixture([]);
    // The definition exists but stays draft — activation is a founder action.
    await createPipelineDefinition(
      db,
      WORKSPACE_ID,
      { taskKey: "signal_social_post", name: "Mini", description: "", spec: miniSpec() },
      ACTOR,
    );
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "pipeline" });

    const result = await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);
    expect(result.results[0]).toMatchObject({ generated: 1, engineQueued: 0 });
    const [draft] = await listDrafts(db, WORKSPACE_ID);
    expect(draft).toMatchObject({ state: "pending_review", channel: "linkedin" });
    expect(await allRuns(db)).toHaveLength(0);
  });

  it("keeps the kill switch blocking scheduled_auto queueing", async () => {
    const { db, gateway, deps } = await fixture([], "scheduled_auto");
    await activeDefinition(db);
    await updateSocialAutomationSettings(db, WORKSPACE_ID, {
      generationPath: "pipeline",
      killSwitch: true,
    });
    const result = await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);
    expect(result.results[0]).toMatchObject({ blocked: "kill_switch_on", engineQueued: 0 });
    expect(await allRuns(db)).toHaveLength(0);
  });
});

describe("automation on the shadow path (D-65.7)", () => {
  it("drafts via legacy and queues a paired shadow run once", async () => {
    const { db, gateway, deps } = await fixture(cleanRun());
    await activeDefinition(db);
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "shadow" });

    const first = await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);
    expect(first.results[0]).toMatchObject({
      generated: 1,
      engineQueued: 0,
      shadowQueued: 1,
    });
    const [draft] = await listDrafts(db, WORKSPACE_ID);
    expect(draft!.state).toBe("pending_review");

    const runs = await allRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      mode: "shadow",
      status: "queued",
      idempotencyKey: shadowPairKey({
        workspaceId: WORKSPACE_ID,
        signalId: SIGNAL_ID,
        campaignId: CAMPAIGN_ID,
        channel: "linkedin",
      }),
    });
    const pairs = await db
      .select()
      .from(pipelineShadowPairs)
      .where(eq(pipelineShadowPairs.workspaceId, WORKSPACE_ID))
      .all();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ draftId: draft!.id, runId: runs[0]!.id });

    // Rerun: the draft dedupe (hasDraftFor) short-circuits — no second pair.
    const second = await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);
    expect(second.results[0]).toMatchObject({ generated: 0, shadowQueued: 0 });
    expect(await allRuns(db)).toHaveLength(1);
  });
});

describe("the pipelines tick (D-65.3/D-65.4)", () => {
  it("does not claim a queued run from another workspace", async () => {
    const { db, gateway, deps } = await fixture(cleanRun());
    await activeDefinition(db);
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "pipeline" });
    await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);
    const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
    await db.insert(workspaces)
      .values({
        id: otherWorkspaceId,
        name: "Other",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    expect(
      await runPipelinesTick(db, deps, { workspaceId: otherWorkspaceId }),
    ).toMatchObject({ processed: 0 });
    expect((await allRuns(db))[0]).toMatchObject({ status: "queued" });
  });

  it("executes a queued live run into a gate draft, auto-approving for scheduled_auto", async () => {
    const { db, gateway, deps } = await fixture(cleanRun("Engine wrote this."), "scheduled_auto");
    await activeDefinition(db);
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "pipeline" });
    await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);

    const tick = await runPipelinesTick(db, deps);
    expect(tick).toMatchObject({
      processed: 1,
      succeeded: 1,
      failed: 0,
      escalated: 0,
      autoApproved: 1,
    });
    const [draft] = await listDrafts(db, WORKSPACE_ID);
    expect(draft).toMatchObject({ state: "approved", content: "Engine wrote this." });
    // Same attribution as the legacy auto-approve: a logged system decision.
    const decisions = await listDecisions(db, draft!.id);
    expect(decisions.map((d) => d.action)).toEqual(["submit", "approve"]);
    expect(decisions[1]).toMatchObject({ actor: "system", actorId: null });

    // Nothing left queued — the next tick is a no-op.
    expect(await runPipelinesTick(db, deps)).toMatchObject({ processed: 0 });
  });

  it("leaves human_in_the_loop drafts at the gate", async () => {
    const { db, gateway, deps } = await fixture(cleanRun());
    await activeDefinition(db);
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "pipeline" });
    await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);

    const tick = await runPipelinesTick(db, deps);
    expect(tick).toMatchObject({ succeeded: 1, autoApproved: 0 });
    expect((await listDrafts(db, WORKSPACE_ID))[0]!.state).toBe("pending_review");
  });

  it("re-checks the kill switch at approve time (D-65.4)", async () => {
    const { db, gateway, deps } = await fixture(cleanRun(), "scheduled_auto");
    await activeDefinition(db);
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "pipeline" });
    await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);
    // The switch flips while the run is queued.
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { killSwitch: true });

    const tick = await runPipelinesTick(db, deps);
    expect(tick).toMatchObject({ succeeded: 1, autoApproved: 0 });
    expect((await listDrafts(db, WORKSPACE_ID))[0]!.state).toBe("pending_review");
  });

  it("finishes shadow runs simulated — proposal recorded, no draft (D-65.2)", async () => {
    const { db, gateway, deps } = await fixture(cleanRun("Engine shadow take."));
    await activeDefinition(db);
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "shadow" });
    await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);

    const tick = await runPipelinesTick(db, deps);
    expect(tick).toMatchObject({ processed: 1, succeeded: 1, autoApproved: 0 });
    // Still exactly the one legacy draft.
    expect(await listDrafts(db, WORKSPACE_ID)).toHaveLength(1);
    expect((await listDrafts(db, WORKSPACE_ID))[0]!.content).toContain("Legacy");

    const [pair] = await listShadowPairs(db, WORKSPACE_ID);
    expect(pair).toMatchObject({
      runStatus: "succeeded",
      proposalContent: "Engine shadow take.",
      verdict: null,
    });
  });

  it("keeps a failed automation run terminal — no silent retry (D-65.5)", async () => {
    // Two invalid outputs exhaust STEP_MAX_ATTEMPTS on the draft step.
    const { db, gateway, deps } = await fixture([{ text: "not json" }, { text: "still not" }]);
    await activeDefinition(db);
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "pipeline" });
    await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);

    const tick = await runPipelinesTick(db, deps);
    expect(tick).toMatchObject({ processed: 1, failed: 1 });
    expect(await listDrafts(db, WORKSPACE_ID)).toHaveLength(0);

    // The next automation pass dedupes on the key: still one (failed) run.
    const rerun = await runAutomation(db, gateway, deps.evidence, WORKSPACE_ID);
    expect(rerun.results[0]).toMatchObject({ engineQueued: 0, skipped: 0 });
    const runs = await allRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
  });
});

describe("settings", () => {
  it("persists generationPath and defaults to legacy", async () => {
    const db = createTestDb();
    await db.insert(workspaces)
      .values({ id: WORKSPACE_ID, name: "AB", createdAt: 1, updatedAt: 1 })
      .run();
    expect((await getSocialAutomationSettings(db, WORKSPACE_ID)).generationPath).toBe("legacy");
    await updateSocialAutomationSettings(db, WORKSPACE_ID, { generationPath: "shadow" });
    expect((await getSocialAutomationSettings(db, WORKSPACE_ID)).generationPath).toBe("shadow");
  });
});
