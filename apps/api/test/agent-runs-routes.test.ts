import { beforeEach, describe, expect, it } from "vitest";
import {
  agentRunDetailSchema,
  agentRunSummarySchema,
  type AgentRunDetail,
  type AgentRunSummary,
} from "@tuezday/contracts";
import type { Db } from "../src/db";
import { ScriptedGateway } from "../src/llm/scripted";
import type { TuezdayApp } from "../src/app";
import { buildApp } from "../src/app";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

// The proof route drives the REAL registry (all eleven read tools declared to
// the model) against a scripted gateway — no network, real persistence.
function proofScript() {
  return new ScriptedGateway([
    {
      toolCalls: [{ name: "get_brain_section", arguments: { query: "voice tone" } }],
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
    },
    {
      text: "The brain has no written content yet, so I cannot answer from it.",
      usage: { inputTokens: 150, outputTokens: 30, cachedTokens: 0 },
    },
  ]);
}

let db: Db;
let app: TuezdayApp;

async function createWorkspace(name = "Inspector"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/workspaces", payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("agent run routes", () => {
  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({ db, llm: proofScript() });
  });

  it("runs a proof agent over the registry and exposes the full trace", async () => {
    const workspaceId = await createWorkspace();

    const proof = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-runs/proof`,
      payload: { question: "What is our tone of voice?" },
    });
    expect(proof.statusCode).toBe(201);
    const { runId, stopReason } = proof.json() as { runId: string; stopReason: string };
    expect(stopReason).toBe("complete");

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs`,
    });
    expect(list.statusCode).toBe(200);
    const runs = (list.json() as { runs: AgentRunSummary[] }).runs;
    expect(runs).toHaveLength(1);
    const summary = agentRunSummarySchema.parse(runs[0]);
    expect(summary.id).toBe(runId);
    expect(summary.task).toBe("proof");
    expect(summary.createdBy).toBe("founder");
    expect(summary.status).toBe("done");
    expect(summary.usage.inputTokens).toBe(250);
    expect(summary.finishedAt).not.toBeNull();

    const detailRes = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs/${runId}`,
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = agentRunDetailSchema.parse(detailRes.json()) as AgentRunDetail;
    expect(detail.system).toContain("workspace research agent");
    expect(detail.inputMessages[0]!.content).toBe("What is our tone of voice?");
    expect(detail.steps.map((s) => s.kind)).toEqual(["model_call", "tool_call", "model_call"]);
    const toolStep = detail.steps[1]!;
    expect(toolStep.toolName).toBe("get_brain_section");
    expect(toolStep.toolArgs).toEqual({ query: "voice tone" });
    expect(toolStep.toolResult).toMatchObject({ sections: [] });
    expect(detail.output).toContain("no written content");
  });

  it("filters the list by task and honors limit", async () => {
    const workspaceId = await createWorkspace();
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-runs/proof`,
      payload: { question: "Anything?" },
    });

    const byTask = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs?task=proof&limit=1`,
    });
    expect((byTask.json() as { runs: unknown[] }).runs).toHaveLength(1);

    const byOtherTask = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs?task=pipeline:research`,
    });
    expect((byOtherTask.json() as { runs: unknown[] }).runs).toHaveLength(0);
  });

  it("rejects a malformed proof request", async () => {
    const workspaceId = await createWorkspace();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-runs/proof`,
      payload: { question: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
  });

  it("404s an unknown run and keeps other workspaces' runs invisible", async () => {
    const workspaceId = await createWorkspace();
    const proof = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agent-runs/proof`,
      payload: { question: "Hello?" },
    });
    const { runId } = proof.json() as { runId: string };

    const missing = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs/does-not-exist`,
    });
    expect(missing.statusCode).toBe(404);

    // A different user with their own workspace: the guard forbids the foreign
    // workspace outright, and the foreign run id resolves to nothing in theirs.
    const rawApp = await buildApp({ db, llm: proofScript() });
    const intruder = await registerUser(rawApp, "intruder@test.dev", "intruder");
    const intruderApp = asUser(rawApp, intruder.token);
    const intruderWorkspace = await (async () => {
      const res = await intruderApp.inject({
        method: "POST",
        url: "/workspaces",
        payload: { name: "Other" },
      });
      return res.json().id as string;
    })();

    const forbidden = await intruderApp.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs`,
    });
    expect(forbidden.statusCode).toBe(403);

    const crossRun = await intruderApp.inject({
      method: "GET",
      url: `/workspaces/${intruderWorkspace}/agent-runs/${runId}`,
    });
    expect(crossRun.statusCode).toBe(404);
  });
});
