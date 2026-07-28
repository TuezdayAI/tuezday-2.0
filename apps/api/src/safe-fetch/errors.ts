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

const PUBLIC_MESSAGES: Record<SafeFetchErrorCode, string> = {
  invalid_url: "The destination URL is invalid.",
  scheme_blocked: "The destination protocol is not allowed.",
  credentials_blocked: "Credentials are not allowed in destination URLs.",
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

export class SafeFetchError extends Error {
  constructor(
    public readonly code: SafeFetchErrorCode,
    options?: { cause?: unknown },
  ) {
    super(PUBLIC_MESSAGES[code], options);
    this.name = "SafeFetchError";
  }
}

export function safeFetchError(code: SafeFetchErrorCode, cause?: unknown): SafeFetchError {
  return new SafeFetchError(code, cause === undefined ? undefined : { cause });
}
