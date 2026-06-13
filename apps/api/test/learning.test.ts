import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nowSynthesisSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

function fakeGateway(captured: { prompts: string[] }): LlmGateway {
  return {
    async generate({ prompt }) {
      captured.prompts.push(prompt);
      if (prompt.includes("synthesize")) {
        return {
          text: 'PROPOSAL:\n- LinkedIn posts about the memory problem outperform feature posts.\n- Edits consistently shorten openings.\nRATIONALE:\nTwo of three accepted outputs led with the memory problem; both edits cut the first sentence.',
          model: "fake",
          provider: "fake",
          durationMs: 3,
        };
      }
      return { text: "Generated output.", model: "fake", provider: "fake", durationMs: 3 };
    },
  };
}

describe("learning API", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let captured: { prompts: string[] };

  beforeEach(async () => {
    captured = { prompts: [] };
    app = await buildAuthedApp({ db: createTestDb(), llm: fakeGateway(captured) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Learner" } })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function generateAndRate(rating: string) {
    const gen = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/generations/${gen.id}/rating`,
      payload: { rating },
    });
    return gen;
  }

  async function makeDecidedDraft(opts: { edit?: string; action: "approve" | "reject" }) {
    const gen = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      })
    ).json();
    const draft = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${gen.id}/submit`,
      })
    ).json();
    if (opts.edit) {
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/edit`,
        payload: { content: opts.edit },
      });
    }
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draft.id}/${opts.action}`,
    });
    return draft;
  }

  describe("training examples", () => {
    it("derives examples from rated generations and decided drafts", async () => {
      await generateAndRate("accepted");
      await makeDecidedDraft({ edit: "Founder-edited version.", action: "approve" });

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/learning/examples`,
      });
      expect(res.statusCode).toBe(200);
      const examples = res.json();
      const ratingExample = examples.find((e: { kind: string }) => e.kind === "rating");
      expect(ratingExample).toBeDefined();
      expect(ratingExample.rating).toBe("accepted");

      const decisionExample = examples.find((e: { kind: string }) => e.kind === "decision");
      expect(decisionExample).toBeDefined();
      expect(decisionExample.decision).toBe("approved");
      expect(decisionExample.content).toBe("Founder-edited version.");
      expect(decisionExample.originalContent).toBe("Generated output.");
      expect(decisionExample.wasEdited).toBe(true);
    });

    it("excludes undecided drafts and unrated generations", async () => {
      // generation without rating, draft left pending
      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${gen.id}/submit`,
      });

      const examples = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/learning/examples` })
      ).json();
      expect(examples).toEqual([]);
    });

    it("reports stats", async () => {
      await generateAndRate("accepted");
      await generateAndRate("rejected");
      await makeDecidedDraft({ edit: "v2", action: "approve" });
      await makeDecidedDraft({ action: "reject" });

      const stats = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/learning/stats` })
      ).json();
      expect(stats.ratings.accepted).toBe(1);
      expect(stats.ratings.rejected).toBe(1);
      expect(stats.decisions.approved).toBe(1);
      expect(stats.decisions.rejected).toBe(1);
      expect(stats.editedCount).toBe(1);
    });
  });

  describe("metrics", () => {
    it("records and lists metrics", async () => {
      const draft = await makeDecidedDraft({ action: "approve" });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/metrics`,
        payload: {
          draftId: draft.id,
          channel: "linkedin",
          description: "Launch post",
          impressions: 5000,
          engagements: 200,
        },
      });
      expect(res.statusCode).toBe(201);
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/metrics` })
      ).json();
      expect(list).toHaveLength(1);
      expect(list[0].impressions).toBe(5000);
    });

    it("rejects an unknown draftId", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/metrics`,
        payload: { draftId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", channel: "linkedin" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("synthesis", () => {
    it("refuses when there is nothing to learn from", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/learning/synthesize`,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("nothing_to_learn");
    });

    it("synthesizes a proposal from decisions, ratings, and metrics", async () => {
      await generateAndRate("accepted");
      const draft = await makeDecidedDraft({ edit: "Sharper version.", action: "approve" });
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/metrics`,
        payload: { draftId: draft.id, channel: "linkedin", impressions: 9000, engagements: 400 },
      });

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/learning/synthesize`,
      });
      expect(res.statusCode).toBe(201);
      const synthesis = res.json();
      expect(nowSynthesisSchema.safeParse(synthesis).success).toBe(true);
      expect(synthesis.status).toBe("proposed");
      expect(synthesis.proposal).toContain("memory problem");
      expect(synthesis.rationale.length).toBeGreaterThan(0);

      const prompt = captured.prompts.find((p) => p.includes("synthesize"))!;
      expect(prompt).toContain("accepted: 1");
      expect(prompt).toContain("Sharper version.");
      expect(prompt).toContain("9000");
    });

    it("accepting appends a dated learnings block to the now doc with a version", async () => {
      await generateAndRate("accepted");
      const synthesis = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/learning/synthesize`,
        })
      ).json();

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/learning/syntheses/${synthesis.id}/accept`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().synthesis.status).toBe("accepted");

      const brain = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/brain` })
      ).json();
      const now = brain.docs.find((d: { docType: string }) => d.docType === "now");
      expect(now.content).toContain("## Learnings (synthesized");
      expect(now.content).toContain("memory problem");

      const versions = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/brain/now/versions`,
        })
      ).json();
      expect(versions.length).toBeGreaterThan(0);
    });

    it("preserves existing now content when appending", async () => {
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/now`,
        payload: { content: "Existing now content." },
      });
      await generateAndRate("accepted");
      const synthesis = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/learning/synthesize`,
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/learning/syntheses/${synthesis.id}/accept`,
      });
      const brain = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/brain` })
      ).json();
      const now = brain.docs.find((d: { docType: string }) => d.docType === "now");
      expect(now.content).toContain("Existing now content.");
      expect(now.content).toContain("## Learnings");
    });

    it("dismisses a proposal", async () => {
      await generateAndRate("accepted");
      const synthesis = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/learning/synthesize`,
        })
      ).json();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/learning/syntheses/${synthesis.id}/dismiss`,
      });
      expect(res.json().status).toBe("dismissed");
    });

    it("refuses double-deciding with 409", async () => {
      await generateAndRate("accepted");
      const synthesis = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/learning/synthesize`,
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/learning/syntheses/${synthesis.id}/dismiss`,
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/learning/syntheses/${synthesis.id}/accept`,
      });
      expect(res.statusCode).toBe(409);
    });

    it("lists syntheses newest first", async () => {
      await generateAndRate("accepted");
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/learning/synthesize`,
      });
      const list = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/learning/syntheses`,
        })
      ).json();
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe("proposed");
    });
  });
});
