import { z } from "zod";
import type { JsonSchema } from "./gateway";

// ---------------------------------------------------------------------------
// zod → JSON Schema, for exactly the subset tool inputs and structured
// responses use (Sprints 57–58).
//
// The repo is on the zod v3 API, which has no native toJSONSchema, and a
// dependency isn't warranted for these flat schemas. This converter walks
// object / string / number / boolean / enum / array / optional / default /
// nullable and THROWS on anything else — a schema using an unsupported
// construct fails loudly at composition, not silently at call time.
//
// Emitted keywords stay inside the subset the Gemini function-declaration and
// response-schema dialects are known to accept (type, properties, required,
// description, enum, items, minimum, maximum, nullable). String length/format
// constraints are deliberately NOT emitted — zod still enforces them at
// validation, where a violation becomes instructive error data.
// ---------------------------------------------------------------------------

/** Tool-input schemas (Sprint 57): must be object-rooted per function calling. */
export function jsonSchemaFor(schema: z.ZodTypeAny): JsonSchema {
  const out = convert(schema);
  if (out.type !== "object") {
    throw new Error("jsonSchemaFor: tool input schemas must be zod objects.");
  }
  return out;
}

/** Structured-response schemas (Sprint 58): object- or array-rooted. */
export function responseJsonSchemaFor(schema: z.ZodTypeAny): JsonSchema {
  const out = convert(schema);
  if (out.type !== "object" && out.type !== "array") {
    throw new Error(
      "responseJsonSchemaFor: response schemas must be zod objects or arrays.",
    );
  }
  return out;
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  const described = (node: JsonSchema): JsonSchema => {
    const description = schema.description;
    return description ? { description, ...node } : node;
  };

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return described(convert(schema._def.innerType as z.ZodTypeAny));
  }
  if (schema instanceof z.ZodNullable) {
    // OpenAPI-style nullable — the dialect Gemini's responseSchema accepts.
    return described({ ...convert(schema._def.innerType as z.ZodTypeAny), nullable: true });
  }
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      properties[key] = convert(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    return described({
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    });
  }
  if (schema instanceof z.ZodString) {
    return described({ type: "string" });
  }
  if (schema instanceof z.ZodNumber) {
    const out: JsonSchema = { type: "number" };
    for (const check of schema._def.checks) {
      if (check.kind === "int") out.type = "integer";
      if (check.kind === "min") out.minimum = check.value;
      if (check.kind === "max") out.maximum = check.value;
    }
    return described(out);
  }
  if (schema instanceof z.ZodBoolean) {
    return described({ type: "boolean" });
  }
  if (schema instanceof z.ZodEnum) {
    return described({ type: "string", enum: [...(schema._def.values as string[])] });
  }
  if (schema instanceof z.ZodArray) {
    return described({ type: "array", items: convert(schema._def.type as z.ZodTypeAny) });
  }
  throw new Error(
    `jsonSchemaFor: unsupported zod construct ${schema._def?.typeName ?? typeof schema} — ` +
      "schemas are limited to object/string/number/boolean/enum/array/optional/default/nullable.",
  );
}
