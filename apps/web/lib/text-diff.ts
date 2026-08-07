// ---------------------------------------------------------------------------
// A word-level diff for the draft card's inline edit (Sprint 77).
//
// The PRD asks for a diff card. This is what one needs to be honest: before a
// founder saves an edit from inside a conversation, they should see exactly
// what they are changing — the edit box is small, the draft may be long, and
// "I thought I only fixed the typo" is how a paragraph goes missing.
//
// Word-level rather than character-level because the unit of a GTM edit is a
// word, and a character diff of prose renders as noise.
// ---------------------------------------------------------------------------

export type DiffOp = "equal" | "insert" | "delete";

export interface DiffSpan {
  op: DiffOp;
  text: string;
}

/** Split into words while KEEPING the whitespace, so a rebuild is lossless. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token.length > 0);
}

/**
 * Longest common subsequence over tokens. O(n·m) in both time and space, which
 * is fine for a draft: the caller caps at `MAX_TOKENS` and falls back to a
 * whole-block replace beyond it, because a diff nobody can read is not worth
 * a second of main-thread time.
 */
const MAX_TOKENS = 2_000;

export function diffWords(before: string, after: string): DiffSpan[] {
  if (before === after) return before ? [{ op: "equal", text: before }] : [];

  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    const out: DiffSpan[] = [];
    if (before) out.push({ op: "delete", text: before });
    if (after) out.push({ op: "insert", text: after });
    return out;
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const spans: DiffSpan[] = [];
  const push = (op: DiffOp, text: string) => {
    const last = spans[spans.length - 1];
    // Runs are merged so the rendered diff is a handful of spans, not one per
    // word — which is both faster to render and far easier to read.
    if (last && last.op === op) last.text += text;
    else spans.push({ op, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("equal", a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push("delete", a[i]!);
      i++;
    } else {
      push("insert", b[j]!);
      j++;
    }
  }
  while (i < a.length) push("delete", a[i++]!);
  while (j < b.length) push("insert", b[j++]!);

  return spans;
}

/** Whether an edit changed anything at all — the Save button's enabled state. */
export function hasChanges(before: string, after: string): boolean {
  return before.trim() !== after.trim();
}

/** "3 words added, 1 removed" — the summary above the diff. */
export function describeDiff(spans: DiffSpan[]): string {
  const count = (op: DiffOp) =>
    spans
      .filter((s) => s.op === op)
      .reduce((total, s) => total + s.text.split(/\s+/).filter(Boolean).length, 0);
  const added = count("insert");
  const removed = count("delete");
  if (added === 0 && removed === 0) return "No changes.";
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} word${added === 1 ? "" : "s"} added`);
  if (removed > 0) parts.push(`${removed} removed`);
  return `${parts.join(", ")}.`;
}
