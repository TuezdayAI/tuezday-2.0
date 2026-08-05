import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { automationComparisonSchema, pipelineSpecSchema } from "@tuezday/contracts";
import type { Db } from "../src/db";
import {
  campaigns,
  drafts as draftsTable,
  llmUsageEvents,
  pipelineRuns,
  signals,
  users,
  workspaces,
} from "../src/db/schema";
import { getSocialAutomationSettings } from "../src/services/automation";
import {
  applyDraftAction,
  submitAutomaticDraft,
  submitDraft,
  type DraftActor,
} from "../src/services/drafts";
import { createPipelineDefinition } from "../src/services/pipeline-definitions";
import {
  createShadowPair,
  getAutomationComparison,
  listRolloutDecisions,
  listShadowPairs,
  recordRolloutDecision,
  recordShadowVerdict,
  shadowPairKey,
} from "../src/services/pipeline-shadow";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const SIGNAL_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const HUMAN: DraftActor = { userId: null, label: "founder", human: true };
const DAY_MS = 24 * 60 * 60 * 1000;

function fixture() {
  const db = createTestDb();
  db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Shadow", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(users)
    .values({ id: USER_ID, email: "founder@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(campaigns)
    .values({
      id: CAMPAIGN_ID,
      workspaceId: WORKSPACE_ID,
      name: "Launch",
      channelsJson: '["linkedin"]',
      status: "active",
      automationMode: "human_in_the_loop",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(signals)
    .values({
      id: SIGNAL_ID,
      workspaceId: WORKSPACE_ID,
      content: "Competitor raised.",
      source: "manual",
      sourceUrl: null,
      createdAt: 2,
    })
    .run();
  const definition = createPipelineDefinition(
    db,
    WORKSPACE_ID,
    {
      taskKey: "signal_social_post",
      name: "Mini",
      description: "",
      spec: pipelineSpecSchema.parse({
        steps: [
          {
            key: "draft",
            title: "Draft",
            goal: "Write.",
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
            goal: "Judge.",
            kind: "agent",
            tools: [],
            tier: "cheap",
            output: "findings",
            maxSteps: 2,
            maxTokens: 8_000,
          },
          { key: "propose", title: "Propose", goal: "Submit.", kind: "propose", output: "proposal" },
        ],
        budget: { maxTokens: 100_000 },
      }),
    },
    { userId: null, label: "founder" },
  );
  return { db, definition };
}

function legacyDraft(db: Db, content: string, channel = "linkedin") {
  return submitAutomaticDraft(
    db,
    {
      workspaceId: WORKSPACE_ID,
      sourceGenerationId: randomUUID(),
      sourceSignalId: SIGNAL_ID,
      campaignId: CAMPAIGN_ID,
      taskType: "signal_response",
      channel: channel as never,
      personaId: null,
      content,
      automationKey: `automation:v1:${WORKSPACE_ID}:${SIGNAL_ID}:${CAMPAIGN_ID}:${channel}:${randomUUID()}`,
      autoApprove: false,
    },
    { userId: null, label: "system", human: false },
  ).draft;
}

function engineRun(
  db: Db,
  definitionId: string,
  over: Partial<typeof pipelineRuns.$inferInsert> = {},
) {
  const id = randomUUID();
  db.insert(pipelineRuns)
    .values({
      id,
      workspaceId: WORKSPACE_ID,
      definitionId,
      definitionVersion: 1,
      taskKey: "signal_social_post",
      signalId: SIGNAL_ID,
      campaignId: CAMPAIGN_ID,
      channel: "linkedin",
      createdBy: "automation",
      createdAt: Date.now(),
      ...over,
    })
    .run();
  return id;
}

describe("shadow pairs", () => {
  it("lists pairs enriched with draft + proposal and records verdicts", () => {
    const { db, definition } = fixture();
    const draft = legacyDraft(db, "The legacy take.");
    const runId = engineRun(db, definition.id, {
      mode: "shadow",
      status: "succeeded",
      resultJson: JSON.stringify({
        content: "The engine take.",
        channel: "linkedin",
        taskType: "signal_response",
        generationId: null,
        draftId: null,
        simulated: true,
      }),
    });
    createShadowPair(db, {
      workspaceId: WORKSPACE_ID,
      pairKey: shadowPairKey({
        workspaceId: WORKSPACE_ID,
        signalId: SIGNAL_ID,
        campaignId: CAMPAIGN_ID,
        channel: "linkedin",
      }),
      signalId: SIGNAL_ID,
      campaignId: CAMPAIGN_ID,
      channel: "linkedin",
      draftId: draft.id,
      runId,
    });

    const [pair] = listShadowPairs(db, WORKSPACE_ID, { reviewed: false });
    expect(pair).toMatchObject({
      draftContent: "The legacy take.",
      draftState: "pending_review",
      proposalContent: "The engine take.",
      runStatus: "succeeded",
      verdict: null,
    });

    const reviewed = recordShadowVerdict(
      db,
      WORKSPACE_ID,
      pair!.id,
      { verdict: "engine", notes: "Tighter hook." },
      { userId: USER_ID },
    );
    expect(reviewed).toMatchObject({ verdict: "engine", verdictNotes: "Tighter hook." });
    expect(reviewed!.verdictAt).toBeGreaterThan(0);
    expect(listShadowPairs(db, WORKSPACE_ID, { reviewed: false })).toHaveLength(0);
    expect(listShadowPairs(db, WORKSPACE_ID, { reviewed: true })).toHaveLength(1);
    expect(
      recordShadowVerdict(db, WORKSPACE_ID, randomUUID(), { verdict: "tie", notes: "" }, { userId: null }),
    ).toBeUndefined();
  });
});

describe("automation comparison (D-65.8)", () => {
  it("aggregates approval rate, edit distance, cost, and shadow tallies per path", () => {
    const { db, definition } = fixture();

    // Legacy: approved untouched, edited-then-approved (50% rewrite), rejected.
    const untouched = legacyDraft(db, "aaaaaaaaaa", "linkedin");
    applyDraftAction(db, untouched, "approve", HUMAN);
    const edited = legacyDraft(db, "aaaaaaaaaa", "x");
    const afterEdit = applyDraftAction(db, edited, "edit", HUMAN, "aaaaabbbbb");
    applyDraftAction(db, afterEdit, "approve", HUMAN);
    const rejected = legacyDraft(db, "cccc", "email");
    applyDraftAction(db, rejected, "reject", HUMAN);
    // A stale draft outside the window must not count.
    const stale = legacyDraft(db, "old", "pr");
    db.update(draftsTable)
      .set({ createdAt: Date.now() - 40 * DAY_MS })
      .where(eq(draftsTable.id, stale.id))
      .run();

    // Engine: one live run whose gate draft was approved untouched, plus a
    // failed shadow run and an escalated live run.
    const engineDraft = submitDraft(
      db,
      {
        workspaceId: WORKSPACE_ID,
        sourceGenerationId: randomUUID(),
        sourceSignalId: SIGNAL_ID,
        campaignId: CAMPAIGN_ID,
        taskType: "signal_response",
        channel: "linkedin",
        personaId: null,
        content: "Engine wrote this.",
      },
      { userId: null, label: "automation", human: false },
    );
    applyDraftAction(db, engineDraft, "approve", HUMAN);
    engineRun(db, definition.id, {
      mode: "live",
      status: "succeeded",
      draftId: engineDraft.id,
      costCents: 10,
    });
    engineRun(db, definition.id, { mode: "shadow", status: "failed", costCents: 2 });
    engineRun(db, definition.id, { mode: "live", status: "escalated", costCents: 3 });
    // Dry runs are founder experiments — excluded from the A/B.
    engineRun(db, definition.id, { mode: "dry_run", status: "succeeded", costCents: 99 });

    // Legacy cost: signal_draft + review usage only; pipeline_run is engine.
    const usage = (pipeline: string, costCents: number) =>
      db
        .insert(llmUsageEvents)
        .values({
          id: randomUUID(),
          workspaceId: WORKSPACE_ID,
          pipeline,
          campaignId: null,
          agentRunId: null,
          model: "fake",
          provider: "fake",
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          costCents,
          createdAt: Date.now(),
        })
        .run();
    usage("signal_draft", 7);
    usage("review", 3);
    usage("pipeline_run", 99);

    // Shadow pairs: engine win, legacy win, unreviewed.
    const pairFor = (suffix: string, verdict: "engine" | "legacy" | null) => {
      const runId = engineRun(db, definition.id, { mode: "shadow", status: "succeeded" });
      createShadowPair(db, {
        workspaceId: WORKSPACE_ID,
        pairKey: `k-${suffix}`,
        signalId: SIGNAL_ID,
        campaignId: CAMPAIGN_ID,
        channel: "linkedin",
        draftId: untouched.id,
        runId,
      });
      if (verdict) {
        const [pair] = listShadowPairs(db, WORKSPACE_ID, { reviewed: false });
        recordShadowVerdict(db, WORKSPACE_ID, pair!.id, { verdict, notes: "" }, { userId: null });
      }
    };
    pairFor("a", "engine");
    pairFor("b", "legacy");
    pairFor("c", null);

    const comparison = getAutomationComparison(db, WORKSPACE_ID);
    expect(automationComparisonSchema.parse(comparison)).toEqual(comparison);
    expect(comparison.legacy).toEqual({
      drafts: 3,
      decided: 3,
      approved: 2,
      rejected: 1,
      approvalRate: 66.7,
      avgEditDistance: 25, // mean(0, 50)
      costCents: 10,
    });
    expect(comparison.engine).toMatchObject({
      drafts: 1,
      decided: 1,
      approved: 1,
      approvalRate: 100,
      avgEditDistance: 0,
    });
    // 10 + 2 + 3 from the A/B runs + 3 succeeded shadow pair runs at 0 — the
    // 99¢ dry run stays out.
    expect(comparison.engine.costCents).toBe(15);
    expect(comparison.engine.health).toEqual({
      runs: 6,
      succeeded: 4,
      failed: 1,
      escalated: 1,
    });
    expect(comparison.shadow).toEqual({
      pairs: 3,
      reviewed: 2,
      engineWins: 1,
      legacyWins: 1,
      ties: 0,
    });
  });

  it("returns nulls, not zeros, when nothing has been decided", () => {
    const { db } = fixture();
    const comparison = getAutomationComparison(db, WORKSPACE_ID);
    expect(comparison.legacy).toMatchObject({
      drafts: 0,
      approvalRate: null,
      avgEditDistance: null,
    });
    expect(comparison.generationPath).toBe("legacy");
  });
});

describe("rollout decisions (D-65.9)", () => {
  it("freezes the snapshot, applies the flag, and stays append-only", () => {
    const { db } = fixture();
    const adopted = recordRolloutDecision(
      db,
      WORKSPACE_ID,
      { decision: "adopt_engine", rationale: "Engine wins on approvals and cost." },
      { userId: USER_ID },
    );
    expect(adopted).toMatchObject({
      taskKey: "signal_social_post",
      decision: "adopt_engine",
      decidedByUserId: USER_ID,
    });
    expect(adopted.metrics.workspaceId).toBe(WORKSPACE_ID);
    expect(getSocialAutomationSettings(db, WORKSPACE_ID).generationPath).toBe("pipeline");

    const kept = recordRolloutDecision(
      db,
      WORKSPACE_ID,
      { decision: "keep_legacy", rationale: "Regression after the model swap." },
      { userId: null },
    );
    expect(getSocialAutomationSettings(db, WORKSPACE_ID).generationPath).toBe("legacy");
    // The first decision's snapshot recorded the path at its decision time.
    const listed = listRolloutDecisions(db, WORKSPACE_ID);
    expect(listed.map((d) => d.id)).toEqual([kept.id, adopted.id]);
    expect(listed[1]!.metrics.generationPath).toBe("legacy");
  });
});
