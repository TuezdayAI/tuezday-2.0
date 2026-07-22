import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceDocumentSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { connections, drafts, evidenceDocuments, publications } from "../src/db/schema";
import { EvidenceStoreError, type EvidenceStore } from "../src/evidence/store";
import { DbEvidenceStore, EVIDENCE_EMBEDDING_DIMENSIONS } from "../src/evidence/db-store";
import type { LlmGateway } from "../src/llm/gateway";
import { backfillCollections } from "../src/services/evidence";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated.", model: "fake", provider: "fake", durationMs: 5 };
  },
};

interface FakeStoreState {
  healthy: boolean;
  collections: Map<string, string>;
  documents: Map<string, { title: string; content: string; collectionId: string }>;
  lastQuery: string | null;
  lastCollectionId: string | null;
}

function fakeStore(state: FakeStoreState): EvidenceStore {
  let docCounter = 0;
  let colCounter = 0;
  return {
    async health() {
      return state.healthy
        ? { healthy: true }
        : { healthy: false, detail: "fake store is down" };
    },
    async createCollection(name) {
      if (!state.healthy) throw new EvidenceStoreError("store down");
      const existing = state.collections.get(name);
      if (existing) return existing;
      const id = `col-${++colCounter}`;
      state.collections.set(name, id);
      return id;
    },
    async addDocument({ title, content, collectionId }) {
      if (!state.healthy) throw new EvidenceStoreError("store down");
      if (title === "FAIL") throw new EvidenceStoreError("ingestion exploded");
      const id = `r2r-${++docCounter}`;
      state.documents.set(id, { title, content, collectionId });
      return id;
    },
    async attachDocument(collectionId, documentId) {
      const doc = state.documents.get(documentId);
      if (doc) doc.collectionId = collectionId;
    },
    async deleteDocument(documentId) {
      state.documents.delete(documentId);
    },
    async search(query, collectionId, limit) {
      state.lastQuery = query;
      state.lastCollectionId = collectionId;
      return [...state.documents.entries()]
        .filter(([, doc]) => doc.collectionId === collectionId)
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
  let db: Db;
  let store: EvidenceStore;
  let workspaceId: string;
  let state: FakeStoreState;

  beforeEach(async () => {
    state = {
      healthy: true,
      collections: new Map(),
      documents: new Map(),
      lastQuery: null,
      lastCollectionId: null,
    };
    db = createTestDb();
    store = fakeStore(state);
    app = await buildAuthedApp({ db, llm: fakeLlm, evidence: store });
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

    it("scopes search to this workspace's own collection only", async () => {
      await upload();
      // a second workspace with its own document in a different collection
      const other = (
        await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Other" } })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${other.id}/evidence`,
        payload: { title: "Other doc", content: "Other workspace content." },
      });

      const res = await resolve();
      const section = res.json().sections.find((s: { key: string }) => s.key === "evidence");
      // Search ran against this workspace's collection; the other workspace's
      // document never appears.
      expect(state.lastCollectionId).toBe(state.collections.get(workspaceId));
      expect(section.content).toContain("Website copy");
      expect(section.content).not.toContain("Other workspace content");
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

    it("exposes the per-chunk retrieval trace on the evidence section", async () => {
      await upload();
      const res = await resolve();
      const section = res.json().sections.find((s: { key: string }) => s.key === "evidence");
      expect(section.included).toBe(true);
      expect(section.evidence.query).toBeTruthy();
      expect(section.evidence.chunks.length).toBeGreaterThan(0);
      const chunk = section.evidence.chunks[0];
      expect(chunk).toHaveProperty("finalScore");
      expect(chunk).toHaveProperty("recencyScore");
      expect(chunk.kept).toBe(true);
    });
  });

  describe("ingest candidates (Sprint 30)", () => {
    async function createSignal(content = "Churn spikes after onboarding friction", source = "reddit") {
      return (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/signals`,
          payload: { content, source },
        })
      ).json();
    }

    /** Seed a published post directly (connection + draft + publication). */
    function seedPublishedPost(title = "Our launch post", content = "We shipped the memory layer.") {
      const ts = Date.now();
      const connectionId = randomUUID();
      db.insert(connections)
        .values({ id: connectionId, workspaceId, providerKey: "reddit", nangoConnectionId: "n-1", createdAt: ts, updatedAt: ts })
        .run();
      const draftId = randomUUID();
      db.insert(drafts)
        .values({
          id: draftId,
          workspaceId,
          taskType: "linkedin_post",
          channel: "linkedin",
          originalContent: content,
          content,
          state: "approved",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      const pubId = randomUUID();
      db.insert(publications)
        .values({
          id: pubId,
          workspaceId,
          draftId,
          connectionId,
          providerKey: "reddit",
          target: "r/test",
          title,
          status: "published",
          scheduledFor: ts,
          publishedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      return { pubId, content, title, publishedAt: ts };
    }

    async function sweep() {
      return app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/evidence/candidates/sweep`,
      });
    }

    async function listCandidates(status = "pending") {
      return (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/evidence/candidates?status=${status}`,
        })
      ).json();
    }

    it("proposes every signal and published post once, idempotently", async () => {
      await createSignal();
      seedPublishedPost();

      expect((await sweep()).json()).toEqual({ signal: { proposed: 1 }, published: { proposed: 1 } });
      // a second sweep proposes nothing new
      expect((await sweep()).json()).toEqual({ signal: { proposed: 0 }, published: { proposed: 0 } });

      const { candidates } = await listCandidates();
      expect(candidates).toHaveLength(2);
      expect(candidates.map((c: { kind: string }) => c.kind).sort()).toEqual(["published", "signal"]);
    });

    it("pulls a signal's source/date and the draft's content into candidates", async () => {
      const signal = await createSignal("Unique churn insight", "reddit");
      const { content: postContent } = seedPublishedPost("Launch", "Shipped today.");
      await sweep();

      const { candidates } = await listCandidates();
      const signalCand = candidates.find((c: { kind: string }) => c.kind === "signal");
      const publishedCand = candidates.find((c: { kind: string }) => c.kind === "published");
      expect(signalCand.content).toBe("Unique churn insight");
      expect(signalCand.sourceRef).toBe(signal.id);
      expect(signalCand.title).toContain("reddit");
      expect(publishedCand.content).toBe(postContent);
      expect(publishedCand.sourceCreatedAt).toBeGreaterThan(0);
    });

    it("accepts a candidate into the corpus with provenance and links it", async () => {
      await createSignal("Insight to ground future posts");
      await sweep();
      const candidate = (await listCandidates()).candidates[0];

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/evidence/candidates/${candidate.id}/accept`,
      });
      expect(res.statusCode).toBe(201);
      const doc = res.json();
      expect(doc.kind).toBe("signal");
      expect(doc.sourceRef).toBe(candidate.sourceRef);
      expect(doc.status).toBe("ready");

      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/evidence` })
      ).json();
      expect(list.documents.find((d: { kind: string }) => d.kind === "signal")).toBeDefined();

      expect((await listCandidates()).candidates).toHaveLength(0);
      expect((await listCandidates("accepted")).candidates[0].evidenceDocumentId).toBe(doc.id);
    });

    it("keeps the candidate pending and returns 503 when the store is down", async () => {
      await createSignal();
      await sweep();
      const candidate = (await listCandidates()).candidates[0];
      state.healthy = false;

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/evidence/candidates/${candidate.id}/accept`,
      });
      expect(res.statusCode).toBe(503);
      expect((await listCandidates()).candidates).toHaveLength(1);
    });

    it("dismisses a candidate and never re-proposes it", async () => {
      await createSignal();
      await sweep();
      const candidate = (await listCandidates()).candidates[0];

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/evidence/candidates/${candidate.id}/dismiss`,
      });
      expect(res.statusCode).toBe(204);
      expect((await listCandidates()).candidates).toHaveLength(0);

      await sweep();
      expect((await listCandidates()).candidates).toHaveLength(0);
    });

    it("rejects deciding the same candidate twice (409)", async () => {
      await createSignal();
      await sweep();
      const candidate = (await listCandidates()).candidates[0];
      const url = `/workspaces/${workspaceId}/evidence/candidates/${candidate.id}/dismiss`;
      await app.inject({ method: "POST", url });
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(409);
    });
  });

  describe("collection backfill (Sprint 30)", () => {
    function seedReadyDoc(r2rId: string, title = "Old copy", content = "Legacy website copy.") {
      state.documents.set(r2rId, { title, content, collectionId: "" });
      db.insert(evidenceDocuments)
        .values({
          id: randomUUID(),
          workspaceId,
          r2rDocumentId: r2rId,
          title,
          chars: content.length,
          status: "ready",
          error: null,
          kind: "manual",
          sourceRef: null,
          sourceCreatedAt: null,
          createdAt: Date.now(),
        })
        .run();
    }

    it("attaches pre-existing ready documents to the workspace collection", async () => {
      seedReadyDoc("r2r-pre");
      await backfillCollections(db, store);

      const collectionId = state.collections.get(workspaceId);
      expect(collectionId).toBeTruthy();
      expect(state.documents.get("r2r-pre")!.collectionId).toBe(collectionId);
    });

    it("is graceful when the store is unavailable", async () => {
      seedReadyDoc("r2r-pre");
      state.healthy = false;
      await expect(backfillCollections(db, store)).resolves.toBeUndefined();
    });
  });
});

// Sprint 47 wire-through: the whole evidence flow against the REAL native
// store on an in-memory DB — no fakes between the route and the chunks.
describe("evidence with the native DbEvidenceStore", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  const embedLlm: LlmGateway = {
    async generate() {
      return { text: "Generated.", model: "fake", provider: "fake", durationMs: 1 };
    },
    async embed({ texts }) {
      const dims = EVIDENCE_EMBEDDING_DIMENSIONS;
      const embeddings = texts.map((t) => {
        const v = new Array<number>(dims).fill(0);
        for (const word of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
          v[h % dims] = (v[h % dims] ?? 0) + 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
      return { embeddings, model: "fake-embed", provider: "fake", dimensions: dims };
    },
  };

  beforeEach(async () => {
    const db = createTestDb();
    const store = new DbEvidenceStore(db, embedLlm);
    app = await buildAuthedApp({ db, llm: embedLlm, evidence: store });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Native" } })
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

  it("uploads, resolves with citations, and deletes through the real store", async () => {
    const uploaded = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/evidence`,
      payload: {
        title: "Pricing research",
        content:
          "GTM teams forget what worked last quarter. The starter plan costs $49 per month and includes one workspace.",
      },
    });
    expect(uploaded.statusCode).toBe(201);
    const doc = uploaded.json();
    expect(doc.status).toBe("ready");

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin", useEvidence: true },
    });
    expect(res.statusCode).toBe(200);
    const section = res.json().sections.find((s: { key: string }) => s.key === "evidence");
    expect(section?.included).toBe(true);
    expect(section?.content).toContain("$49");

    const del = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/evidence/${doc.id}`,
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin", useEvidence: true },
    });
    const gone = after.json().sections.find((s: { key: string }) => s.key === "evidence");
    expect(gone?.included).toBe(false);
  });
});
