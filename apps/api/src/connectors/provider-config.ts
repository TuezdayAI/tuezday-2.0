export const DEFAULT_LINKEDIN_API_VERSION = "202607";

const ENABLED_OPERATOR_VALUES = new Set(["true", "1", "yes", "on"]);

export function operatorFlagEnabled(value: string | undefined): boolean {
  return ENABLED_OPERATOR_VALUES.has(value?.trim().toLowerCase() ?? "");
}

export function linkedinApiVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.LINKEDIN_API_VERSION?.trim();
  if (!configured) return DEFAULT_LINKEDIN_API_VERSION;
  if (!/^\d{6}$/.test(configured)) {
    throw new Error(
      "LINKEDIN_API_VERSION must be exactly six digits in YYYYMM form.",
    );
  }
  return configured;
}

export function linkedinRestHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  return {
    "LinkedIn-Version": linkedinApiVersion(env),
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

export function assertProviderConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): void {
  linkedinApiVersion(env);
}
