import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { drafts, workspaces } from "../src/db/schema";
import {
  completeTurn,
  countCompletedRevisionTurnsSince,
  createRunningTurn,
  failTurn,
  getTurnByRequest,
  listRevisionTurns,
} from "../src/services/draft-revisions";
import { createTestDb } from "./helpers";

describe("draft revision persistence", () => {
  let db: Db;
  let workspaceId: string;
  let draftId: string;

  beforeEach(async () => {
    db = await createTestDb();
    workspaceId = randomUUID();
    draftId = randomUUID();
    await db.insert(workspaces)
      .values({ id: workspaceId, name: "Editor", createdAt: 1, updatedAt: 1 });
    await db.insert(drafts)
      .values({
        id: draftId,
        workspaceId,
        sourceGenerationId: null,
        sourceSignalId: null,
        campaignId: null,
        leadId: null,
        mediaContactId: null,
        taskType: "linkedin_post",
        channel: "linkedin",
        personaId: null,
        originalContent: "Original",
        content: "Original",
        state: "pending_review",
        reviewJson: null,
        mediaJson: null,
        createdAt: 2,
        updatedAt: 2,
      });
  });

  function runningInput(requestId = randomUUID()) {
    return {
      requestId,
      workspaceId,
      draftId,
      actorId: null,
      instruction: "Make it shorter.",
      sourceContent: "Original",
    };
  }

  it("persists a running turn and completes it with provenance", async () => {
    const running = await createRunningTurn(db, runningInput());
    expect(running.status).toBe("running");
    expect(running.contextSections).toEqual([]);

    const completed = await completeTurn(db, workspaceId, running.id, {
      resultContent: "Short",
      contextSections: [
        {
          key: "voice",
          layer: "org",
          title: "Voice",
          content: "Direct",
          included: true,
          reason: "Constitutional",
          tokens: 1,
          evidence: null,
        },
      ],
      model: "fake-model",
      provider: "fake",
      durationMs: 5,
    });

    expect(completed).toMatchObject({
      status: "completed",
      resultContent: "Short",
      model: "fake-model",
      error: null,
    });
    expect(await listRevisionTurns(db, workspaceId, draftId)).toEqual([completed]);
  });

  it("marks a turn failed without result metadata", async () => {
    const running = await createRunningTurn(db, runningInput());
    const failed = await failTurn(db, workspaceId, running.id, "provider down");
    expect(failed).toMatchObject({
      status: "failed",
      error: "provider down",
      resultContent: null,
      model: null,
    });
  });

  it("finds a turn by its draft-scoped request id", async () => {
    const requestId = randomUUID();
    const running = await createRunningTurn(db, runningInput(requestId));
    expect(await getTurnByRequest(db, workspaceId, draftId, requestId)).toEqual(running);
    expect(await getTurnByRequest(db, workspaceId, draftId, randomUUID())).toBeUndefined();
  });

  it("enforces one request id per draft", async () => {
    const input = runningInput();
    await createRunningTurn(db, input);
    expect(async () => await createRunningTurn(db, input)).toThrow();
  });

  it("orders turns oldest first", async () => {
    const first = await createRunningTurn(db, runningInput(), 10);
    const second = await createRunningTurn(db, runningInput(), 20);
    expect((await listRevisionTurns(db, workspaceId, draftId)).map((turn) => turn.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("counts only completed turns since the boundary", async () => {
    const completed = await createRunningTurn(db, runningInput(), 100);
    await completeTurn(db, workspaceId, completed.id, {
      resultContent: "Short",
      contextSections: [],
      model: "fake-model",
      provider: "fake",
      durationMs: 5,
    }, 110);
    const failed = await createRunningTurn(db, runningInput(), 120);
    await failTurn(db, workspaceId, failed.id, "provider down", 130);
    expect(await countCompletedRevisionTurnsSince(db, workspaceId, 105)).toBe(1);
    expect(await countCompletedRevisionTurnsSince(db, workspaceId, 115)).toBe(0);
  });
});
