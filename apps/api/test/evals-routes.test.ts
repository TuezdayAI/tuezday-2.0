import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { GatewayError } from "../src/llm/gateway";
import type {
  AgentStepParams,
  AgentStepResult,
  GenerateResult,
  LlmGateway,
} from "../src/llm/gateway";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import {
  ensurePipelineDefinitions,
  listPipelineDefinitions,
  setPipelineStatus,
} from "../src/services/pipeline-definitions";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

/**
 * Seeding history needs generate(); replaying needs agentStep(). One gateway
 * does both — but only pipeline steps may draw on the script. Pre-review also
 * reaches for agentStep when a gateway exposes it, and letting it consume
 * script entries would starve the replay.
 */
function dualGateway(script: ScriptedStep[]): LlmGateway {
  const scripted = new ScriptedGateway(script);
  let n = 0;
  return {
    async generate(): Promise<GenerateResult> {
      n += 1;
      return {
        text: `Historical take ${n} on usage-based pricing.`,
        model: "fake-model",
        provider: "fake",
        durationMs: 1,
      };
    },
    async agentStep(params: AgentStepParams): Promise<AgentStepResult> {
      if (!params.system?.includes("content pipeline for the workspace")) {
        throw new GatewayError("provider_error", "Only pipeline steps are scripted here.");
      }
      return await scripted.agentStep(params);
    },
  };
}

function caseScript(content: string): ScriptedStep[] {
  return [
    { text: JSON.stringify({ summary: "s", keyFacts: ["f"], sources: [] }) },
    { text: JSON.stringify({ angles: [{ title: "t", rationale: "r" }] }) },
    { text: JSON.stringify({ content }) },
    { text: JSON.stringify({ score: 90, findings: [], guardrailUncertain: false }) },
  ];
}

const CLEAN =
  "A competitor moved to usage-based pricing, and the interesting part is what it says " +
  "about who they now think their buyer is.";

describe("Sprint 67 — eval routes", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({
      db,
      llm: dualGateway([...caseScript(CLEAN), ...caseScript(CLEAN)]),
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Evals" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedDecidedDraft(content: string, action: "approve" | "reject") {
    const signal = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/signals`,
      payload: { content, source: "other" },
    });
    const draft = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/signals/${signal.json().id}/draft`,
      payload: { channel: "linkedin" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draft.json().id}/${action}`,
      ...(action === "reject" ? { payload: { reason: "Too pitchy" } } : {}),
    });
    expect(res.statusCode).toBe(200);
  }

  describe("banned claims", () => {
    it("adds, lists, deduplicates and removes", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/banned-claims`,
        payload: { phrase: "guaranteed results" },
      });
      expect(created.statusCode).toBe(201);
      const claimId = created.json().id;

      // Adding the same phrase again returns the existing row rather than a duplicate.
      const again = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/banned-claims`,
        payload: { phrase: "guaranteed results" },
      });
      expect(again.json().id).toBe(claimId);

      const listed = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/banned-claims`,
      });
      expect(listed.json().claims).toHaveLength(1);

      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/workspaces/${workspaceId}/banned-claims/${claimId}`,
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/workspaces/${workspaceId}/banned-claims/${claimId}`,
          })
        ).statusCode,
      ).toBe(404);
    });

    it("rejects a phrase too short to match on", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/banned-claims`,
        payload: { phrase: "a" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("suites and runs", () => {
    it("builds a suite, replays it, and reports the comparison", async () => {
      await seedDecidedDraft("Competitor published usage-based pricing.", "approve");
      await seedDecidedDraft("A rival announced a cloud partnership.", "reject");
      await ensurePipelineDefinitions(db, workspaceId);
      const definition = (await listPipelineDefinitions(db, workspaceId))[0]!;
      await setPipelineStatus(db, workspaceId, definition.id, "active");

      const suiteRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/evals/suites`,
        payload: { name: "baseline", channel: "linkedin", limit: 10 },
      });
      expect(suiteRes.statusCode).toBe(201);
      const suiteId = suiteRes.json().suite.id;
      expect(suiteRes.json().suite.caseCount).toBe(2);

      const casesRes = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/evals/suites/${suiteId}/cases`,
      });
      expect(casesRes.json().cases).toHaveLength(2);

      const runRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/evals/runs`,
        payload: { suiteId, judge: false, baselineLabel: "pre-66" },
      });
      expect(runRes.statusCode).toBe(201);
      const run = runRes.json();
      expect(run.status).toBe("succeeded");
      expect(run.metrics.completed).toBe(2);
      expect(run.baselineLabel).toBe("pre-66");
      expect(run.results).toHaveLength(2);

      const detail = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/evals/runs/${run.id}`,
      });
      expect(detail.json().results).toHaveLength(2);

      // Compared against itself there is no baseline to use, so everything is skipped.
      const comparison = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/evals/runs/${run.id}/comparison`,
      });
      expect(comparison.statusCode).toBe(200);
      expect(comparison.json().baselineRunId).toBeNull();
      expect(comparison.json().skipped.length).toBeGreaterThan(0);

      const runs = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/evals/runs`,
      });
      expect(runs.json().runs).toHaveLength(1);
    });

    it("409s when no pipeline definition is active to replay through", async () => {
      await seedDecidedDraft("Competitor published usage-based pricing.", "approve");
      const suiteRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/evals/suites`,
        payload: { name: "no-definition" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/evals/runs`,
        payload: { suiteId: suiteRes.json().suite.id },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("no_active_definition");
    });

    it("404s on an unknown suite and 400s on invalid input", async () => {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${workspaceId}/evals/runs`,
            payload: { suiteId: "6a1f8f6e-8a4e-4e21-9a63-0dfc1f2a2b11" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${workspaceId}/evals/suites`,
            payload: { name: "", limit: 999 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${workspaceId}/evals/runs/6a1f8f6e-8a4e-4e21-9a63-0dfc1f2a2b11/baseline`,
            payload: { baselineLabel: "x" },
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  describe("auth", () => {
    it("refuses a non-member and an unauthenticated caller", async () => {
      const stranger = await registerUser(app, "stranger@test.dev", "stranger");
      const asStranger = asUser(app, stranger.token);
      expect(
        (
          await asStranger.inject({
            method: "GET",
            url: `/workspaces/${workspaceId}/evals/runs`,
          })
        ).statusCode,
      ).toBe(403);

      const anonymous = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/evals/suites`,
        headers: { authorization: "" },
      });
      expect(anonymous.statusCode).toBe(401);
    });
  });
});
