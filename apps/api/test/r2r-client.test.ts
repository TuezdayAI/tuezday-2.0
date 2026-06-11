import { describe, expect, it } from "vitest";
import { R2REvidenceStore } from "../src/evidence/r2r";

type Fetcher = typeof fetch;

interface Captured {
  url: string;
  method?: string;
  body?: unknown;
}

function capture(responses: Record<string, { status: number; body: unknown }>): {
  fetcher: Fetcher;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method, body: init?.body });
    const match = Object.entries(responses).find(([key]) => u.includes(key));
    if (!match) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(match[1].body), { status: match[1].status });
  }) as Fetcher;
  return { fetcher, calls };
}

describe("R2REvidenceStore", () => {
  it("reports healthy from /v3/health", async () => {
    const { fetcher } = capture({ "/v3/health": { status: 200, body: { results: { message: "ok" } } } });
    const store = new R2REvidenceStore("http://r2r.test", fetcher);
    expect((await store.health()).healthy).toBe(true);
  });

  it("reports unreachable with an actionable hint", async () => {
    const fetcher = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as Fetcher;
    const store = new R2REvidenceStore("http://r2r.test", fetcher);
    const health = await store.health();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("r2r:up");
  });

  it("creates documents via multipart raw_text and returns the id", async () => {
    const { fetcher, calls } = capture({
      "/v3/documents": { status: 202, body: { results: { document_id: "doc-123" } } },
    });
    const store = new R2REvidenceStore("http://r2r.test", fetcher);
    const id = await store.addDocument({
      title: "Website copy",
      content: "Tuezday is the GTM memory layer.",
      metadata: { workspace_id: "ws-1" },
    });
    expect(id).toBe("doc-123");
    const call = calls.find((c) => c.url.includes("/v3/documents"))!;
    expect(call.method).toBe("POST");
    const form = call.body as FormData;
    expect(form.get("raw_text")).toBe("Tuezday is the GTM memory layer.");
    expect(JSON.parse(form.get("metadata") as string)).toMatchObject({
      title: "Website copy",
      workspace_id: "ws-1",
    });
  });

  it("searches with document_id filters and parses chunk results", async () => {
    const { fetcher, calls } = capture({
      "/v3/retrieval/search": {
        status: 200,
        body: {
          results: {
            chunk_search_results: [
              { text: "Chunk one.", score: 0.9, document_id: "doc-1" },
              { text: "Chunk two.", score: 0.5, document_id: "doc-2" },
            ],
          },
        },
      },
    });
    const store = new R2REvidenceStore("http://r2r.test", fetcher);
    const results = await store.search("memory layer", ["doc-1", "doc-2"], 5);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ text: "Chunk one.", score: 0.9, documentId: "doc-1" });

    const call = calls.find((c) => c.url.includes("/v3/retrieval/search"))!;
    const body = JSON.parse(call.body as string);
    expect(body.query).toBe("memory layer");
    expect(body.search_settings.filters).toEqual({ document_id: { $in: ["doc-1", "doc-2"] } });
    expect(body.search_settings.limit).toBe(5);
  });

  it("returns empty without calling the API when no document ids are given", async () => {
    const { fetcher, calls } = capture({});
    const store = new R2REvidenceStore("http://r2r.test", fetcher);
    expect(await store.search("anything", [], 5)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("deletes documents and tolerates 404", async () => {
    const { fetcher, calls } = capture({ "/v3/documents/doc-1": { status: 404, body: {} } });
    const store = new R2REvidenceStore("http://r2r.test", fetcher);
    await store.deleteDocument("doc-1");
    expect(calls[0]!.method).toBe("DELETE");
  });
});
