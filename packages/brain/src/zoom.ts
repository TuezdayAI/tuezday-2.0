import type { BrainDocType } from "@tuezday/contracts";
import type { DocSection } from "./sections";
import type {
  ResolveAccount,
  ResolveCampaign,
  ResolveConversation,
  ResolveLead,
  ResolveMediaContact,
  ResolvePersona,
  ResolveSignal,
} from "./resolver";

// ---------------------------------------------------------------------------
// Zoom (Sprint 43, Tier 3) — lexical BM25 over doc sections, in-process.
//
// Deliberately dependency-free and deterministic: no embeddings, no vector
// store, no stemming. At brain-doc corpus sizes (tens of sections), BM25 is
// sufficient; embeddings are a logged deferred improvement with a trigger
// ("lexical recall measurably fails").
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "how", "in", "is", "it", "its", "not", "of", "on", "or", "our",
  "should", "that", "the", "their", "them", "they", "this", "to", "was", "we",
  "were", "what", "when", "which", "who", "why", "will", "with", "you", "your",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Compose the Tier-3 retrieval query from everything the task descriptor
 * already knows before drafting. Deterministic; shown verbatim in the trace.
 */
export function composeZoomQuery(input: {
  taskType: string;
  channel: string;
  persona?: ResolvePersona;
  account?: ResolveAccount;
  campaign?: ResolveCampaign;
  signal?: ResolveSignal;
  lead?: ResolveLead;
  mediaContact?: ResolveMediaContact;
  conversation?: ResolveConversation;
  angle?: string;
}): string {
  const parts: string[] = [input.taskType.replace(/_/g, " "), input.channel];
  // Sprint 44: persona/account topics describe what this voice covers —
  // exactly the query material Tier 3 needs.
  if (input.persona?.topics?.length) parts.push(input.persona.topics.join(" "));
  if (input.account?.topics?.length) parts.push(input.account.topics.join(" "));
  if (input.campaign) {
    parts.push(input.campaign.name);
    if (input.campaign.objective?.trim()) parts.push(input.campaign.objective.trim());
    if (input.campaign.pillars?.length) parts.push(input.campaign.pillars.join(" "));
  }
  if (input.signal) parts.push(input.signal.content);
  if (input.lead) {
    parts.push(
      [input.lead.name, input.lead.company, input.lead.role, input.lead.notes]
        .filter((s) => s.trim())
        .join(" "),
    );
  }
  if (input.mediaContact) {
    parts.push(
      [input.mediaContact.outlet, input.mediaContact.beat, input.mediaContact.coverageNotes]
        .filter((s) => s.trim())
        .join(" "),
    );
  }
  if (input.conversation) parts.push(input.conversation.inboundMessage);
  if (input.angle?.trim()) parts.push(input.angle.trim());
  return parts.filter((p) => p.trim()).join("\n");
}

export interface ZoomCandidate {
  docType: BrainDocType;
  section: DocSection;
}

export interface RankedSection extends ZoomCandidate {
  /** BM25 score against the composed query (> 0: at least one term matched). */
  score: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25-rank candidate sections against the query. All candidates form one
 * corpus (shared IDF across docs). Returns only positive-scoring sections,
 * descending score; ties break by candidate (document) order.
 */
export function rankSections(query: string, candidates: ZoomCandidate[]): RankedSection[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || candidates.length === 0) return [];

  const docs = candidates.map((c) => tokenize(c.section.body));
  const docLengths = docs.map((d) => d.length);
  const avgLength = docLengths.reduce((a, b) => a + b, 0) / docs.length || 1;

  const termFreqs = docs.map((tokens) => {
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    return freq;
  });
  const docFreq = new Map<string, number>();
  for (const term of queryTerms) {
    docFreq.set(term, termFreqs.filter((f) => f.has(term)).length);
  }

  const n = docs.length;
  const scored = candidates.map((candidate, i) => {
    let score = 0;
    for (const term of queryTerms) {
      const df = docFreq.get(term)!;
      if (df === 0) continue;
      const tf = termFreqs[i]!.get(term) ?? 0;
      if (tf === 0) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const denom = tf + K1 * (1 - B + (B * docLengths[i]!) / avgLength);
      score += idf * ((tf * (K1 + 1)) / denom);
    }
    return { ...candidate, score, index: i };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ index: _index, ...rest }) => rest);
}
