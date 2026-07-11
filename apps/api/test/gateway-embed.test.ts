import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiGateway } from "../src/llm/gemini";
import { GatewayError } from "../src/llm/gateway";
import { EVIDENCE_EMBEDDING_DIMENSIONS } from "../src/evidence/db-store";

function okResponse(count: number): Response {
  return new Response(
    JSON.stringify({
      embeddings: Array.from({ length: count }, (_, i) => ({
        values: Array.from({ length: EVIDENCE_EMBEDDING_DIMENSIONS }, () => 0.01 * (i + 1)),
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("GeminiGateway.embed", () => {
  const savedKey = process.env.GEMINI_API_KEY;
  const savedEmbedModel = process.env.GEMINI_EMBED_MODEL;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.GEMINI_EMBED_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    if (savedEmbedModel === undefined) delete process.env.GEMINI_EMBED_MODEL;
    else process.env.GEMINI_EMBED_MODEL = savedEmbedModel;
  });

  it("sends a batch request with the embed model and 768 output dimensions", async () => {
    const fetcher = vi.fn(async () => okResponse(2));
    vi.stubGlobal("fetch", fetcher);

    const result = await new GeminiGateway().embed({ texts: ["alpha", "beta"] });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain("gemini-embedding-001:batchEmbedContents");
    const body = JSON.parse(String(init.body)) as {
      requests: {
        model: string;
        content: { parts: { text: string }[] };
        outputDimensionality: number;
      }[];
    };
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]!.content.parts[0]!.text).toBe("alpha");
    expect(body.requests[0]!.outputDimensionality).toBe(EVIDENCE_EMBEDDING_DIMENSIONS);
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]!).toHaveLength(EVIDENCE_EMBEDDING_DIMENSIONS);
    expect(result.dimensions).toBe(EVIDENCE_EMBEDDING_DIMENSIONS);
    expect(result.provider).toBe("gemini");
  });

  it("throws missing_api_key without a key and never calls the network", async () => {
    process.env.GEMINI_API_KEY = "";
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(new GeminiGateway().embed({ texts: ["x"] })).rejects.toMatchObject({
      code: "missing_api_key",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("throws provider_error on a non-200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 }),
      ),
    );

    const err = await new GeminiGateway()
      .embed({ texts: ["x"] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("provider_error");
    expect((err as GatewayError).message).toContain("quota");
  });

  it("honors the GEMINI_EMBED_MODEL override, tolerating blank env lines", async () => {
    process.env.GEMINI_EMBED_MODEL = "  ";
    let fetcher = vi.fn(async () => okResponse(1));
    vi.stubGlobal("fetch", fetcher);
    await new GeminiGateway().embed({ texts: ["x"] });
    expect((fetcher.mock.calls[0]! as unknown as [string])[0]).toContain("gemini-embedding-001");

    process.env.GEMINI_EMBED_MODEL = "custom-embed-2";
    fetcher = vi.fn(async () => okResponse(1));
    vi.stubGlobal("fetch", fetcher);
    await new GeminiGateway().embed({ texts: ["x"] });
    expect((fetcher.mock.calls[0]! as unknown as [string])[0]).toContain("custom-embed-2");
  });
});
