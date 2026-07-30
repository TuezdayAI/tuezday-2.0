import {
  createSafeFetchPolicy,
  validateSafeFetchUrl,
  type SafeFetchRequest,
  type SafeFetchResult,
  type SafeFetchService,
} from "../src/safe-fetch";

export interface FixtureResponse {
  body?: string | Uint8Array;
  contentType: string;
  status?: number;
  error?: unknown;
}

function fixtureResult(
  request: SafeFetchRequest,
  fixture: FixtureResponse,
): SafeFetchResult {
  const bytes =
    typeof fixture.body === "string"
      ? Buffer.from(fixture.body)
      : fixture.body ?? new Uint8Array();
  const text = () => new TextDecoder().decode(bytes);
  return {
    finalUrl: request.url,
    status: fixture.status ?? 200,
    contentType: fixture.contentType,
    bytes,
    text,
    json<T = unknown>(): T {
      return JSON.parse(text()) as T;
    },
  };
}

export function fixtureSafeFetch(
  responder: (
    request: SafeFetchRequest,
  ) => FixtureResponse | Promise<FixtureResponse>,
): SafeFetchService {
  const policy = createSafeFetchPolicy({
    TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "true",
  });
  return {
    validateUrl: (url) => validateSafeFetchUrl(url, policy),
    async fetch(request) {
      const fixture = await responder(request);
      if (fixture.error) throw fixture.error;
      return fixtureResult(request, fixture);
    },
  };
}
