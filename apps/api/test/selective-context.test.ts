import { afterEach, describe, expect, it } from "vitest";
import { TASK_TYPES, MATRIX_DOC_TYPES } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

/**
 * A gateway for the selective-context slice: answers outline-summary prompts
 * with proper SUMMARY lines, angle prompts with ANGLE lines, everything else
 * with a plain draft (reviewer prompts parse to null scores — harmless).
 */
function selectiveGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      let text: string;
      if (prompt.includes("SUMMARY")) {
        text = Array.from({ length: 16 }, (_, i) => `SUMMARY ${i + 1}: LLM one-liner ${i + 1}`).join("\n");
      } else if (prompt.includes("ANGLE: ")) {
        text = "ANGLE: the pricing angle\nANGLE: the reporting angle\nANGLE: the story angle";
      } else {
        text = "FAKE DRAFT OUTPUT";
      }
      return { text, model: "fake-model", provider: "fake", durationMs: 3 };
    },
  };
}

/** Throws only on outline-summary prompts; saves must still succeed. */
function summariesFailGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      if (prompt.includes("SUMMARY")) throw new GatewayError("provider_error", "summaries down");
      return { text: "FAKE DRAFT OUTPUT", model: "fake-model", provider: "fake", durationMs: 3 };
    },
  };
}

// Big enough to clear ZOOM_SMALL_DOC_TOKENS (600), with real H2 sections.
const PAD = " Deliberate filler prose to push this document past the small-doc escape hatch so outline mode engages for real.".repeat(16);

const BIG_HISTORY = [
  `## Launch of reporting dashboards\n\nWe shipped weekly reporting dashboards in March. Agencies loved the export.${PAD}`,
  `## Pricing experiment\n\nWe tested usage-based pricing in April. Churn dropped for small agencies.${PAD}`,
  `## Conference talk\n\nThe founder spoke at SaaSCon about onboarding.${PAD}`,
].join("\n\n");

const BIG_ICP = [
  `## Founder-led SaaS\n\nSmall GTM teams, positioning still in the founder's head.${PAD}`,
  `## Marketing agencies\n\nAgencies drowning in weekly client reporting busywork.${PAD}`,
].join("\n\n");

describe("selective context (Sprint 43)", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  async function setup(llm: LlmGateway = selectiveGateway()) {
    app = await buildAuthedApp({ db: createTestDb(), llm });
    const res = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "S43" } });
    workspaceId = res.json().id;
  }

  afterEach(async () => {
    await app.close();
  });

  function putDoc(docType: string, content: string) {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/${docType}`,
      payload: { content },
    });
  }

  describe("outlines at save time", () => {
    it("persists an LLM-summarized outline on save and serves it from GET /brain", async () => {
      await setup();
      const res = await putDoc("history", BIG_HISTORY);
      expect(res.statusCode).toBe(200);
      const doc = res.json();
      expect(doc.outline).toBeTruthy();
      expect(doc.outline.sections.map((s: { id: string }) => s.id)).toEqual([
        "launch-of-reporting-dashboards",
        "pricing-experiment",
        "conference-talk",
      ]);
      expect(doc.outline.sections[0].summary).toBe("LLM one-liner 1");
      expect(doc.outline.sections.every((s: { summarySource: string }) => s.summarySource === "llm")).toBe(true);

      const brain = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/brain` });
      const history = brain.json().docs.find((d: { docType: string }) => d.docType === "history");
      expect(history.outline.sections).toHaveLength(3);
    });

    it("falls back to deterministic summaries when the gateway is down — save still succeeds", async () => {
      await setup(summariesFailGateway());
      const res = await putDoc("history", BIG_HISTORY);
      expect(res.statusCode).toBe(200);
      const doc = res.json();
      expect(doc.outline.sections).toHaveLength(3);
      expect(doc.outline.sections.every((s: { summarySource: string }) => s.summarySource === "fallback")).toBe(true);
      expect(doc.outline.sections[1].summary).toContain("usage-based pricing");
    });

    it("stores a null outline for an emptied doc", async () => {
      await setup();
      await putDoc("history", BIG_HISTORY);
      const res = await putDoc("history", "");
      expect(res.statusCode).toBe(200);
      expect(res.json().outline).toBeNull();
    });
  });

  describe("context matrix routes", () => {
    it("GET returns every taskType × docType cell with defaults", async () => {
      await setup();
      const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/context-matrix` });
      expect(res.statusCode).toBe(200);
      const cells = res.json();
      expect(cells).toHaveLength(TASK_TYPES.length * MATRIX_DOC_TYPES.length);
      expect(cells.every((c: { source: string }) => c.source === "default")).toBe(true);
      const cell = cells.find(
        (c: { taskType: string; docType: string }) => c.taskType === "pr_pitch" && c.docType === "history",
      );
      expect(cell.mode).toBe("full");
      expect(cell.reason.length).toBeGreaterThan(0);
    });

    it("PUT overrides a cell, DELETE resets it", async () => {
      await setup();
      const put = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/context-matrix/linkedin_post/history`,
        payload: { mode: "full", reason: "We want the whole story in posts." },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ mode: "full", source: "workspace" });

      const list = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/context-matrix` });
      const cell = list
        .json()
        .find((c: { taskType: string; docType: string }) => c.taskType === "linkedin_post" && c.docType === "history");
      expect(cell).toMatchObject({ mode: "full", source: "workspace", reason: "We want the whole story in posts." });

      const del = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/context-matrix/linkedin_post/history`,
      });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toMatchObject({ mode: "outline", source: "default" });
    });

    it("validates task type, doc type, and mode", async () => {
      await setup();
      const badTask = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/context-matrix/tiktok_post/history`,
        payload: { mode: "full" },
      });
      expect(badTask.statusCode).toBe(400);
      expect(badTask.json().error).toBe("invalid_task_type");

      const badDoc = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/context-matrix/linkedin_post/soul`,
        payload: { mode: "full" },
      });
      expect(badDoc.statusCode).toBe(400);
      expect(badDoc.json().error).toBe("invalid_doc_type");

      const badMode = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/context-matrix/linkedin_post/history`,
        payload: { mode: "verbatim" },
      });
      expect(badMode.statusCode).toBe(400);
      expect(badMode.json().error).toBe("invalid_input");
    });

    it("requires workspace membership", async () => {
      await setup();
      const outsider = await registerUser(app, "outsider@test.dev", "outsider");
      const res = await asUser(app, outsider.token).inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/context-matrix`,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("/resolve with the tiered resolver", () => {
    async function seedBigBrain() {
      await putDoc("soul", "We exist to end GTM amnesia.");
      await putDoc("icp", BIG_ICP);
      await putDoc("history", BIG_HISTORY);
    }

    it("returns outlines + zoom sections with tier/mode/score trace fields", async () => {
      await setup();
      await seedBigBrain();
      const campaignRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: {
          name: "Pricing push",
          objective: "Win agencies with usage-based pricing",
          pillars: ["reporting busywork", "churn"],
        },
      });
      const campaignId = campaignRes.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId, useEvidence: false },
      });
      expect(res.statusCode).toBe(200);
      const bundle = res.json();

      const icp = bundle.sections.find((s: { key: string }) => s.key === "org:icp");
      expect(icp.mode).toBe("outline");
      expect(icp.tier).toBe(2);
      expect(icp.title).toBe("ICP (outline)");

      const zoomSections = bundle.sections.filter((s: { layer: string }) => s.layer === "zoom");
      expect(zoomSections.length).toBeGreaterThan(0);
      expect(zoomSections.some((s: { key: string }) => s.key === "zoom:history:pricing-experiment")).toBe(true);
      expect(zoomSections[0].tier).toBe(3);
      expect(zoomSections[0].zoom.score).toBeGreaterThan(0);
      expect(bundle.zoomQuery).toContain("usage-based pricing");

      const soul = bundle.sections.find((s: { key: string }) => s.key === "org:soul");
      expect(soul.reason).toMatch(/tier 1, constitutional|included whole/);
    });

    it("honors a workspace matrix override in the resolve trace", async () => {
      await setup();
      await seedBigBrain();
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/context-matrix/linkedin_post/history`,
        payload: { mode: "omit", reason: "Posts never need history." },
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", useEvidence: false },
      });
      const history = res.json().sections.find((s: { key: string }) => s.key === "org:history");
      expect(history.included).toBe(false);
      expect(history.reason).toContain("workspace override");
      expect(history.reason).toContain("Posts never need history.");
    });
  });

  describe("generation paths", () => {
    it("persists the tiered trace on a generation and keeps the prompt selective", async () => {
      await setup();
      await putDoc("soul", "We exist to end GTM amnesia.");
      await putDoc("icp", BIG_ICP);
      await putDoc("history", BIG_HISTORY);
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/generation-settings`,
        payload: { reviewEnabled: false },
      });

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin", useEvidence: false },
      });
      expect(res.statusCode).toBe(201);
      const generation = res.json();
      const icp = generation.sections.find((s: { key: string }) => s.key === "org:icp");
      expect(icp.mode).toBe("outline");
      // The prompt carries the outline, not the padded full text.
      expect(generation.prompt).not.toContain("Deliberate filler prose");
      expect(generation.prompt).toContain("- Marketing agencies");
    });

    it("runs the angle step as a brief (no zoom, no evidence) and feeds the angle into the draft", async () => {
      await setup();
      await putDoc("soul", "We exist to end GTM amnesia.");
      await putDoc("history", BIG_HISTORY);
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/generation-settings`,
        payload: { reviewEnabled: false, angleEnabled: true },
      });

      const angles = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/angles`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      });
      expect(angles.statusCode).toBe(201);
      const angleSections = angles.json().sections;
      expect(angleSections.some((s: { layer: string }) => s.layer === "zoom")).toBe(false);
      const history = angleSections.find((s: { key: string }) => s.key === "org:history");
      expect(history.mode).toBe("outline");
      expect(history.reason).toMatch(/zoom off \(brief mode\)/);
      const evidenceSection = angleSections.find((s: { key: string }) => s.key === "evidence");
      expect(evidenceSection.included).toBe(false);
      expect(evidenceSection.reason).toMatch(/brief mode/);

      const gen = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin", autoAngle: true, useEvidence: false },
      });
      expect(gen.statusCode).toBe(201);
      const body = gen.json();
      expect(body.chosenAngle).toBe("the pricing angle");
      const angleSection = body.sections.find((s: { key: string }) => s.key === "angle");
      expect(angleSection.included).toBe(true);
      // The chosen angle reaches the zoom query: "pricing" pulls the pricing
      // section of history into the draft bundle.
      expect(body.sections.some((s: { key: string }) => s.key === "zoom:history:pricing-experiment")).toBe(true);
    });
  });
});
