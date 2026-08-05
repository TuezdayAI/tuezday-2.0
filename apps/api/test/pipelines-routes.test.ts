import { beforeEach, describe, expect, it } from "vitest";
import {
  listPipelineDefinitionsResponseSchema,
  pipelineRunDetailSchema,
  pipelineRunSchema,
  REFERENCE_SIGNAL_SOCIAL_POST_SPEC,
  type PipelineSpec,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { drafts, signals } from "../src/db/schema";
import { ScriptedGateway } from "../src/llm/scripted";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

const SIGNAL_ID = "11111111-1111-4111-8111-111111111111";

const draftOut = (content: string) => ({ text: JSON.stringify({ content }) });
const findingsOut = (score: number) => ({
  text: JSON.stringify({ score, findings: [], guardrailUncertain: false }),
});

/** Enough scripted steps for several reference-definition runs: each run
 * consumes research, angle, draft, critique (score 90 → revise skipped). */
function referenceScript(runs: number) {
  const one = [
    {
      text: JSON.stringify({
        summary: "Summary.",
        keyFacts: ["Fact"],
        sources: [],
      }),
    },
    { text: JSON.stringify({ angles: [{ title: "Angle", rationale: "Why" }] }) },
    draftOut("Pipeline post"),
    findingsOut(90),
  ];
  return Array.from({ length: runs }, () => one).flat();
}

describe("pipeline routes (Sprint 64)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: new ScriptedGateway(referenceScript(4)) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Pipelines" } })
    ).json().id;
    db.insert(signals)
      .values({
        id: SIGNAL_ID,
        workspaceId,
        content: "A competitor raised a Series B.",
        source: "manual",
        sourceUrl: null,
        createdAt: Date.now(),
      })
      .run();
  });

  it("seeds and lists the reference definition, edits it into a new version, and activates it", async () => {
    const list = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/pipelines` });
    expect(list.statusCode).toBe(200);
    const parsed = listPipelineDefinitionsResponseSchema.parse(list.json());
    expect(parsed.definitions).toHaveLength(1);
    const definition = parsed.definitions[0]!;
    expect(definition.status).toBe("draft");
    expect(definition.currentVersion).toBe(1);

    const edited = JSON.parse(JSON.stringify(REFERENCE_SIGNAL_SOCIAL_POST_SPEC)) as PipelineSpec;
    edited.steps[4]!.loop!.threshold = 80;
    const put = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/pipelines/${definition.id}`,
      payload: { spec: edited },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().currentVersion).toBe(2);

    const activate = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pipelines/${definition.id}/activate`,
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().status).toBe("active");

    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/pipelines/${definition.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().versions.map((version: { version: number }) => version.version)).toEqual([
      2, 1,
    ]);

    const invalid = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/pipelines/${definition.id}`,
      payload: { spec: { steps: [], budget: { maxTokens: 10_000 } } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_input");
  });

  it("runs a live pipeline over HTTP and lands a draft at the gate", async () => {
    const definitionId = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/pipelines` })
    ).json().definitions[0].id;

    const missingSignal = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pipelines/${definitionId}/run`,
      payload: { signalId: "99999999-9999-4999-8999-999999999999", channel: "linkedin" },
    });
    expect(missingSignal.statusCode).toBe(404);
    expect(missingSignal.json().error).toBe("signal_not_found");

    const run = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pipelines/${definitionId}/run`,
      payload: { signalId: SIGNAL_ID, channel: "linkedin", idempotencyKey: "sig:1" },
    });
    expect(run.statusCode).toBe(201);
    const body = pipelineRunSchema.parse(run.json());
    expect(body.status).toBe("succeeded");
    expect(body.draftId).not.toBeNull();
    expect(body.checklist.map((entry) => entry.stepKey)).toContain("propose");

    const draftRows = db.select().from(drafts).all();
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]!.state).toBe("pending_review");

    const duplicate = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pipelines/${definitionId}/run`,
      payload: { signalId: SIGNAL_ID, channel: "linkedin", idempotencyKey: "sig:1" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("duplicate_run");

    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/pipeline-runs/${body.id}`,
    });
    expect(detail.statusCode).toBe(200);
    const runDetail = pipelineRunDetailSchema.parse(detail.json());
    expect(runDetail.steps.length).toBeGreaterThanOrEqual(5);
    expect(runDetail.steps.filter((step) => step.agentRunId).length).toBe(4);
  });

  it("dry-runs over HTTP without writing drafts and lists the stored runs", async () => {
    const definitionId = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/pipelines` })
    ).json().definitions[0].id;

    const dryRun = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pipelines/${definitionId}/dry-run`,
      payload: { limit: 1 },
    });
    expect(dryRun.statusCode).toBe(201);
    const body = dryRun.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].proposal.simulated).toBe(true);
    expect(db.select().from(drafts).all()).toHaveLength(0);

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/pipeline-runs?mode=dry_run`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);

    const badFilter = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/pipeline-runs?status=exploded`,
    });
    expect(badFilter.statusCode).toBe(400);
  });

  it("validates decisions and 404s unknown runs", async () => {
    const noReason = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pipeline-runs/33333333-3333-4333-8333-333333333333/decision`,
      payload: { action: "cancel" },
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error).toBe("invalid_input");

    const unknown = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pipeline-runs/33333333-3333-4333-8333-333333333333/decision`,
      payload: { action: "cancel", reason: "gone" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("hides the workspace from non-members", async () => {
    const outsider = await registerUser(app, "outsider@test.dev", "outsider");
    const asOutsider = asUser(app, outsider.token);
    const res = await asOutsider.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/pipelines`,
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});
