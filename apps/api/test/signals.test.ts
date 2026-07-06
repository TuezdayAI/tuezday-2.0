import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { draftSchema, signalSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { signalMatches } from "../src/db/schema";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      return {
        text: `RESPONSE (saw signal: ${prompt.includes("Market signal")})`,
        model: "fake-model",
        provider: "fake",
        durationMs: 5,
      };
    },
  };
}

describe("signals API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: fakeGateway() });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Signals Co" } })
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

  async function createSignal(payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/signals`,
      payload: {
        content: "Reddit thread: why does all AI content sound the same?",
        source: "reddit",
        sourceUrl: "https://reddit.com/r/marketing/abc",
        ...payload,
      },
    });
  }

  describe("POST /workspaces/:id/signals", () => {
    it("creates a signal", async () => {
      const res = await createSignal();
      expect(res.statusCode).toBe(201);
      const signal = res.json();
      expect(signalSchema.safeParse(signal).success).toBe(true);
      expect(signal.source).toBe("reddit");
      expect(signal.sourceUrl).toBe("https://reddit.com/r/marketing/abc");
    });

    it("creates a signal without a url", async () => {
      const res = await createSignal({ sourceUrl: undefined, source: "other" });
      expect(res.statusCode).toBe(201);
      expect(res.json().sourceUrl).toBeNull();
    });

    it("rejects empty content", async () => {
      const res = await createSignal({ content: "  " });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown source", async () => {
      const res = await createSignal({ source: "tiktok" });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for an unknown workspace", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/signals",
        payload: { content: "hi", source: "x" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /workspaces/:id/signals/:signalId/draft", () => {
    it("generates a draft from the signal straight into pending_review", async () => {
      const signal = (await createSignal()).json();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/signals/${signal.id}/draft`,
        payload: { channel: "linkedin" },
      });
      expect(res.statusCode).toBe(201);
      const draft = res.json();
      expect(draftSchema.safeParse(draft).success).toBe(true);
      expect(draft.state).toBe("pending_review");
      expect(draft.taskType).toBe("signal_response");
      expect(draft.sourceSignalId).toBe(signal.id);
      expect(draft.sourceGenerationId).not.toBeNull();
      // the fake gateway proves the signal section reached the prompt
      expect(draft.content).toContain("saw signal: true");
    });

    it("stores the generation in the training log", async () => {
      const signal = (await createSignal()).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/signals/${signal.id}/draft`,
        payload: { channel: "linkedin" },
      });
      const gens = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/generations` })
      ).json();
      expect(gens).toHaveLength(1);
      expect(gens[0].taskType).toBe("signal_response");
      expect(gens[0].prompt).toContain("Market signal");
    });

    it("allows multiple drafts per signal", async () => {
      const signal = (await createSignal()).json();
      const first = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/signals/${signal.id}/draft`,
        payload: { channel: "linkedin" },
      });
      const second = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/signals/${signal.id}/draft`,
        payload: { channel: "x" },
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().channel).toBe("x");
    });

    it("includes the persona overlay when given", async () => {
      const persona = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/personas`,
          payload: { name: "CEO", overlay: "Founder voice." },
        })
      ).json();
      const signal = (await createSignal()).json();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/signals/${signal.id}/draft`,
        payload: { channel: "linkedin", personaId: persona.id },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().personaId).toBe(persona.id);
    });

    it("returns 502 and stores nothing when the provider fails", async () => {
      const failApp = await buildAuthedApp({
        db: createTestDb(),
        llm: {
          async generate() {
            throw new GatewayError("provider_error", "boom");
          },
        },
      });
      const ws = (
        await failApp.inject({ method: "POST", url: "/workspaces", payload: { name: "F" } })
      ).json();
      const signal = (
        await failApp.inject({
          method: "POST",
          url: `/workspaces/${ws.id}/signals`,
          payload: { content: "sig", source: "x" },
        })
      ).json();
      const res = await failApp.inject({
        method: "POST",
        url: `/workspaces/${ws.id}/signals/${signal.id}/draft`,
        payload: { channel: "x" },
      });
      expect(res.statusCode).toBe(502);
      const drafts = (
        await failApp.inject({ method: "GET", url: `/workspaces/${ws.id}/drafts` })
      ).json();
      expect(drafts).toEqual([]);
      await failApp.close();
    });

    it("returns 404 for an unknown signal", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/signals/7c9e6679-7425-40de-944b-e07fc1f90ae7/draft`,
        payload: { channel: "linkedin" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // Sprint 45: POST /signals runs the same persona×campaign matching a
  // discovered item gets — unless the caller named a persona/campaign
  // explicitly, in which case that input is trusted and the LLM never runs.
  describe("manual signal matching", () => {
    /**
     * Fresh app + workspace with one persona assigned to one active campaign.
     * Deliberately no brain-doc PUT: saving a brain doc makes a best-effort
     * outline-summary LLM call (Sprint 43) that would pollute the strict
     * gateway-invocation counts these tests assert on.
     */
    async function buildMatchingApp(llm: LlmGateway) {
      const db = createTestDb();
      const matchApp = await buildAuthedApp({ db, llm });
      const wsId = (
        await matchApp.inject({ method: "POST", url: "/workspaces", payload: { name: "Match Co" } })
      ).json().id as string;
      const persona = (
        await matchApp.inject({
          method: "POST",
          url: `/workspaces/${wsId}/personas`,
          payload: { name: "Field CTO" },
        })
      ).json();
      // The persona must be assigned to the campaign — matching drops a
      // suggested persona the campaign doesn't allow.
      const campaign = (
        await matchApp.inject({
          method: "POST",
          url: `/workspaces/${wsId}/campaigns`,
          payload: { name: "Launch", objective: "Win fintech VPs", personaIds: [persona.id] },
        })
      ).json();
      return {
        matchApp,
        db,
        wsId,
        personaId: persona.id as string,
        campaignId: campaign.id as string,
      };
    }

    /** Records every prompt; answers scoring calls with one persona×campaign match. */
    function matchingGateway(
      refs: { personaId: string | null; campaignId: string | null },
      calls: string[],
    ): LlmGateway {
      return {
        async generate({ prompt }) {
          calls.push(prompt);
          return {
            text: JSON.stringify([
              {
                index: 0,
                score: 88,
                matches: [
                  {
                    personaId: refs.personaId,
                    campaignId: refs.campaignId,
                    score: 74,
                    reason: "Fits the launch pipeline.",
                  },
                ],
              },
            ]),
            model: "fake",
            provider: "fake",
            durationMs: 3,
          };
        },
      };
    }

    it("scores an unmapped signal through the LLM into signal_matches rows", async () => {
      const refs: { personaId: string | null; campaignId: string | null } = {
        personaId: null,
        campaignId: null,
      };
      const calls: string[] = [];
      const { matchApp, db, wsId, personaId, campaignId } = await buildMatchingApp(
        matchingGateway(refs, calls),
      );
      refs.personaId = personaId;
      refs.campaignId = campaignId;

      const res = await matchApp.inject({
        method: "POST",
        url: `/workspaces/${wsId}/signals`,
        payload: { content: "A new agentic-coding benchmark just dropped", source: "other" },
      });
      expect(res.statusCode).toBe(201);
      const signal = res.json();
      expect(signalSchema.safeParse(signal).success).toBe(true);
      // one LLM judgment call, carrying the signal content
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("A new agentic-coding benchmark just dropped");
      expect(signal.matches).toHaveLength(1);
      expect(signal.matches[0]).toMatchObject({
        personaId,
        personaName: "Field CTO",
        campaignId,
        campaignName: "Launch",
        score: 74,
        reason: "Fits the launch pipeline.",
      });
      // the best match is patched onto the convenience fields
      expect(signal.suggestedPersonaId).toBe(personaId);
      expect(signal.suggestedCampaignId).toBe(campaignId);
      // and it is backed by a real signal_matches row
      const rows = db
        .select()
        .from(signalMatches)
        .where(eq(signalMatches.signalId, signal.id))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ personaId, campaignId, score: 74 });
      await matchApp.close();
    });

    it("an explicit persona skips the LLM and writes one score-100 match", async () => {
      const calls: string[] = [];
      const { matchApp, wsId, personaId } = await buildMatchingApp(
        matchingGateway({ personaId: null, campaignId: null }, calls),
      );
      const res = await matchApp.inject({
        method: "POST",
        url: `/workspaces/${wsId}/signals`,
        payload: { content: "Founder already knows who this is for", source: "other", suggestedPersonaId: personaId },
      });
      expect(res.statusCode).toBe(201);
      expect(calls).toHaveLength(0); // explicit intent: the LLM was never invoked
      const signal = res.json();
      expect(signal.matches).toEqual([
        {
          personaId,
          personaName: "Field CTO",
          campaignId: null,
          campaignName: null,
          score: 100,
          reason: "Set explicitly at signal creation.",
        },
      ]);
      expect(signal.suggestedPersonaId).toBe(personaId);
      await matchApp.close();
    });

    it("an explicit campaign skips the LLM and writes one score-100 match", async () => {
      const calls: string[] = [];
      const { matchApp, wsId, campaignId } = await buildMatchingApp(
        matchingGateway({ personaId: null, campaignId: null }, calls),
      );
      const res = await matchApp.inject({
        method: "POST",
        url: `/workspaces/${wsId}/signals`,
        payload: { content: "Slot this under the launch push", source: "other", suggestedCampaignId: campaignId },
      });
      expect(res.statusCode).toBe(201);
      expect(calls).toHaveLength(0);
      const signal = res.json();
      expect(signal.matches).toEqual([
        {
          personaId: null,
          personaName: null,
          campaignId,
          campaignName: "Launch",
          score: 100,
          reason: "Set explicitly at signal creation.",
        },
      ]);
      expect(signal.suggestedCampaignId).toBe(campaignId);
      await matchApp.close();
    });

    it("still creates the signal with zero matches when the LLM fails", async () => {
      const calls: string[] = [];
      const throwing: LlmGateway = {
        async generate({ prompt }) {
          calls.push(prompt);
          throw new GatewayError("provider_error", "boom");
        },
      };
      const { matchApp, wsId } = await buildMatchingApp(throwing);
      const res = await matchApp.inject({
        method: "POST",
        url: `/workspaces/${wsId}/signals`,
        payload: { content: "Signal that arrives during an LLM outage", source: "other" },
      });
      expect(res.statusCode).toBe(201);
      expect(calls).toHaveLength(1); // matching was attempted...
      const signal = res.json();
      expect(signalSchema.safeParse(signal).success).toBe(true);
      expect(signal.matches).toEqual([]); // ...but its failure never blocked creation
      // the signal really persisted
      const list = (
        await matchApp.inject({ method: "GET", url: `/workspaces/${wsId}/signals` })
      ).json();
      expect(list.map((s: { id: string }) => s.id)).toContain(signal.id);
      await matchApp.close();
    });
  });

  describe("GET /workspaces/:id/signals", () => {
    it("lists signals newest first with draft summaries", async () => {
      const s1 = (await createSignal()).json();
      const s2 = (await createSignal({ content: "Second signal", source: "x" })).json();
      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/signals/${s1.id}/draft`,
          payload: { channel: "linkedin" },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
      });

      const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/signals` });
      const list = res.json();
      expect(list).toHaveLength(2);
      const withDraft = list.find((s: { id: string }) => s.id === s1.id);
      const withoutDraft = list.find((s: { id: string }) => s.id === s2.id);
      expect(withoutDraft.drafts).toEqual([]);
      expect(withDraft.drafts).toHaveLength(1);
      expect(withDraft.drafts[0]).toMatchObject({
        id: draft.id,
        state: "approved",
        channel: "linkedin",
      });
    });
  });
});
