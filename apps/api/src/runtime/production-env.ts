export interface ProductionEnvCheck {
  errors: string[];
  warnings: string[];
}

function isMissing(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Fail-fast production config check. Development and tests are unaffected —
 * both arrays are empty unless NODE_ENV is exactly "production". The
 * deployment plan brings the app up with only the LLM configured and adds
 * email, connectors, and billing in later sprints, so those are warnings
 * (boot proceeds, the feature stays inert) rather than errors (boot refused).
 */
export function validateProductionEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProductionEnvCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (env.NODE_ENV !== "production") {
    return { errors, warnings };
  }

  // Must match createLlmGatewayFromEnv() in ../llm/index.ts: LLM_PROVIDER
  // defaults to "gemini"; only "openrouter" requires OPENROUTER_API_KEY,
  // every other value (including the default) requires GEMINI_API_KEY.
  const provider = env.LLM_PROVIDER?.trim() || "gemini";
  if (provider === "openrouter") {
    if (isMissing(env.OPENROUTER_API_KEY)) {
      errors.push("OPENROUTER_API_KEY is not set.");
    }
  } else if (isMissing(env.GEMINI_API_KEY)) {
    errors.push("GEMINI_API_KEY is not set.");
  }

  if (isMissing(env.TUEZDAY_WORKER_TOKEN)) {
    errors.push("TUEZDAY_WORKER_TOKEN is not set.");
  }
  if (isMissing(env.APP_BASE_URL)) {
    errors.push("APP_BASE_URL is not set.");
  }

  if (isMissing(env.RESEND_API_KEY)) {
    warnings.push(
      "RESEND_API_KEY is not set — outbound email sending is disabled.",
    );
  }
  if (isMissing(env.NANGO_SECRET_KEY)) {
    warnings.push("NANGO_SECRET_KEY is not set — OAuth connectors are disabled.");
  }
  if (isMissing(env.STRIPE_SECRET_KEY)) {
    warnings.push(
      "STRIPE_SECRET_KEY is not set — billing and checkout are disabled.",
    );
  }
  if (isMissing(env.POSTHOG_API_KEY)) {
    warnings.push(
      "POSTHOG_API_KEY is not set — product analytics is disabled.",
    );
  }
  if (isMissing(env.TELEGRAM_BOT_TOKEN)) {
    warnings.push(
      "TELEGRAM_BOT_TOKEN is not set — mobile approvals and notifications are disabled.",
    );
  }

  return { errors, warnings };
}
