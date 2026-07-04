import type { DocOutline, DocOutlineSection } from "@tuezday/contracts";
import { estimateTokens } from "./tokens";

// ---------------------------------------------------------------------------
// Section parsing (Sprint 43) — the "map" in map-then-zoom.
//
// Brain docs are heading-structured markdown. A doc splits into sections at H2
// and H3 boundaries (outside fenced code blocks); content before the first H2
// is a preamble section. Section IDs are slugified heading paths — stable
// across edits that don't rename headings, human-readable in the trace.
// ---------------------------------------------------------------------------

export const PREAMBLE_ID = "(preamble)";

export interface DocSection {
  /** Stable slug path, e.g. "operating-principles/brain-first". */
  id: string;
  /** Parent H2's id for an H3 section; null for top-level sections. */
  parentId: string | null;
  heading: string;
  level: 2 | 3;
  /** Section text including its own heading line — what zoom injects verbatim. */
  body: string;
  tokens: number;
}

export function slugifyHeading(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/**
 * Split markdown into H2/H3 sections. Heading markers inside fenced code
 * blocks are ignored. A doc with no headings parses to a single preamble
 * section. Duplicate slugs get -2, -3… suffixes in document order.
 */
export function parseDocSections(content: string): DocSection[] {
  const text = content.trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const raw: { heading: string; level: 2 | 3; lines: string[] }[] = [];
  let current: { heading: string; level: 2 | 3; lines: string[] } = {
    heading: PREAMBLE_ID,
    level: 2,
    lines: [],
  };
  let inFence = false;

  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    const match = inFence ? null : /^(##|###)\s+(.+?)\s*$/.exec(line);
    if (match) {
      raw.push(current);
      current = { heading: match[2]!, level: match[1] === "##" ? 2 : 3, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  raw.push(current);

  const sections: DocSection[] = [];
  const usedIds = new Set<string>();
  let currentH2Id: string | null = null;

  for (const part of raw) {
    const body = part.lines.join("\n").trim();
    if (!body) continue; // skip the empty preamble and heading-only artifacts
    const isPreamble = part.heading === PREAMBLE_ID && sections.length === 0 && part.level === 2;
    const baseSlug = isPreamble ? PREAMBLE_ID : slugifyHeading(part.heading);
    const parentId: string | null = !isPreamble && part.level === 3 ? currentH2Id : null;
    const pathSlug: string = parentId ? `${parentId}/${baseSlug}` : baseSlug;
    let id: string = pathSlug;
    for (let n = 2; usedIds.has(id); n++) id = `${pathSlug}-${n}`;
    usedIds.add(id);
    if (part.level === 2) currentH2Id = id;
    sections.push({
      id,
      parentId,
      heading: part.heading,
      level: part.level,
      body,
      tokens: estimateTokens(body),
    });
  }

  return sections;
}

/**
 * Deterministic fallback summary: the first sentence of the section body
 * (heading line skipped), hard-truncated.
 */
export function firstSentenceSummary(body: string, max = 160): string {
  const withoutHeading = body.replace(/^(##|###)\s+.+$/m, "").trim();
  const flattened = withoutHeading
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*>]\s+/, "").trim())
    .filter(Boolean)
    .join(" ");
  if (!flattened) return "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(flattened)?.[0] ?? flattened;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

/** Build a fully-deterministic outline (fallback summaries) from doc content. */
export function buildFallbackOutline(content: string, generatedAt: number): DocOutline | null {
  const sections = parseDocSections(content);
  if (sections.length === 0) return null;
  return {
    generatedAt,
    sections: sections.map((s) => ({
      id: s.id,
      parentId: s.parentId,
      heading: s.heading,
      level: s.level,
      summary: firstSentenceSummary(s.body),
      summarySource: "fallback" as const,
      tokens: s.tokens,
    })),
  };
}

/**
 * Render an outline as the doc's in-prompt "map": heading bullets with
 * one-line summaries, H3s indented under their H2.
 */
export function renderOutline(outline: DocOutline): string {
  return outline.sections
    .map((s: DocOutlineSection) => {
      const indent = s.level === 3 ? "  " : "";
      const label = s.heading === PREAMBLE_ID ? "(intro)" : s.heading;
      return `${indent}- ${label}${s.summary ? ` — ${s.summary}` : ""}`;
    })
    .join("\n");
}
