import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { campaignSchema } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import type { LlmGateway } from "../src/llm/gateway";
import { createTestDb } from "./helpers";

const fakeGateway: LlmGateway = {
  async generate() {
    return { text: "Generated output.", model: "fake", provider: "fake", durationMs: 5 };
  },
};

const CAMPAIGN_PAYLOAD = {
  name: "Q3 GTM memory push",
  objective: "Position Tuezday as the GTM memory layer",
  kpi: "20 demo calls booked",
  timeframe: "Jul-Sep 2026",
  audience: "Founder-led SaaS teams",
  pillars: ["GTM that remembers", "Brain before pipeline"],
  channels: ["linkedin", "email"],
  overlay: "This quarter we lead hard on the memory problem.",
};

describe("campaigns API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildApp({ db: createTestDb(), llm: fakeGateway });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Campy" } })
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

  async function createCampaign(payload: Record<string, unknown> = CAMPAIGN_PAYLOAD) {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload,
      })
    ).json();
  }

  describe("CRUD", () => {
    it("creates a campaign", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: CAMPAIGN_PAYLOAD,
      });
      expect(res.statusCode).toBe(201);
      const campaign = res.json();
      expect(campaignSchema.safeParse(campaign).success).toBe(true);
      expect(campaign.status).toBe("active");
      expect(campaign.pillars).toEqual(CAMPAIGN_PAYLOAD.pillars);
    });

    it("rejects an empty name", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: " " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("lists campaigns", async () => {
      await createCampaign();
      await createCampaign({ ...CAMPAIGN_PAYLOAD, name: "Second" });
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/campaigns` })
      ).json();
      expect(list).toHaveLength(2);
    });

    it("updates and archives a campaign", async () => {
      const campaign = await createCampaign();
      const res = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
        payload: { ...CAMPAIGN_PAYLOAD, name: "Renamed", status: "archived" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("Renamed");
      expect(res.json().status).toBe("archived");
    });

    it("returns 404 for an unknown campaign", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/campaigns/7c9e6679-7425-40de-944b-e07fc1f90ae7`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("resolver integration", () => {
    it("includes a composed campaign section when campaignId is given", async () => {
      const campaign = await createCampaign();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
      });
      expect(res.statusCode).toBe(200);
      const section = res.json().sections.find((s: { key: string }) => s.key === "campaign");
      expect(section.included).toBe(true);
      expect(section.title).toContain("Q3 GTM memory push");
      expect(section.content).toContain("Position Tuezday as the GTM memory layer");
      expect(section.content).toContain("GTM that remembers");
      expect(section.content).toContain("memory problem");
      expect(section.content).toContain("20 demo calls");
    });

    it("keeps the campaign slot excluded without a campaignId", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      });
      const section = res.json().sections.find((s: { key: string }) => s.key === "campaign");
      expect(section.included).toBe(false);
    });

    it("returns 404 for an unknown campaignId", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: {
          taskType: "linkedin_post",
          channel: "linkedin",
          campaignId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("campaign_not_found");
    });

    it("refuses an archived campaign with 409", async () => {
      const campaign = await createCampaign();
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
        payload: { ...CAMPAIGN_PAYLOAD, status: "archived" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("campaign_archived");
    });
  });

  describe("tagging", () => {
    it("tags generations and submitted drafts with the campaign", async () => {
      const campaign = await createCampaign();
      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
        })
      ).json();
      expect(gen.campaignId).toBe(campaign.id);

      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${gen.id}/submit`,
        })
      ).json();
      expect(draft.campaignId).toBe(campaign.id);
    });

    it("tags signal-response drafts with the campaign", async () => {
      const campaign = await createCampaign();
      const signal = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/signals`,
          payload: { content: "Market complaint", source: "reddit" },
        })
      ).json();
      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/signals/${signal.id}/draft`,
          payload: { channel: "linkedin", campaignId: campaign.id },
        })
      ).json();
      expect(draft.campaignId).toBe(campaign.id);
    });

    it("filters drafts by campaign", async () => {
      const campaign = await createCampaign();
      const tagged = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${tagged.id}/submit`,
      });
      const untagged = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${untagged.id}/submit`,
      });

      const filtered = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/drafts?campaignId=${campaign.id}`,
        })
      ).json();
      expect(filtered).toHaveLength(1);
      expect(filtered[0].campaignId).toBe(campaign.id);
    });

    it("reports draft counts by state on the campaign detail", async () => {
      const campaign = await createCampaign();
      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
        })
      ).json();
      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${gen.id}/submit`,
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
      });

      const detail = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
        })
      ).json();
      expect(detail.campaign.id).toBe(campaign.id);
      expect(detail.draftCounts.approved).toBe(1);
      expect(detail.drafts).toHaveLength(1);
      expect(detail.drafts[0].state).toBe("approved");
    });
  });
});
