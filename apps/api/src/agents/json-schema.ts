import { z } from "zod";
import type { JsonSchema } from "../llm/gateway";

// ---------------------------------------------------------------------------
// zod → JSON Schema, for exactly the subset tool inputs use (Sprint 57).
//
// The repo is on the zod v3 API, which has no native toJSONSchema, and a
// dependency isn't warranted for eleven flat input schemas. This converter
// walks object / string / number / boolean / enum / array / optional /
// default and THROWS on anything else — a tool input using an unsupported
// construct fails loudly at registration, not silently at call time.
//
// Emitted keywords stay inside the subset the Gemini function-declaration
// schema is known to accept (type, properties, required, description, enum,
// items, minimum, maximum). String length/format constraints are deliberately
// NOT emitted — zod still enforces them at dispatch, where a violation goes
// back to the model as instructive error data.
// ---------------------------------------------------------------------------

export function jsonSchemaFor(schema: z.ZodTypeAny): JsonSchema {
  const out = convert(schema);
  if (out.type !== "object") {
    throw new Error("jsonSchemaFor: tool input schemas must be zod objects.");
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
      "tool inputs are limited to object/string/number/boolean/enum/array/optional/default.",
  );
}
