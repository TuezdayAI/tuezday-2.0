import ipaddr from "ipaddr.js";
import { isIP } from "node:net";
import { safeFetchError } from "./errors";
import type { SafeFetchPolicy } from "./policy";

const BLOCKED_HOSTNAMES = [
  "metadata.google.internal",
  "metadata.google",
  "instance-data.ec2.internal",
  "metadata.azure.internal",
] as const;

const BLOCKED_PLATFORM_ADDRESSES = new Set([
  "100.100.100.200",
  "168.63.129.16",
  "169.254.169.254",
  "169.254.170.2",
]);

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function normalizeHostname(hostname: string): string {
  return hostnameWithoutBrackets(hostname).toLowerCase().replace(/\.+$/, "");
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return BLOCKED_HOSTNAMES.some(
    (blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`),
  );
}

export function assertPublicAddress(address: string): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.process(hostnameWithoutBrackets(address));
  } catch (cause) {
    throw safeFetchError("dns_failed", cause);
  }

  const normalized = parsed.toString();
  if (parsed.range() !== "unicast" || BLOCKED_PLATFORM_ADDRESSES.has(normalized)) {
    throw safeFetchError("destination_blocked");
  }
}

export function validateSafeFetchUrl(input: string, policy: SafeFetchPolicy): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw safeFetchError("invalid_url", cause);
  }

  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    throw safeFetchError("scheme_blocked");
  }
  if (url.username || url.password) {
    throw safeFetchError("credentials_blocked");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw safeFetchError("invalid_url");
  if (isBlockedHostname(hostname)) throw safeFetchError("destination_blocked");
  if (isIP(hostname)) assertPublicAddress(hostname);

  return url;
}
