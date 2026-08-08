import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  DefaultSafeFetchService,
  UndiciSafeFetchTransport,
  createSafeFetchService,
  createSafeFetchPolicy,
  type PinnedRequest,
  type ResolvedAddress,
  type SafeFetchResolver,
  type SafeFetchTransport,
  type TransportBody,
  type TransportResponse,
} from "../src/safe-fetch";

class FixtureBody implements TransportBody {
  destroyed = false;

  constructor(private readonly chunks: Uint8Array[] = []) {}

  destroy(): void {
    this.destroyed = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (const chunk of this.chunks) {
      if (this.destroyed) return;
      yield chunk;
    }
  }
}

function response(
  status: number,
  headers: TransportResponse["headers"] = { "content-type": "text/plain" },
  text = "",
): TransportResponse & { body: FixtureBody } {
  return {
    status,
    headers,
    body: new FixtureBody([Buffer.from(text)]),
  };
}

function routingHarness(options: {
  answers?: Record<string, ResolvedAddress[]>;
  responses?: TransportResponse[];
  resolverError?: Error;
  allowHttp?: boolean;
}) {
  const resolved: string[] = [];
  const requests: PinnedRequest[] = [];
  const queue = [...(options.responses ?? [response(200, undefined, "ok")])];
  const resolver: SafeFetchResolver = {
    async resolve(hostname) {
      resolved.push(hostname);
      if (options.resolverError) throw options.resolverError;
      return options.answers?.[hostname] ?? [];
    },
  };
  const transport: SafeFetchTransport = {
    async request(input) {
      requests.push(input);
      const next = queue.shift();
      if (!next) throw new Error("fixture response queue exhausted");
      return next;
    },
  };
  const policy = createSafeFetchPolicy(
    options.allowHttp ? { TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "true" } : {},
  );
  return {
    service: new DefaultSafeFetchService(policy, resolver, transport),
    requests,
    resolved,
  };
}

describe("DefaultSafeFetchService DNS pinning", () => {
  it("pins the transport to the validated public address", async () => {
    const h = routingHarness({
      answers: {
        "public.example": [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
        ],
      },
    });

    const result = await h.service.fetch({
      url: "https://public.example/feed",
      profile: "feed",
      headers: { "user-agent": "tuezday-test" },
    });

    expect(result.text()).toBe("ok");
    expect(h.resolved).toEqual(["public.example"]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      url: new URL("https://public.example/feed"),
      address: { address: "93.184.216.34", family: 4 },
      headers: { "user-agent": "tuezday-test" },
      connectTimeoutMs: 5_000,
    });
  });

  it("rejects an empty DNS answer before transport", async () => {
    const h = routingHarness({ answers: { "empty.example": [] } });
    await expect(
      h.service.fetch({ url: "https://empty.example", profile: "website" }),
    ).rejects.toMatchObject({ code: "dns_failed" });
    expect(h.requests).toEqual([]);
  });

  it("rejects resolver failures without exposing the raw failure", async () => {
    const h = routingHarness({ resolverError: new Error("lookup db.internal 10.0.0.1") });
    await expect(
      h.service.fetch({ url: "https://broken.example", profile: "website" }),
    ).rejects.toMatchObject({
      code: "dns_failed",
      message: "The destination could not be resolved safely.",
    });
    expect(h.requests).toEqual([]);
  });

  it("rejects malformed resolver output before transport", async () => {
    const h = routingHarness({
      answers: { "malformed.example": [{ address: "not-an-ip", family: 4 }] },
    });
    await expect(
      h.service.fetch({ url: "https://malformed.example", profile: "website" }),
    ).rejects.toMatchObject({ code: "dns_failed" });
    expect(h.requests).toEqual([]);
  });

  it.each([null, undefined, "1.1.1.1", { family: 4 }, { address: "1.1.1.1", family: 0 }])(
    "rejects a malformed resolver entry %j before transport",
    async (entry) => {
      const h = routingHarness({
        answers: {
          "malformed.example": [entry] as unknown as ResolvedAddress[],
        },
      });
      await expect(
        h.service.fetch({ url: "https://malformed.example", profile: "website" }),
      ).rejects.toMatchObject({ code: "dns_failed" });
      expect(h.requests).toEqual([]);
    },
  );

  it("rejects a private-only DNS answer before transport", async () => {
    const h = routingHarness({
      answers: { "private.example": [{ address: "10.0.0.8", family: 4 }] },
    });
    await expect(
      h.service.fetch({ url: "https://private.example", profile: "website" }),
    ).rejects.toMatchObject({ code: "destination_blocked" });
    expect(h.requests).toEqual([]);
  });

  it("rejects the whole answer set when public and private addresses are mixed", async () => {
    const h = routingHarness({
      answers: {
        "mixed.example": [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.7", family: 4 },
        ],
      },
    });
    await expect(
      h.service.fetch({ url: "https://mixed.example", profile: "website" }),
    ).rejects.toMatchObject({ code: "destination_blocked" });
    expect(h.requests).toEqual([]);
  });

  it("uses a validated literal directly instead of resolving it again", async () => {
    const h = routingHarness({});
    await h.service.fetch({ url: "https://8.8.8.8/dns", profile: "website" });
    expect(h.resolved).toEqual([]);
    expect(h.requests[0]?.address).toEqual({ address: "8.8.8.8", family: 4 });
  });
});

describe("DefaultSafeFetchService redirects", () => {
  it("resolves relative locations and revalidates and repins every hop", async () => {
    const first = response(302, { location: "https://second.example/next" });
    const second = response(301, { location: "/final" });
    const final = response(200, { "content-type": "text/plain" }, "finished");
    const h = routingHarness({
      answers: {
        "first.example": [{ address: "93.184.216.34", family: 4 }],
        "second.example": [{ address: "1.1.1.1", family: 4 }],
      },
      responses: [first, second, final],
    });

    const result = await h.service.fetch({
      url: "https://first.example/start",
      profile: "website",
    });

    expect(result.finalUrl).toBe("https://second.example/final");
    expect(result.text()).toBe("finished");
    expect(h.resolved).toEqual(["first.example", "second.example", "second.example"]);
    expect(h.requests.map((request) => request.address.address)).toEqual([
      "93.184.216.34",
      "1.1.1.1",
      "1.1.1.1",
    ]);
    expect(first.body.destroyed).toBe(true);
    expect(second.body.destroyed).toBe(true);
  });

  it("blocks a redirect to a private DNS answer before the second request", async () => {
    const redirect = response(302, { location: "https://private.example/admin" });
    const h = routingHarness({
      answers: {
        "public.example": [{ address: "93.184.216.34", family: 4 }],
        "private.example": [{ address: "192.168.1.5", family: 4 }],
      },
      responses: [redirect],
    });

    await expect(
      h.service.fetch({ url: "https://public.example", profile: "website" }),
    ).rejects.toMatchObject({ code: "destination_blocked" });
    expect(h.requests).toHaveLength(1);
    expect(redirect.body.destroyed).toBe(true);
  });

  it("classifies a blocked protocol downgrade as a redirect failure", async () => {
    const blocked = routingHarness({
      answers: { "public.example": [{ address: "93.184.216.34", family: 4 }] },
      responses: [response(302, { location: "http://public.example/insecure" })],
    });
    await expect(
      blocked.service.fetch({ url: "https://public.example", profile: "website" }),
    ).rejects.toMatchObject({ code: "redirect_blocked" });
    expect(blocked.requests).toHaveLength(1);

    const allowed = routingHarness({
      allowHttp: true,
      answers: { "public.example": [{ address: "93.184.216.34", family: 4 }] },
      responses: [
        response(302, { location: "http://public.example/insecure" }),
        response(200, { "content-type": "text/plain" }, "allowed"),
      ],
    });
    const result = await allowed.service.fetch({
      url: "https://public.example",
      profile: "website",
    });
    expect(result.finalUrl).toBe("http://public.example/insecure");
    expect(result.text()).toBe("allowed");
  });

  it.each([
    ["embedded credentials", "https://user:secret@public.example/private"],
    ["localhost", "https://localhost/admin"],
    ["private literal", "https://127.0.0.1/admin"],
    ["metadata literal", "https://169.254.169.254/latest/meta-data"],
  ])("classifies redirect policy rejection for %s", async (_label, location) => {
    const redirect = response(302, { location });
    const h = routingHarness({
      answers: { "public.example": [{ address: "93.184.216.34", family: 4 }] },
      responses: [redirect],
    });
    await expect(
      h.service.fetch({ url: "https://public.example", profile: "website" }),
    ).rejects.toMatchObject({ code: "redirect_blocked" });
    expect(h.requests).toHaveLength(1);
    expect(redirect.body.destroyed).toBe(true);
  });

  it("rejects a malformed redirect target", async () => {
    const redirect = response(302, { location: "http://[" });
    const h = routingHarness({
      answers: { "public.example": [{ address: "93.184.216.34", family: 4 }] },
      responses: [redirect],
    });
    await expect(
      h.service.fetch({ url: "https://public.example", profile: "website" }),
    ).rejects.toMatchObject({ code: "redirect_blocked" });
    expect(h.requests).toHaveLength(1);
    expect(redirect.body.destroyed).toBe(true);
  });

  it("rejects a redirect with no usable Location", async () => {
    const missing = response(302);
    const h = routingHarness({
      answers: { "public.example": [{ address: "93.184.216.34", family: 4 }] },
      responses: [missing],
    });
    await expect(
      h.service.fetch({ url: "https://public.example", profile: "website" }),
    ).rejects.toMatchObject({ code: "redirect_blocked" });
    expect(missing.body.destroyed).toBe(true);
  });

  it("stops redirect loops at the fixed limit", async () => {
    const redirects = Array.from({ length: 6 }, () =>
      response(302, { location: "/loop" }),
    );
    const h = routingHarness({
      answers: { "public.example": [{ address: "93.184.216.34", family: 4 }] },
      responses: redirects,
    });
    await expect(
      h.service.fetch({ url: "https://public.example/loop", profile: "website" }),
    ).rejects.toMatchObject({ code: "redirect_limit" });
    expect(h.requests).toHaveLength(6);
    expect(redirects.every((item) => item.body.destroyed)).toBe(true);
  });
});

describe("DefaultSafeFetchService request headers", () => {
  it.each([
    "host",
    "Host",
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "connection",
    "transfer-encoding",
    "upgrade",
  ])("rejects unsafe header %s before DNS or transport", async (header) => {
    const h = routingHarness({
      answers: { "public.example": [{ address: "93.184.216.34", family: 4 }] },
    });
    await expect(
      h.service.fetch({
        url: "https://public.example",
        profile: "website",
        headers: { [header]: "unsafe" },
      }),
    ).rejects.toMatchObject({ code: "credentials_blocked" });
    expect(h.resolved).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it("rejects headers outside the benign allowlist and newline values", async () => {
    const disallowed = routingHarness({});
    await expect(
      disallowed.service.fetch({
        url: "https://public.example",
        profile: "website",
        headers: { "x-forwarded-host": "internal.example" },
      }),
    ).rejects.toMatchObject({ code: "credentials_blocked" });

    const newline = routingHarness({});
    await expect(
      newline.service.fetch({
        url: "https://public.example",
        profile: "website",
        headers: { accept: "text/html\r\nhost: internal.example" },
      }),
    ).rejects.toMatchObject({ code: "credentials_blocked" });
  });
});

describe("createSafeFetchService", () => {
  it("constructs the production service from operator policy", () => {
    const service = createSafeFetchService(createSafeFetchPolicy({}));
    expect(service).toBeInstanceOf(DefaultSafeFetchService);
    expect(service.validateUrl("https://example.com")).toBeInstanceOf(URL);
  });
});

describe("UndiciSafeFetchTransport", () => {
  it("connects to the pinned address while preserving the URL hostname", async () => {
    let server: Server | undefined;
    try {
      server = createServer((request, reply) => {
        expect(request.headers.host).toMatch(/^does-not-resolve\.invalid:/);
        reply.writeHead(200, { "content-type": "text/plain" });
        reply.end("pinned");
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server port");

      const transport = new UndiciSafeFetchTransport();
      const response = await transport.request({
        url: new URL(`http://does-not-resolve.invalid:${address.port}/`),
        address: { address: "127.0.0.1", family: 4 },
        headers: {},
        signal: new AbortController().signal,
        connectTimeoutMs: 1_000,
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body) chunks.push(chunk);

      expect(Buffer.concat(chunks).toString("utf8")).toBe("pinned");
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});
