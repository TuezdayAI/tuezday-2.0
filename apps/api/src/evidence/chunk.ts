// Deterministic chunking for the native evidence store (Sprint 47). Owning
// the store means owning chunking; determinism matters because re-ingesting
// the same document must produce identical chunks (migration idempotency,
// stable citations).

export const CHUNK_MAX_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 150;

/** Split one oversized paragraph on sentence boundaries where possible,
 * falling back to hard cuts, with overlap carried between pieces. */
function splitLongBlock(block: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < block.length) {
    let end = Math.min(start + CHUNK_MAX_CHARS, block.length);
    if (end < block.length) {
      // Prefer the last sentence boundary inside the window; fall back to the
      // last space; hard-cut only when neither exists.
      const window = block.slice(start, end);
      const sentence = window.search(/[.!?]\s[^.!?]*$/);
      if (sentence > CHUNK_MAX_CHARS / 3) end = start + sentence + 1;
      else {
        const space = window.lastIndexOf(" ");
        if (space > CHUNK_MAX_CHARS / 3) end = start + space;
      }
    }
    pieces.push(block.slice(start, end).trim());
    if (end >= block.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
  return pieces.filter(Boolean);
}

/**
 * Split document content into chunks of at most CHUNK_MAX_CHARS: paragraphs
 * (blank-line blocks) are packed together while they fit; oversized blocks are
 * sentence-split; adjacent chunks share ~CHUNK_OVERLAP_CHARS of context.
 */
export function chunkText(content: string): string[] {
  const blocks = content
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .flatMap((b) => (b.length > CHUNK_MAX_CHARS ? splitLongBlock(b) : [b]));

  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > CHUNK_MAX_CHARS) {
      chunks.push(current);
      // Carry a tail of the finished chunk as overlap into the next one.
      const overlap = current.slice(-CHUNK_OVERLAP_CHARS);
      const boundary = overlap.indexOf(" ");
      current = boundary === -1 ? overlap : overlap.slice(boundary + 1);
    }
    current = current ? `${current}\n\n${block}` : block;
    // Packing overlap + a near-max block can overshoot; split the remainder.
    while (current.length > CHUNK_MAX_CHARS) {
      const [head, ...rest] = splitLongBlock(current);
      chunks.push(head!);
      current = rest.join("\n\n");
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [content.trim()].filter(Boolean);
}
