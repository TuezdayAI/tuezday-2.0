import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentInboxFeedSchema, priorityQueueSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { agentQuestions, drafts } from "../src/db/schema";
import { buildAgentInboxFeed, listWorkspacePriorities } from "../src/services/agent-inbox";
import { buildAuthedApp, createTestDb } from "./helpers";

describe("the unified inbox (Sprint 70)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({ db });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Attention" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedDraft(createdAt = 100): Promise<string> {
    const id = randomUUID();
    await db.insert(drafts)
      .values({
        id,
        workspaceId,
        taskType: "linkedin_post",
        channel: "linkedin",
        originalContent: "A post about usage-based pricing.",
        content: "A post about usage-based pricing.",
        state: "pending_review",
        createdAt,
        updatedAt: createdAt,
      });
    return id;
  }

  async function seedQuestion(createdAt = 200): Promise<string> {
    const id = randomUUID();
    await db.insert(agentQuestions)
      .values({
        id,
        workspaceId,
        agentRunId: randomUUID(),
        pipelineRunId: null,
        stepKey: "draft",
        type: "missing_permission",
        question: "May we name the investors?",
        why: "The plan does not say.",
        optionsJson: JSON.stringify(["Yes", "No"]),
        fingerprint: `fp-${id}`,
        status: "open",
        createdAt,
      });
    return id;
  }

  it("returns one feed with three lanes and honest counts", async () => {
    await seedDraft();
    await seedQuestion();
    const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/agent-inbox` });
    expect(res.statusCode).toBe(200);
    const feed = agentInboxFeedSchema.parse(res.json());

    expect(feed.counts.ask).toBe(1);
    expect(feed.counts.review).toBe(1);
    // A fresh workspace has unmet setup steps, which now live in the feed.
    expect(feed.counts.notify).toBeGreaterThan(0);
    expect(feed.items.filter((item) => item.lane === "ask")).toHaveLength(1);
    expect(feed.items.every((item) => item.lane !== "ask" || item.kind === "agent_question")).toBe(
      true,
    );
  });

  it("carries the question on its item so answering needs no second fetch", async () => {
    const questionId = await seedQuestion();
    const feed = await buildAgentInboxFeed(db, workspaceId);
    const ask = feed.items.find((item) => item.lane === "ask")!;
    expect(ask.id).toBe(questionId);
    expect(ask.question?.options).toEqual(["Yes", "No"]);
    expect(ask.title).toBe("May we name the investors?");
    expect(ask.reason).toBe("The plan does not say.");
  });

  it("ranks a stopped agent above ordinary review, and below nothing that broke", async () => {
    await seedDraft();
    await seedQuestion();
    const feed = await buildAgentInboxFeed(db, workspaceId);
    const kinds = feed.items.map((item) => item.kind);
    // D-70.10: the question is the cheapest thing on the list to clear and the
    // only one holding work still, so it leads.
    expect(kinds[0]).toBe("agent_question");
    expect(kinds.indexOf("agent_question")).toBeLessThan(kinds.indexOf("content_review"));
    // Setup steps sit at the bottom: nothing is waiting on them right now.
    expect(kinds.indexOf("setup_task")).toBeGreaterThan(kinds.indexOf("content_review"));
  });

  it("counts the whole feed, not the page", async () => {
    for (let i = 0; i < 4; i += 1) await seedDraft(100 + i);
    const feed = await buildAgentInboxFeed(db, workspaceId, { limit: 1 });
    expect(feed.items).toHaveLength(1);
    // A lane badge that shrank with the page size would be lying about how
    // much is waiting.
    expect(feed.counts.review).toBe(4);
  });

  it("keeps /priorities byte-identical to the feed minus ask and setup (D-70.8)", async () => {
    await seedDraft();
    await seedQuestion();
    const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/priorities` });
    const queue = priorityQueueSchema.parse(res.json());
    const feed = await buildAgentInboxFeed(db, workspaceId, { limit: 100 });
    const expected = feed.items
      .filter((item) => item.lane !== "ask" && item.kind !== "setup_task")
      .map((item) => item.id);
    expect(queue.items.map((item) => item.id)).toEqual(expected);
    // The projection drops the discriminator rather than exposing a new field
    // on the old contract.
    for (const item of queue.items) expect(item).not.toHaveProperty("lane");
  });

  it("drops an answered question out of the ask lane", async () => {
    const questionId = await seedQuestion();
    expect((await buildAgentInboxFeed(db, workspaceId)).counts.ask).toBe(1);
    await db.update(agentQuestions)
      .set({ status: "answered", answer: "No.", answeredAt: 300, answeredByLabel: "founder" });
    expect((await buildAgentInboxFeed(db, workspaceId)).counts.ask).toBe(0);
    expect(
      (await listWorkspacePriorities(db, workspaceId)).items.some((item) => item.id === questionId),
    ).toBe(false);
  });
});
