import {
  EVAL_MAX_BODY_CHARS,
  EVAL_MIN_BODY_CHARS,
  type Channel,
  type CtaExpectation,
  type EvalCheckResult,
} from "@tuezday/contracts";

/**
 * The deterministic half of the harness (D-67.4). Pure functions, no DB, no
 * gateway, no network — which is exactly why these are the checks allowed to
 * block a merge: CI can compute them.
 *
 * Every check returns a result even when it does not apply, with status
 * `skipped` and a reason. A check that silently vanishes from the report is
 * indistinguishable from a check that passed.
 */

export interface HardCheckInput {
  content: string;
  channel: Channel;
  /** Phrases from `workspace_banned_claims`. Empty ⇒ the check is skipped. */
  bannedClaims: string[];
  ctaExpectation: CtaExpectation;
  /** Citations the critique step attached to its findings (Sprint 66). */
  citations: string[];
  /** Everything the run actually retrieved: step prompts, tool results, injected context. */
  corpus: string;
}

/** Phrases that read as a call to action across the channels we publish to. */
const CTA_PHRASES = [
  "learn more",
  "read more",
  "sign up",
  "signup",
  "get started",
  "book a",
  "check out",
  "join us",
  "join the",
  "dm me",
  "dm us",
  "comment below",
  "let me know",
  "let us know",
  "reach out",
  "get in touch",
  "link in bio",
  "download",
  "register",
  "subscribe",
  "follow along",
  "try it",
  "start free",
  "request a",
  "talk to us",
];

/** Template residue that should never survive into a draft. */
const PLACEHOLDER_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "[insert …]", pattern: /\[insert\b/i },
  { label: "[your …]", pattern: /\[your\b/i },
  { label: "{{ … }}", pattern: /\{\{/ },
  { label: "<name>-style placeholder", pattern: /<[a-z_ ]{2,20}>/i },
  { label: "TODO", pattern: /\bTODO\b/ },
  { label: "TBD", pattern: /\bTBD\b/ },
  { label: "lorem ipsum", pattern: /\blorem ipsum\b/i },
  { label: "XX% placeholder", pattern: /\bXX+%/ },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary, case-insensitive. Substring matching would flag "AI-first" on
 * a banned "AI" and make the list unusable; boundaries keep it honest.
 */
export function matchBannedClaims(claims: string[], text: string): string[] {
  return claims.filter((claim) => {
    const trimmed = claim.trim();
    if (!trimmed) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}($|[^\\p{L}\\p{N}])`, "iu").test(
      text,
    );
  });
}

export function detectCta(content: string): string | null {
  const lower = content.toLowerCase();
  const phrase = CTA_PHRASES.find((candidate) => lower.includes(candidate));
  if (phrase) return phrase;
  // A bare link at the end of a social post is a call to action in practice.
  return /https?:\/\/\S+/i.test(content) ? "a link" : null;
}

function normalizeForGrounding(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const NGRAM_SIZE = 4;

/** Every n-gram of the citation, as normalized whitespace-joined strings. */
export function significantNgrams(citation: string, size = NGRAM_SIZE): string[] {
  const tokens = normalizeForGrounding(citation).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  if (tokens.length < size) return [tokens.join(" ")];
  const grams: string[] = [];
  for (let i = 0; i + size <= tokens.length; i += 1) {
    grams.push(tokens.slice(i, i + size).join(" "));
  }
  return grams;
}

/**
 * D-67.6 — a citation is grounded when a run of its own words actually occurs
 * in what the run retrieved. Sprint 66 made citations mandatory; without this,
 * "mandatory" only guarantees a non-empty string.
 */
export function citationsGrounded(
  citations: string[],
  corpus: string,
): { grounded: string[]; fabricated: string[] } {
  const haystack = normalizeForGrounding(corpus);
  const grounded: string[] = [];
  const fabricated: string[] = [];
  for (const citation of citations) {
    const grams = significantNgrams(citation);
    const hit = grams.length > 0 && grams.some((gram) => haystack.includes(gram));
    (hit ? grounded : fabricated).push(citation);
  }
  return { grounded, fabricated };
}

function lengthCheck(content: string, channel: Channel): EvalCheckResult {
  const length = content.trim().length;
  if (length < EVAL_MIN_BODY_CHARS) {
    return {
      kind: "length_bounds",
      status: "fail",
      detail: `${length} characters — under the ${EVAL_MIN_BODY_CHARS}-character floor.`,
    };
  }
  const max = EVAL_MAX_BODY_CHARS[channel];
  if (max === undefined) {
    return {
      kind: "length_bounds",
      status: "pass",
      detail: `${length} characters; no published upper bound for ${channel}, floor cleared.`,
    };
  }
  return length > max
    ? {
        kind: "length_bounds",
        status: "fail",
        detail: `${length} characters — over the ${max}-character ${channel} limit.`,
      }
    : {
        kind: "length_bounds",
        status: "pass",
        detail: `${length} of ${max} characters for ${channel}.`,
      };
}

function bannedClaimsCheck(content: string, claims: string[]): EvalCheckResult {
  if (claims.length === 0) {
    return {
      kind: "banned_claims",
      status: "skipped",
      detail: "No banned claims configured for this workspace.",
    };
  }
  const hits = matchBannedClaims(claims, content);
  return hits.length > 0
    ? {
        kind: "banned_claims",
        status: "fail",
        detail: `Uses banned claim(s): ${hits.map((hit) => `"${hit}"`).join(", ")}.`,
      }
    : {
        kind: "banned_claims",
        status: "pass",
        detail: `None of the ${claims.length} banned claim(s) appear.`,
      };
}

function placeholderCheck(content: string): EvalCheckResult {
  const hits = PLACEHOLDER_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(
    ({ label }) => label,
  );
  return hits.length > 0
    ? {
        kind: "placeholder_leak",
        status: "fail",
        detail: `Template residue survived: ${hits.join(", ")}.`,
      }
    : { kind: "placeholder_leak", status: "pass", detail: "No template residue." };
}

function ctaCheck(content: string, expectation: CtaExpectation): EvalCheckResult {
  if (expectation === "any") {
    return {
      kind: "cta_presence",
      status: "skipped",
      detail: "This suite has no CTA expectation.",
    };
  }
  const cta = detectCta(content);
  if (expectation === "required") {
    return cta
      ? { kind: "cta_presence", status: "pass", detail: `Call to action present ("${cta}").` }
      : { kind: "cta_presence", status: "fail", detail: "A call to action was required; none found." };
  }
  return cta
    ? {
        kind: "cta_presence",
        status: "fail",
        detail: `Calls to action are forbidden here, but found "${cta}".`,
      }
    : { kind: "cta_presence", status: "pass", detail: "No call to action, as required." };
}

function citationCheck(citations: string[], corpus: string): EvalCheckResult {
  if (citations.length === 0) {
    return {
      kind: "citation_validity",
      status: "skipped",
      detail: "The run produced no critique findings to cite.",
    };
  }
  const { fabricated } = citationsGrounded(citations, corpus);
  return fabricated.length > 0
    ? {
        kind: "citation_validity",
        status: "fail",
        detail: `${fabricated.length} of ${citations.length} citation(s) are not grounded in what the run retrieved: ${fabricated
          .map((citation) => `"${citation}"`)
          .join(", ")}.`,
      }
    : {
        kind: "citation_validity",
        status: "pass",
        detail: `All ${citations.length} citation(s) trace to retrieved context.`,
      };
}

/** All five checks, always in EVAL_CHECK_KINDS order. */
export function runHardChecks(input: HardCheckInput): EvalCheckResult[] {
  return [
    lengthCheck(input.content, input.channel),
    bannedClaimsCheck(input.content, input.bannedClaims),
    placeholderCheck(input.content),
    ctaCheck(input.content, input.ctaExpectation),
    citationCheck(input.citations, input.corpus),
  ];
}

export function hardChecksPassed(checks: EvalCheckResult[]): boolean {
  return checks.every((check) => check.status !== "fail");
}
