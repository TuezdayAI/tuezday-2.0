export const SAFE_FETCH_ERROR_CODES = [
  "invalid_url",
  "scheme_blocked",
  "credentials_blocked",
  "destination_blocked",
  "dns_failed",
  "redirect_blocked",
  "redirect_limit",
  "connect_timeout",
  "total_timeout",
  "compressed_limit",
  "decoded_limit",
  "decompression_ratio",
  "encoding_blocked",
  "mime_blocked",
  "upstream_status",
  "transport_failed",
] as const;

export type SafeFetchErrorCode = (typeof SAFE_FETCH_ERROR_CODES)[number];

const SAFE_FETCH_ERROR_CODE_SET = new Set<unknown>(SAFE_FETCH_ERROR_CODES);
const TRUSTED_SAFE_FETCH_ERRORS = new WeakMap<object, SafeFetchErrorCode>();

const PUBLIC_MESSAGES: Record<SafeFetchErrorCode, string> = {
  invalid_url: "The destination URL is invalid.",
  scheme_blocked: "The destination protocol is not allowed.",
  credentials_blocked: "Credentials and unsafe request headers are not allowed.",
  destination_blocked: "The destination is not allowed.",
  dns_failed: "The destination could not be resolved safely.",
  redirect_blocked: "The destination redirect is not allowed.",
  redirect_limit: "The destination redirected too many times.",
  connect_timeout: "The destination took too long to connect.",
  total_timeout: "The destination took too long to respond.",
  compressed_limit: "The destination response is too large.",
  decoded_limit: "The destination response is too large.",
  decompression_ratio: "The destination response could not be decoded safely.",
  encoding_blocked: "The destination response encoding is not allowed.",
  mime_blocked: "The destination response type is not allowed.",
  upstream_status: "The destination returned an unsuccessful response.",
  transport_failed: "The destination could not be reached.",
};

export interface SerializedSafeFetchError {
  code: SafeFetchErrorCode;
  message: string;
}

export function safeFetchPublicMessage(code: SafeFetchErrorCode): string {
  const canonical = SAFE_FETCH_ERROR_CODE_SET.has(code)
    ? code
    : "transport_failed";
  return PUBLIC_MESSAGES[canonical];
}

export class SafeFetchError extends Error {
  public readonly code: SafeFetchErrorCode;

  constructor(code: SafeFetchErrorCode, options?: { cause?: unknown }) {
    const canonical = SAFE_FETCH_ERROR_CODE_SET.has(code)
      ? code
      : "transport_failed";
    super(safeFetchPublicMessage(canonical), options);
    this.code = canonical;
    this.name = "SafeFetchError";
    TRUSTED_SAFE_FETCH_ERRORS.set(this, canonical);
  }
}

export function safeFetchError(code: SafeFetchErrorCode, cause?: unknown): SafeFetchError {
  return new SafeFetchError(code, cause === undefined ? undefined : { cause });
}

export function toSafeFetchError(error: unknown): SafeFetchError {
  let trustedCode: SafeFetchErrorCode | undefined;
  try {
    if (
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
    ) {
      trustedCode = TRUSTED_SAFE_FETCH_ERRORS.get(error as object);
    }
  } catch {
    // Hostile and revoked proxy values are always treated as unknown failures.
  }
  return safeFetchError(trustedCode ?? "transport_failed", error);
}

export function serializeSafeFetchError(
  error: unknown,
): SerializedSafeFetchError {
  const safe = toSafeFetchError(error);
  return {
    code: safe.code,
    message: safeFetchPublicMessage(safe.code),
  };
}
