import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuezdayApp } from "../src/app";
import { buildAuthedApp, createTestDb } from "./helpers";

describe("resolve API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb() });
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Resolvable" },
    });
    workspaceId = res.json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/voice`,
      payload: { content: "Direct, technical, never corporate." },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("resolves a bundle with ordered sections and a trace", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json();
    const keys = bundle.sections.map((s: { key: string }) => s.key);
    // Sprint 53: the plan rides immediately after the campaign overlay and
    // before persona. Asserted by index arithmetic first, so a future edit of
    // the pinned list below cannot silently move it.
    expect(keys.indexOf("campaign_plan")).toBe(keys.indexOf("campaign") + 1);
    expect(keys.indexOf("campaign_plan")).toBe(keys.indexOf("persona") - 1);
    expect(keys).toEqual([
      "org:soul",
      "org:icp",
      "org:voice",
      "org:history",
      "org:now",
      "channel",
      "campaign",
      "campaign_plan",
      "persona",
      "lead",
      "media_contact",
      "signal",
      "evidence",
      "task",
    ]);
    expect(bundle.prompt).toContain("We exist to end GTM amnesia.");
    expect(bundle.includedTokens).toBeGreaterThan(0);
    expect(bundle.overBudget).toBe(false);
    // empty docs excluded with reasons
    const icp = bundle.sections.find((s: { key: string }) => s.key === "org:icp");
    expect(icp.included).toBe(false);
  });

  it("includes the persona overlay when personaId is given", async () => {
    const persona = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "CEO", overlay: "Write as the founder, first person." },
      })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin", personaId: persona.id },
    });
    expect(res.statusCode).toBe(200);
    const section = res.json().sections.find((s: { key: string }) => s.key === "persona");
    expect(section.included).toBe(true);
    expect(section.content).toContain("Write as the founder");
  });

  it("returns 404 for an unknown persona", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: {
        taskType: "linkedin_post",
        channel: "linkedin",
        personaId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("persona_not_found");
  });

  it("rejects an invalid task type with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "tiktok_dance", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/resolve",
      payload: { taskType: "linkedin_post", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("honors a custom token budget", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin", tokenBudget: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokenBudget).toBe(500);
  });

  // Sprint 53 — the resolver reads the curated plan, so the API layer has to
  // load it. Without this plumbing the section composed in Sprint 53 Task 2 is
  // inert: it is always present and always excluded.
  describe("campaign plan (Sprint 53)", () => {
    async function createCampaign(name: string): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id;
    }

    async function activatePlan(
      campaignId: string,
      plan: { objective?: string; kpi?: string; pillars?: string[]; guidance?: string },
    ): Promise<void> {
      const created = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
        payload: { startAt: null, endAt: null, ...plan },
      });
      expect(created.statusCode).toBe(201);
      const activated = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${created.json().id}/activate`,
      });
      expect(activated.statusCode).toBe(200);
    }

    it("populates the campaign_plan section from the active plan revision", async () => {
      const campaignId = await createCampaign("Category creation");
      await activatePlan(campaignId, {
        objective: "Own the phrase GTM amnesia",
        kpi: "Qualified conversations per week",
        pillars: ["Memory beats tooling", "Show the trace"],
        guidance: "Never say synergy.",
      });

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId },
      });
      expect(res.statusCode).toBe(200);
      const bundle = res.json();
      const section = bundle.sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.included).toBe(true);
      expect(section.tier).toBe(1);
      expect(section.tokens).toBeGreaterThan(0);
      expect(section.title).toBe("Campaign plan (revision 1)");
      expect(section.content).toContain("Own the phrase GTM amnesia");
      expect(section.content).toContain("Memory beats tooling");
      // …and it actually reaches the prompt, not just the trace.
      expect(bundle.prompt).toContain("Qualified conversations per week");
      expect(bundle.prompt).toContain("Never say synergy.");
    });

    it("degrades to an excluded-with-reason section when the campaign has no plan", async () => {
      const campaignId = await createCampaign("Unplanned");
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId },
      });
      expect(res.statusCode).toBe(200);
      const section = res
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.included).toBe(false);
      expect(section.tokens).toBe(0);
      expect(section.reason).toContain("no active plan revision");
    });

    it("reports no campaign at all rather than crashing", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      });
      expect(res.statusCode).toBe(200);
      const section = res
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.included).toBe(false);
      expect(section.reason).toContain("no campaign selected");
    });

    it("resolves the newly activated revision after the plan is edited", async () => {
      const campaignId = await createCampaign("Iterating");
      await activatePlan(campaignId, { objective: "V1", pillars: ["Pillar the first"] });
      await activatePlan(campaignId, { objective: "V2", pillars: ["Pillar the second"] });

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId },
      });
      const section = res
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.title).toBe("Campaign plan (revision 2)");
      expect(section.content).toContain("Pillar the second");
      expect(section.content).not.toContain("Pillar the first");
    });
  });
});
