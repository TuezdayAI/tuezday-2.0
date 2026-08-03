import { createHash } from "node:crypto";

// Sprint 45's dedupe normalizers, extracted in Sprint 60 so the canonical
// story layer shares them without importing the whole discovery service.

const TRACKING_PARAM = /^(utm_[^=]*|fbclid|gclid|ref)(=|$)/;

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash of the normalized URL: protocol, `www.`, fragment, trailing slash and
 * known tracking params (`utm_*`, `fbclid`, `gclid`, `ref`) stripped. Null
 * when the item has no URL.
 */
export function hashUrl(url: string): string | null {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return null;
  let u = trimmed.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const fragmentAt = u.indexOf("#");
  if (fragmentAt !== -1) u = u.slice(0, fragmentAt);
  const queryAt = u.indexOf("?");
  let path = queryAt === -1 ? u : u.slice(0, queryAt);
  path = path.replace(/\/+$/, "");
  const params =
    queryAt === -1
      ? []
      : u
          .slice(queryAt + 1)
          .split("&")
          .filter((p) => p && !TRACKING_PARAM.test(p));
  return sha256(params.length > 0 ? `${path}?${params.join("&")}` : path);
}

/** Hash of the whitespace/case-normalized title + first 300 chars of summary. */
export function hashContent(title: string, summary: string): string {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return sha256(`${normalize(title)}\n${normalize(summary.slice(0, 300))}`);
}
