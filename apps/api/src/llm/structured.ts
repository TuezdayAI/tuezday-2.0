import type { z } from "zod";
import type { AgentMessage, ModelTier } from "@tuezday/contracts";
import type { GenerateParams, LlmGateway } from "./gateway";
import { responseJsonSchemaFor } from "./json-schema";

// ---------------------------------------------------------------------------
// generateStructured (Sprint 58) — the ONE way services get structure out of
// the model. Prefers Gateway v2's agentStep with a constrained responseSchema
// (real constrained decoding on Gemini); degrades to generate() for gateways
// without it (every pre-56 fake), where the prompt's own JSON instruction plus
// the validation below carry the contract. Either way the result is validated
// against the zod schema, repaired once on failure, and a second failure is a
// typed StructuredOutputError with a recorded failure class — never a silent
// empty array. All tolerance about LLM JSON framing (fences, preamble noise)
// lives HERE and nowhere else.
// ---------------------------------------------------------------------------

/** Why a structured call failed, recorded on the error for telemetry/columns. */
export type StructuredFailureClass = "no_json" | "invalid_json" | "schema_mismatch";

export class StructuredOutputError extends Error {
  constructor(
    public readonly failureClass: StructuredFailureClass,
    public readonly issues: string[],
    /** The final attempt's full raw text — callers may persist it for
     * inspection (e.g. the ad-creatives generation record); never re-parsed. */
    public readonly rawText: string,
    public readonly model: string,
    public readonly provider: string,
    public readonly durationMs: number,
  ) {
    super(
      `Structured output failed after repair retry (${failureClass}): ${issues.join("; ")}`,
    );
    this.name = "StructuredOutputError";
  }
}

export interface GenerateStructuredParams {
  prompt: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Model tier (Sprint 59); omitted = "frontier". */
  tier?: ModelTier;
}

export interface GenerateStructuredResult<T> {
  value: T;
  model: string;
  provider: string;
  /** Summed across attempts when the repair retry ran. */
  durationMs: number;
  /** True when the repair retry produced the value. */
  repaired: boolean;
}

/** Strip a markdown fence, then take the outermost JSON object/array. */
function extractJson(
  text: string,
): { json: string } | { error: string; failureClass: "no_json" | "invalid_json" } {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const starts = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter((i) => i >= 0);
  if (starts.length === 0) {
    return { error: "no JSON object or array found in the response", failureClass: "no_json" };
  }
  const start = Math.min(...starts);
  const end = cleaned[start] === "{" ? cleaned.lastIndexOf("}") : cleaned.lastIndexOf("]");
  if (end <= start) {
    // JSON started but never closed — the typical max-tokens truncation.
    return { error: "unterminated JSON in the response", failureClass: "invalid_json" };
  }
  return { json: cleaned.slice(start, end + 1) };
}

interface Attempt<T> {
  value?: T;
  failureClass?: StructuredFailureClass;
  error?: string;
  text: string;
  model: string;
  provider: string;
  durationMs: number;
}

function validate<S extends z.ZodTypeAny>(
  schema: S,
  result: { text: string; model: string; provider: string; durationMs: number },
): Attempt<z.output<S>> {
  const base = {
    text: result.text,
    model: result.model,
    provider: result.provider,
    durationMs: result.durationMs,
  };
  const extracted = extractJson(result.text);
  if ("error" in extracted) {
    return { ...base, failureClass: extracted.failureClass, error: extracted.error };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(extracted.json);
  } catch (err) {
    return {
      ...base,
      failureClass: "invalid_json",
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ...base,
      failureClass: "schema_mismatch",
      error: `schema validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ...base, value: parsed.data };
}

function repairInstruction(error: string): string {
  return (
    `Your previous response could not be used. Error: ${error}. ` +
    "Return ONLY the corrected JSON — no prose, no markdown fences."
  );
}

/**
 * One structured model call + one repair retry, validated against `schema`.
 * The repair carries the previous raw response and the exact parse/validation
 * error so the model can fix its own output. GatewayError and aborts propagate
 * untouched (transport failure is not a schema failure); two schema-level
 * failures throw StructuredOutputError.
 */
export async function generateStructured<S extends z.ZodTypeAny>(
  llm: LlmGateway,
  schema: S,
  params: GenerateStructuredParams,
): Promise<GenerateStructuredResult<z.output<S>>> {
  const call = llm.agentStep
    ? agentStepCall(llm, responseJsonSchemaFor(schema), params)
    : generateCall(llm, params);

  const first = validate(schema, await call.first());
  if (first.value !== undefined) {
    return {
      value: first.value,
      model: first.model,
      provider: first.provider,
      durationMs: first.durationMs,
      repaired: false,
    };
  }

  const second = validate(schema, await call.repair(first.text, first.error!));
  if (second.value !== undefined) {
    return {
      value: second.value,
      model: second.model,
      provider: second.provider,
      durationMs: first.durationMs + second.durationMs,
      repaired: true,
    };
  }
  throw new StructuredOutputError(
    second.failureClass!,
    [second.error!],
    second.text,
    second.model,
    second.provider,
    first.durationMs + second.durationMs,
  );
}

interface TransportCall {
  first(): Promise<{ text: string; model: string; provider: string; durationMs: number }>;
  repair(
    previousText: string,
    error: string,
  ): Promise<{ text: string; model: string; provider: string; durationMs: number }>;
}

function agentStepCall(
  llm: LlmGateway,
  responseSchema: Record<string, unknown>,
  params: GenerateStructuredParams,
): TransportCall {
  const userMessage: AgentMessage = { role: "user", content: params.prompt };
  const step = async (messages: AgentMessage[]) => {
    const result = await llm.agentStep!({
      system: "",
      messages,
      responseSchema,
      maxOutputTokens: params.maxOutputTokens,
      signal: params.signal,
      tier: params.tier,
    });
    return {
      text: result.message.content,
      model: result.model,
      provider: result.provider,
      durationMs: result.durationMs,
    };
  };
  return {
    first: () => step([userMessage]),
    // The failed response rides as an assistant turn so the model sees exactly
    // what it produced next to the error it must fix.
    repair: (previousText, error) =>
      step([
        userMessage,
        { role: "assistant", content: previousText },
        { role: "user", content: repairInstruction(error) },
      ]),
  };
}

function generateCall(llm: LlmGateway, params: GenerateStructuredParams): TransportCall {
  const generate = async (prompt: string) => {
    const request: GenerateParams = { prompt };
    if (params.maxOutputTokens !== undefined) request.maxOutputTokens = params.maxOutputTokens;
    if (params.signal !== undefined) request.signal = params.signal;
    if (params.tier !== undefined) request.tier = params.tier;
    return llm.generate(request);
  };
  return {
    first: () => generate(params.prompt),
    repair: (previousText, error) =>
      generate(
        [
          params.prompt,
          `Your previous response:\n${previousText}`,
          repairInstruction(error),
        ].join("\n\n"),
      ),
  };
}
