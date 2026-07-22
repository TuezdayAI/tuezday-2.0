import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

/** Stable SHA-256 identity for one exact external side effect. */
export function canonicalActionFingerprint(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  return createHash("sha256").update(json).digest("hex");
}
