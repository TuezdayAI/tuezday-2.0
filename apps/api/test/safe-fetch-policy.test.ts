import { describe, expect, it } from "vitest";
import {
  SAFE_FETCH_LIMITS,
  SAFE_FETCH_MIME_TYPES,
  SafeFetchError,
  assertPublicAddress,
  createSafeFetchPolicy,
  validateSafeFetchUrl,
} from "../src/safe-fetch";

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
