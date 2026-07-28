export const SAFE_FETCH_LIMITS = Object.freeze({
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 20_000,
  maxRedirects: 5,
  maxCompressedBytes: 2 * 1024 * 1024,
  maxDecodedBytes: 5 * 1024 * 1024,
  maxExpansionRatio: 20,
});

export type SafeFetchLimits = typeof SAFE_FETCH_LIMITS;

export const SAFE_FETCH_MIME_TYPES = Object.freeze({
  feed: Object.freeze([
    "application/rss+xml",
    "application/atom+xml",
    "application/xml",
    "text/xml",
    "text/plain",
  ]),
  json: Object.freeze(["application/json", "text/json"]),
  website: Object.freeze(["text/html", "application/xhtml+xml", "text/plain"]),
});

export type SafeFetchProfile = keyof typeof SAFE_FETCH_MIME_TYPES;

export interface SafeFetchPolicy {
  allowHttp: boolean;
  limits: SafeFetchLimits;
}

export function createSafeFetchPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SafeFetchPolicy {
  return {
    allowHttp: env.TUEZDAY_SAFE_FETCH_ALLOW_HTTP === "true",
    limits: SAFE_FETCH_LIMITS,
  };
}
