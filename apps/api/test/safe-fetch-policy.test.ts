import { describe, expect, it } from "vitest";
import {
  SAFE_FETCH_ERROR_CODES,
  SAFE_FETCH_LIMITS,
  SAFE_FETCH_MIME_TYPES,
  SafeFetchError,
  assertPublicAddress,
  createSafeFetchPolicy,
  safeFetchError,
  safeFetchPublicMessage,
  serializeSafeFetchError,
  toSafeFetchError,
  validateSafeFetchUrl,
} from "../src/safe-fetch";

const HOSTILE_FAILURE_DETAILS = [
  "169.254.169.254",
  "db.internal",
  "https://user:secret@host",
  "<html><body>private response</body></html>",
  "connect ECONNREFUSED 10.0.0.8:5432",
] as const;

describe("safe-fetch failure redaction", () => {
  it.each(SAFE_FETCH_ERROR_CODES)(
    "serializes %s to its exact public-only shape",
    (code) => {
      const cause = new Error(HOSTILE_FAILURE_DETAILS.join(" | "));
      const error = safeFetchError(code, cause);
      const expected = {
        code,
        message: safeFetchPublicMessage(code),
      };

      expect(error.cause).toBe(cause);
      expect(error.message).toBe(expected.message);
      expect(serializeSafeFetchError(error)).toEqual(expected);
      expect(Object.keys(serializeSafeFetchError(error))).toEqual([
        "code",
        "message",
      ]);

      const persistedSafeText = JSON.stringify(serializeSafeFetchError(error));
      for (const detail of HOSTILE_FAILURE_DETAILS) {
        expect(error.message).not.toContain(detail);
        expect(persistedSafeText).not.toContain(detail);
      }
    },
  );

  it("maps an unexpected hostile failure to transport_failed without stringifying it", () => {
    let stringified = false;
    const hostile = {
      url: "https://user:secret@db.internal",
      body: "<html>private response</html>",
      toString() {
        stringified = true;
        return "169.254.169.254";
      },
    };

    const safe = toSafeFetchError(hostile);
    expect(safe).toMatchObject({
      code: "transport_failed",
      message: safeFetchPublicMessage("transport_failed"),
      cause: hostile,
    });
    expect(serializeSafeFetchError(hostile)).toEqual({
      code: "transport_failed",
      message: safeFetchPublicMessage("transport_failed"),
    });
    expect(stringified).toBe(false);
  });

  it("reconstructs an existing failure from its original trusted class", () => {
    const original = safeFetchError(
      "dns_failed",
      new Error("lookup db.internal at 169.254.169.254"),
    );
    Object.defineProperty(original, "message", {
      value: "https://user:secret@db.internal",
    });
    (original as { code: string }).code = "169.254.169.254";

    const reconstructed = toSafeFetchError(original);
    expect(reconstructed).not.toBe(original);
    expect(reconstructed).toMatchObject({
      code: "dns_failed",
      message: safeFetchPublicMessage("dns_failed"),
      cause: original,
    });
  });

  it("does not trust prototype-spoofed or revoked error-like values", () => {
    const spoofed = Object.assign(
      Object.create(SafeFetchError.prototype) as Record<string, unknown>,
      {
        code: "dns_failed",
        message: "lookup db.internal at 169.254.169.254",
      },
    );
    expect(serializeSafeFetchError(spoofed)).toEqual({
      code: "transport_failed",
      message: safeFetchPublicMessage("transport_failed"),
    });

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => toSafeFetchError(proxy)).not.toThrow();
    expect(serializeSafeFetchError(proxy)).toEqual({
      code: "transport_failed",
      message: safeFetchPublicMessage("transport_failed"),
    });
  });
});

describe("createSafeFetchPolicy", () => {
  it("uses the fixed production limits", () => {
    expect(createSafeFetchPolicy({}).limits).toEqual({
      connectTimeoutMs: 5_000,
      totalTimeoutMs: 20_000,
      maxRedirects: 5,
      maxCompressedBytes: 2 * 1024 * 1024,
      maxDecodedBytes: 5 * 1024 * 1024,
      maxExpansionRatio: 20,
    });
    expect(createSafeFetchPolicy({}).limits).toBe(SAFE_FETCH_LIMITS);
  });

  it("defaults HTTP off and enables it only for the literal true value", () => {
    expect(createSafeFetchPolicy({}).allowHttp).toBe(false);
    expect(createSafeFetchPolicy({ TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "true" }).allowHttp).toBe(true);
    expect(createSafeFetchPolicy({ TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "TRUE" }).allowHttp).toBe(false);
    expect(createSafeFetchPolicy({ TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "1" }).allowHttp).toBe(false);
    expect(createSafeFetchPolicy({ TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "garbage" }).allowHttp).toBe(
      false,
    );
  });

  it("defines the approved fixed MIME profiles", () => {
    expect(SAFE_FETCH_MIME_TYPES).toEqual({
      feed: [
        "application/rss+xml",
        "application/atom+xml",
        "application/xml",
        "text/xml",
        "text/plain",
      ],
      json: ["application/json", "text/json"],
      website: ["text/html", "application/xhtml+xml", "text/plain"],
    });
  });
});

describe("validateSafeFetchUrl", () => {
  const securePolicy = createSafeFetchPolicy({});

  it.each([
    ["malformed URL", "not a url", "invalid_url"],
    ["relative URL", "/relative", "invalid_url"],
    ["HTTP by default", "http://example.com", "scheme_blocked"],
    ["file scheme", "file:///etc/passwd", "scheme_blocked"],
    ["FTP scheme", "ftp://example.com/file", "scheme_blocked"],
    ["username", "https://user@example.com", "credentials_blocked"],
    ["password", "https://user:secret@example.com", "credentials_blocked"],
    ["localhost", "https://localhost", "destination_blocked"],
    ["localhost trailing dot", "https://LOCALHOST.", "destination_blocked"],
    ["localhost subdomain", "https://api.localhost", "destination_blocked"],
    ["Google metadata alias", "https://metadata.google.internal/", "destination_blocked"],
    ["EC2 metadata alias", "https://instance-data.ec2.internal/", "destination_blocked"],
    ["Azure metadata alias", "https://metadata.azure.internal/", "destination_blocked"],
    ["IPv4 unspecified", "https://0.0.0.0/", "destination_blocked"],
    ["IPv4 loopback", "https://127.0.0.1/", "destination_blocked"],
    ["IPv4 short loopback", "https://127.1/", "destination_blocked"],
    ["IPv4 private 10/8", "https://10.0.0.1/", "destination_blocked"],
    ["IPv4 private 172.16/12", "https://172.16.0.1/", "destination_blocked"],
    ["IPv4 private 192.168/16", "https://192.168.0.1/", "destination_blocked"],
    ["IPv4 carrier grade NAT", "https://100.64.0.1/", "destination_blocked"],
    ["IPv4 link local", "https://169.254.1.1/", "destination_blocked"],
    ["AWS metadata", "https://169.254.169.254/latest/meta-data", "destination_blocked"],
    ["Azure platform address", "https://168.63.129.16/", "destination_blocked"],
    ["IPv4 documentation", "https://192.0.2.1/", "destination_blocked"],
    ["IPv4 benchmarking", "https://198.18.0.1/", "destination_blocked"],
    ["IPv4 multicast", "https://224.0.0.1/", "destination_blocked"],
    ["IPv4 reserved", "https://240.0.0.1/", "destination_blocked"],
    ["IPv4 broadcast", "https://255.255.255.255/", "destination_blocked"],
    ["IPv6 unspecified", "https://[::]/", "destination_blocked"],
    ["IPv6 loopback", "https://[::1]/", "destination_blocked"],
    ["IPv6 unique local", "https://[fc00::1]/", "destination_blocked"],
    ["IPv6 link local", "https://[fe80::1]/", "destination_blocked"],
    ["IPv6 multicast", "https://[ff00::1]/", "destination_blocked"],
    ["IPv6 documentation", "https://[2001:db8::1]/", "destination_blocked"],
    ["IPv4-mapped private IPv6", "https://[::ffff:10.0.0.1]/", "destination_blocked"],
    ["IPv4-mapped metadata IPv6", "https://[::ffff:169.254.169.254]/", "destination_blocked"],
  ])("rejects %s", (_label, url, code) => {
    try {
      validateSafeFetchUrl(url, securePolicy);
      throw new Error("expected URL validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SafeFetchError);
      expect(error).toMatchObject({ code });
    }
  });

  it.each([
    "https://example.com/path?query=yes#fragment",
    "https://8.8.8.8/",
    "https://[2606:4700:4700::1111]/",
  ])("accepts public HTTPS URL %s", (url) => {
    expect(validateSafeFetchUrl(url, securePolicy)).toBeInstanceOf(URL);
  });

  it("accepts public HTTP only under operator policy", () => {
    const httpPolicy = createSafeFetchPolicy({ TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "true" });
    expect(validateSafeFetchUrl("http://example.com/path", httpPolicy).protocol).toBe("http:");
  });
});

describe("assertPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "168.63.129.16",
    "169.254.169.254",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
    "2001:db8::1",
    "::ffff:192.168.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(() => assertPublicAddress(address)).toThrow(
      expect.objectContaining({ code: "destination_blocked" }),
    );
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "accepts public unicast address %s",
    (address) => {
      expect(() => assertPublicAddress(address)).not.toThrow();
    },
  );

  it("classifies malformed resolver output as a DNS failure", () => {
    expect(() => assertPublicAddress("definitely-not-an-address")).toThrow(
      expect.objectContaining({ code: "dns_failed" }),
    );
  });
});
