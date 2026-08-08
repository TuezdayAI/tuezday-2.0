import { resolveCorsOrigin } from "./cors-origin";

export interface ProductionEnvCheck {
  errors: string[];
  warnings: string[];
}

function isMissing(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/** Origin strings must be exactly `scheme://host[:port]` — no path, query, or trailing slash. */
function isValidOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/** Pushes one warning naming every missing variable in a feature's group, or nothing if none are missing. */
function warnMissingGroup(
  warnings: string[],
  env: NodeJS.ProcessEnv,
  description: string,
  names: readonly string[],
): void {
  const missing = names.filter((name) => isMissing(env[name]));
  if (missing.length > 0) {
    warnings.push(`${description} — missing ${missing.join(", ")}.`);
  }
}

/**
 * Fail-fast production config check. Development and tests are unaffected —
 * both arrays are empty unless NODE_ENV is exactly "production". The
 * deployment plan brings the app up with only the LLM configured and adds
 * email, connectors, and billing in later sprints, so those are warnings
 * (boot proceeds, the feature stays inert) rather than errors (boot refused).
 */
export function validateProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductionEnvCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (env.NODE_ENV !== "production") {
    return { errors, warnings };
  }

  // Must match createLlmGatewayFromEnv() in ../llm/index.ts: LLM_PROVIDER
  // defaults to "gemini"; any value other than exactly "gemini" or
  // "openrouter" (case-sensitive) is rejected there with a thrown error, so
  // it is rejected here too rather than falling through to the "gemini"
  // credential check and passing validation only to crash moments later.
  const provider = env.LLM_PROVIDER?.trim() || "gemini";
  if (provider !== "gemini" && provider !== "openrouter") {
    errors.push(
      `LLM_PROVIDER "${provider}" is invalid — expected "gemini" or "openrouter".`,
    );
  } else if (provider === "openrouter") {
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
  // A container must never fall back to the local development server —
  // resolveDatabaseUrl's default is a loopback address, which inside a
  // container is the container itself. See ./database-url.ts.
  if (isMissing(env.DATABASE_URL)) {
    errors.push(
      "DATABASE_URL is not set — a container must not fall back to the local development database.",
    );
  }

  warnMissingGroup(
    warnings,
    env,
    "Outbound email sending is disabled or will fail at send time",
    ["RESEND_API_KEY", "MAIL_FROM", "EMAIL_UNSUBSCRIBE_SECRET"],
  );
  if (isMissing(env.NANGO_SECRET_KEY)) {
    warnings.push("NANGO_SECRET_KEY is not set — OAuth connectors are disabled.");
  }
  warnMissingGroup(
    warnings,
    env,
    "Billing is disabled or checkout webhooks will be rejected",
    ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  );
  if (isMissing(env.POSTHOG_API_KEY)) {
    warnings.push(
      "POSTHOG_API_KEY is not set — product analytics is disabled.",
    );
  }
  warnMissingGroup(
    warnings,
    env,
    "Mobile approvals and notifications are disabled or broken",
    ["TELEGRAM_BOT_TOKEN", "NOTIFY_SIGNING_SECRET"],
  );

  // Closing the open CORS door is opt-in (resolveCorsOrigin's unset case
  // preserves today's origin: true behavior on purpose) — but a production
  // boot that never opts in gets no signal that the door is still open.
  const corsOrigin = resolveCorsOrigin(env);
  if (corsOrigin === true) {
    warnings.push(
      "WEB_ORIGIN is not set — the API accepts requests from any browser origin.",
    );
  } else {
    const invalid = corsOrigin.filter((origin) => !isValidOrigin(origin));
    if (invalid.length > 0) {
      warnings.push(
        `WEB_ORIGIN has entries that are not valid origins (must be exactly scheme://host, e.g. https://app.example.com, with no path): ${invalid.join(", ")}.`,
      );
    }
  }

  return { errors, warnings };
}
