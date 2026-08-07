import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  automationComparisonSchema,
  pipelineShadowPairSchema,
  pipelineSpecSchema,
  rolloutDecisionSchema,
} from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { campaigns, drafts as draftsTable, pipelineRuns, signals } from "../src/db/schema";
import { createPipelineDefinition } from "../src/services/pipeline-definitions";
import { createShadowPair, shadowPairKey } from "../src/services/pipeline-shadow";
import { asUser, createTestDb, registerUser, type TestUser } from "./helpers";

const WORKER_TOKEN = "worker-test-token-with-enough-entropy";
const SIGNAL_ID = "11111111-1111-4111-8111-111111111111";

describe("automation A/B routes (Sprint 65)", () => {
  let rawApp: TuezdayApp;
  let app: TuezdayApp;
  let db: Db;
  let founder: TestUser;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    rawApp = await buildApp({ db, workerToken: WORKER_TOKEN });
    founder = await registerUser(rawApp);
    app = asUser(rawApp, founder.token);
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "AB" } })
    ).json().id;
    await db.insert(signals)
      .values({
        id: SIGNAL_ID,
        workspaceId,
        content: "Competitor raised.",
        source: "manual",
        sourceUrl: null,
        createdAt: Date.now(),
      })
      .run();
  });

  async function seedPair() {
    const campaignId = randomUUID();
    await db.insert(campaigns)
      .values({
        id: campaignId,
        workspaceId,
        name: "Launch",
        channelsJson: '["linkedin"]',
        status: "active",
        automationMode: "human_in_the_loop",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    const draftId = randomUUID();
    await db.insert(draftsTable)
      .values({
        id: draftId,
        workspaceId,
        taskType: "signal_response",
        channel: "linkedin",
        originalContent: "The legacy take.",
        content: "The legacy take.",
        state: "pending_review",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    const definition = await createPipelineDefinition(
      db,
      workspaceId,
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
            { key: "propose", title: "Propose", goal: "Submit.", kind: "propose", output: "proposal" },
          ],
          budget: { maxTokens: 100_000 },
        }),
      },
      { userId: founder.id, label: "founder" },
    );
    const runId = randomUUID();
    await db.insert(pipelineRuns)
      .values({
        id: runId,
        workspaceId,
        definitionId: definition.id,
        definitionVersion: 1,
        taskKey: "signal_social_post",
        signalId: SIGNAL_ID,
        campaignId,
        channel: "linkedin",
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
        createdBy: "automation",
        createdAt: Date.now(),
      })
      .run();
    return await createShadowPair(db, {
      workspaceId,
      pairKey: shadowPairKey({
        workspaceId,
        signalId: SIGNAL_ID,
        campaignId,
        channel: "linkedin",
      }),
      signalId: SIGNAL_ID,
      campaignId,
      channel: "linkedin",
      draftId,
      runId,
    });
  }

  it("round-trips generationPath through the settings PATCH and rejects unknown paths", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/automation/settings`,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().generationPath).toBe("legacy");

    const patched = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/automation/settings`,
      payload: { generationPath: "shadow" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().generationPath).toBe("shadow");

    const invalid = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/automation/settings`,
      payload: { generationPath: "yolo" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_input");

    const after = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/automation/settings`,
    });
    expect(after.json().generationPath).toBe("shadow");
  });

  it("serves the comparison in the contracts shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/automation/comparison`,
    });
    expect(res.statusCode).toBe(200);
    const comparison = automationComparisonSchema.parse(res.json());
    expect(comparison.workspaceId).toBe(workspaceId);
    expect(comparison.generationPath).toBe("legacy");
    expect(comparison.legacy.approvalRate).toBeNull();
    expect(comparison.engine.health.runs).toBe(0);
  });

  it("runs the shadow review flow over HTTP", async () => {
    const pair = await seedPair();

    const unreviewed = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/automation/shadow-pairs?reviewed=false`,
    });
    expect(unreviewed.statusCode).toBe(200);
    expect(unreviewed.json()).toHaveLength(1);
    expect(pipelineShadowPairSchema.parse(unreviewed.json()[0]).proposalContent).toBe(
      "The engine take.",
    );

    const badVerdict = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/automation/shadow-pairs/${pair.id}/verdict`,
      payload: { verdict: "better" },
    });
    expect(badVerdict.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/automation/shadow-pairs/${randomUUID()}/verdict`,
      payload: { verdict: "engine" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("pair_not_found");

    const verdict = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/automation/shadow-pairs/${pair.id}/verdict`,
      payload: { verdict: "engine", notes: "Tighter hook." },
    });
    expect(verdict.statusCode).toBe(200);
    expect(verdict.json()).toMatchObject({ verdict: "engine", verdictNotes: "Tighter hook." });

    const reviewed = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/automation/shadow-pairs?reviewed=true`,
    });
    expect(reviewed.json()).toHaveLength(1);
    const remaining = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/automation/shadow-pairs?reviewed=false`,
    });
    expect(remaining.json()).toHaveLength(0);
  });

  it("records rollout decisions, flips the flag, and lists them", async () => {
    const noRationale = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/automation/rollout-decisions`,
      payload: { decision: "adopt_engine" },
    });
    expect(noRationale.statusCode).toBe(400);

    const adopted = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/automation/rollout-decisions`,
      payload: { decision: "adopt_engine", rationale: "Engine wins on approvals and cost." },
    });
    expect(adopted.statusCode).toBe(201);
    const record = rolloutDecisionSchema.parse(adopted.json());
    expect(record.decision).toBe("adopt_engine");
    expect(record.decidedByUserId).toBe(founder.id);
    // The snapshot freezes the comparison as it stood at decision time.
    expect(record.metrics.generationPath).toBe("legacy");

    const settings = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/automation/settings`,
    });
    expect(settings.json().generationPath).toBe("pipeline");

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/automation/rollout-decisions`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].id).toBe(record.id);
  });

  it("retires the standalone pipelines tick after the queue cutover", async () => {
    for (const headers of [
      undefined,
      { authorization: `Bearer ${founder.token}` },
      { authorization: `Bearer ${WORKER_TOKEN}` },
    ]) {
      const response = await rawApp.inject({
        method: "POST",
        url: "/internal/pipelines/tick",
        payload: {},
        headers,
      });
      expect([401, 404]).toContain(response.statusCode);
    }
  });

  it("hides the A/B surface from non-members", async () => {
    const outsider = await registerUser(rawApp, "outsider@test.dev", "outsider");
    const asOutsider = asUser(rawApp, outsider.token);
    for (const url of [
      `/workspaces/${workspaceId}/automation/comparison`,
      `/workspaces/${workspaceId}/automation/shadow-pairs`,
      `/workspaces/${workspaceId}/automation/rollout-decisions`,
    ]) {
      const res = await asOutsider.inject({ method: "GET", url });
      expect([403, 404]).toContain(res.statusCode);
    }
  });
});
