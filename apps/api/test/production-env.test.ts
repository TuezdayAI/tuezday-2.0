import { describe, expect, it } from "vitest";
import { validateProductionEnv } from "../src/runtime/production-env";

const FULLY_CONFIGURED: Record<string, string> = {
  NODE_ENV: "production",
  GEMINI_API_KEY: "gemini-key",
  TUEZDAY_WORKER_TOKEN: "worker-token",
  APP_BASE_URL: "https://app.example.com",
  RESEND_API_KEY: "resend-key",
  NANGO_SECRET_KEY: "nango-key",
  STRIPE_SECRET_KEY: "stripe-key",
  POSTHOG_API_KEY: "posthog-key",
  TELEGRAM_BOT_TOKEN: "telegram-key",
};

describe("validateProductionEnv", () => {
  it("is a no-op when NODE_ENV is unset, even with everything missing", () => {
    expect(validateProductionEnv({})).toEqual({ errors: [], warnings: [] });
  });

  it("is a no-op in development, even with everything missing", () => {
    expect(validateProductionEnv({ NODE_ENV: "development" })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("errors naming GEMINI_API_KEY when it is missing under the default provider", () => {
    const { errors } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      GEMINI_API_KEY: undefined,
    });
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/GEMINI_API_KEY/)]),
    );
  });

  it("requires no LLM error when LLM_PROVIDER=openrouter and only OPENROUTER_API_KEY is set", () => {
    const { errors } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      LLM_PROVIDER: "openrouter",
      GEMINI_API_KEY: undefined,
      OPENROUTER_API_KEY: "openrouter-key",
    });
    expect(errors).toEqual([]);
  });

  it("errors naming OPENROUTER_API_KEY when LLM_PROVIDER=openrouter and only GEMINI_API_KEY is set", () => {
    const { errors } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: undefined,
    });
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/OPENROUTER_API_KEY/)]),
    );
  });

  it("warns (does not error) when RESEND_API_KEY is missing", () => {
    const { errors, warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      RESEND_API_KEY: undefined,
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/RESEND_API_KEY/)]),
    );
  });

  it("treats a whitespace-only value as missing", () => {
    const { errors } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      TUEZDAY_WORKER_TOKEN: "   ",
    });
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/TUEZDAY_WORKER_TOKEN/)]),
    );
  });

  it("returns both arrays empty when fully configured", () => {
    expect(validateProductionEnv(FULLY_CONFIGURED)).toEqual({
      errors: [],
      warnings: [],
    });
  });
});
