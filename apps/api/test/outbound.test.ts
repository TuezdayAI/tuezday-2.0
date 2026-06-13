import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leadSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      const leadMatch = /To: ([^\n]+)/.exec(prompt);
      if (prompt.includes("FAIL-THIS-LEAD")) {
        throw new GatewayError("provider_error", "boom");
      }
      return {
        text: `Subject: For ${leadMatch?.[1] ?? "you"}\n\nPersonalized email body.`,
        model: "fake",
        provider: "fake",
        durationMs: 5,
      };
    },
  };
}

const CSV = `name,email,company,role,notes
Asha Patel,asha@acme.io,Acme Robotics,Head of Growth,"Complained about AI slop, wants better"
Ben Cho,ben@volt.dev,Volt,Founder,Met at SaaStr
Bad Row,not-an-email,Nope,,
Asha Patel,ASHA@acme.io,Acme Robotics,,duplicate by email`;

describe("outbound API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: fakeGateway() });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Out" } })
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

  async function createLead(payload: Record<string, unknown> = {}) {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/leads`,
        payload: { name: "Asha Patel", email: "asha@acme.io", company: "Acme Robotics", role: "Head of Growth", notes: "Hates AI slop", ...payload },
      })
    ).json();
  }

  describe("leads", () => {
    it("creates and lists leads", async () => {
      const lead = await createLead();
      expect(leadSchema.safeParse(lead).success).toBe(true);
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/leads` })
      ).json();
      expect(list).toHaveLength(1);
    });

    it("rejects an invalid email", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/leads`,
        payload: { name: "X", email: "nope" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("deletes a lead", async () => {
      const lead = await createLead();
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/leads/${lead.id}`,
      });
      expect(res.statusCode).toBe(204);
    });

    it("imports CSV with quoted fields, skips invalid emails, dedupes", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/leads/import`,
        payload: { csv: CSV },
      });
      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(2);

      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/leads` })
      ).json();
      expect(list).toHaveLength(2);
      const asha = list.find((l: { email: string }) => l.email === "asha@acme.io");
      expect(asha.notes).toBe("Complained about AI slop, wants better");
    });

    it("handles reordered headers", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/leads/import`,
        payload: { csv: "email,name\nzoe@x.io,Zoe" },
      });
      expect(res.json().imported).toBe(1);
    });

    it("dedupes against existing leads", async () => {
      await createLead();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/leads/import`,
        payload: { csv: "name,email\nAsha Again,asha@acme.io" },
      });
      expect(res.json().imported).toBe(0);
      expect(res.json().skipped).toBe(1);
    });
  });

  describe("batch drafting", () => {
    it("creates a personalized pending_review draft per lead", async () => {
      const asha = await createLead();
      const ben = await createLead({ name: "Ben Cho", email: "ben@volt.dev", company: "Volt", role: "Founder", notes: "" });

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/draft`,
        payload: { leadIds: [asha.id, ben.id] },
      });
      expect(res.statusCode).toBe(200);
      const results = res.json().results;
      expect(results).toHaveLength(2);
      expect(results.every((r: { draftId?: string }) => r.draftId)).toBe(true);

      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(drafts).toHaveLength(2);
      const ashaDraft = drafts.find((d: { leadId: string }) => d.leadId === asha.id);
      expect(ashaDraft.state).toBe("pending_review");
      expect(ashaDraft.taskType).toBe("outbound_email");
      expect(ashaDraft.content).toContain("Asha Patel");

      const gens = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/generations` })
      ).json();
      const ashaGen = gens.find((g: { leadId: string }) => g.leadId === asha.id);
      expect(ashaGen.prompt).toContain("Acme Robotics");
      expect(ashaGen.prompt).toContain("Hates AI slop");
    });

    it("tolerates per-lead failures without aborting the batch", async () => {
      const good = await createLead();
      const bad = await createLead({ name: "FAIL-THIS-LEAD", email: "fail@x.io" });

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/draft`,
        payload: { leadIds: [good.id, bad.id] },
      });
      const results = res.json().results;
      expect(results.find((r: { leadId: string }) => r.leadId === good.id).draftId).toBeDefined();
      expect(results.find((r: { leadId: string }) => r.leadId === bad.id).error).toContain("boom");
      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(drafts).toHaveLength(1);
    });

    it("404s on an unknown lead id", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/draft`,
        payload: { leadIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"] },
      });
      expect(res.statusCode).toBe(404);
    });

    it("carries persona and campaign through", async () => {
      const persona = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/personas`,
          payload: { name: "CEO" },
        })
      ).json();
      const campaign = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns`,
          payload: { name: "Outbound Q3" },
        })
      ).json();
      const lead = await createLead();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/draft`,
        payload: { leadIds: [lead.id], personaId: persona.id, campaignId: campaign.id },
      });
      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(drafts[0].personaId).toBe(persona.id);
      expect(drafts[0].campaignId).toBe(campaign.id);
    });
  });

  describe("export", () => {
    it("exports approved lead-linked drafts as CSV with escaping", async () => {
      const lead = await createLead({ company: 'Acme, "Robotics"' });
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/draft`,
        payload: { leadIds: [lead.id] },
      });
      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${drafts[0].id}/approve`,
      });

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/outbound/export.csv`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      const lines = res.body.split("\n");
      expect(lines[0]).toBe("name,email,company,role,channel,content");
      expect(res.body).toContain("asha@acme.io");
      expect(res.body).toContain('"Acme, ""Robotics"""');
      expect(res.body).toContain("Subject: For Asha Patel");
    });

    it("exports only the requested state", async () => {
      const lead = await createLead();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/draft`,
        payload: { leadIds: [lead.id] },
      });
      // still pending_review — approved export should be empty
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/outbound/export.csv`,
      });
      expect(res.body.trim().split("\n")).toHaveLength(1); // header only
    });
  });
});
