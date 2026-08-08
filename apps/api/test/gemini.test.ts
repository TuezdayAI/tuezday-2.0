import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayError } from "../src/llm/gateway";
import { GeminiGateway } from "../src/llm/gemini";

describe("GeminiGateway config", () => {
  const savedKey = process.env.GEMINI_API_KEY;
  const savedModel = process.env.GEMINI_MODEL;

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
  });

  it("falls back to the default model when GEMINI_MODEL is an empty string", () => {
    process.env.GEMINI_MODEL = "";
    expect(new GeminiGateway().model).toBe("gemini-2.5-flash");
  });

  it("falls back to the default model when GEMINI_MODEL is whitespace", () => {
    process.env.GEMINI_MODEL = "   ";
    expect(new GeminiGateway().model).toBe("gemini-2.5-flash");
  });

  it("uses GEMINI_MODEL when set", () => {
    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    expect(new GeminiGateway().model).toBe("gemini-2.5-pro");
  });

  it("treats an empty api key as missing and fails with a clear error", async () => {
    process.env.GEMINI_API_KEY = "";
    const gateway = new GeminiGateway();
    await expect(gateway.generate({ prompt: "hi" })).rejects.toThrowError(GatewayError);
    await expect(gateway.generate({ prompt: "hi" })).rejects.toMatchObject({
      code: "missing_api_key",
    });
  });
});
