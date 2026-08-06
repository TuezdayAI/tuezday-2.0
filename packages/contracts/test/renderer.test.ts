import { describe, expect, it } from "vitest";
import * as contracts from "../src/index";

describe("internal renderer contract", () => {
  it("bounds document size, dimensions, placeholders, and values", () => {
    const api = contracts as unknown as {
      renderRequestSchema?: {
        safeParse(value: unknown): { success: boolean };
        parse(value: unknown): { width: number; height: number };
      };
    };

    expect(api.renderRequestSchema).toBeDefined();
    const schema = api.renderRequestSchema!;
    const valid = {
      template: {
        html: "<main>{{title}}</main>",
        css: "main{color:#111}",
        placeholders: ["title"],
      },
      values: { title: "A safe title" },
    };
    expect(schema.parse(valid)).toMatchObject({ width: 1080, height: 1080 });
    expect(schema.safeParse({ ...valid, width: 63 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, height: 4097 }).success).toBe(false);
    expect(
      schema.safeParse({
        ...valid,
        template: { ...valid.template, placeholders: ["not allowed"] },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...valid,
        values: { title: "x".repeat(20_001) },
      }).success,
    ).toBe(false);
  });

  it("accepts only stable bounded renderer error responses", () => {
    const api = contracts as unknown as {
      renderErrorSchema?: { safeParse(value: unknown): { success: boolean } };
    };
    expect(api.renderErrorSchema).toBeDefined();
    const schema = api.renderErrorSchema!;
    expect(schema.safeParse({ error: "render_timeout", message: "Render timed out." }).success).toBe(true);
    expect(schema.safeParse({ error: "anything", message: "x".repeat(501) }).success).toBe(false);
  });
});
