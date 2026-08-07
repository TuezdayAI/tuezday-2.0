import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextActionStateSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { connections, workspaceMembers } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb, registerUser } from "./helpers";

const fakeGateway: LlmGateway = {
  async generate() {
    return { text: "Generated post text.", model: "fake-model", provider: "fake", durationMs: 5 };
  },
};

describe("next-action API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: fakeGateway });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Guided" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function fetchNextAction() {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/next-action`,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  /** Generate → submit, returning the pending_review draft id. */
  async function submitDraft(): Promise<string> {
    const generationId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      })
    ).json().id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/generations/${generationId}/submit`,
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it("fresh workspace points at the first unmet checklist item", async () => {
    const body = await fetchNextAction();
    expect(nextActionStateSchema.safeParse(body.state).success).toBe(true);
    expect(body.nextAction).toMatchObject({
      kind: "checklist",
      checklistItem: "brain_reviewed",
      module: "/brain",
    });
    expect(body.checklist).toEqual({ done: 0, total: 6, complete: false });
    expect(body.state.draftCount).toBe(0);
  });

  it("counts a pending draft but no longer ranks it (Sprint 70, D-70.9)", async () => {
    await submitDraft();
    const body = await fetchNextAction();
    // The count is still real state the UI shows.
    expect(body.state.draftCount).toBe(1);
    // But the draft is the inbox's item to rank, not this engine's. Setup is
    // still incomplete here, so the setup answer stands.
    expect(body.nextAction).toMatchObject({
      kind: "checklist",
      checklistItem: "brain_reviewed",
    });
  });

  it("counts checklist items from real state and moves to campaign content", async () => {
    // brain_reviewed: a human save creates a version beyond the seeded state.
    const brainRes = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We believe in shipping." },
    });
    expect(brainRes.statusCode).toBe(200);

    // first_campaign: an active campaign (with no content attached yet).
    const campaignRes = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/campaigns`,
      payload: { name: "Launch week" },
    });
    expect(campaignRes.statusCode).toBe(201);

    // first_approval: approve a submitted draft (not attached to the campaign).
    const draftId = await submitDraft();
    const approveRes = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/approve`,
    });
    expect(approveRes.statusCode).toBe(200);

    // channel_connected: a connected social-category connection. Inserted
    // directly — the real connect flow round-trips through Nango.
    const now = Date.now();
    await db.insert(connections)
      .values({
        id: randomUUID(),
        workspaceId,
        providerKey: "reddit",
        nangoConnectionId: "nango-test-1",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // team_invited: a second member (inserted directly; the invite flow is
    // covered by teams.test.ts).
    const teammate = await registerUser(app, "teammate@test.dev", "Teammate");
    await db.insert(workspaceMembers)
      .values({
        id: randomUUID(),
        workspaceId,
        userId: teammate.id,
        role: "member",
        createdAt: now,
      })
      .run();

    const body = await fetchNextAction();
    expect(body.state.checklist).toEqual({
      brain_reviewed: true,
      channel_connected: true,
      first_campaign: true,
      first_approval: true,
      insights_live: false, // stubbed false until the insights slice lands
      team_invited: true,
    });
    expect(body.checklist).toEqual({ done: 5, total: 6, complete: false });

    // The campaign-without-content count is still real state, but Sprint 70
    // stopped this engine ranking it (D-70.9): the remaining unmet setup step
    // is the only thing left for it to answer, and the campaign shows up in
    // the inbox as a campaign risk instead.
    expect(body.state.draftCount).toBe(0);
    expect(body.state.liveCampaignsWithoutContent).toBe(1);
    expect(body.nextAction).toMatchObject({
      kind: "checklist",
      checklistItem: "insights_live",
    });
  });

  it("returns 404 for an unknown workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${randomUUID()}/next-action`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("workspace_not_found");
  });
});
