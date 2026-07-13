import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calendarEntrySchema,
  createPostingCadenceInputSchema,
  postingCadenceSchema,
  publicationSchema,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import { publications } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { applyDraftAction, submitDraft } from "../src/services/drafts";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated.", model: "fake", provider: "fake", durationMs: 1 };
  },
};

// Monday 08:00:00 UTC — a fixed clock so slot timestamps are deterministic.
const MONDAY_8AM_UTC = new Date("2026-07-06T08:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// --- Minimal fake fabric with an in-memory Reddit behind the proxy ----------

interface FabricState {
  connections: Map<string, unknown>;
  posts: Array<{ sr: string; title: string; text: string }>;
  nextId: number;
}

function fabricState(): FabricState {
  return { connections: new Map(), posts: [], nextId: 1 };
}

function fakeFabric(state: FabricState): ConnectorFabric {
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession(integrationKey, endUserId) {
      return { token: `tok-${integrationKey}-${endUserId}` };
    },
    async importConnection(_key, connectionId, credentials) {
      state.connections.set(connectionId, credentials);
    },
    async connectionExists(connectionId) {
      return state.connections.has(connectionId);
    },
    async deleteConnection(connectionId) {
      state.connections.delete(connectionId);
    },
    async proxyGet() {
      return { status: 200, bodySnippet: '{"ok":true}' };
    },
    async proxyJson(method, path, _connectionId, _providerConfigKey, opts): Promise<ProxyJsonResult> {
      if (method === "POST" && path.startsWith("/api/submit")) {
        const id = state.nextId++;
        const form = opts?.form ?? {};
        state.posts.push({ sr: form.sr ?? "", title: form.title ?? "", text: form.text ?? "" });
        return {
          status: 200,
          json: {
            json: {
              errors: [],
              data: { name: `t3_p${id}`, url: `https://www.reddit.com/r/${form.sr}/c/p${id}/` },
            },
          },
        };
      }
      if (method === "GET" && path.startsWith("/api/v1/me")) {
        return { status: 200, json: { name: "founder" } };
      }
      return { status: 404, json: { message: "no endpoint" } };
    },
  };
}

describe("posting cadences", () => {
  let app: TuezdayApp;
  let db: Db;
  let state: FabricState;
  let workspaceId: string;

  beforeEach(async () => {
    vi.stubEnv("REDDIT_CLIENT_ID", "cid");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "csecret");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MONDAY_8AM_UTC);
    db = createTestDb();
    state = fabricState();
    app = await buildAuthedApp({ db, llm: fakeLlm, connectors: fakeFabric(state) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Cadencer" } })
    ).json().id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await app.close();
  });

  async function connectReddit(): Promise<string> {
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/reddit/oauth/session`,
    });
    const nangoConnectionId = `nango-${randomUUID()}`;
    state.connections.set(nangoConnectionId, { type: "OAUTH2" });
    const complete = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/reddit/oauth/complete`,
      payload: { connectionId: nangoConnectionId },
    });
    expect(complete.statusCode).toBe(201);
    return complete.json().id;
  }

  async function connectSocial(providerKey: string, nangoConnectionId = `nango-${providerKey}-${randomUUID()}`): Promise<string> {
    if (providerKey === "linkedin") {
      vi.stubEnv("LINKEDIN_CLIENT_ID", "cid");
      vi.stubEnv("LINKEDIN_CLIENT_SECRET", "csecret");
    }
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/session`,
    });
    state.connections.set(nangoConnectionId, { type: "OAUTH2" });
    const complete = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/complete`,
      payload: { connectionId: nangoConnectionId },
    });
    expect(complete.statusCode).toBe(201);
    return complete.json().id;
  }

  async function createCampaign(name = "Launch"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/campaigns`,
      payload: { name },
    });
    return res.json().id;
  }

  async function createPersona(name = "VP Eng"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name },
    });
    return res.json().id;
  }

  async function assignSocialAccount(
    personaId: string,
    connectionId: string,
    channel = "linkedin",
    isPrimary = true,
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas/${personaId}/social-accounts`,
      payload: { connectionId, channel, isPrimary },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  function seedApprovedDraft(opts: {
    campaignId?: string | null;
    channel?: string;
    personaId?: string | null;
    content?: string;
  }): string {
    const draft = submitDraft(
      db,
      {
        workspaceId,
        sourceGenerationId: randomUUID(),
        campaignId: opts.campaignId ?? null,
        personaId: opts.personaId ?? null,
        taskType: "linkedin_post",
        channel: (opts.channel ?? "linkedin") as never,
        content: opts.content ?? "Headline of the post\nThe body of the post.",
      },
      { userId: null, label: "test" },
    );
    return applyDraftAction(db, draft, "approve", { userId: null, label: "test" }).id;
  }

  function cadencePayload(over: Record<string, unknown> = {}) {
    return {
      name: "Weekly LinkedIn",
      channel: "linkedin",
      target: "test",
      daysOfWeek: [1, 3, 5],
      timeOfDay: "09:00",
      timezone: "America/New_York",
      ...over,
    };
  }

  async function createCadence(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: `/workspaces/${workspaceId}/cadences`, payload });
  }

  // --- Contracts ------------------------------------------------------------

  describe("contracts", () => {
    it("accepts a valid cadence and dedupes/sorts daysOfWeek", () => {
      const parsed = createPostingCadenceInputSchema.parse({
        name: "Cadence",
        campaignId: randomUUID(),
        channel: "linkedin",
        connectionId: randomUUID(),
        target: "test",
        daysOfWeek: [5, 1, 1, 3],
        timeOfDay: "09:30",
        timezone: "America/New_York",
      });
      expect(parsed.daysOfWeek).toEqual([1, 3, 5]);
      expect(parsed.status).toBe("active");
    });

    it("accepts a persona cadence without an explicit connectionId", () => {
      const parsed = createPostingCadenceInputSchema.parse({
        name: "Persona cadence",
        campaignId: randomUUID(),
        personaId: randomUUID(),
        channel: "linkedin",
        target: "feed",
        daysOfWeek: [1],
        timeOfDay: "09:30",
        timezone: "UTC",
      });
      expect(parsed.connectionId).toBeUndefined();
    });

    it("rejects a bad time, weekday, and timezone", () => {
      const base = {
        name: "X",
        campaignId: randomUUID(),
        channel: "linkedin",
        connectionId: randomUUID(),
        target: "test",
        daysOfWeek: [1],
        timeOfDay: "09:00",
        timezone: "America/New_York",
      };
      expect(createPostingCadenceInputSchema.safeParse({ ...base, timeOfDay: "9:5" }).success).toBe(false);
      expect(createPostingCadenceInputSchema.safeParse({ ...base, timeOfDay: "24:00" }).success).toBe(false);
      expect(createPostingCadenceInputSchema.safeParse({ ...base, daysOfWeek: [7] }).success).toBe(false);
      expect(createPostingCadenceInputSchema.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
    });

    it("publicationSchema carries a nullable cadenceId", () => {
      const fields = publicationSchema.shape;
      expect(fields.cadenceId.safeParse(null).success).toBe(true);
      expect(fields.cadenceId.safeParse(randomUUID()).success).toBe(true);
    });
  });

  // --- CRUD + validation ----------------------------------------------------

  describe("CRUD + validation", () => {
    it("creates, lists, gets, pauses, and deletes a cadence", async () => {
      const connectionId = await connectReddit();
      const campaignId = await createCampaign();
      const created = await createCadence(cadencePayload({ campaignId, connectionId }));
      expect(created.statusCode).toBe(201);
      const cadence = postingCadenceSchema.parse(created.json());
      expect(cadence.daysOfWeek).toEqual([1, 3, 5]);

      const list = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/cadences` });
      expect(list.json()).toHaveLength(1);
      expect(list.json()[0]).toMatchObject({ queuedCount: 0 });
      expect(typeof list.json()[0].nextSlotAt).toBe("number");

      const paused = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/cadences/${cadence.id}`,
        payload: { status: "paused" },
      });
      expect(paused.json().status).toBe("paused");

      const del = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/cadences/${cadence.id}`,
      });
      expect(del.statusCode).toBe(204);
      const after = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/cadences` });
      expect(after.json()).toHaveLength(0);
    });

    it("creates a persona cadence from the persona primary account", async () => {
      const personaId = await createPersona("CEO");
      const accountId = await connectSocial("linkedin", "nango-linkedin-ceo");
      await assignSocialAccount(personaId, accountId, "linkedin", true);
      const campaignId = await createCampaign();

      const res = await createCadence(
        cadencePayload({
          name: "CEO LinkedIn",
          campaignId,
          personaId,
          channel: "linkedin",
          target: "feed",
          daysOfWeek: [1],
          timeOfDay: "09:00",
          timezone: "UTC",
        }),
      );

      expect(res.statusCode).toBe(201);
      expect(res.json().connectionId).toBe(accountId);
    });

    it("rejects unknown campaign / connection / persona, and non-social connections", async () => {
      const connectionId = await connectReddit();
      const campaignId = await createCampaign();

      expect(
        (await createCadence(cadencePayload({ campaignId: randomUUID(), connectionId }))).json().error,
      ).toBe("campaign_not_found");
      expect(
        (await createCadence(cadencePayload({ campaignId, connectionId: randomUUID() }))).json().error,
      ).toBe("connection_not_found");
      expect(
        (
          await createCadence(cadencePayload({ campaignId, connectionId, personaId: randomUUID() }))
        ).json().error,
      ).toBe("persona_not_found");

      // Disconnect the social account → it is no longer a valid target.
      const disc = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/connections/${connectionId}`,
      });
      expect(disc.statusCode).toBe(204);
      expect((await createCadence(cadencePayload({ campaignId, connectionId }))).json().error).toBe(
        "not_social",
      );
    });

    it("404s an unknown cadence", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/cadences/${randomUUID()}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // --- Slot math via the calendar -------------------------------------------

  it("computes the right weekly slots (EDT) on the calendar", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign();
    await createCadence(cadencePayload({ campaignId, connectionId }));

    const now = Date.now();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/calendar?from=${now}&to=${now + 7 * DAY_MS}`,
    });
    const entries = res.json().entries.map((e: unknown) => calendarEntrySchema.parse(e));
    const slots = entries.filter((e: { kind: string }) => e.kind === "slot");
    // Mon/Wed/Fri this week; next Monday falls on the window boundary (excluded).
    expect(slots).toHaveLength(3);
    for (const slot of slots) {
      const d = new Date(slot.at);
      expect(d.getUTCHours()).toBe(13); // 09:00 EDT = 13:00 UTC
      expect([1, 3, 5]).toContain(d.getUTCDay());
      expect(slot.status).toBe("open");
    }
  });

  it("carries campaign identity and failure detail on calendar entries", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign("Summer Launch");
    seedApprovedDraft({ campaignId, channel: "linkedin" });
    const cadenceId = (await createCadence(cadencePayload({ campaignId, connectionId }))).json().id;
    const fill = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/cadences/${cadenceId}/fill`,
    });
    expect(fill.json().filled).toBe(1);

    // Flip the receipt to failed directly — the failure path itself is covered
    // in publish.test.ts; here we only assert the calendar projection.
    const pub = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })
    ).json()[0];
    db.update(publications)
      .set({ status: "failed", lastError: "RATELIMIT: slow down" })
      .where(eq(publications.id, pub.id))
      .run();

    const now = Date.now();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/calendar?from=${now}&to=${now + 7 * DAY_MS}`,
    });
    const entries = res.json().entries.map((e: unknown) => calendarEntrySchema.parse(e));

    const receipt = entries.find((e: { kind: string }) => e.kind === "publication");
    expect(receipt).toMatchObject({
      campaignId,
      campaignName: "Summer Launch",
      error: "RATELIMIT: slow down",
      status: "failed",
    });

    const slots = entries.filter((e: { kind: string }) => e.kind === "slot");
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.campaignId).toBe(campaignId);
      expect(slot.campaignName).toBe("Summer Launch");
      expect(slot.error).toBeNull();
    }
  });

  // --- Fill -----------------------------------------------------------------

  describe("fill", () => {
    it("slots matching approved drafts into open slots, and is idempotent", async () => {
      const connectionId = await connectReddit();
      const campaignId = await createCampaign();
      const otherCampaign = await createCampaign("Other");
      for (let i = 0; i < 3; i++) seedApprovedDraft({ campaignId, channel: "linkedin" });
      // Decoys that must NOT be slotted:
      seedApprovedDraft({ campaignId, channel: "email" }); // wrong channel
      seedApprovedDraft({ campaignId: otherCampaign, channel: "linkedin" }); // wrong campaign
      submitDraft(
        db,
        {
          workspaceId,
          sourceGenerationId: randomUUID(),
          campaignId,
          personaId: null,
          taskType: "linkedin_post",
          channel: "linkedin" as never,
          content: "Pending only",
        },
        { userId: null, label: "test" },
      ); // not approved

      const cadenceId = (await createCadence(cadencePayload({ campaignId, connectionId }))).json().id;
      const fill = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/cadences/${cadenceId}/fill`,
      });
      expect(fill.json().filled).toBe(3);

      const pubs = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })
      ).json();
      expect(pubs).toHaveLength(3);
      for (const p of pubs) {
        expect(p.status).toBe("scheduled");
        expect(p.cadenceId).toBe(cadenceId);
        expect(p.scheduledFor).toBeGreaterThan(Date.now());
        expect(new Date(p.scheduledFor).getUTCHours()).toBe(13);
        expect([1, 3, 5]).toContain(new Date(p.scheduledFor).getUTCDay());
        expect(p.title).toBe("Headline of the post");
      }
      // Distinct drafts, distinct slots.
      expect(new Set(pubs.map((p: { draftId: string }) => p.draftId)).size).toBe(3);
      expect(new Set(pubs.map((p: { scheduledFor: number }) => p.scheduledFor)).size).toBe(3);

      // Second fill adds nothing.
      const again = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/cadences/${cadenceId}/fill`,
      });
      expect(again.json().filled).toBe(0);
    });

    it("respects a persona filter and never fills a paused cadence", async () => {
      const connectionId = await connectReddit();
      const campaignId = await createCampaign();
      const personaId = await createPersona();
      seedApprovedDraft({ campaignId, channel: "linkedin", personaId });
      seedApprovedDraft({ campaignId, channel: "linkedin", personaId: null }); // different persona

      const scoped = (
        await createCadence(cadencePayload({ campaignId, connectionId, personaId }))
      ).json();
      const fill = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/cadences/${scoped.id}/fill`,
      });
      expect(fill.json().filled).toBe(1); // only the persona-matched draft

      // A paused cadence fills nothing.
      const paused = (
        await createCadence(cadencePayload({ name: "Paused", campaignId, connectionId, status: "paused" }))
      ).json();
      const fillPaused = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/cadences/${paused.id}/fill`,
      });
      expect(fillPaused.json().filled).toBe(0);
    });
  });

  // --- Firing reuses the Sprint 17 worker -----------------------------------

  it("a filled slot publishes when due via publish/run", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign();
    seedApprovedDraft({ campaignId, channel: "linkedin", content: "Cadence post title\nBody text." });

    // A Monday slot five minutes out, in UTC for easy math.
    const cadenceId = (
      await createCadence(
        cadencePayload({
          campaignId,
          connectionId,
          daysOfWeek: [1],
          timeOfDay: "08:05",
          timezone: "UTC",
        }),
      )
    ).json().id;
    const fill = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/cadences/${cadenceId}/fill`,
    });
    expect(fill.json().filled).toBe(1);

    // Before the slot: nothing fires.
    const early = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/publish/run` });
    expect(early.json().results).toHaveLength(0);

    // Advance past the slot and run.
    vi.setSystemTime(new Date(MONDAY_8AM_UTC.getTime() + 10 * 60 * 1000));
    const run = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/publish/run` });
    expect(run.json().results).toEqual([{ id: expect.any(String), ok: true }]);

    const pubs = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })
    ).json();
    expect(pubs[0].status).toBe("published");
    expect(pubs[0].externalUrl).toContain("reddit.com");
    expect(state.posts[0]).toMatchObject({ sr: "test", title: "Cadence post title" });
  });

  it("deleting a cadence cancels its still-scheduled posts", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign();
    seedApprovedDraft({ campaignId, channel: "linkedin" });
    const cadenceId = (await createCadence(cadencePayload({ campaignId, connectionId }))).json().id;
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/cadences/${cadenceId}/fill` });
    expect(
      (await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })).json(),
    ).toHaveLength(1);

    await app.inject({ method: "DELETE", url: `/workspaces/${workspaceId}/cadences/${cadenceId}` });
    const pubs = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })
    ).json();
    expect(pubs).toHaveLength(0); // the scheduled (unfired) post was canceled
  });
});
