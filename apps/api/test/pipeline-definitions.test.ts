import { describe, expect, it } from "vitest";
import {
  REFERENCE_SIGNAL_SOCIAL_POST_SPEC,
  type PipelineSpec,
} from "@tuezday/contracts";
import { campaignLanes, campaigns, workspaces } from "../src/db/schema";
import {
  createPipelineDefinition,
  ensurePipelineDefinitions,
  getPipelineDefinitionDetail,
  listPipelineDefinitions,
  resolvePipelineDefinition,
  setPipelineStatus,
  updatePipelineSpec,
} from "../src/services/pipeline-definitions";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "ws-pipelines";
const CAMPAIGN_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CAMPAIGN_ID = "55555555-5555-4555-8555-555555555555";
const LANE_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR = { userId: null, label: "founder" };

async function fixture() {
  const db = await createTestDb();
  await db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Pipelines", createdAt: 1, updatedAt: 1 });
  for (const id of [CAMPAIGN_ID, OTHER_CAMPAIGN_ID]) {
    await db.insert(campaigns)
      .values({ id, workspaceId: WORKSPACE_ID, name: `Campaign ${id.slice(0, 4)}`, createdAt: 1, updatedAt: 1 });
  }
  await db.insert(campaignLanes)
    .values({
      id: LANE_ID,
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      key: "founder-linkedin",
      name: "Founder LinkedIn",
      createdAt: 1,
      updatedAt: 1,
    });
  return db;
}

function spec(): PipelineSpec {
  return JSON.parse(JSON.stringify(REFERENCE_SIGNAL_SOCIAL_POST_SPEC)) as PipelineSpec;
}

describe("pipeline definitions", () => {
  it("seeds the reference definition once, as a draft at version 1", async () => {
    const db = await fixture();
    await ensurePipelineDefinitions(db, WORKSPACE_ID);
    await ensurePipelineDefinitions(db, WORKSPACE_ID);
    const definitions = await listPipelineDefinitions(db, WORKSPACE_ID);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      taskKey: "signal_social_post",
      status: "draft",
      currentVersion: 1,
      campaignId: null,
      laneId: null,
    });
    expect(definitions[0]!.spec.steps.map((step) => step.key)).toEqual(
      REFERENCE_SIGNAL_SOCIAL_POST_SPEC.steps.map((step) => step.key),
    );
    const detail = (await getPipelineDefinitionDetail(db, WORKSPACE_ID, definitions[0]!.id))!;
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]).toMatchObject({ version: 1, actorLabel: "system" });
  });

  it("bumps the version and appends history on every spec edit", async () => {
    const db = await fixture();
    await ensurePipelineDefinitions(db, WORKSPACE_ID);
    const definition = (await listPipelineDefinitions(db, WORKSPACE_ID))[0]!;

    const edited = spec();
    edited.steps[4]!.loop!.threshold = 85;
    const updated = await updatePipelineSpec(
      db,
      WORKSPACE_ID,
      definition.id,
      { spec: edited, name: "Tightened reference" },
      ACTOR,
    );
    expect(updated.currentVersion).toBe(2);
    expect(updated.name).toBe("Tightened reference");
    expect(updated.spec.steps[4]!.loop!.threshold).toBe(85);

    const detail = (await getPipelineDefinitionDetail(db, WORKSPACE_ID, definition.id))!;
    expect(detail.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(detail.versions[0]!.actorLabel).toBe("founder");
    // History is immutable: version 1 still carries the original threshold.
    expect(detail.versions[1]!.spec.steps[4]!.loop!.threshold).toBe(70);
  });

  it("activation demotes only the active sibling in the same exact scope", async () => {
    const db = await fixture();
    await ensurePipelineDefinitions(db, WORKSPACE_ID);
    const workspaceScoped = (await listPipelineDefinitions(db, WORKSPACE_ID))[0]!;
    const campaignScoped = await createPipelineDefinition(
      db,
      WORKSPACE_ID,
      {
        taskKey: "signal_social_post",
        name: "Launch campaign variant",
        description: "",
        campaignId: CAMPAIGN_ID,
        spec: spec(),
      },
      ACTOR,
    );

    await setPipelineStatus(db, WORKSPACE_ID, workspaceScoped.id, "active");
    await setPipelineStatus(db, WORKSPACE_ID, campaignScoped.id, "active");
    // Different scopes — both stay active.
    const statuses = new Map(
      (await listPipelineDefinitions(db, WORKSPACE_ID)).map((definition) => [
        definition.id,
        definition.status,
      ]),
    );
    expect(statuses.get(workspaceScoped.id)).toBe("active");
    expect(statuses.get(campaignScoped.id)).toBe("active");

    // A second workspace-scoped definition demotes the first on activation.
    const rival = await createPipelineDefinition(
      db,
      WORKSPACE_ID,
      { taskKey: "signal_social_post", name: "Rival", description: "", spec: spec() },
      ACTOR,
    );
    await setPipelineStatus(db, WORKSPACE_ID, rival.id, "active");
    const after = new Map(
      (await listPipelineDefinitions(db, WORKSPACE_ID)).map((definition) => [
        definition.id,
        definition.status,
      ]),
    );
    expect(after.get(rival.id)).toBe("active");
    expect(after.get(workspaceScoped.id)).toBe("draft");
    expect(after.get(campaignScoped.id)).toBe("active");
  });

  it("resolves the most specific active definition: lane > campaign > workspace", async () => {
    const db = await fixture();
    const campaignId = CAMPAIGN_ID;
    const laneId = LANE_ID;
    const workspaceScoped = await createPipelineDefinition(
      db,
      WORKSPACE_ID,
      { taskKey: "signal_social_post", name: "Default", description: "", spec: spec() },
      ACTOR,
    );
    const campaignScoped = await createPipelineDefinition(
      db,
      WORKSPACE_ID,
      { taskKey: "signal_social_post", name: "Campaign", description: "", campaignId, spec: spec() },
      ACTOR,
    );
    const laneScoped = await createPipelineDefinition(
      db,
      WORKSPACE_ID,
      {
        taskKey: "signal_social_post",
        name: "Lane",
        description: "",
        campaignId,
        laneId,
        spec: spec(),
      },
      ACTOR,
    );

    // Nothing active yet.
    expect(
      await resolvePipelineDefinition(db, { workspaceId: WORKSPACE_ID, taskKey: "signal_social_post" }),
    ).toBeUndefined();

    await setPipelineStatus(db, WORKSPACE_ID, workspaceScoped.id, "active");
    await setPipelineStatus(db, WORKSPACE_ID, campaignScoped.id, "active");
    await setPipelineStatus(db, WORKSPACE_ID, laneScoped.id, "active");

    expect(
      (await resolvePipelineDefinition(db, {
        workspaceId: WORKSPACE_ID,
        taskKey: "signal_social_post",
        campaignId,
        laneId,
      }))?.id,
    ).toBe(laneScoped.id);
    expect(
      (await resolvePipelineDefinition(db, {
        workspaceId: WORKSPACE_ID,
        taskKey: "signal_social_post",
        campaignId,
      }))?.id,
    ).toBe(campaignScoped.id);
    expect(
      (await resolvePipelineDefinition(db, {
        workspaceId: WORKSPACE_ID,
        taskKey: "signal_social_post",
        campaignId: OTHER_CAMPAIGN_ID,
      }))?.id,
    ).toBe(workspaceScoped.id);
  });
});
