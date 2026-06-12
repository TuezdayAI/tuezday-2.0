import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mediaContactSchema } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { createTestDb } from "./helpers";

function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      if (prompt.includes("FAIL-THIS-CONTACT")) {
        throw new GatewayError("provider_error", "boom");
      }
      const contactMatch = /Pitching: ([^\n—]+)/.exec(prompt);
      const text = contactMatch
        ? `Subject: A story for ${contactMatch[1]!.trim()}\n\nPitch body referencing the beat.`
        : "One-liner: Tuezday is the GTM brain.\nAbout: Tuezday keeps go-to-market context in one place.\nKey facts:\n- Founded 2026";
      return { text, model: "fake", provider: "fake", durationMs: 5 };
    },
  };
}

const CSV = `name,email,publication,topics,type,notes
Riya Sen,riya@techcrunch.com,TechCrunch India,"AI startups, developer tools",journalist,Covered GTM tooling in May
Sam Wood,sam@saaspod.fm,The SaaS Pod,founder-led growth,podcast,
Bad Row,not-an-email,Nope,,,
Mystery Type,mt@wired.com,Wired,,influencer,
Riya Sen,RIYA@techcrunch.com,TechCrunch India,,journalist,duplicate by email`;

describe("PR & media outreach API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildApp({ db: createTestDb(), llm: fakeGateway() });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "PR" } })
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

  async function createContact(payload: Record<string, unknown> = {}) {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/media-contacts`,
        payload: {
          name: "Riya Sen",
          email: "riya@techcrunch.com",
          type: "journalist",
          outlet: "TechCrunch India",
          beat: "AI startups and developer tools",
          coverageNotes: "Covered GTM tooling consolidation in May",
          ...payload,
        },
      })
    ).json();
  }

  async function createSignal() {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/signals`,
        payload: {
          content: "Big incumbent just shut down its marketing suite, users stranded.",
          source: "news",
        },
      })
    ).json();
  }

  describe("media contacts", () => {
    it("creates and lists contacts", async () => {
      const contact = await createContact();
      expect(mediaContactSchema.safeParse(contact).success).toBe(true);
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/media-contacts` })
      ).json();
      expect(list).toHaveLength(1);
      expect(list[0].beat).toBe("AI startups and developer tools");
    });

    it("rejects an invalid email", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/media-contacts`,
        payload: { name: "X", email: "nope" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("deletes a contact and 404s on an unknown one", async () => {
      const contact = await createContact();
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/media-contacts/${contact.id}`,
      });
      expect(res.statusCode).toBe(204);
      const again = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/media-contacts/${contact.id}`,
      });
      expect(again.statusCode).toBe(404);
    });

    it("imports CSV with aliased headers, quoted fields, type fallback, and dedupe", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/media-contacts/import`,
        payload: { csv: CSV },
      });
      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.imported).toBe(3);
      expect(result.skipped).toBe(2);

      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/media-contacts` })
      ).json();
      expect(list).toHaveLength(3);
      const riya = list.find((c: { email: string }) => c.email === "riya@techcrunch.com");
      expect(riya.outlet).toBe("TechCrunch India");
      expect(riya.beat).toBe("AI startups, developer tools");
      expect(riya.coverageNotes).toBe("Covered GTM tooling in May");
      const sam = list.find((c: { email: string }) => c.email === "sam@saaspod.fm");
      expect(sam.type).toBe("podcast");
      const mystery = list.find((c: { email: string }) => c.email === "mt@wired.com");
      expect(mystery.type).toBe("journalist"); // unknown type falls back
    });

    it("dedupes against existing contacts", async () => {
      await createContact();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/media-contacts/import`,
        payload: { csv: "name,email\nRiya Again,riya@techcrunch.com" },
      });
      expect(res.json().imported).toBe(0);
      expect(res.json().skipped).toBe(1);
    });
  });

  describe("pitch drafting", () => {
    it("creates a personalized pending_review draft per contact", async () => {
      const riya = await createContact();
      const sam = await createContact({
        name: "Sam Wood",
        email: "sam@saaspod.fm",
        type: "podcast",
        outlet: "The SaaS Pod",
        beat: "founder-led growth",
        coverageNotes: "",
      });

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: { contactIds: [riya.id, sam.id], pitchType: "announcement" },
      });
      expect(res.statusCode).toBe(200);
      const results = res.json().results;
      expect(results).toHaveLength(2);
      expect(results.every((r: { draftId?: string }) => r.draftId)).toBe(true);

      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(drafts).toHaveLength(2);
      const riyaDraft = drafts.find((d: { mediaContactId: string }) => d.mediaContactId === riya.id);
      expect(riyaDraft.state).toBe("pending_review");
      expect(riyaDraft.taskType).toBe("pr_pitch");
      expect(riyaDraft.channel).toBe("pr");
      expect(riyaDraft.content).toContain("Riya Sen");

      const gens = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/generations` })
      ).json();
      const riyaGen = gens.find(
        (g: { mediaContactId: string }) => g.mediaContactId === riya.id,
      );
      expect(riyaGen.prompt).toContain("TechCrunch India");
      expect(riyaGen.prompt).toContain("AI startups and developer tools");
      expect(riyaGen.prompt).toContain("GTM tooling consolidation");
      expect(riyaGen.taskType).toBe("pr_pitch");
    });

    it("carries persona and campaign through", async () => {
      const persona = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/personas`,
          payload: { name: "Founder" },
        })
      ).json();
      const campaign = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns`,
          payload: { name: "Launch week" },
        })
      ).json();
      const contact = await createContact();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: {
          contactIds: [contact.id],
          pitchType: "announcement",
          personaId: persona.id,
          campaignId: campaign.id,
        },
      });
      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(drafts[0].personaId).toBe(persona.id);
      expect(drafts[0].campaignId).toBe(campaign.id);
    });

    it("409s on an archived campaign", async () => {
      const campaign = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns`,
          payload: { name: "Done", status: "archived" },
        })
      ).json();
      const contact = await createContact();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: { contactIds: [contact.id], pitchType: "announcement", campaignId: campaign.id },
      });
      expect(res.statusCode).toBe(409);
    });

    it("404s on an unknown contact id", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: {
          contactIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
          pitchType: "announcement",
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it("embeds the signal in a reactive pitch and stamps provenance", async () => {
      const contact = await createContact();
      const signal = await createSignal();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: { contactIds: [contact.id], pitchType: "reactive", signalId: signal.id },
      });
      expect(res.statusCode).toBe(200);
      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(drafts[0].sourceSignalId).toBe(signal.id);
      const gens = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/generations` })
      ).json();
      expect(gens[0].prompt).toContain("users stranded");
      expect(gens[0].prompt).toMatch(/timeliness/i);
    });

    it("400s a reactive pitch without a signal and a signal on a non-reactive pitch", async () => {
      const contact = await createContact();
      const signal = await createSignal();
      const noSignal = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: { contactIds: [contact.id], pitchType: "reactive" },
      });
      expect(noSignal.statusCode).toBe(400);
      const withSignal = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: { contactIds: [contact.id], pitchType: "announcement", signalId: signal.id },
      });
      expect(withSignal.statusCode).toBe(400);
    });

    it("404s on an unknown signal", async () => {
      const contact = await createContact();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: {
          contactIds: [contact.id],
          pitchType: "reactive",
          signalId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it("tolerates per-contact failures without aborting the batch", async () => {
      const good = await createContact();
      const bad = await createContact({ name: "FAIL-THIS-CONTACT", email: "fail@x.io" });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: { contactIds: [good.id, bad.id], pitchType: "announcement" },
      });
      const results = res.json().results;
      expect(results.find((r: { contactId: string }) => r.contactId === good.id).draftId).toBeDefined();
      expect(results.find((r: { contactId: string }) => r.contactId === bad.id).error).toContain("boom");
      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(drafts).toHaveLength(1);
    });
  });

  describe("press kit", () => {
    it("creates a press_boilerplate draft from the brain", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/press-kit`,
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const draft = res.json();
      expect(draft.taskType).toBe("press_boilerplate");
      expect(draft.channel).toBe("pr");
      expect(draft.state).toBe("pending_review");
      expect(draft.content).toContain("One-liner:");
      expect(draft.mediaContactId).toBeNull();
    });

    it("creates a new draft per regeneration — the version history", async () => {
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/press-kit`,
        payload: {},
      });
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/press-kit`,
        payload: {},
      });
      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(
        drafts.filter((d: { taskType: string }) => d.taskType === "press_boilerplate"),
      ).toHaveLength(2);
    });
  });

  describe("export", () => {
    it("exports approved contact-linked drafts as CSV with escaping", async () => {
      const contact = await createContact({ outlet: 'TechCrunch, "India"' });
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: { contactIds: [contact.id], pitchType: "announcement" },
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
        url: `/workspaces/${workspaceId}/pr/export.csv`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      const lines = res.body.split("\n");
      expect(lines[0]).toBe("name,email,type,outlet,beat,content");
      expect(res.body).toContain("riya@techcrunch.com");
      expect(res.body).toContain('"TechCrunch, ""India"""');
      expect(res.body).toContain("Subject: A story for Riya Sen");
    });

    it("exports only the requested state and rejects unknown states", async () => {
      const contact = await createContact();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: { contactIds: [contact.id], pitchType: "announcement" },
      });
      // still pending_review — approved export is header-only
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/pr/export.csv`,
      });
      expect(res.body.trim().split("\n")).toHaveLength(1);
      const bad = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/pr/export.csv?state=published`,
      });
      expect(bad.statusCode).toBe(400);
    });

    it("never mixes outbound and PR exports", async () => {
      const contact = await createContact();
      const lead = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/leads`,
          payload: { name: "Asha Patel", email: "asha@acme.io" },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/pr/pitch`,
        payload: { contactIds: [contact.id], pitchType: "announcement" },
      });
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/draft`,
        payload: { leadIds: [lead.id] },
      });
      const drafts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      for (const draft of drafts) {
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
        });
      }
      const pr = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/pr/export.csv`,
      });
      expect(pr.body).toContain("riya@techcrunch.com");
      expect(pr.body).not.toContain("asha@acme.io");
      const outbound = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/outbound/export.csv`,
      });
      expect(outbound.body).toContain("asha@acme.io");
      expect(outbound.body).not.toContain("riya@techcrunch.com");
    });
  });
});
