import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiGateway } from "../src/llm/gemini";
import { FallbackGateway } from "../src/llm/fallback";
import { costCents } from "../src/llm/pricing";
import {
  GatewayError,
  type AgentStepParams,
  type AgentStepResult,
  type AgentStepStreamEvent,
  type LlmGateway,
} from "../src/llm/gateway";

const STEP_PARAMS: AgentStepParams = {
  system: "You are a test agent.",
  messages: [
    { role: "user", content: "Find the pricing." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "lookup", arguments: { q: "pricing" } }],
    },
    {
      role: "tool",
      content: JSON.stringify({ value: "usage-based" }),
      toolCallId: "call_1",
      toolName: "lookup",
    },
  ],
  tools: [
    {
      name: "lookup",
      description: "Look up a value.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeminiGateway agentStep", () => {
  it("maps the transcript, tools and schema into the request and parses the reply", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "Checking " },
                  { text: "again." },
                  { functionCall: { name: "lookup", args: { q: "more" } } },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 5,
            cachedContentTokenCount: 40,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new GeminiGateway("test-key", "gemini-2.5-flash");

    const result = await gateway.agentStep({
      ...STEP_PARAMS,
      responseSchema: { type: "object", properties: { answer: { type: "string" } } },
    });

    // Request mapping.
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain("gemini-2.5-flash:generateContent");
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe("You are a test agent.");
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Find the pricing." }] },
      { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "pricing" } } }] },
      {
        role: "user",
        parts: [{ functionResponse: { name: "lookup", response: { value: "usage-based" } } }],
      },
    ]);
    expect(body.tools[0].functionDeclarations[0]).toMatchObject({
      name: "lookup",
      description: "Look up a value.",
    });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual({
      type: "object",
      properties: { answer: { type: "string" } },
    });

    // Response parsing: joined text, minted call ids, thoughts counted as output.
    expect(result.message).toEqual({
      role: "assistant",
      content: "Checking again.",
      toolCalls: [{ id: "call_1", name: "lookup", arguments: { q: "more" } }],
    });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 25, cachedTokens: 40 });
    expect(result.provider).toBe("gemini");
  });

  it("throws GatewayError on a provider error and an empty response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 }),
      ),
    );
    const gateway = new GeminiGateway("test-key", "gemini-2.5-flash");
    await expect(await gateway.agentStep(STEP_PARAMS)).rejects.toThrow(/quota exceeded/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), { status: 200 }),
      ),
    );
    await expect(await gateway.agentStep(STEP_PARAMS)).rejects.toThrow(/empty agent response/);
  });
});

describe("GeminiGateway agentStepStream", () => {
  it("emits deltas and tool calls from SSE chunks and accumulates the result", async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"},{"functionCall":{"name":"lookup","args":{"q":"x"}}}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":8,"cachedContentTokenCount":4}}',
      "",
    ].join("\n");
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new GeminiGateway("test-key", "gemini-2.5-flash");
    const events: AgentStepStreamEvent[] = [];

    const result = await gateway.agentStepStream(STEP_PARAMS, (e) => events.push(e));

    const [url] = fetchMock.mock.calls[0]! as unknown as [string];
    expect(url).toContain(":streamGenerateContent?alt=sse");
    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      {
        type: "tool_call",
        call: { id: "call_1", name: "lookup", arguments: { q: "x" } },
      },
    ]);
    expect(result.message.content).toBe("Hello");
    expect(result.message.toolCalls).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 8, cachedTokens: 4 });
  });
});

describe("FallbackGateway agent steps", () => {
  const step: AgentStepResult = {
    message: { role: "assistant", content: "ok" },
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    model: "m",
    provider: "secondary",
    durationMs: 0,
  };
  const generateOnly: LlmGateway = {
    generate: async () => ({ text: "x", model: "m", provider: "p", durationMs: 0 }),
  };

  it("uses the secondary when the primary does not implement agentStep", async () => {
    const secondary: LlmGateway = { ...generateOnly, agentStep: async () => step };
    const gateway = new FallbackGateway(generateOnly, secondary);
    await expect(await gateway.agentStep(STEP_PARAMS)).resolves.toMatchObject({
      provider: "secondary",
    });
  });

  it("falls back on a GatewayError from the primary", async () => {
    const primary: LlmGateway = {
      ...generateOnly,
      agentStep: async () => {
        throw new GatewayError("provider_error", "primary down");
      },
    };
    const secondary: LlmGateway = { ...generateOnly, agentStep: async () => step };
    const gateway = new FallbackGateway(primary, secondary);
    await expect(await gateway.agentStep(STEP_PARAMS)).resolves.toMatchObject({
      provider: "secondary",
    });
  });

  it("serves a stream request via plain agentStep when streaming is unsupported", async () => {
    const secondary: LlmGateway = { ...generateOnly, agentStep: async () => step };
    const gateway = new FallbackGateway(generateOnly, secondary);
    await expect(await gateway.agentStepStream(STEP_PARAMS, () => {})).resolves.toMatchObject({
      provider: "secondary",
    });
  });

  it("throws a clear error when no provider supports agent steps", async () => {
    const gateway = new FallbackGateway(generateOnly, generateOnly);
    await expect(await gateway.agentStep(STEP_PARAMS)).rejects.toThrow(
      /No configured LLM provider supports agent steps/,
    );
  });
});

describe("pricing", () => {
  it("prices gemini-2.5-flash usage with the cached-input discount", async () => {
    expect(
      costCents("gemini-2.5-flash", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedTokens: 0,
      }),
    ).toBeCloseTo(280);
    expect(
      costCents("gemini-2.5-flash", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedTokens: 400_000,
      }),
    ).toBeCloseTo(21);
  });

  it("prices unknown models at zero instead of failing", () => {
    expect(
      costCents("mystery-model", { inputTokens: 500, outputTokens: 500, cachedTokens: 0 }),
    ).toBe(0);
  });
});
