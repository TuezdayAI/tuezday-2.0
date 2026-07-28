import { isIP } from "node:net";
import { assertPublicAddress, normalizeHostname, validateSafeFetchUrl } from "./destination";
import { SafeFetchError, safeFetchError } from "./errors";
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
  return Array.isArray(value) ? value[0] : value;
}

function resultFromBytes(
  finalUrl: URL,
  response: TransportResponse,
  bytes: Uint8Array,
): SafeFetchResult {
  const text = () => new TextDecoder().decode(bytes);
  return {
    finalUrl: finalUrl.toString(),
    status: response.status,
    contentType: headerValue(response.headers, "content-type") ?? "",
    bytes,
    text,
    json<T = unknown>(): T {
      return JSON.parse(text()) as T;
    },
  };
}

async function readResponse(response: TransportResponse): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export class DefaultSafeFetchService implements SafeFetchService {
  constructor(
    private readonly policy: SafeFetchPolicy,
    private readonly resolver: SafeFetchResolver = new NodeSafeFetchResolver(),
    private readonly transport: SafeFetchTransport = new UndiciSafeFetchTransport(),
  ) {}

  validateUrl(url: string): URL {
    return validateSafeFetchUrl(url, this.policy);
  }

  private async resolveAndValidate(url: URL): Promise<ResolvedAddress[]> {
    const hostname = normalizeHostname(url.hostname);
    const literalFamily = isIP(hostname);
    if (literalFamily) {
      assertPublicAddress(hostname);
      return [{ address: hostname, family: literalFamily as 4 | 6 }];
    }

    let answers: ResolvedAddress[];
    try {
      answers = await this.resolver.resolve(hostname);
    } catch (cause) {
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
    let currentUrl = request.url;
    let redirectTarget = false;
    const signal = new AbortController().signal;
    const headers = validateSafeFetchHeaders(request.headers);

    for (let redirects = 0; ; redirects += 1) {
      let url: URL;
      try {
        url = this.validateUrl(currentUrl);
      } catch (cause) {
        if (redirectTarget && cause instanceof SafeFetchError) {
          throw safeFetchError("redirect_blocked", cause);
        }
        throw cause;
      }
      const addresses = await this.resolveAndValidate(url);
      let response: TransportResponse;
      try {
        response = await this.transport.request({
          url,
          address: addresses[0]!,
          headers,
          signal,
          connectTimeoutMs: this.policy.limits.connectTimeoutMs,
        });
      } catch (cause) {
        if (cause instanceof SafeFetchError) throw cause;
        throw safeFetchError("transport_failed", cause);
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        try {
          return resultFromBytes(url, response, await readResponse(response));
        } catch (cause) {
          if (cause instanceof SafeFetchError) throw cause;
          throw safeFetchError("transport_failed", cause);
        }
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
  }
}

export function createSafeFetchService(
  policy: SafeFetchPolicy = createSafeFetchPolicy(),
): SafeFetchService {
  return new DefaultSafeFetchService(policy);
}
