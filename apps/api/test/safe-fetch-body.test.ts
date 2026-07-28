import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
} from "node:zlib";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  DefaultSafeFetchService,
  assertAllowedMime,
  createSafeFetchPolicy,
  normalizeContentType,
  readBoundedBody,
  type PinnedRequest,
  type SafeFetchDeadline,
  type SafeFetchResolver,
  type SafeFetchTransport,
  type TransportBody,
  type TransportResponse,
} from "../src/safe-fetch";

class FixtureBody implements TransportBody {
  destroyed = false;
  yielded = 0;

  constructor(
    private readonly chunks: Uint8Array[],
    private readonly waitAfterChunks = false,
  ) {}

  destroy(): void {
    this.destroyed = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (const chunk of this.chunks) {
      if (this.destroyed) return;
      this.yielded += 1;
      yield chunk;
    }
    if (this.waitAfterChunks && !this.destroyed) {
      await new Promise<void>(() => {});
    }
  }
}

const DEFAULT_BODY_LIMITS = {
  maxCompressedBytes: 2 * 1024 * 1024,
  maxDecodedBytes: 5 * 1024 * 1024,
  maxExpansionRatio: 20,
};

async function readFixture(
  input: Uint8Array | Uint8Array[],
  options: Partial<{
    contentType: string;
    contentEncoding: string;
    profile: "feed" | "json" | "website";
    maxCompressedBytes: number;
    maxDecodedBytes: number;
    maxExpansionRatio: number;
    signal: AbortSignal;
  }> = {},
) {
  const body = new FixtureBody(Array.isArray(input) ? input : [input]);
  const result = readBoundedBody({
    body,
    contentType: options.contentType ?? "application/json",
    contentEncoding: options.contentEncoding,
    profile: options.profile ?? "json",
    limits: {
      maxCompressedBytes:
        options.maxCompressedBytes ?? DEFAULT_BODY_LIMITS.maxCompressedBytes,
      maxDecodedBytes: options.maxDecodedBytes ?? DEFAULT_BODY_LIMITS.maxDecodedBytes,
      maxExpansionRatio:
        options.maxExpansionRatio ?? DEFAULT_BODY_LIMITS.maxExpansionRatio,
    },
    signal: options.signal ?? new AbortController().signal,
  });
  return { body, result };
}

function transportResponse(
  status: number,
  body: FixtureBody,
  headers: TransportResponse["headers"] = {
    "content-type": "application/json",
  },
): TransportResponse {
  return { status, body, headers };
}

function serviceHarness(options: {
  responses?: TransportResponse[];
  transportError?: unknown;
  deadline?: SafeFetchDeadline;
  resolver?: SafeFetchResolver;
}) {
  const requests: PinnedRequest[] = [];
  const queue = [...(options.responses ?? [])];
  const resolver: SafeFetchResolver =
    options.resolver ?? {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
  const transport: SafeFetchTransport = {
    async request(input) {
      requests.push(input);
      if (options.transportError) throw options.transportError;
      const next = queue.shift();
      if (!next) throw new Error("fixture response queue exhausted");
      return next;
    },
  };
  let deadlineCalls = 0;
  const service = new DefaultSafeFetchService(
    createSafeFetchPolicy({}),
    resolver,
    transport,
    () => {
      deadlineCalls += 1;
      return (
        options.deadline ?? {
          signal: new AbortController().signal,
          dispose() {},
        }
      );
    },
  );
  return {
    service,
    requests,
    deadlineCalls: () => deadlineCalls,
  };
}

describe("safe-fetch MIME policy", () => {
  it("normalizes only a valid MIME token before parameters", () => {
    expect(normalizeContentType(" Application/JSON ; charset=utf-8 ")).toBe(
      "application/json",
    );
    expect(normalizeContentType("not-a-mime")).toBeUndefined();
    expect(normalizeContentType(undefined)).toBeUndefined();
  });

  it.each([
    ["feed", "application/rss+xml"],
    ["feed", "text/xml; charset=utf-8"],
    ["json", "application/json"],
    ["json", "application/problem+json"],
    ["json", "application/vnd.example~variant+json"],
    ["website", "text/html"],
    ["website", "application/xhtml+xml"],
  ] as const)("accepts %s profile MIME %s", (profile, contentType) => {
    expect(assertAllowedMime(profile, contentType)).toBe(
      normalizeContentType(contentType),
    );
  });

  it.each([
    ["feed", "application/json"],
    ["json", "text/html"],
    ["website", "application/json"],
  ] as const)("rejects %s profile MIME %s", (profile, contentType) => {
    expect(() => assertAllowedMime(profile, contentType)).toThrowError(
      expect.objectContaining({ code: "mime_blocked" }),
    );
  });

  it("rejects missing or invalid MIME before consuming the body", async () => {
    for (const contentType of [undefined, "", "not-a-mime"]) {
      const body = new FixtureBody([Buffer.from("never read")]);
      await expect(
        readBoundedBody({
          body,
          contentType,
          profile: "json",
          limits: DEFAULT_BODY_LIMITS,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "mime_blocked" });
      expect(body.yielded).toBe(0);
      expect(body.destroyed).toBe(true);
    }
  });

  it("reports an expired deadline before response header policy", async () => {
    const controller = new AbortController();
    controller.abort();
    const body = new FixtureBody([Buffer.from("never read")]);
    await expect(
      readBoundedBody({
        body,
        contentType: "not-a-mime",
        contentEncoding: "unknown",
        profile: "json",
        limits: DEFAULT_BODY_LIMITS,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "total_timeout" });
    expect(body.yielded).toBe(0);
    expect(body.destroyed).toBe(true);
  });

  it("rejects ambiguous repeated MIME and encoding headers before body consumption", async () => {
    const repeatedMime = new FixtureBody([Buffer.from("never read")]);
    const mimeHarness = serviceHarness({
      responses: [
        transportResponse(200, repeatedMime, {
          "content-type": ["application/json", "text/html"],
        }),
      ],
    });
    await expect(
      mimeHarness.service.fetch({
        url: "https://public.example/data",
        profile: "json",
      }),
    ).rejects.toMatchObject({ code: "mime_blocked" });
    expect(repeatedMime.yielded).toBe(0);

    const repeatedEncoding = new FixtureBody([Buffer.from("never read")]);
    const encodingHarness = serviceHarness({
      responses: [
        transportResponse(200, repeatedEncoding, {
          "content-type": "application/json",
          "content-encoding": ["gzip", "br"],
        }),
      ],
    });
    await expect(
      encodingHarness.service.fetch({
        url: "https://public.example/data",
        profile: "json",
      }),
    ).rejects.toMatchObject({ code: "encoding_blocked" });
    expect(repeatedEncoding.yielded).toBe(0);
  });

  it("safely closes a real Readable when policy rejects before consumption", async () => {
    const body = Readable.from([Buffer.from("never read")]) as TransportBody;
    await expect(
      readBoundedBody({
        body,
        contentType: "text/html",
        profile: "json",
        limits: DEFAULT_BODY_LIMITS,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "mime_blocked" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((body as Readable).destroyed).toBe(true);
  });
});

describe("safe-fetch streaming decoding", () => {
  it.each([
    ["identity", (value: Buffer) => value],
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const)("decodes supported %s content", async (encoding, encode) => {
    const original = Buffer.from('{"safe":true}');
    const { result } = await readFixture(encode(original), {
      contentEncoding: encoding,
    });
    expect(Buffer.from((await result).bytes).toString("utf8")).toBe(
      original.toString("utf8"),
    );
  });

  it.each(["compress", "gzip, br", "identity, gzip"])(
    "rejects unsupported or stacked encoding %s before body consumption",
    async (contentEncoding) => {
      const body = new FixtureBody([Buffer.from("never read")]);
      await expect(
        readBoundedBody({
          body,
          contentType: "application/json",
          contentEncoding,
          profile: "json",
          limits: DEFAULT_BODY_LIMITS,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "encoding_blocked" });
      expect(body.yielded).toBe(0);
      expect(body.destroyed).toBe(true);
    },
  );

  it("stops while streaming when compressed bytes cross the limit", async () => {
    const { body, result } = await readFixture(
      [Buffer.alloc(600, 0x61), Buffer.alloc(600, 0x62), Buffer.alloc(600, 0x63)],
      {
        contentType: "text/plain",
        profile: "website",
        maxCompressedBytes: 1_000,
        maxDecodedBytes: 10_000,
        maxExpansionRatio: 100,
      },
    );
    await expect(result).rejects.toMatchObject({ code: "compressed_limit" });
    expect(body.yielded).toBe(2);
    expect(body.destroyed).toBe(true);
  });

  it("stops while streaming when decoded bytes cross the limit", async () => {
    const { body, result } = await readFixture(
      [Buffer.alloc(600, 0x61), Buffer.alloc(600, 0x62), Buffer.alloc(600, 0x63)],
      {
        contentType: "text/plain",
        profile: "website",
        maxCompressedBytes: 10_000,
        maxDecodedBytes: 1_000,
        maxExpansionRatio: 100,
      },
    );
    await expect(result).rejects.toMatchObject({ code: "decoded_limit" });
    expect(body.yielded).toBe(2);
    expect(body.destroyed).toBe(true);
  });

  it("aborts a gzip bomb when the expansion ratio crosses 20:1", async () => {
    const compressed = gzipSync(Buffer.alloc(256_000, 0x61));
    const { body, result } = await readFixture(compressed, {
      contentEncoding: "gzip",
      maxExpansionRatio: 20,
    });
    await expect(result).rejects.toMatchObject({ code: "decompression_ratio" });
    expect(body.destroyed).toBe(true);
  });

  it("propagates a compressed limit while gzip decoding", async () => {
    const compressed = gzipSync(randomBytes(4_096));
    const { body, result } = await readFixture(
      [
        compressed.subarray(0, 700),
        compressed.subarray(700, 1_400),
        compressed.subarray(1_400),
      ],
      {
        contentEncoding: "gzip",
        maxCompressedBytes: 1_000,
      },
    );
    await expect(result).rejects.toMatchObject({ code: "compressed_limit" });
    expect(body.destroyed).toBe(true);
  });

  it("terminates a hanging gzip body on the total deadline", async () => {
    const controller = new AbortController();
    const compressedPrefix = gzipSync(Buffer.from('{"safe":true}')).subarray(0, 5);
    const body = new FixtureBody([compressedPrefix], true);
    const result = readBoundedBody({
      body,
      contentType: "application/json",
      contentEncoding: "gzip",
      profile: "json",
      limits: DEFAULT_BODY_LIMITS,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: "total_timeout" });
    expect(body.destroyed).toBe(true);
  });

  it("does not miss an abort that races with listener registration", async () => {
    let aborted = false;
    const racingSignal = {
      get aborted() {
        return aborted;
      },
      addEventListener() {
        aborted = true;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    const { body, result } = await readFixture(Buffer.from("{}"), {
      signal: racingSignal,
    });

    await expect(result).rejects.toMatchObject({ code: "total_timeout" });
    expect(body.destroyed).toBe(true);
  });
});

describe("DefaultSafeFetchService resource policy", () => {
  it("honors lower caller body limits", async () => {
    const body = new FixtureBody([Buffer.alloc(1_001, 0x61)]);
    const h = serviceHarness({ responses: [transportResponse(200, body)] });

    await expect(
      h.service.fetch({
        url: "https://public.example/data",
        profile: "json",
        limits: { maxDecodedBytes: 1_000 },
      }),
    ).rejects.toMatchObject({ code: "decoded_limit" });
    expect(body.destroyed).toBe(true);
  });

  it.each([
    ["maxCompressedBytes", 2 * 1024 * 1024 + 1, "compressed_limit"],
    ["maxDecodedBytes", 5 * 1024 * 1024 + 1, "decoded_limit"],
  ] as const)("rejects an attempt to raise %s before transport", async (limit, value, code) => {
    const h = serviceHarness({});
    await expect(
      h.service.fetch({
        url: "https://public.example/data",
        profile: "json",
        limits: { [limit]: value },
      }),
    ).rejects.toMatchObject({ code });
    expect(h.requests).toEqual([]);
  });

  it("destroys non-2xx bodies and returns upstream_status", async () => {
    const body = new FixtureBody([Buffer.from("private upstream details")]);
    const h = serviceHarness({ responses: [transportResponse(503, body)] });

    await expect(
      h.service.fetch({
        url: "https://public.example/data",
        profile: "json",
      }),
    ).rejects.toMatchObject({ code: "upstream_status" });
    expect(body.yielded).toBe(0);
    expect(body.destroyed).toBe(true);
  });

  it("classifies the Undici connect timeout and passes the fixed 5-second bound", async () => {
    const cause = Object.assign(new Error("connect timed out"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const h = serviceHarness({ transportError: cause });

    await expect(
      h.service.fetch({
        url: "https://public.example/data",
        profile: "json",
      }),
    ).rejects.toMatchObject({ code: "connect_timeout" });
    expect(h.requests[0]?.connectTimeoutMs).toBe(5_000);
  });

  it("uses one total deadline across redirects and the final body", async () => {
    const controller = new AbortController();
    const redirectBody = new FixtureBody([]);
    const finalBody = new FixtureBody([], true);
    const h = serviceHarness({
      deadline: {
        signal: controller.signal,
        dispose() {},
      },
      responses: [
        transportResponse(302, redirectBody, {
          location: "https://public.example/final",
        }),
        transportResponse(200, finalBody),
      ],
    });

    const pending = h.service.fetch({
      url: "https://public.example/start",
      profile: "json",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "total_timeout" });
    expect(h.deadlineCalls()).toBe(1);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0]?.signal).toBe(controller.signal);
    expect(h.requests[1]?.signal).toBe(controller.signal);
    expect(redirectBody.destroyed).toBe(true);
    expect(finalBody.destroyed).toBe(true);
  });

  it("actively bounds a DNS lookup with the same total deadline", async () => {
    const controller = new AbortController();
    const h = serviceHarness({
      deadline: {
        signal: controller.signal,
        dispose() {},
      },
      resolver: {
        async resolve() {
          return new Promise(() => {});
        },
      },
    });

    const pending = h.service
      .fetch({
        url: "https://public.example/data",
        profile: "json",
      })
      .catch((error: unknown) => error);
    controller.abort();
    const stillPending = Symbol("still pending");
    const outcome = await Promise.race([
      pending,
      new Promise<typeof stillPending>((resolve) =>
        setTimeout(() => resolve(stillPending), 20),
      ),
    ]);

    expect(outcome).toMatchObject({ code: "total_timeout" });
    expect(h.requests).toEqual([]);
  });
});
