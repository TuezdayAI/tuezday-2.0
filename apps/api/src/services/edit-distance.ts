// Sprint 65 (D-65.10): the "how much did the founder have to fix it" metric.
// Plain two-row Levenshtein — no dependency, inputs capped so a pathological
// blob can't stall a comparison read.

const MAX_COMPARED_CHARS = 20_000;

export function levenshtein(a: string, b: string): number {
  const s = a.slice(0, MAX_COMPARED_CHARS);
  const t = b.slice(0, MAX_COMPARED_CHARS);
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let previous = Array.from({ length: t.length + 1 }, (_, i) => i);
  let current = new Array<number>(t.length + 1);
  for (let i = 1; i <= s.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const substitution = previous[j - 1]! + (s[i - 1] === t[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[t.length]!;
}

/** Normalized distance on a 0–100 scale: 0 = untouched, 100 = fully rewritten. */
export function normalizedEditDistance(a: string, b: string): number {
  const max = Math.max(a.length, b.length, 1);
  return Math.round((100 * levenshtein(a, b)) / Math.min(max, MAX_COMPARED_CHARS) * 10) / 10;
}
