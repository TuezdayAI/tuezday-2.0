import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeGateway: LlmGateway = {
  async generate() {
    return { text: "Generated post text.", model: "fake-model", provider: "fake", durationMs: 5 };
  },
};

describe("approval gate API", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let generationId: string;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: fakeGateway });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Gatekeeper" } })
    ).json().id;
    generationId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function submit() {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/generations/${generationId}/submit`,
    });
  }

  async function act(draftId: string, action: string, payload?: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/${action}`,
      ...(payload ? { payload } : {}),
    });
  }

  describe("submit", () => {
    it("creates a pending_review draft from a generation", async () => {
      const res = await submit();
      expect(res.statusCode).toBe(201);
      const draft = res.json();
      expect(draftSchema.safeParse(draft).success).toBe(true);
      expect(draft.state).toBe("pending_review");
      expect(draft.content).toBe("Generated post text.");
      expect(draft.originalContent).toBe("Generated post text.");
      expect(draft.sourceGenerationId).toBe(generationId);
      expect(draft.taskType).toBe("linkedin_post");
    });

    it("logs the submit decision", async () => {
      const draft = (await submit()).json();
      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draft.id}` })
      ).json();
      expect(detail.decisions).toHaveLength(1);
      expect(detail.decisions[0]).toMatchObject({
        action: "submit",
        fromState: "draft",
        toState: "pending_review",
        actor: "founder",
      });
    });

    it("refuses submitting the same generation twice", async () => {
      await submit();
      const res = await submit();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("already_submitted");
    });

    it("returns 404 for an unknown generation", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/7c9e6679-7425-40de-944b-e07fc1f90ae7/submit`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("edit", () => {
    it("updates content, sets state edited, keeps original, logs snapshot", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "edit", { content: "Better post text." });
      expect(res.statusCode).toBe(200);
      const edited = res.json();
      expect(edited.state).toBe("edited");
      expect(edited.content).toBe("Better post text.");
      expect(edited.originalContent).toBe("Generated post text.");

      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draft.id}` })
      ).json();
      const editDecision = detail.decisions.find((d: { action: string }) => d.action === "edit");
      expect(editDecision.contentSnapshot).toBe("Better post text.");
    });

    it("allows re-editing an edited draft", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "v2" });
      const res = await act(draft.id, "edit", { content: "v3" });
      expect(res.statusCode).toBe(200);
      expect(res.json().content).toBe("v3");
    });

    it("rejects empty content", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "edit", { content: "" });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("transitions", () => {
    it("approves from pending_review", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "approve");
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe("approved");
    });

    it("approves from edited keeping the edited content", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "Edited then approved." });
      const res = await act(draft.id, "approve");
      expect(res.statusCode).toBe(200);
      expect(res.json().content).toBe("Edited then approved.");

      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draft.id}` })
      ).json();
      const approval = detail.decisions.find((d: { action: string }) => d.action === "approve");
      expect(approval.fromState).toBe("edited");
    });

    it("rejects from pending_review", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "reject");
      expect(res.json().state).toBe("rejected");
    });

    it("resubmits an edited draft back to pending_review", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "v2" });
      const res = await act(draft.id, "resubmit");
      expect(res.json().state).toBe("pending_review");
    });

    it("refuses editing an approved draft with 409", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");
      const res = await act(draft.id, "edit", { content: "too late" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("invalid_transition");
      expect(res.json().message).toContain("approved");
    });

    it("refuses approving a rejected draft with 409", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "reject");
      const res = await act(draft.id, "approve");
      expect(res.statusCode).toBe(409);
    });

    it("refuses resubmitting a pending_review draft with 409", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "resubmit");
      expect(res.statusCode).toBe(409);
    });

    it("returns 404 for an unknown draft", async () => {
      const res = await act("7c9e6679-7425-40de-944b-e07fc1f90ae7", "approve");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("queue", () => {
    it("lists drafts newest first with optional state filter", async () => {
      const first = (await submit()).json();
      const gen2 = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "cold_email_opener", channel: "email" },
        })
      ).json();
      const second = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${gen2.id}/submit`,
        })
      ).json();
      await act(first.id, "approve");

      const all = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe(second.id);

      const approved = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts?state=approved` })
      ).json();
      expect(approved).toHaveLength(1);
      expect(approved[0].id).toBe(first.id);
    });

    it("rejects an invalid state filter", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/drafts?state=bogus`,
      });
      expect(res.statusCode).toBe(400);
    });

    it("decision log is oldest first and complete", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "v2" });
      await act(draft.id, "resubmit");
      await act(draft.id, "approve");

      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draft.id}` })
      ).json();
      expect(detail.decisions.map((d: { action: string }) => d.action)).toEqual([
        "submit",
        "edit",
        "resubmit",
        "approve",
      ]);
    });
  });
});
