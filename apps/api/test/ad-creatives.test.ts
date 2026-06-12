import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAdCreative } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { createTestDb } from "./helpers";

/**
 * Fake gateway keyed off markers the tests plant in the campaign objective
 * (the objective reaches the prompt through the composed campaign overlay).
 */
function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      if (prompt.includes("MARKER-GATEWAY-FAIL")) {
        throw new GatewayError("provider_error", "boom");
      }
      let text: string;
      if (prompt.includes("MARKER-UNPARSEABLE")) {
        text = "Sure! Here are some great ad ideas for your campaign.";
      } else if (prompt.includes("MARKER-OVERLIMIT")) {
        text = `Primary text: Fine.\nHeadline: ${"x".repeat(50)}\nDescription: ok`;
      } else if (prompt.includes("Google responsive search ad")) {
        const headlines = Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}: H${i + 1}`);
        const descriptions = Array.from({ length: 4 }, (_, i) => `Description ${i + 1}: D${i + 1}`);
        text = [...headlines, ...descriptions].join("\n");
      } else {
        const match = /Write (\d+) distinct Meta ad/.exec(prompt);
        const n = match ? Number(match[1]) : 1;
        text = Array.from(
          { length: n },
          (_, i) =>
            `Primary text: Angle ${i + 1} for the offer.\nHeadline: Headline ${i + 1}\nDescription: Desc ${i + 1}`,
        ).join("\n---\n");
      }
      return { text, model: "fake", provider: "fake", durationMs: 5 };
    },
  };
}

describe("ad creatives API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildApp({ db: createTestDb(), llm: fakeGateway() });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Ads" } })
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

  async function createCampaign(payload: Record<string, unknown> = {}) {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Launch", objective: "Win the launch", ...payload },
      })
    ).json();
  }

  async function generate(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ad-creatives/generate`,
      payload,
    });
  }

  describe("generate", () => {
    it("creates one generation and a pending draft per Meta variant", async () => {
      const campaign = await createCampaign();
      const res = await generate({ taskType: "meta_ad_creative", campaignId: campaign.id });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.generationId).toBeDefined();
      expect(body.drafts).toHaveLength(3); // contract default

      for (const draft of body.drafts) {
        expect(draft.sourceGenerationId).toBe(body.generationId);
        expect(draft.taskType).toBe("meta_ad_creative");
        expect(draft.channel).toBe("ads");
        expect(draft.campaignId).toBe(campaign.id);
        expect(draft.state).toBe("pending_review");
        expect(draft.violations).toEqual([]);
        expect(validateAdCreative("meta_ad_creative", draft.content).ok).toBe(true);
      }
      expect(body.drafts.map((d: { content: string }) => d.content)).toContain(
        "Primary text: Angle 2 for the offer.\nHeadline: Headline 2\nDescription: Desc 2",
      );
    });

    it("honors variantCount", async () => {
      const campaign = await createCampaign();
      const res = await generate({
        taskType: "meta_ad_creative",
        campaignId: campaign.id,
        variantCount: 5,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().drafts).toHaveLength(5);
    });

    it("creates a single asset-set draft for Google RSA", async () => {
      const campaign = await createCampaign();
      const res = await generate({ taskType: "google_rsa", campaignId: campaign.id });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.drafts).toHaveLength(1);
      const content = body.drafts[0].content as string;
      expect(validateAdCreative("google_rsa", content).ok).toBe(true);
      expect(content).toContain("Headline 15: H15");
      expect(content).toContain("Description 4: D4");
    });

    it("records the persona on the drafts", async () => {
      const campaign = await createCampaign();
      const persona = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/personas`,
          payload: { name: "Founder" },
        })
      ).json();
      const res = await generate({
        taskType: "meta_ad_creative",
        campaignId: campaign.id,
        personaId: persona.id,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().drafts[0].personaId).toBe(persona.id);
    });

    it("validates input and references", async () => {
      const campaign = await createCampaign();
      expect((await generate({ taskType: "meta_ad_creative" })).statusCode).toBe(400);
      expect(
        (
          await generate({
            taskType: "google_rsa",
            campaignId: campaign.id,
            variantCount: 3,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await generate({
            taskType: "meta_ad_creative",
            campaignId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await generate({
            taskType: "meta_ad_creative",
            campaignId: campaign.id,
            personaId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          })
        ).statusCode,
      ).toBe(404);

      const archived = await createCampaign({ name: "Old", status: "archived" });
      expect(
        (await generate({ taskType: "meta_ad_creative", campaignId: archived.id })).statusCode,
      ).toBe(409);
    });

    it("keeps over-limit variants but flags the violations", async () => {
      const campaign = await createCampaign({ objective: "MARKER-OVERLIMIT" });
      const res = await generate({ taskType: "meta_ad_creative", campaignId: campaign.id });
      expect(res.statusCode).toBe(201);
      const draft = res.json().drafts[0];
      expect(draft.state).toBe("pending_review");
      expect(draft.violations).toEqual([
        { field: "Headline", message: "Headline is 50 characters (max 40)." },
      ]);
    });

    it("returns 502 and creates no drafts when the output is unparseable", async () => {
      const campaign = await createCampaign({ objective: "MARKER-UNPARSEABLE" });
      const res = await generate({ taskType: "meta_ad_creative", campaignId: campaign.id });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("generation_unparseable");

      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(drafts).toHaveLength(0);
      // The generation is still stored for the trace.
      const generations = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/generations` })
      ).json();
      expect(generations).toHaveLength(1);
    });

    it("returns 502 on gateway failure", async () => {
      const campaign = await createCampaign({ objective: "MARKER-GATEWAY-FAIL" });
      const res = await generate({ taskType: "meta_ad_creative", campaignId: campaign.id });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("generation_failed");
    });
  });

  describe("approval gate format enforcement", () => {
    async function generateOne(objective = "Win the launch") {
      const campaign = await createCampaign({ objective });
      const res = await generate({
        taskType: "meta_ad_creative",
        campaignId: campaign.id,
        variantCount: 1,
      });
      return res.json().drafts[0];
    }

    it("refuses an edit that violates the format", async () => {
      const draft = await generateOne();
      const over = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/edit`,
        payload: {
          content: `Primary text: Fine.\nHeadline: ${"x".repeat(41)}\nDescription: ok`,
        },
      });
      expect(over.statusCode).toBe(400);
      expect(over.json().error).toBe("format_violation");

      const prose = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/edit`,
        payload: { content: "just prose, no labels" },
      });
      expect(prose.statusCode).toBe(400);
      expect(prose.json().error).toBe("format_violation");
    });

    it("refuses to approve an invalid draft until it is edited to fit", async () => {
      const draft = await generateOne("MARKER-OVERLIMIT");
      const approve = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
      });
      expect(approve.statusCode).toBe(409);
      expect(approve.json().error).toBe("format_violation");

      const edit = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/edit`,
        payload: { content: "Primary text: Fine.\nHeadline: Fits now\nDescription: ok" },
      });
      expect(edit.statusCode).toBe(200);
      const approved = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().state).toBe("approved");
    });

    it("approves a valid generated draft directly", async () => {
      const draft = await generateOne();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
      });
      expect(res.statusCode).toBe(200);
    });

    it("leaves non-ad-creative drafts unaffected", async () => {
      const generation = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json();
      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${generation.id}/submit`,
        })
      ).json();
      const edit = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/edit`,
        payload: { content: "free-form prose is fine here" },
      });
      expect(edit.statusCode).toBe(200);
    });
  });

  describe("variant sets", () => {
    it("groups drafts by generation with campaign name and violations", async () => {
      const campaign = await createCampaign();
      await generate({ taskType: "meta_ad_creative", campaignId: campaign.id });
      await generate({ taskType: "google_rsa", campaignId: campaign.id });

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/ad-creatives`,
      });
      expect(res.statusCode).toBe(200);
      const sets = res.json();
      expect(sets).toHaveLength(2);
      const meta = sets.find((s: { taskType: string }) => s.taskType === "meta_ad_creative");
      expect(meta.drafts).toHaveLength(3);
      expect(meta.campaignId).toBe(campaign.id);
      expect(meta.campaignName).toBe("Launch");
      expect(meta.adMetrics).toBeNull();
      expect(meta.drafts[0].violations).toEqual([]);

      const rsa = sets.find((s: { taskType: string }) => s.taskType === "google_rsa");
      expect(rsa.drafts).toHaveLength(1);
    });

    it("shows paid performance when the campaign has linked ad metrics", async () => {
      const campaign = await createCampaign();
      await generate({ taskType: "meta_ad_creative", campaignId: campaign.id });

      // Seed Sprint 14 metrics through the CSV path and link to the campaign.
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/import-csv`,
        payload: {
          rows: [
            {
              date: "2026-06-01",
              campaignName: "Meta launch",
              spend: 12.5,
              impressions: 1000,
              clicks: 40,
              conversions: 3,
            },
          ],
        },
      });
      const report = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/report` })
      ).json();
      const adCampaignId = report.campaigns[0].adCampaign.id;
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/campaigns/${adCampaignId}/link`,
        payload: { campaignId: campaign.id },
      });

      const sets = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ad-creatives` })
      ).json();
      expect(sets[0].adMetrics).not.toBeNull();
      expect(sets[0].adMetrics.totals.spendCents).toBe(1250);
    });
  });

  describe("export", () => {
    it("exports approved Meta variants as CSV", async () => {
      const campaign = await createCampaign();
      const body = (
        await generate({ taskType: "meta_ad_creative", campaignId: campaign.id })
      ).json();
      // Approve two of the three.
      for (const draft of body.drafts.slice(0, 2)) {
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
        });
      }
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/ad-creatives/export.csv?taskType=meta_ad_creative`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      const lines = res.body.trim().split("\n");
      expect(lines[0]).toBe("campaign,primary_text,headline,description,state");
      expect(lines).toHaveLength(3); // header + 2 approved
      expect(lines[1]).toContain("Launch");
      expect(lines[1]).toContain("approved");
    });

    it("exports Google RSA with padded numbered columns", async () => {
      const campaign = await createCampaign();
      const body = (await generate({ taskType: "google_rsa", campaignId: campaign.id })).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${body.drafts[0].id}/approve`,
      });
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/ad-creatives/export.csv?taskType=google_rsa`,
      });
      const lines = res.body.trim().split("\n");
      const header = lines[0]!.split(",");
      expect(header[0]).toBe("campaign");
      expect(header).toContain("headline_1");
      expect(header).toContain("headline_15");
      expect(header).toContain("description_4");
      expect(header[header.length - 1]).toBe("state");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("H15");
    });

    it("never leaks other task types or other states", async () => {
      const campaign = await createCampaign();
      await generate({ taskType: "meta_ad_creative", campaignId: campaign.id }); // all pending

      // An approved linkedin draft must not appear in the export.
      const generation = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json();
      const linkedin = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${generation.id}/submit`,
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${linkedin.id}/approve`,
      });

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/ad-creatives/export.csv?taskType=meta_ad_creative`,
      });
      expect(res.body.trim().split("\n")).toHaveLength(1); // header only

      expect(
        (
          await app.inject({
            method: "GET",
            url: `/workspaces/${workspaceId}/ad-creatives/export.csv?taskType=linkedin_post`,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/workspaces/${workspaceId}/ad-creatives/export.csv?taskType=meta_ad_creative&state=nope`,
          })
        ).statusCode,
      ).toBe(400);
    });
  });
});
