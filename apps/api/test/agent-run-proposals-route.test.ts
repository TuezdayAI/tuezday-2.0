import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRunDetailSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { agentRuns, drafts } from "../src/db/schema";
import { recordAgentProposal } from "../src/services/agent-proposal-ledger";
import { buildAuthedApp, createTestDb, registerUser } from "./helpers";

describe("agent-run inspector carries the proposal ledger (Sprint 69)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let runId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Acting" } })
    ).json().id;
    runId = randomUUID();
    db.insert(agentRuns)
      .values({
        id: runId,
        workspaceId,
        task: "pipeline:draft",
        createdBy: "founder",
        status: "done",
        stopReason: "complete",
        model: "scripted",
        provider: "scripted",
        system: "system",
        inputMessages: "[]",
        startedAt: 1,
      })
      .run();
  });

  afterEach(async () => {
    await app.close();
  });

  function seedDraft(): string {
    const id = randomUUID();
    db.insert(drafts)
      .values({
        id,
        workspaceId,
        taskType: "linkedin_post",
        channel: "linkedin",
        originalContent: "content",
        content: "content",
        state: "pending_review",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    return id;
  }

  it("returns an empty list for a run that proposed nothing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs/${runId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(agentRunDetailSchema.parse(res.json()).proposals).toEqual([]);
  });

  it("shows what the run proposed, with the reason it gave", async () => {
    const draftId = seedDraft();
    recordAgentProposal(db, {
      workspaceId,
      agentRunId: runId,
      tool: "propose_draft",
      targetKind: "draft",
      draftId,
      summary: "Submitted a linkedin draft for review.",
      rationale: "The competitor moved to usage-based pricing.",
    });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs/${runId}`,
    });
    const detail = agentRunDetailSchema.parse(res.json());
    expect(detail.proposals).toHaveLength(1);
    expect(detail.proposals[0]!.draftId).toBe(draftId);
    expect(detail.proposals[0]!.rationale).toContain("usage-based pricing");
  });

  it("keeps the proposal in the trace after its draft is deleted", async () => {
    const draftId = seedDraft();
    recordAgentProposal(db, {
      workspaceId,
      agentRunId: runId,
      tool: "propose_draft",
      targetKind: "draft",
      draftId,
      summary: "Submitted a linkedin draft for review.",
      rationale: "Worth saying now.",
    });
    db.delete(drafts).run();

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs/${runId}`,
    });
    const detail = agentRunDetailSchema.parse(res.json());
    // "The agent proposed something and it is gone" is a different, and more
    // useful, statement than "the agent proposed nothing".
    expect(detail.proposals).toHaveLength(1);
    expect(detail.proposals[0]!.draftId).toBeNull();
  });

  it("keeps one workspace's agent activity out of another's", async () => {
    const stranger = await registerUser(app, "stranger@test.dev", "stranger");
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/agent-runs/${runId}`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
