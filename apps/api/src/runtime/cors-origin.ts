/**
 * Resolves the CORS allowlist from WEB_ORIGIN, a comma-separated list of
 * allowed browser origins. Unset (or empty/whitespace-only, or containing no
 * usable entries) preserves today's open-reflect behavior — `origin: true` —
 * so a deployment must opt in to locking the API down to specific origins.
 */
export function resolveCorsOrigin(
  env: NodeJS.ProcessEnv = process.env,
): true | string[] {
  const raw = env.WEB_ORIGIN;
  if (!raw) return true;
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : true;
}
