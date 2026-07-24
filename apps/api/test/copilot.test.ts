import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  chatSessionDetailSchema,
  chatSessionSchema,
  chatTurnResultSchema,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import type { EvidenceStore, EvidenceStoreHealth, StoreSearchResult } from "../src/evidence/store";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { COPILOT_TOOLS } from "../src/services/copilot-tools";
import { buildAuthedApp, createTestDb } from "./helpers";

// A gateway backed by a MUTABLE reply queue. Setup (workspace + brain save)
// triggers its own generate() calls, so we leave the queue empty during setup
// — those calls get the harmless "(idle)" default — then push the turn's
// scripted replies afterwards. Errors in the queue are thrown, to drive the
// degradation path.
interface QueueGateway {
  gw: LlmGateway;
  queue: Array<string | Error>;
}

function queueGateway(): QueueGateway {
  const queue: Array<string | Error> = [];
  const gw: LlmGateway = {
    async generate() {
      const reply = queue.length > 0 ? queue.shift()! : "(idle)";
      if (reply instanceof Error) throw reply;
      return { text: reply, model: "fake", provider: "fake", durationMs: 1 };
    },
  };
  return { gw, queue };
}

const ICP_DOC = [
  "## Segments",
  "We sell to RevOps leaders at Series B SaaS companies scaling their pipeline.",
  "",
  "## Who we are not for",
  "Enterprises over 5000 employees with entrenched processes.",
].join("\n");

async function setup(gw: LlmGateway): Promise<{ app: TuezdayApp; db: Db; workspaceId: string }> {
  const db = createTestDb();
  const app = await buildAuthedApp({ db, llm: gw });
  const workspaceId = (
    await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Copilot Co" } })
  ).json().id;
  await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/brain/icp`, payload: { content: ICP_DOC } });
  return { app, db, workspaceId };
}

async function createSession(app: TuezdayApp, workspaceId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/chat/sessions`,
    payload: { title: "Test chat" },
  });
  expect(res.statusCode).toBe(201);
  expect(chatSessionSchema.safeParse(res.json()).success).toBe(true);
  return res.json().id as string;
}

function sendMessage(app: TuezdayApp, workspaceId: string, sessionId: string, message: string) {
  return app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/messages`,
    payload: { message },
  });
}

describe("chat copilot API (Sprint 42)", () => {
  describe("grounded tool-loop", () => {
    let app: TuezdayApp;
    let workspaceId: string;
    let queue: Array<string | Error>;

    afterEach(async () => {
      await app.close();
    });

    it("routes a search_brain tool call and returns a grounded answer with brain citations", async () => {
      const g = queueGateway();
      queue = g.queue;
      ({ app, workspaceId } = await setup(g.gw));
      const sessionId = await createSession(app, workspaceId);

      queue.push(
        '{"tool":"search_brain","args":{"query":"segments"}}',
        "Our ICP is RevOps leaders at Series B SaaS companies. [grounded]",
      );
      const res = await sendMessage(app, workspaceId, sessionId, "Summarize our ICP");
      expect(res.statusCode).toBe(201);
      const turn = res.json();
      expect(chatTurnResultSchema.safeParse(turn).success).toBe(true);
      expect(turn.answer).toContain("[grounded]");
      expect(turn.toolCalls).toContainEqual({ tool: "search_brain", ok: true });

      const brainCites = turn.citations.filter((c: { kind: string }) => c.kind === "brain");
      expect(brainCites.length).toBeGreaterThan(0);
      expect(brainCites.some((c: { ref: string }) => c.ref.startsWith("icp#"))).toBe(true);
    });

    it("routes a get_sequence_funnel tool call and surfaces funnel numbers", async () => {
      const g = queueGateway();
      queue = g.queue;
      ({ app, workspaceId } = await setup(g.gw));

      const campaignId = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns`,
          payload: { name: "Q3", objective: "Demos", automationMode: "scheduled_auto" },
        })
      ).json().id;
      const personaId = (
        await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/personas`, payload: { name: "CEO" } })
      ).json().id;
      const audienceId = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/audiences`,
          payload: { name: "A", kind: "static" },
        })
      ).json().id;
      const seqId = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/outreach-sequences`,
          payload: { campaignId, personaId, audienceId, name: "Seq", automationMode: "scheduled_auto" },
        })
      ).json().id;

      const sessionId = await createSession(app, workspaceId);
      queue.push(
        `{"tool":"get_sequence_funnel","args":{"sequenceId":"${seqId}"}}`,
        "The sequence has no sends yet.",
      );
      const res = await sendMessage(app, workspaceId, sessionId, "How is the sequence performing?");
      expect(res.statusCode).toBe(201);
      const turn = res.json();
      expect(turn.toolCalls).toContainEqual({ tool: "get_sequence_funnel", ok: true });
      expect(turn.answer).toContain("no sends");

      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}` })
      ).json();
      const toolMsg = detail.messages.find((m: { role: string }) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      // The funnel numbers (sent/opened/…) are surfaced back to the model.
      expect(toolMsg.content).toContain('"sent"');
    });

    it("terminates a tool-happy model at the iteration cap without throwing", async () => {
      const g = queueGateway();
      queue = g.queue;
      ({ app, workspaceId } = await setup(g.gw));
      const sessionId = await createSession(app, workspaceId);

      // More tool calls than the loop will ever run — the cap must stop it.
      for (let n = 0; n < 20; n++) queue.push('{"tool":"list_campaigns","args":{}}');

      const res = await sendMessage(app, workspaceId, sessionId, "loop forever");
      expect(res.statusCode).toBe(201);
      const turn = res.json();
      // Capped at MAX_ITERS (6) tool invocations, then a best-effort answer.
      expect(turn.toolCalls.length).toBe(6);
      expect(turn.answer.length).toBeGreaterThan(0);
    });

    it("degrades to an answer when the gateway fails mid-loop (never throws)", async () => {
      const g = queueGateway();
      queue = g.queue;
      ({ app, workspaceId } = await setup(g.gw));
      const sessionId = await createSession(app, workspaceId);

      queue.push(
        '{"tool":"search_brain","args":{"query":"segments"}}',
        new GatewayError("provider_error", "upstream 500"),
      );
      const res = await sendMessage(app, workspaceId, sessionId, "Summarize our ICP");
      expect(res.statusCode).toBe(201);
      const turn = res.json();
      expect(turn.answer.length).toBeGreaterThan(0);
      expect(turn.toolCalls).toContainEqual({ tool: "search_brain", ok: true });
      // The degraded answer carries the grounding the tool already returned.
      expect(turn.answer).toContain("search_brain");
    });

    it("degrades to an answer when the reply is unparseable (never throws)", async () => {
      const g = queueGateway();
      queue = g.queue;
      ({ app, workspaceId } = await setup(g.gw));
      const sessionId = await createSession(app, workspaceId);

      queue.push('{"tool": "search_brain", "args": {');
      const res = await sendMessage(app, workspaceId, sessionId, "hello");
      expect(res.statusCode).toBe(201);
      const turn = res.json();
      expect(turn.answer.length).toBeGreaterThan(0);
      expect(turn.toolCalls.length).toBe(0);
    });
  });

  describe("persistence & scoping", () => {
    let app: TuezdayApp;
    let workspaceId: string;
    let queue: Array<string | Error>;

    beforeEach(async () => {
      const g = queueGateway();
      queue = g.queue;
      ({ app, workspaceId } = await setup(g.gw));
    });
    afterEach(async () => {
      await app.close();
    });

    it("persists user + assistant messages in order", async () => {
      const sessionId = await createSession(app, workspaceId);
      queue.push("A plain grounded answer.");
      await sendMessage(app, workspaceId, sessionId, "first question");

      const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}` });
      expect(res.statusCode).toBe(200);
      const detail = res.json();
      expect(chatSessionDetailSchema.safeParse(detail).success).toBe(true);
      expect(detail.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
      expect(detail.messages[0].content).toBe("first question");
      expect(detail.messages[1].content).toBe("A plain grounded answer.");
      // Chronological ordering.
      expect(detail.messages[0].createdAt).toBeLessThanOrEqual(detail.messages[1].createdAt);
    });

    it("lists sessions and deletes them", async () => {
      const sessionId = await createSession(app, workspaceId);
      let list = (await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/chat/sessions` })).json();
      expect(list.map((s: { id: string }) => s.id)).toContain(sessionId);

      const del = await app.inject({ method: "DELETE", url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}` });
      expect(del.statusCode).toBe(204);
      list = (await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/chat/sessions` })).json();
      expect(list.map((s: { id: string }) => s.id)).not.toContain(sessionId);
    });

    it("scopes sessions to their workspace", async () => {
      const sessionId = await createSession(app, workspaceId);
      const otherWs = (
        await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Other Co" } })
      ).json().id;

      // The session is invisible and unreachable from another workspace.
      const list = (await app.inject({ method: "GET", url: `/workspaces/${otherWs}/chat/sessions` })).json();
      expect(list).toEqual([]);
      const detail = await app.inject({ method: "GET", url: `/workspaces/${otherWs}/chat/sessions/${sessionId}` });
      expect(detail.statusCode).toBe(404);
      const msg = await sendMessage(app, otherWs, sessionId, "hi");
      expect(msg.statusCode).toBe(404);
    });
  });

  describe("read-only guardrail", () => {
    it("exposes only a fixed whitelist of read tools", () => {
      const names = COPILOT_TOOLS.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "get_campaign_insights",
          "get_sequence_funnel",
          "get_workspace_insights",
          "get_workspace_summary",
          "list_audiences",
          "list_campaigns",
          "list_leads",
          "list_outreach_sequences",
          "search_brain",
          "search_evidence",
        ].sort(),
      );
      // No tool name hints at a mutation (the registry is the only tool source).
      const writeVerbs = /^(create|update|delete|send|launch|draft|approve|reject|enroll|publish|submit|generate)/;
      for (const name of names) expect(name).not.toMatch(writeVerbs);
    });

    it("runs every tool without mutating any row counts", async () => {
      const db = createTestDb();
      const app = await buildAuthedApp({ db, llm: queueGateway().gw });
      const workspaceId = (
        await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Guardrail Co" } })
      ).json().id;
      await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/brain/icp`, payload: { content: ICP_DOC } });
      const campaignId = (
        await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/campaigns`, payload: { name: "Q3", objective: "Demos", automationMode: "manual" } })
      ).json().id;

      // A minimal in-memory evidence store: read-only, no ingestion.
      const noopEvidence: EvidenceStore = {
        async health(): Promise<EvidenceStoreHealth> {
          return { healthy: true };
        },
        async createCollection() {
          return "col";
        },
        async addDocument() {
          return "doc";
        },
        async attachDocument() {},
        async deleteDocument() {},
        async search(): Promise<StoreSearchResult[]> {
          return [];
        },
      };

      const tables = [
        "chat_sessions",
        "chat_messages",
        "campaigns",
        "leads",
        "audiences",
        "outreach_sequences",
        "personas",
        "brain_documents",
      ];
      const countAll = () =>
        Object.fromEntries(
          tables.map((t) => [
            t,
            (db.get(sql.raw(`SELECT COUNT(*) AS n FROM ${t}`)) as { n: number }).n,
          ]),
        );

      const before = countAll();
      const ctx = { db, evidence: noopEvidence, workspaceId };
      const argsByTool: Record<string, Record<string, unknown>> = {
        search_brain: { query: "icp" },
        search_evidence: { query: "anything" },
        get_campaign_insights: { campaignId },
        get_sequence_funnel: { sequenceId: "missing" },
      };
      for (const tool of COPILOT_TOOLS) {
        await tool.run(ctx, argsByTool[tool.name] ?? {});
      }
      const after = countAll();
      expect(after).toEqual(before);

      await app.close();
    });
  });
});
