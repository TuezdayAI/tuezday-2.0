import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TuezdayApp } from "../src/app";
import type { AnalyticsEventInput } from "../src/analytics/sink";
import type { Db } from "../src/db";
import { drafts, generations } from "../src/db/schema";
import type { EvidenceStore } from "../src/evidence/store";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { completeTurn, createRunningTurn } from "../src/services/draft-revisions";
import { getUsage } from "../src/services/entitlements";
import { buildAuthedApp, createTestDb } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const noEvidence: EvidenceStore = {
  async health() {
    return { healthy: true };
  },
  async createCollection() {
    return "collection";
  },
  async addDocument() {
    return "document";
  },
  async attachDocument() {},
  async deleteDocument() {},
  async search() {
    return [];
  },
};

describe("conversational draft revision API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let draftId: string;
  let updatedAt: number;
  let prompts: string[];
  let captured: AnalyticsEventInput[];
  let mode: "success" | "failure" | "empty" | "deferred";
  let llmEntered: ReturnType<typeof deferred<void>>;
  let llmRelease: ReturnType<
    typeof deferred<{ text: string; model: string; provider: string; durationMs: number }>
  >;

  beforeEach(async () => {
    prompts = [];
    captured = [];
    mode = "success";
    llmEntered = deferred<void>();
    llmRelease = deferred();
    const llm: LlmGateway = {
      async generate({ prompt }) {
        prompts.push(prompt);
        if (mode === "failure") throw new GatewayError("provider_error", "provider down");
        if (mode === "empty") {
          return { text: "   ", model: "fake-model", provider: "fake", durationMs: 5 };
        }
        if (mode === "deferred") {
          llmEntered.resolve();
          return llmRelease.promise;
        }
        return { text: "Sharper copy", model: "fake-model", provider: "fake", durationMs: 5 };
      },
    };
    db = createTestDb();
    app = await buildAuthedApp({
      db,
      llm,
      evidence: noEvidence,
      analytics: { capture: (event) => captured.push(event) },
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Editor" } })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/voice`,
      payload: { content: "Be direct and specific." },
    });
    // Brain outline generation also uses the gateway; assertions below measure
    // revision calls only.
    prompts.length = 0;
    draftId = randomUUID();
    updatedAt = Date.now();
    db.insert(drafts)
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
        originalContent: "Original copy",
        content: "Original copy",
        state: "pending_review",
        reviewJson: null,
        mediaJson: null,
        createdAt: updatedAt,
        updatedAt,
      })
      .run();
  });

  afterEach(async () => {
    await app.close();
  });

  function revise(requestId = randomUUID(), expectedDraftUpdatedAt = updatedAt) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/revise`,
      payload: {
        requestId,
        instruction: "Make the opening sharper.",
        expectedDraftUpdatedAt,
      },
    });
  }

  async function editor() {
    return (
      await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/drafts/${draftId}/editor`,
      })
    ).json();
  }

  it("revises with current context and records the canonical edit decision", async () => {
    const beforeUsage = getUsage(db, workspaceId).monthlyGenerations;
    const response = await revise();
    expect(response.statusCode).toBe(200);
    expect(response.json().draft).toMatchObject({ state: "edited", content: "Sharper copy" });
    expect(response.json().turn).toMatchObject({
      status: "completed",
      resultContent: "Sharper copy",
      model: "fake-model",
    });
    expect(prompts[0]).toContain("Make the opening sharper.");
    expect(prompts[0]).toContain("CURRENT DRAFT");
    expect(prompts[0]).toContain("Be direct and specific.");
    const context = await editor();
    expect(context.decisions.at(-1)).toMatchObject({ action: "edit", toState: "edited" });
    expect(context.contextSections.length).toBeGreaterThan(0);
    expect(context.contextSections.find((section: { key: string }) => section.key === "evidence"))
      .toMatchObject({ included: false, reason: expect.stringContaining("no evidence") });
    expect(getUsage(db, workspaceId).monthlyGenerations).toBe(beforeUsage + 1);
    expect(captured.filter((event) => event.event === "review.revision_requested"))
      .toHaveLength(1);
  });

  it("returns the stored completed result for a duplicate request id", async () => {
    const requestId = randomUUID();
    const first = await revise(requestId);
    const second = await revise(requestId);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(prompts).toHaveLength(1);
    expect(captured.filter((event) => event.event === "review.revision_requested"))
      .toHaveLength(1);
  });

  it("rejects a duplicate running request without calling the provider", async () => {
    const requestId = randomUUID();
    createRunningTurn(db, {
      requestId,
      workspaceId,
      draftId,
      actorId: null,
      instruction: "Make the opening sharper.",
      sourceContent: "Original copy",
    });
    const response = await revise(requestId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("revision_in_progress");
    expect(prompts).toHaveLength(0);
  });

  it("does not overwrite a draft changed during the provider call", async () => {
    mode = "deferred";
    const pending = revise();
    await llmEntered.promise;
    db.update(drafts)
      .set({ content: "Newer manual copy", updatedAt: updatedAt + 1 })
      .where(eq(drafts.id, draftId))
      .run();
    llmRelease.resolve({
      text: "Late AI copy",
      model: "fake-model",
      provider: "fake",
      durationMs: 5,
    });
    const response = await pending;
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("draft_changed");
    expect((await editor()).draft.content).toBe("Newer manual copy");
    expect((await editor()).turns.at(-1).status).toBe("failed");
  });

  it.each(["approved", "rejected"] as const)("rejects revisions once the draft is %s", async (state) => {
    db.update(drafts).set({ state }).where(eq(drafts.id, draftId)).run();
    const response = await revise();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("invalid_transition");
    expect(prompts).toHaveLength(0);
  });

  it("records provider failure without changing content or usage", async () => {
    const beforeUsage = getUsage(db, workspaceId).monthlyGenerations;
    mode = "failure";
    const response = await revise();
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("revision_failed");
    const context = await editor();
    expect(context.draft.content).toBe("Original copy");
    expect(context.turns.at(-1)).toMatchObject({ status: "failed", error: "provider down" });
    expect(getUsage(db, workspaceId).monthlyGenerations).toBe(beforeUsage);
  });

  it("treats an empty provider result as a failed turn", async () => {
    mode = "empty";
    const response = await revise();
    expect(response.statusCode).toBe(502);
    expect((await editor()).turns.at(-1).status).toBe("failed");
  });

  it("bounds conversational history to the six newest completed turns", async () => {
    for (let index = 1; index <= 7; index += 1) {
      const turn = createRunningTurn(db, {
        requestId: randomUUID(),
        workspaceId,
        draftId,
        actorId: null,
        instruction: `Historical instruction ${index}`,
        sourceContent: "Original copy",
      });
      completeTurn(db, workspaceId, turn.id, {
        resultContent: `Historical result ${index}`,
        contextSections: [],
        model: "history-model",
        provider: "fake",
        durationMs: 1,
      });
    }
    expect((await revise()).statusCode).toBe(200);
    expect(prompts[0]).not.toContain("Historical instruction 1");
    expect(prompts[0]).toContain("Historical instruction 2");
    expect(prompts[0]).toContain("Historical instruction 7");
  });

  it("resolves current campaign-scoped guidance into the revision prompt", async () => {
    const campaign = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Spring launch" },
      })
    ).json();
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/guidance/linkedin`,
      payload: { content: "Lead with the customer proof point.", campaignId: campaign.id },
    });
    db.update(drafts).set({ campaignId: campaign.id }).where(eq(drafts.id, draftId)).run();
    expect((await revise()).statusCode).toBe(200);
    expect(prompts[0]).toContain("Lead with the customer proof point.");
  });

  it("returns 402 before calling the provider when monthly generation usage is exhausted", async () => {
    const previous = process.env.TEST_BILLING_GATING;
    process.env.TEST_BILLING_GATING = "1";
    for (let index = 0; index < 50; index += 1) {
      db.insert(generations).values({
        id: randomUUID(),
        workspaceId,
        taskType: "linkedin_post",
        channel: "linkedin",
        prompt: "metered",
        sectionsJson: "[]",
        output: "copy",
        model: "fake-model",
        provider: "fake",
        durationMs: 1,
        createdAt: Date.now(),
      }).run();
    }
    const response = await revise();
    process.env.TEST_BILLING_GATING = previous;
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ error: "upgrade_required", key: "monthlyGenerations" });
    expect(prompts).toHaveLength(0);
  });

  it("does not expose a draft through another workspace", async () => {
    const otherWorkspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Other" } })
    ).json().id;
    const response = await app.inject({
      method: "POST",
      url: `/workspaces/${otherWorkspaceId}/drafts/${draftId}/revise`,
      payload: {
        requestId: randomUUID(),
        instruction: "Rewrite this.",
        expectedDraftUpdatedAt: updatedAt,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(prompts).toHaveLength(0);
  });
});
