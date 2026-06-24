import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuezdayApp } from "../src/app";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

/**
 * A gateway that branches on the prompt so one fake exercises drafting, the
 * angle step, and both reviewer passes in a single test run:
 *  - an ANGLE: prompt → three angle lines
 *  - a SCORE: prompt (a reviewer pass) → a weak score (42) to exercise flagging
 *  - anything else → a plain draft
 */
function qualityGateway(scoreText = "SCORE: 42\nISSUES:\n- too generic\n- no hook"): LlmGateway {
  return {
    async generate({ prompt }) {
      let text: string;
      if (prompt.includes("ANGLE: ")) {
        text = "ANGLE: the contrarian take\nANGLE: the data angle\nANGLE: the story angle";
      } else if (prompt.includes("SCORE:")) {
        text = scoreText;
      } else {
        text = "FAKE DRAFT OUTPUT";
      }
      return { text, model: "fake-model", provider: "fake", durationMs: 3 };
    },
  };
}

/** Throws only on reviewer prompts; drafting still succeeds. */
function reviewFailsGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      if (prompt.includes("SCORE:")) throw new GatewayError("provider_error", "reviewer down");
      return { text: "FAKE DRAFT OUTPUT", model: "fake-model", provider: "fake", durationMs: 3 };
    },
  };
}

describe("generation quality (Sprint 22)", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  async function setup(llm: LlmGateway) {
    app = await buildAuthedApp({ db: createTestDb(), llm });
    const res = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "QA" } });
    workspaceId = res.json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
  }

  afterEach(async () => {
    await app.close();
  });

  function generate(payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/generate`,
      payload: { taskType: "linkedin_post", channel: "linkedin", ...payload },
    });
  }

  function setSettings(payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/generation-settings`,
      payload,
    });
  }

  describe("settings", () => {
    beforeEach(() => setup(qualityGateway()));

    it("returns review-on / angle-off defaults for a fresh workspace", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/generation-settings`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        reviewEnabled: true,
        angleEnabled: false,
        angleCount: 3,
        flagThreshold: 70,
      });
    });

    it("updates settings and validates input", async () => {
      const ok = await setSettings({ angleEnabled: true, flagThreshold: 80 });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ angleEnabled: true, flagThreshold: 80, reviewEnabled: true });

      const bad = await setSettings({ angleCount: 99 });
      expect(bad.statusCode).toBe(400);
      const bad2 = await setSettings({ flagThreshold: 200 });
      expect(bad2.statusCode).toBe(400);
    });
  });

  describe("dual-LLM pre-review", () => {
    beforeEach(() => setup(qualityGateway()));

    it("attaches both checks with scores and flags a weak draft", async () => {
      const res = await generate();
      expect(res.statusCode).toBe(201);
      const gen = res.json();
      expect(gen.review).not.toBeNull();
      expect(gen.review.checks).toHaveLength(2);
      expect(gen.review.checks.map((c: { check: string }) => c.check).sort()).toEqual([
        "brand_voice",
        "channel_fit",
      ]);
      expect(gen.review.checks[0].score).toBe(42);
      expect(gen.review.checks[0].issues).toContain("too generic");
      expect(gen.review.flagged).toBe(true); // 42 < 70

      // Persisted: re-fetching the generation carries the review.
      const list = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/generations`,
      });
      expect(list.json()[0].review.flagged).toBe(true);
    });

    it("does not flag when scores clear the threshold", async () => {
      await app.close();
      await setup(qualityGateway("SCORE: 95\nISSUES:\n- none"));
      const gen = (await generate()).json();
      expect(gen.review.flagged).toBe(false);
      expect(gen.review.checks[0].score).toBe(95);
      expect(gen.review.checks[0].issues).toEqual([]);
    });

    it("skips review when disabled", async () => {
      await setSettings({ reviewEnabled: false });
      const gen = (await generate()).json();
      expect(gen.review).toBeNull();
    });

    it("never blocks the generation when the reviewer fails", async () => {
      await app.close();
      await setup(reviewFailsGateway());
      const res = await generate();
      expect(res.statusCode).toBe(201);
      const gen = res.json();
      expect(gen.review).not.toBeNull();
      // Both checks failed gracefully: null score, never flagged.
      expect(gen.review.checks.every((c: { score: number | null }) => c.score === null)).toBe(true);
      expect(gen.review.flagged).toBe(false);
    });
  });

  describe("angle step", () => {
    beforeEach(() => setup(qualityGateway()));

    it("drafts from an explicit angle, surfaced in the trace", async () => {
      const res = await generate({ angle: "the contrarian take" });
      const gen = res.json();
      expect(gen.prompt).toContain("the contrarian take");
      expect(gen.sections.map((s: { key: string }) => s.key)).toContain("angle");
    });

    it("auto-picks the strongest angle and returns the candidates", async () => {
      const res = await generate({ autoAngle: true });
      const gen = res.json();
      expect(gen.angles).toEqual([
        "the contrarian take",
        "the data angle",
        "the story angle",
      ]);
      expect(gen.chosenAngle).toBe("the contrarian take");
      expect(gen.prompt).toContain("the contrarian take");
    });

    it("POST /angles returns parsed angles and a trace", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/angles`,
        payload: { taskType: "linkedin_post", channel: "linkedin", angleCount: 3 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.angles).toHaveLength(3);
      expect(body.sections.map((s: { key: string }) => s.key)).toContain("task");
    });
  });

  describe("review carries to the draft", () => {
    beforeEach(() => setup(qualityGateway()));

    it("copies the generation's review onto the submitted draft", async () => {
      const gen = (await generate()).json();
      const submit = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${gen.id}/submit`,
      });
      expect(submit.statusCode).toBe(201);
      expect(submit.json().review.flagged).toBe(true);

      // And it shows on the drafts list.
      const drafts = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` });
      expect(drafts.json()[0].review.checks).toHaveLength(2);
    });

    it("re-runs review against the draft's current content on demand", async () => {
      // Disable auto-review so the draft starts unreviewed.
      await setSettings({ reviewEnabled: false });
      const gen = (await generate()).json();
      expect(gen.review).toBeNull();
      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${gen.id}/submit`,
        })
      ).json();
      expect(draft.review).toBeNull();

      const rerun = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/review`,
      });
      expect(rerun.statusCode).toBe(200);
      expect(rerun.json().review.checks).toHaveLength(2);
      expect(rerun.json().review.flagged).toBe(true);
    });

    it("returns 404 re-running review on an unknown draft", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/7c9e6679-7425-40de-944b-e07fc1f90ae7/review`,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
