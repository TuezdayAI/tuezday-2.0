import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GatewayError,
  type AgentStepParams,
  type AgentStepResult,
  type GenerateParams,
  type GenerateResult,
  type LlmGateway,
} from "../src/llm/gateway";
import { jsonSchemaFor, responseJsonSchemaFor } from "../src/llm/json-schema";
import { generateStructured, StructuredOutputError } from "../src/llm/structured";

const itemSchema = z.object({ name: z.string(), score: z.number() });

/** generate()-only fake — the shape every pre-56 test gateway has. */
function generateOnly(responses: string[]): LlmGateway & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async generate(params: GenerateParams): Promise<GenerateResult> {
      prompts.push(params.prompt);
      const text = responses.shift();
      if (text === undefined) throw new Error("fake exhausted");
      return { text, model: "fake-model", provider: "fake", durationMs: 5 };
    },
  };
}

/** agentStep-capable fake recording params, so the constrained path is provable. */
function agentStepFake(
  responses: string[],
): LlmGateway & { steps: AgentStepParams[]; generateCalls: number } {
  const steps: AgentStepParams[] = [];
  const fake = {
    steps,
    generateCalls: 0,
    async generate(): Promise<GenerateResult> {
      fake.generateCalls += 1;
      throw new Error("structured must not use generate() when agentStep exists");
    },
    async agentStep(params: AgentStepParams): Promise<AgentStepResult> {
      steps.push({ ...params, messages: [...params.messages] });
      const text = responses.shift();
      if (text === undefined) throw new Error("fake exhausted");
      return {
        message: { role: "assistant", content: text },
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
        model: "fake-agent-model",
        provider: "fake",
        durationMs: 7,
      };
    },
  };
  return fake;
}

describe("generateStructured", () => {
  it("returns the validated value over the generate() fallback path", async () => {
    const llm = generateOnly(['{"name": "a", "score": 3}']);
    const result = await generateStructured(llm, itemSchema, { prompt: "p" });
    expect(result.value).toEqual({ name: "a", score: 3 });
    expect(result.repaired).toBe(false);
    expect(result.model).toBe("fake-model");
    expect(llm.prompts).toEqual(["p"]);
  });

  it("prefers agentStep with the converted responseSchema and empty system", async () => {
    const llm = agentStepFake(['{"name": "a", "score": 1}']);
    const result = await generateStructured(llm, itemSchema, { prompt: "the prompt" });
    expect(result.value).toEqual({ name: "a", score: 1 });
    expect(llm.generateCalls).toBe(0);
    expect(llm.steps).toHaveLength(1);
    expect(llm.steps[0]!.system).toBe("");
    expect(llm.steps[0]!.messages).toEqual([{ role: "user", content: "the prompt" }]);
    expect(llm.steps[0]!.responseSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, score: { type: "number" } },
      required: ["name", "score"],
    });
  });

  it("tolerates fences and prose noise around the JSON", async () => {
    const llm = generateOnly(['```json\n{"name": "a", "score": 2}\n```']);
    const fenced = await generateStructured(llm, itemSchema, { prompt: "p" });
    expect(fenced.value.score).toBe(2);

    const noisy = generateOnly(['Sure! Here it is: {"name": "b", "score": 4} Hope that helps.']);
    const result = await generateStructured(noisy, itemSchema, { prompt: "p" });
    expect(result.value).toEqual({ name: "b", score: 4 });
  });

  it("parses top-level arrays", async () => {
    const llm = generateOnly(['[{"name": "a", "score": 1}, {"name": "b", "score": 2}]']);
    const result = await generateStructured(llm, z.array(itemSchema), { prompt: "p" });
    expect(result.value).toHaveLength(2);
  });

  it("repairs once, feeding back the previous response and the exact error", async () => {
    const llm = generateOnly(["not json at all", '{"name": "fixed", "score": 9}']);
    const result = await generateStructured(llm, itemSchema, { prompt: "p" });
    expect(result.value).toEqual({ name: "fixed", score: 9 });
    expect(result.repaired).toBe(true);
    expect(result.durationMs).toBe(10);
    expect(llm.prompts[1]).toContain("not json at all");
    expect(llm.prompts[1]).toContain("no JSON object or array found");
  });

  it("repairs over agentStep with the failure as an assistant turn", async () => {
    const llm = agentStepFake(['{"name": "a"}', '{"name": "a", "score": 5}']);
    const result = await generateStructured(llm, itemSchema, { prompt: "p" });
    expect(result.repaired).toBe(true);
    const repairMessages = llm.steps[1]!.messages;
    expect(repairMessages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(repairMessages[1]!.content).toBe('{"name": "a"}');
    expect(repairMessages[2]!.content).toContain("schema validation failed");
  });

  it("throws a typed error with the failure class after two failures", async () => {
    const cases: Array<[string, string]> = [
      ["there is no json here", "no_json"],
      ['{"name": "a", broken', "invalid_json"],
      ['{"name": "a", "score": "high"}', "schema_mismatch"],
    ];
    for (const [text, failureClass] of cases) {
      const llm = generateOnly([text, text]);
      const err = await generateStructured(llm, itemSchema, { prompt: "p" }).catch((e) => e);
      expect(err).toBeInstanceOf(StructuredOutputError);
      expect((err as StructuredOutputError).failureClass).toBe(failureClass);
      expect((err as StructuredOutputError).rawText).toContain(text.slice(0, 10));
    }
  });

  it("propagates GatewayError untouched — transport is not a schema failure", async () => {
    const llm: LlmGateway = {
      async generate() {
        throw new GatewayError("provider_error", "down");
      },
    };
    await expect(await generateStructured(llm, itemSchema, { prompt: "p" })).rejects.toThrow(
      GatewayError,
    );
  });
});

describe("responseJsonSchemaFor", () => {
  it("allows array roots and emits nullable", () => {
    const schema = z.array(z.object({ id: z.string().nullable() }));
    expect(responseJsonSchemaFor(schema)).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string", nullable: true } },
        required: ["id"],
      },
    });
  });

  it("treats nullish fields as optional nullable", () => {
    const schema = z.object({ personaId: z.string().nullish(), score: z.number() });
    expect(responseJsonSchemaFor(schema)).toEqual({
      type: "object",
      properties: {
        personaId: { type: "string", nullable: true },
        score: { type: "number" },
      },
      required: ["score"],
    });
  });

  it("rejects non-object/array roots; tool inputs still require objects", () => {
    expect(() => responseJsonSchemaFor(z.string())).toThrow(/object|array/);
    expect(() => jsonSchemaFor(z.array(z.string()))).toThrow(/object/);
  });
});
