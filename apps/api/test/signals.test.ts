import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftSchema, signalSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
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
