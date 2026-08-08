import { describe, expect, it } from "vitest";
import { validateProductionEnv } from "../src/runtime/production-env";

const FULLY_CONFIGURED: Record<string, string> = {
  NODE_ENV: "production",
  GEMINI_API_KEY: "gemini-key",
  TUEZDAY_WORKER_TOKEN: "worker-token",
  APP_BASE_URL: "https://app.example.com",
  DATABASE_URL: "postgres://tuezday:secret@db.internal:5432/tuezday",
  RESEND_API_KEY: "resend-key",
  MAIL_FROM: "founder@example.com",
  EMAIL_UNSUBSCRIBE_SECRET: "unsubscribe-secret",
  NANGO_SECRET_KEY: "nango-key",
  STRIPE_SECRET_KEY: "stripe-key",
  STRIPE_WEBHOOK_SECRET: "stripe-webhook-secret",
  POSTHOG_API_KEY: "posthog-key",
  TELEGRAM_BOT_TOKEN: "telegram-key",
  NOTIFY_SIGNING_SECRET: "notify-secret",
  WEB_ORIGIN: "https://app.example.com",
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

  it("errors naming DATABASE_URL when it is missing (C1: must not fall back to the local server)", () => {
    const { errors } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      DATABASE_URL: undefined,
    });
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/DATABASE_URL/)]),
    );
  });

  it("errors naming DATABASE_URL when it is blank", () => {
    const { errors } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      DATABASE_URL: "   ",
    });
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/DATABASE_URL/)]),
    );
  });

  it("errors on an LLM_PROVIDER value the gateway does not accept, even with GEMINI_API_KEY set (I4)", () => {
    const { errors } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      LLM_PROVIDER: "Gemini",
    });
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/LLM_PROVIDER/)]),
    );
  });

  it("warns naming every missing member of the email group, not just RESEND_API_KEY (I2)", () => {
    const { warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      RESEND_API_KEY: undefined,
      MAIL_FROM: undefined,
      EMAIL_UNSUBSCRIBE_SECRET: undefined,
    });
    const emailWarning = warnings.find((w) => w.includes("RESEND_API_KEY"));
    expect(emailWarning).toBeDefined();
    expect(emailWarning).toMatch(/MAIL_FROM/);
    expect(emailWarning).toMatch(/EMAIL_UNSUBSCRIBE_SECRET/);
  });

  it("warns naming MAIL_FROM even when RESEND_API_KEY is set (I2)", () => {
    const { warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      MAIL_FROM: undefined,
    });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/MAIL_FROM/)]),
    );
  });

  it("warns naming EMAIL_UNSUBSCRIBE_SECRET even when RESEND_API_KEY and MAIL_FROM are set (I2)", () => {
    const { warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      EMAIL_UNSUBSCRIBE_SECRET: undefined,
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/EMAIL_UNSUBSCRIBE_SECRET/),
      ]),
    );
  });

  it("warns naming STRIPE_WEBHOOK_SECRET even when STRIPE_SECRET_KEY is set (I2)", () => {
    const { warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      STRIPE_WEBHOOK_SECRET: undefined,
    });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/STRIPE_WEBHOOK_SECRET/)]),
    );
  });

  it("warns naming NOTIFY_SIGNING_SECRET even when TELEGRAM_BOT_TOKEN is set (I2)", () => {
    const { warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      NOTIFY_SIGNING_SECRET: undefined,
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/NOTIFY_SIGNING_SECRET/),
      ]),
    );
  });

  it("warns when WEB_ORIGIN is not set (I3)", () => {
    const { errors, warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      WEB_ORIGIN: undefined,
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/WEB_ORIGIN/)]),
    );
  });

  it("warns when a WEB_ORIGIN entry has no scheme (M5)", () => {
    const { warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      WEB_ORIGIN: "app.example.com",
    });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/app\.example\.com/)]),
    );
  });

  it("warns when a WEB_ORIGIN entry has a path (M5)", () => {
    const { warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      WEB_ORIGIN: "https://app.example.com/app",
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/https:\/\/app\.example\.com\/app/),
      ]),
    );
  });

  it("does not warn about WEB_ORIGIN when every entry is a valid origin", () => {
    const { warnings } = validateProductionEnv({
      ...FULLY_CONFIGURED,
      WEB_ORIGIN: "https://app.example.com,https://admin.example.com",
    });
    expect(warnings.some((w) => w.includes("WEB_ORIGIN"))).toBe(false);
  });
});
