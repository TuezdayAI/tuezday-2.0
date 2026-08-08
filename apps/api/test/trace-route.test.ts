import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Channel } from "@tuezday/contracts";
import { artifactTraceSchema, knobUsageReportSchema } from "@tuezday/contracts";
import { defaultResolvedMatrix, resolveContext } from "@tuezday/brain";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  contextSnapshots,
  deliverables,
  drafts,
  generations,
  guidanceOverrides,
  variants,
} from "../src/db/schema";
import { activatePlanRevision, createPlanRevision } from "../src/services/campaign-plans";
import { upsertLaneRevision } from "../src/services/campaign-lanes";
import { buildAuthedApp, createTestDb, registerUser } from "./helpers";

const ACTOR = { userId: null, label: "founder" };

const DOCS = {
  soul: "# Soul\nWe help founders sell without a sales team.",
  icp: "# ICP\nSeed-stage B2B founders.",
  voice: "# Voice\nPlain, specific, never breathless.",
  history: "# History\nWe launched in 2024.",
  now: "# Now\nShipping the pricing page rewrite.",
};

function bundle(channel: Channel = "linkedin") {
  return resolveContext({
    workspaceName: "Acme",
    docs: DOCS,
    taskType: "linkedin_post",
    channel,
    matrix: defaultResolvedMatrix(),
  });
}

describe("the trace surface over HTTP (Sprint 71)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let personaId: string;
  let campaignId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({ db });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })
    ).json().id;
    personaId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Founder" },
      })
    ).json().id;
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Pricing rewrite" },
      })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedDraft(): Promise<string> {
    const generationId = randomUUID();
    const draftId = randomUUID();
    const resolved = bundle();
    await db.insert(generations)
      .values({
        id: generationId,
        workspaceId,
        taskType: "linkedin_post",
        channel: "linkedin",
        prompt: resolved.prompt,
        sectionsJson: JSON.stringify(resolved.sections),
        output: "A post about usage-based pricing.",
        model: "gemini-2.5-flash",
        provider: "google",
        durationMs: 900,
        createdAt: 20,
      });
    await db.insert(drafts)
      .values({
        id: draftId,
        workspaceId,
        sourceGenerationId: generationId,
        sourceSignalId: null,
        taskType: "linkedin_post",
        channel: "linkedin",
        originalContent: "A post about usage-based pricing.",
        content: "A post about usage-based pricing.",
        state: "pending_review",
        createdAt: 21,
        updatedAt: 21,
      });
    return draftId;
  }

  const traceUrl = (kind: string, id: string) => `/workspaces/${workspaceId}/trace/${kind}/${id}`;

  it("serves a draft's trace under the contract", async () => {
    const draftId = await seedDraft();
    const res = await app.inject({ method: "GET", url: traceUrl("draft", draftId) });
    expect(res.statusCode).toBe(200);
    const trace = artifactTraceSchema.parse(res.json());
    expect(trace.subject.id).toBe(draftId);
    expect(trace.context.length).toBeGreaterThan(0);
    expect(trace.knobs).toHaveLength(9);
  });

  it("rejects a subject kind it does not know instead of guessing", async () => {
    const res = await app.inject({ method: "GET", url: traceUrl("campaign", randomUUID()) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_subject_kind");
  });

  it("404s a subject that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: traceUrl("draft", randomUUID()) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("subject_not_found");
  });

  it("traces a deliverable through its latest variant's context snapshot", async () => {
    const revision = await createPlanRevision(
      db,
      workspaceId,
      campaignId,
      {
        objective: "Land usage-based pricing",
        kpi: "Qualified conversations",
        timeframe: "Q3",
        startAt: null,
        endAt: null,
        audienceIds: [],
        pillars: ["Usage-based pricing is the honest default", "Hiring"],
        offers: [],
        ctas: [],
        guidance: "",
      },
      ACTOR,
    );
    const lane = await upsertLaneRevision(
      db,
      workspaceId,
      campaignId,
      revision.id,
      {
        key: "founder-linkedin",
        name: "Founder LinkedIn",
        personaId,
        audienceId: null,
        channel: "linkedin",
        format: "linkedin_post",
        publishingConnectionId: null,
        providerTarget: "feed",
        deliveryMode: "planned",
        plannedQuantity: 1,
        schedule: { daysOfWeek: [2], timeOfDay: "10:00", timezone: "Asia/Kolkata" },
        reactivePeriod: null,
        reactiveCap: null,
        status: "active",
      },
    );
    await activatePlanRevision(db, workspaceId, campaignId, revision.id);

    const deliverableId = randomUUID();
    await db.insert(deliverables)
      .values({
        id: deliverableId,
        workspaceId,
        campaignId,
        planRevisionId: revision.id,
        laneId: lane.laneId,
        laneRevisionId: lane.id,
        kind: "planned",
        originalScheduledFor: 1_000,
        packageId: null,
        angle: "Usage-based pricing is the honest default",
        angleHash: "hash",
        status: "generated",
        createdAt: 30,
        updatedAt: 30,
      });
    const snapshotId = randomUUID();
    await db.insert(contextSnapshots)
      .values({
        id: snapshotId,
        workspaceId,
        deliverableId,
        packageId: null,
        resolvedContextJson: JSON.stringify(bundle()),
        inputsJson: "{}",
        model: "gemini-2.5-flash",
        provider: "google",
        createdAt: 31,
      });
    await db.insert(variants)
      .values({
        id: randomUUID(),
        workspaceId,
        deliverableId,
        variantVersion: 1,
        contextSnapshotId: snapshotId,
        status: "selected",
        content: "Usage-based pricing is the honest default for teams that grow.",
        model: "gemini-2.5-flash",
        provider: "google",
        durationMs: 500,
        selectedAt: 32,
        createdAt: 32,
      });

    const res = await app.inject({ method: "GET", url: traceUrl("deliverable", deliverableId) });
    expect(res.statusCode).toBe(200);
    const trace = artifactTraceSchema.parse(res.json());
    expect(trace.subject.kind).toBe("deliverable");
    expect(trace.context.length).toBeGreaterThan(0);
    // The pillar is a wording match, and the closest one wins (D-71.4).
    expect(trace.plan!.closestPillar).toBe("Usage-based pricing is the honest default");
    expect(trace.cost!.estimated).toBe(true);
  });

  it("reports knob usage for the deletion decision", async () => {
    await seedDraft();
    await db.insert(guidanceOverrides)
      .values({
        id: randomUUID(),
        workspaceId,
        channel: "x",
        personaId: null,
        campaignId: null,
        content: "Short posts on X.",
        createdAt: 1,
        updatedAt: 2,
      });
    const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/knob-usage` });
    expect(res.statusCode).toBe(200);
    const report = knobUsageReportSchema.parse(res.json());
    expect(report.knobs).toHaveLength(9);
    expect(report.sampledResolves).toBe(1);
    const guidance = report.knobs.find((knob) => knob.key === "channel_guidance_workspace")!;
    expect(guidance.configured).toBe(true);
    expect(guidance.appliedResolves).toBe(0);
  });

  it("refuses a sample size outside the bound rather than scanning everything", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/knob-usage?sampleLimit=0`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps one workspace's reasoning out of another's", async () => {
    const draftId = await seedDraft();
    const stranger = await registerUser(app, "stranger@test.dev", "Stranger");
    for (const url of [traceUrl("draft", draftId), `/workspaces/${workspaceId}/knob-usage`]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${stranger.token}` },
      });
      expect(res.statusCode).toBe(403);
    }
  });
});
