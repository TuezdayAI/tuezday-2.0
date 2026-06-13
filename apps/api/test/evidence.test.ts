import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceDocumentSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { EvidenceStoreError, type EvidenceStore } from "../src/evidence/store";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated.", model: "fake", provider: "fake", durationMs: 5 };
  },
};

interface FakeStoreState {
  healthy: boolean;
  documents: Map<string, { title: string; content: string }>;
  lastQuery: string | null;
  lastDocumentIds: string[] | null;
}

function fakeStore(state: FakeStoreState): EvidenceStore {
  let counter = 0;
  return {
    async health() {
      return state.healthy
        ? { healthy: true }
        : { healthy: false, detail: "fake store is down" };
    },
    async addDocument({ title, content }) {
      if (!state.healthy) throw new EvidenceStoreError("store down");
      if (title === "FAIL") throw new EvidenceStoreError("ingestion exploded");
      const id = `r2r-${++counter}`;
      state.documents.set(id, { title, content });
      return id;
    },
    async deleteDocument(documentId) {
      state.documents.delete(documentId);
    },
    async search(query, documentIds, limit) {
      state.lastQuery = query;
      state.lastDocumentIds = documentIds;
      return [...state.documents.entries()]
        .filter(([id]) => documentIds.includes(id))
        .slice(0, limit)
        .map(([id, doc]) => ({
          text: doc.content.slice(0, 100),
          score: 0.8,
          documentId: id,
        }));
    },
  };
}

describe("evidence API", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let state: FakeStoreState;

  beforeEach(async () => {
    state = { healthy: true, documents: new Map(), lastQuery: null, lastDocumentIds: null };
    app = await buildAuthedApp({ db: createTestDb(), llm: fakeLlm, evidence: fakeStore(state) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Evi" } })
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

  async function upload(title = "Website copy", content = "Tuezday is the GTM memory layer.") {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/evidence`,
      payload: { title, content },
    });
  }

  async function resolve(payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin", ...payload },
    });
  }

  describe("documents", () => {
    it("uploads evidence and marks it ready", async () => {
      const res = await upload();
      expect(res.statusCode).toBe(201);
      const doc = res.json();
      expect(evidenceDocumentSchema.safeParse(doc).success).toBe(true);
      expect(doc.status).toBe("ready");
      expect(doc.r2rDocumentId).toBe("r2r-1");
      expect(doc.chars).toBeGreaterThan(0);
    });

    it("stores a failed row when ingestion fails", async () => {
      const res = await upload("FAIL");
      expect(res.statusCode).toBe(502);
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/evidence` })
      ).json();
      expect(list.documents[0].status).toBe("failed");
      expect(list.documents[0].error).toContain("exploded");
    });

    it("returns 503 when the store is down", async () => {
      state.healthy = false;
      const res = await upload();
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("evidence_store_unavailable");
    });

    it("lists documents with store status", async () => {
      await upload();
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/evidence`,
      });
      const body = res.json();
      expect(body.documents).toHaveLength(1);
      expect(body.store.healthy).toBe(true);
    });

    it("deletes a document from both sides", async () => {
      const doc = (await upload()).json();
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/evidence/${doc.id}`,
      });
      expect(res.statusCode).toBe(204);
      expect(state.documents.size).toBe(0);
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/evidence` })
      ).json();
      expect(list.documents).toEqual([]);
    });

    it("rejects empty content", async () => {
      const res = await upload("Title", "  ");
      expect(res.statusCode).toBe(400);
    });
  });

  describe("retrieval in resolution", () => {
    it("includes cited evidence in the bundle when documents exist", async () => {
      await upload();
      const res = await resolve();
      const section = res.json().sections.find((s: { key: string }) => s.key === "evidence");
      expect(section.included).toBe(true);
      expect(section.content).toContain("[1]");
      expect(section.content).toContain("Sources:");
      expect(section.content).toContain("Website copy");
    });

    it("scopes search to this workspace's documents only", async () => {
      await upload();
      // a second workspace with its own document
      const other = (
        await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Other" } })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${other.id}/evidence`,
        payload: { title: "Other doc", content: "Other workspace content." },
      });

      await resolve();
      expect(state.lastDocumentIds).toEqual(["r2r-1"]);
    });

    it("excludes evidence with a reason when no documents exist", async () => {
      const res = await resolve();
      const section = res.json().sections.find((s: { key: string }) => s.key === "evidence");
      expect(section.included).toBe(false);
      expect(section.reason).toContain("no evidence documents");
    });

    it("excludes evidence when useEvidence is false", async () => {
      await upload();
      const res = await resolve({ useEvidence: false });
      const section = res.json().sections.find((s: { key: string }) => s.key === "evidence");
      expect(section.included).toBe(false);
      expect(section.reason).toContain("turned off");
    });

    it("degrades gracefully when the store goes down after upload", async () => {
      await upload();
      state.healthy = false;
      const res = await resolve();
      expect(res.statusCode).toBe(200);
      const section = res.json().sections.find((s: { key: string }) => s.key === "evidence");
      expect(section.included).toBe(false);
      expect(section.reason).toContain("fake store is down");
    });

    it("prefers signal content in the retrieval query", async () => {
      await upload();
      const signal = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/signals`,
          payload: { content: "Unique signal phrase about churn", source: "reddit" },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/signals/${signal.id}/draft`,
        payload: { channel: "linkedin" },
      });
      expect(state.lastQuery).toContain("Unique signal phrase about churn");
    });

    it("falls back to the now/soul docs in the query without signal or campaign", async () => {
      await upload();
      await resolve();
      expect(state.lastQuery).toContain("We exist to end GTM amnesia.");
      expect(state.lastQuery).toContain("linkedin");
    });

    it("evidence flows into generation prompts", async () => {
      await upload();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().prompt).toContain("## Evidence");
    });
  });
});
