import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayError, type GenerateParams, type GenerateResult, type LlmGateway } from "../src/llm/gateway";
import { GeminiGateway } from "../src/llm/gemini";
import { OpenRouterGateway } from "../src/llm/openrouter";
import { FallbackGateway } from "../src/llm/fallback";
import { createLlmGatewayFromEnv } from "../src/llm";

type Fetcher = typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okChatCompletion(content: string, model = "google/gemini-2.5-flash") {
  return jsonResponse(200, {
    model,
    choices: [{ message: { role: "assistant", content } }],
  });
}

describe("OpenRouterGateway", () => {
  it("throws missing_api_key when no key is configured", async () => {
    const gateway = new OpenRouterGateway("", undefined, () => {
      throw new Error("fetch must not be called");
    });
    await expect(gateway.generate({ prompt: "hi" })).rejects.toMatchObject({
      name: "GatewayError",
      code: "missing_api_key",
    });
  });

  it("returns text/model/provider on success and sends auth + attribution headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: Fetcher = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return okChatCompletion("hello world");
    }) as Fetcher;

    const gateway = new OpenRouterGateway("or-key", undefined, fetcher);
    const result = await gateway.generate({ prompt: "say hello" });

    expect(result.text).toBe("hello world");
    expect(result.model).toBe("google/gemini-2.5-flash");
    expect(result.provider).toBe("openrouter");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer or-key");
    expect(headers["X-Title"]).toBe("Tuezday");
    expect(headers["HTTP-Referer"]).toBeTruthy();
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.messages).toEqual([{ role: "user", content: "say hello" }]);
  });

  it("forwards maxOutputTokens as max_tokens", async () => {
    let sentBody: any;
    const fetcher: Fetcher = (async (_url: any, init: any) => {
      sentBody = JSON.parse(String(init.body));
      return okChatCompletion("ok");
    }) as Fetcher;

    await new OpenRouterGateway("or-key", undefined, fetcher).generate({
      prompt: "p",
      maxOutputTokens: 123,
    });
    expect(sentBody.max_tokens).toBe(123);
  });

  it("throws provider_error including the status on non-2xx responses", async () => {
    const fetcher: Fetcher = (async () =>
      jsonResponse(429, { error: { message: "rate limited" } })) as Fetcher;
    const gateway = new OpenRouterGateway("or-key", undefined, fetcher);
    await expect(gateway.generate({ prompt: "p" })).rejects.toMatchObject({
      code: "provider_error",
      message: expect.stringContaining("429"),
    });
    await expect(
      new OpenRouterGateway("or-key", undefined, fetcher).generate({ prompt: "p" }),
    ).rejects.toMatchObject({ message: expect.stringContaining("rate limited") });
  });

  it("throws provider_error on empty choices or empty content", async () => {
    const empty: Fetcher = (async () => jsonResponse(200, { choices: [] })) as Fetcher;
    await expect(
      new OpenRouterGateway("or-key", undefined, empty).generate({ prompt: "p" }),
    ).rejects.toMatchObject({ code: "provider_error" });

    const blank: Fetcher = (async () =>
      jsonResponse(200, { choices: [{ message: { content: "   " } }] })) as Fetcher;
    await expect(
      new OpenRouterGateway("or-key", undefined, blank).generate({ prompt: "p" }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("throws provider_error when fetch itself rejects", async () => {
    const fetcher: Fetcher = (async () => {
      throw new Error("ECONNREFUSED");
    }) as Fetcher;
    await expect(
      new OpenRouterGateway("or-key", undefined, fetcher).generate({ prompt: "p" }),
    ).rejects.toMatchObject({
      code: "provider_error",
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("falls back to defaults when env values are blank", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENROUTER_MODEL", "  ");
    const gateway = new OpenRouterGateway();
    expect(gateway.model).toBe("google/gemini-2.5-flash");
    vi.unstubAllEnvs();
  });

  it("uses the model from the response when provided", async () => {
    const fetcher: Fetcher = (async () =>
      okChatCompletion("hi", "google/gemini-2.5-flash-lite")) as Fetcher;
    const result = await new OpenRouterGateway("or-key", "google/gemini-2.5-flash", fetcher).generate({
      prompt: "p",
    });
    expect(result.model).toBe("google/gemini-2.5-flash-lite");
  });
});

function fakeGateway(
  behavior: (params: GenerateParams) => Promise<GenerateResult>,
): LlmGateway & { calls: GenerateParams[] } {
  const calls: GenerateParams[] = [];
  return {
    calls,
    generate(params) {
      calls.push(params);
      return behavior(params);
    },
  };
}

const okResult = (provider: string): GenerateResult => ({
  text: `from ${provider}`,
  model: "m",
  provider,
  durationMs: 1,
});

describe("FallbackGateway", () => {
  it("returns the primary result without calling the secondary", async () => {
    const primary = fakeGateway(async () => okResult("gemini"));
    const secondary = fakeGateway(async () => okResult("openrouter"));
    const result = await new FallbackGateway(primary, secondary).generate({ prompt: "p" });
    expect(result.provider).toBe("gemini");
    expect(secondary.calls).toHaveLength(0);
  });

  it("falls back to the secondary on a primary GatewayError (provider_error)", async () => {
    const primary = fakeGateway(async () => {
      throw new GatewayError("provider_error", "gemini down");
    });
    const secondary = fakeGateway(async () => okResult("openrouter"));
    const result = await new FallbackGateway(primary, secondary).generate({ prompt: "p" });
    expect(result.provider).toBe("openrouter");
    expect(primary.calls).toHaveLength(1);
  });

  it("falls back on a primary missing_api_key too", async () => {
    const primary = fakeGateway(async () => {
      throw new GatewayError("missing_api_key", "no key");
    });
    const secondary = fakeGateway(async () => okResult("openrouter"));
    const result = await new FallbackGateway(primary, secondary).generate({ prompt: "p" });
    expect(result.provider).toBe("openrouter");
  });

  it("throws a single GatewayError naming both providers when both fail", async () => {
    const primary = fakeGateway(async () => {
      throw new GatewayError("provider_error", "gemini exploded");
    });
    const secondary = fakeGateway(async () => {
      throw new GatewayError("provider_error", "openrouter exploded");
    });
    await expect(
      new FallbackGateway(primary, secondary).generate({ prompt: "p" }),
    ).rejects.toMatchObject({
      name: "GatewayError",
      code: "provider_error",
      message: expect.stringMatching(/gemini exploded[\s\S]*openrouter exploded/),
    });
  });

  it("rethrows non-GatewayError from the primary without calling the secondary", async () => {
    const boom = new TypeError("programmer error");
    const primary = fakeGateway(async () => {
      throw boom;
    });
    const secondary = fakeGateway(async () => okResult("openrouter"));
    await expect(new FallbackGateway(primary, secondary).generate({ prompt: "p" })).rejects.toBe(
      boom,
    );
    expect(secondary.calls).toHaveLength(0);
  });
});

describe("createLlmGatewayFromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to a bare Gemini gateway when only GEMINI_API_KEY is set", () => {
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("GEMINI_API_KEY", "g-key");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const gateway = createLlmGatewayFromEnv();
    expect(gateway).toBeInstanceOf(GeminiGateway);
  });

  it("wraps in a FallbackGateway (Gemini primary) when both keys are set", () => {
    vi.stubEnv("GEMINI_API_KEY", "g-key");
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");
    const gateway = createLlmGatewayFromEnv();
    expect(gateway).toBeInstanceOf(FallbackGateway);
    expect((gateway as FallbackGateway).primary).toBeInstanceOf(GeminiGateway);
    expect((gateway as FallbackGateway).secondary).toBeInstanceOf(OpenRouterGateway);
  });

  it("makes OpenRouter the primary when LLM_PROVIDER=openrouter", () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("GEMINI_API_KEY", "g-key");
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");
    const gateway = createLlmGatewayFromEnv();
    expect(gateway).toBeInstanceOf(FallbackGateway);
    expect((gateway as FallbackGateway).primary).toBeInstanceOf(OpenRouterGateway);
    expect((gateway as FallbackGateway).secondary).toBeInstanceOf(GeminiGateway);
  });

  it("returns a bare OpenRouter gateway when the Gemini key is absent", () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");
    const gateway = createLlmGatewayFromEnv();
    expect(gateway).toBeInstanceOf(OpenRouterGateway);
  });

  it("throws at startup on an unknown LLM_PROVIDER value", () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    expect(() => createLlmGatewayFromEnv()).toThrow(/LLM_PROVIDER/);
  });
});
