import { isIP } from "node:net";
import { readBoundedBody } from "./body";
import { assertPublicAddress, normalizeHostname, validateSafeFetchUrl } from "./destination";
import { SafeFetchError, safeFetchError, toSafeFetchError } from "./errors";
import {
  createSafeFetchPolicy,
  validateSafeFetchHeaders,
  type SafeFetchPolicy,
} from "./policy";
import type { SafeFetchRequest, SafeFetchResult, SafeFetchService } from "./index";
import {
  NodeSafeFetchResolver,
  UndiciSafeFetchTransport,
  type ResolvedAddress,
  type SafeFetchResolver,
  type SafeFetchTransport,
  type TransportResponse,
} from "./transport";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isResolvedAddress(value: unknown): value is ResolvedAddress {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ResolvedAddress>;
  return (
    typeof candidate.address === "string" &&
    (candidate.family === 4 || candidate.family === 6)
  );
}

function headerValue(
  headers: TransportResponse["headers"],
  name: string,
): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return Array.isArray(value) ? undefined : value;
}

function hasAmbiguousHeader(
  headers: TransportResponse["headers"],
  name: string,
): boolean {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return Array.isArray(entry?.[1]);
}

function resultFromBytes(
  finalUrl: URL,
  response: TransportResponse,
  contentType: string,
  bytes: Uint8Array,
): SafeFetchResult {
  const text = () => new TextDecoder().decode(bytes);
  return {
    finalUrl: finalUrl.toString(),
    status: response.status,
    contentType,
    bytes,
    text,
    json<T = unknown>(): T {
      try {
        return JSON.parse(text()) as T;
      } catch (cause) {
        throw safeFetchError("transport_failed", cause);
      }
    },
  };
}

function hasErrorCode(cause: unknown, code: string): boolean {
  let current = cause;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === code) return true;
    current = candidate.cause;
  }
  return false;
}

async function withDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let rejectOnAbort: ((error: SafeFetchError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(safeFetchError("total_timeout"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function effectiveLimit(
  requested: number | undefined,
  fixed: number,
  errorCode: "compressed_limit" | "decoded_limit",
): number {
  if (requested === undefined) return fixed;
  if (!Number.isSafeInteger(requested) || requested <= 0 || requested > fixed) {
    throw safeFetchError(errorCode);
  }
  return requested;
}

export interface SafeFetchDeadline {
  signal: AbortSignal;
  dispose(): void;
}

export type SafeFetchDeadlineFactory = (timeoutMs: number) => SafeFetchDeadline;

export function createSafeFetchDeadline(timeoutMs: number): SafeFetchDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

export class DefaultSafeFetchService implements SafeFetchService {
  constructor(
    private readonly policy: SafeFetchPolicy,
    private readonly resolver: SafeFetchResolver = new NodeSafeFetchResolver(),
    private readonly transport: SafeFetchTransport = new UndiciSafeFetchTransport(),
    private readonly deadlineFactory: SafeFetchDeadlineFactory = createSafeFetchDeadline,
  ) {}

  validateUrl(url: string): URL {
    return validateSafeFetchUrl(url, this.policy);
  }

  private async resolveAndValidate(
    url: URL,
    signal: AbortSignal,
  ): Promise<ResolvedAddress[]> {
    const hostname = normalizeHostname(url.hostname);
    const literalFamily = isIP(hostname);
    if (literalFamily) {
      assertPublicAddress(hostname);
      return [{ address: hostname, family: literalFamily as 4 | 6 }];
    }

    let answers: ResolvedAddress[];
    try {
      answers = await withDeadline(
        Promise.resolve().then(() => this.resolver.resolve(hostname)),
        signal,
      );
    } catch (cause) {
      if (
        signal.aborted ||
        (cause instanceof SafeFetchError && cause.code === "total_timeout")
      ) {
        throw safeFetchError("total_timeout", cause);
      }
      throw safeFetchError("dns_failed", cause);
    }
    if (answers.length === 0) throw safeFetchError("dns_failed");

    const validated: ResolvedAddress[] = [];
    for (const answer of answers as unknown[]) {
      if (!isResolvedAddress(answer)) throw safeFetchError("dns_failed");
      const actualFamily = isIP(answer.address);
      if (!actualFamily || actualFamily !== answer.family) {
        throw safeFetchError("dns_failed");
      }
      assertPublicAddress(answer.address);
      validated.push(answer);
    }
    return validated;
  }

  async fetch(request: SafeFetchRequest): Promise<SafeFetchResult> {
    try {
      return await this.fetchWithPolicy(request);
    } catch (cause) {
      throw toSafeFetchError(cause);
    }
  }

  private async fetchWithPolicy(
    request: SafeFetchRequest,
  ): Promise<SafeFetchResult> {
    let currentUrl = request.url;
    let redirectTarget = false;
    const headers = validateSafeFetchHeaders(request.headers);
    const limits = {
      maxCompressedBytes: effectiveLimit(
        request.limits?.maxCompressedBytes,
        this.policy.limits.maxCompressedBytes,
        "compressed_limit",
      ),
      maxDecodedBytes: effectiveLimit(
        request.limits?.maxDecodedBytes,
        this.policy.limits.maxDecodedBytes,
        "decoded_limit",
      ),
      maxExpansionRatio: this.policy.limits.maxExpansionRatio,
    };
    const deadline = this.deadlineFactory(this.policy.limits.totalTimeoutMs);

    try {
      for (let redirects = 0; ; redirects += 1) {
        if (deadline.signal.aborted) throw safeFetchError("total_timeout");
        let url: URL;
        try {
          url = this.validateUrl(currentUrl);
        } catch (cause) {
          if (redirectTarget && cause instanceof SafeFetchError) {
            throw safeFetchError("redirect_blocked", cause);
          }
          throw cause;
        }
        const addresses = await this.resolveAndValidate(url, deadline.signal);
        if (deadline.signal.aborted) throw safeFetchError("total_timeout");
        let response: TransportResponse;
        try {
          response = await withDeadline(
            Promise.resolve().then(() =>
              this.transport.request({
                url,
                address: addresses[0]!,
                headers,
                signal: deadline.signal,
                connectTimeoutMs: this.policy.limits.connectTimeoutMs,
              }),
            ),
            deadline.signal,
          );
        } catch (cause) {
          if (deadline.signal.aborted) {
            throw safeFetchError("total_timeout", cause);
          }
          if (hasErrorCode(cause, "UND_ERR_CONNECT_TIMEOUT")) {
            throw safeFetchError("connect_timeout", cause);
          }
          if (cause instanceof SafeFetchError) throw cause;
          throw safeFetchError("transport_failed", cause);
        }

        if (!REDIRECT_STATUSES.has(response.status)) {
          if (response.status < 200 || response.status >= 300) {
            response.body.destroy();
            throw safeFetchError("upstream_status");
          }
          if (hasAmbiguousHeader(response.headers, "content-type")) {
            response.body.destroy();
            throw safeFetchError("mime_blocked");
          }
          if (hasAmbiguousHeader(response.headers, "content-encoding")) {
            response.body.destroy();
            throw safeFetchError("encoding_blocked");
          }
          const body = await readBoundedBody({
            body: response.body,
            contentType: headerValue(response.headers, "content-type"),
            contentEncoding: headerValue(response.headers, "content-encoding"),
            profile: request.profile,
            limits,
            signal: deadline.signal,
          });
          return resultFromBytes(url, response, body.contentType, body.bytes);
        }

        const location = headerValue(response.headers, "location");
        response.body.destroy();
        if (redirects >= this.policy.limits.maxRedirects) {
          throw safeFetchError("redirect_limit");
        }
        if (!location) throw safeFetchError("redirect_blocked");
        try {
          currentUrl = new URL(location, url).toString();
          redirectTarget = true;
        } catch (cause) {
          throw safeFetchError("redirect_blocked", cause);
        }
      }
    } finally {
      deadline.dispose();
    }
  }
}

export function createSafeFetchService(
  policy: SafeFetchPolicy = createSafeFetchPolicy(),
): SafeFetchService {
  return new DefaultSafeFetchService(policy);
}
