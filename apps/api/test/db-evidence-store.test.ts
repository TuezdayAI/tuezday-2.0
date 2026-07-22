import { describe, expect, it } from "vitest";
import { chunkText, CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS } from "../src/evidence/chunk";
import { DbEvidenceStore, EVIDENCE_EMBEDDING_DIMENSIONS } from "../src/evidence/db-store";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { rankEvidenceChunks } from "../src/services/evidence";
import { createTestDb } from "./helpers";

/**
 * Deterministic fake embedder: hashes each word into a fixed-dimension bag so
 * texts sharing vocabulary land near each other in cosine space.
 */
function fakeEmbedGateway(): LlmGateway {
  return {
    async generate() {
      return { text: "Generated.", model: "fake", provider: "fake", durationMs: 1 };
    },
    async embed({ texts }) {
      const embeddings = texts.map((t) => {
        const v = new Array<number>(EVIDENCE_EMBEDDING_DIMENSIONS).fill(0);
        for (const word of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
          v[h % EVIDENCE_EMBEDDING_DIMENSIONS] = (v[h % EVIDENCE_EMBEDDING_DIMENSIONS] ?? 0) + 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
      return {
        embeddings,
        model: "fake-embed",
        provider: "fake",
        dimensions: EVIDENCE_EMBEDDING_DIMENSIONS,
      };
    },
  };
}

function keylessGateway(): LlmGateway {
  return {
    async generate() {
      throw new GatewayError("missing_api_key", "no key");
    },
    async embed() {
      throw new GatewayError("missing_api_key", "no key");
    },
  };
}

const PRICING_DOC = [
  "Our pricing philosophy is simple: charge for outcomes, not seats.",
  "The starter plan costs $49 per month and includes one workspace.",
].join("\n\n");

const CHURN_DOC = [
  "Churn analysis from Q2: most cancellations happen in week two.",
  "Customers who connect an integration in onboarding retain at twice the rate.",
].join("\n\n");

describe("chunkText", () => {
  it("returns the whole text as one chunk when it fits", () => {
    expect(chunkText("short text")).toEqual(["short text"]);
  });

  it("is deterministic", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} talks about topic ${i}.`).join(
      "\n\n",
    );
    expect(chunkText(long)).toEqual(chunkText(long));
  });

  it("respects the max chunk size", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join("\n\n");
    for (const chunk of chunkText(long)) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it("overlaps adjacent chunks so boundary context is not lost", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    const tail = chunks[0]!.slice(-Math.floor(CHUNK_OVERLAP_CHARS / 3));
    expect(chunks[1]!).toContain(tail.slice(0, 20));
  });

  it("splits a single giant paragraph rather than emitting an oversized chunk", () => {
    const giant = "word ".repeat(2000).trim();
    const chunks = chunkText(giant);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });
});

describe("DbEvidenceStore", () => {
  function makeStore(gateway: LlmGateway | undefined = fakeEmbedGateway()) {
    const db = createTestDb();
    return new DbEvidenceStore(db, gateway);
  }

  it("reports healthy without any external service", async () => {
    const store = makeStore();
    expect((await store.health()).healthy).toBe(true);
  });

  it("round-trips ingest and hybrid search with relevant-first ranking", async () => {
    const store = makeStore();
    const col = await store.createCollection("ws-1");
    await store.addDocument({
      title: "Pricing",
      content: PRICING_DOC,
      collectionId: col,
      metadata: {},
    });
    await store.addDocument({
      title: "Churn",
      content: CHURN_DOC,
      collectionId: col,
      metadata: {},
    });

    const results = await store.search("what does the starter plan pricing cost", col, 4);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.text).toContain("$49");
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("never leaks results across collections", async () => {
    const store = makeStore();
    const a = await store.createCollection("ws-a");
    const b = await store.createCollection("ws-b");
    await store.addDocument({ title: "A", content: PRICING_DOC, collectionId: a, metadata: {} });

    expect(await store.search("pricing starter plan", b, 5)).toEqual([]);
    const inA = await store.search("pricing starter plan", a, 5);
    expect(inA.length).toBeGreaterThan(0);
  });

  it("deletes a document's chunks without touching other documents", async () => {
    const store = makeStore();
    const col = await store.createCollection("ws-1");
    const pricingId = await store.addDocument({
      title: "Pricing",
      content: PRICING_DOC,
      collectionId: col,
      metadata: {},
    });
    await store.addDocument({ title: "Churn", content: CHURN_DOC, collectionId: col, metadata: {} });

    await store.deleteDocument(pricingId);

    expect(await store.search("starter plan pricing cost", col, 5)).toEqual([]);
    const churn = await store.search("churn cancellations week two", col, 5);
    expect(churn.length).toBeGreaterThan(0);
  });

  it("ingests with null embeddings and still searches when the gateway has no key", async () => {
    const store = makeStore(keylessGateway());
    const col = await store.createCollection("ws-1");
    await store.addDocument({
      title: "Pricing",
      content: PRICING_DOC,
      collectionId: col,
      metadata: {},
    });

    const results = await store.search("starter plan pricing", col, 5);
    expect(results.length).toBeGreaterThan(0);
    // FTS-only scores are scaled into [0.35, 0.9] so the retrieval floor keeps them.
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.35);
      expect(r.score).toBeLessThanOrEqual(0.9);
    }
  });

  it("returns scores that survive rankEvidenceChunks' similarity floor", async () => {
    const store = makeStore();
    const col = await store.createCollection("ws-1");
    await store.addDocument({
      title: "Pricing",
      content: PRICING_DOC,
      collectionId: col,
      metadata: {},
    });

    const results = await store.search("starter plan pricing cost per month", col, 3);
    const ranked = rankEvidenceChunks(
      results.map((r) => ({
        text: r.text,
        title: "Pricing",
        documentId: r.documentId,
        kind: "manual",
        score: r.score,
        sourceCreatedAt: Date.now(),
      })),
      Date.now(),
    );
    expect(ranked.length).toBeGreaterThan(0);
  });

  it("tolerates FTS syntax characters in prose queries", async () => {
    const store = makeStore();
    const col = await store.createCollection("ws-1");
    await store.addDocument({
      title: "Pricing",
      content: PRICING_DOC,
      collectionId: col,
      metadata: {},
    });

    await expect(
      store.search('what is "pricing" AND (cost) OR plan* NOT seats?', col, 5),
    ).resolves.toBeDefined();
    await expect(store.search("???", col, 5)).resolves.toEqual([]);
  });

  it("attachDocument is a compatible no-op", async () => {
    const store = makeStore();
    const col = await store.createCollection("ws-1");
    const id = await store.addDocument({
      title: "Pricing",
      content: PRICING_DOC,
      collectionId: col,
      metadata: {},
    });
    await expect(store.attachDocument(col, id)).resolves.toBeUndefined();
  });
});
