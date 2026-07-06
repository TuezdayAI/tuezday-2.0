import { BRAIN_DOC_TYPES, type BrainDocType } from "@tuezday/contracts";

export * from "./resolver";
export * from "./sections";
export * from "./zoom";

// ---------------------------------------------------------------------------
// Doc metadata — canonical order, display titles, descriptions
// ---------------------------------------------------------------------------

export interface BrainDocMeta {
  docType: BrainDocType;
  title: string;
  description: string;
}

export const BRAIN_DOC_META: readonly BrainDocMeta[] = [
  {
    docType: "soul",
    title: "Soul",
    description: "Why the company exists, what it believes, and what it refuses to be.",
  },
  {
    docType: "icp",
    title: "ICP",
    description: "Who we sell to: segments, pains, triggers, and who we are not for.",
  },
  {
    docType: "voice",
    title: "Voice",
    description: "How we sound: tone, vocabulary, style rules, words we never use.",
  },
  {
    docType: "history",
    title: "History",
    description: "What happened: launches, lessons, what worked and what failed.",
  },
  {
    docType: "now",
    title: "Now",
    description: "What matters this week: current push, live campaigns, fresh learnings.",
  },
] as const;

/** Content of all five docs, keyed by doc type. */
export type BrainContents = Record<BrainDocType, string>;

// ---------------------------------------------------------------------------
// Completeness scoring
// ---------------------------------------------------------------------------

/** A doc with at least this many words counts as complete. */
export const COMPLETE_WORD_THRESHOLD = 40;

export type DocStatus = "empty" | "draft" | "complete";

export interface DocScore {
  words: number;
  status: DocStatus;
}

export interface BrainDocScore extends DocScore {
  docType: BrainDocType;
}

export interface BrainScore {
  percent: number;
  docs: BrainDocScore[];
}

export function scoreDoc(content: string): DocScore {
  // Count only tokens with at least one letter or digit, so markdown
  // punctuation (#, -, >, ---) doesn't inflate the score.
  const words = content
    .trim()
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  const status: DocStatus =
    words === 0 ? "empty" : words >= COMPLETE_WORD_THRESHOLD ? "complete" : "draft";
  return { words, status };
}

const STATUS_WEIGHT: Record<DocStatus, number> = { empty: 0, draft: 0.5, complete: 1 };

export function scoreBrain(contents: BrainContents): BrainScore {
  const docs = BRAIN_DOC_TYPES.map((docType) => ({ docType, ...scoreDoc(contents[docType]) }));
  const weight = docs.reduce((sum, d) => sum + STATUS_WEIGHT[d.status], 0);
  return { percent: Math.round((weight / BRAIN_DOC_TYPES.length) * 100), docs };
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

export function renderBrainMarkdown(workspaceName: string, contents: BrainContents): string {
  const sections = BRAIN_DOC_META.map((meta) => {
    const body = contents[meta.docType].trim();
    return [`## ${meta.title}`, "", `> ${meta.description}`, "", body || "_Not written yet._"].join(
      "\n",
    );
  });

  return [`# ${workspaceName} — GTM Brain`, "", ...sections.join("\n\n---\n\n").split("\n"), ""].join(
    "\n",
  );
}
