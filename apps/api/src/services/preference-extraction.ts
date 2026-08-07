// Sprint 68 (PRD Move 5): extraction — a batch of same-scope diffs becomes a
// small set of durable rules. Runs off the request path (D-68.3): the worker
// tick and the manual route are its only callers.
//
// Not a leaf: it reaches the LLM gateway. That is safe because nothing in
// `agents/tools/` reaches this module — the tools read `preference-rules.ts`,
// which is a leaf (D-68.10).

import {
  EXTRACTION_MAX_RULES,
  preferenceExtractionSchema,
  type Channel,
  type PreferenceEdit,
  type PreferenceExtractionResult,
  type TaskType,
} from "@tuezday/contracts";
import type { Db } from "../db";
import type { LlmGateway } from "../llm/gateway";
import { meteredLlm } from "../llm/metered";
import { generateStructured } from "../llm/structured";
import { listUndigestedEdits, markEditsDigested } from "./preference-edits";
import {
  evidenceExcerpt,
  retireStaleRules,
  upsertPreferenceRule,
} from "./preference-rules";

/** Edits per scope group in one extraction call. */
export const EXTRACTION_GROUP_SIZE = 8;
/** Scope groups per pass, so one workspace's backlog cannot monopolise a tick. */
export const EXTRACTION_MAX_GROUPS = 4;
/** How much of each side of a diff the model sees. */
const DIFF_EXCERPT_CHARS = 700;

function clip(text: string, max = DIFF_EXCERPT_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

interface ScopeGroup {
  taskType: TaskType;
  channel: Channel;
  edits: PreferenceEdit[];
}

/**
 * Group undigested edits by their scope (D-68.4). Scope is then a *fact about
 * the inputs* rather than a judgment the model could get wrong: a rule learned
 * from LinkedIn signal responses cannot silently start governing cold email.
 */
export function groupEditsByScope(edits: PreferenceEdit[]): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const edit of edits) {
    const key = `${edit.taskType}::${edit.channel}`;
    const group = groups.get(key);
    if (group) {
      if (group.edits.length < EXTRACTION_GROUP_SIZE) group.edits.push(edit);
      continue;
    }
    groups.set(key, { taskType: edit.taskType, channel: edit.channel, edits: [edit] });
  }
  return [...groups.values()];
}

export function composeExtractionPrompt(group: ScopeGroup): string {
  const diffs = group.edits.map((edit, index) => {
    const lines = [`### Edit ${index + 1}`];
    if (edit.instruction) lines.push(`The founder asked for: "${edit.instruction}"`);
    lines.push(`BEFORE (what the system wrote):\n${clip(edit.beforeContent)}`);
    lines.push(`AFTER (what the founder kept):\n${clip(edit.afterContent)}`);
    return lines.join("\n");
  });
  return [
    `You are reading a founder's corrections to ${group.taskType} drafts on ${group.channel} and extracting the durable writing preferences behind them.`,
    "",
    ...diffs,
    "",
    `Return at most ${EXTRACTION_MAX_RULES} rules. A good rule is:`,
    "- one imperative sentence a writer could follow without seeing these drafts",
    "  (\"never open with a rhetorical question\", \"name the segment, not the persona\")",
    "- about style, structure, framing, or vocabulary — not about the specific subject matter of these posts",
    "- supported by more than one edit where possible; a pattern beats a one-off",
    "",
    "Set `confidence` honestly: 80+ when the same correction is visible across several edits or the founder stated it outright, 40-60 when you are inferring it from a single ambiguous diff.",
    "Quote the words from the edits that justify each rule in `evidence`.",
    "If these edits show no durable preference — only subject-matter fixes, typos, or facts — return an empty list. That is a correct answer.",
  ].join("\n");
}

export interface PreferenceExtractionOptions {
  maxGroups?: number;
  now?: number;
}

/**
 * One extraction pass for one workspace.
 *
 * Every edit a pass touches is stamped `digestedAt` whether or not it produced
 * a rule — including when the model call throws — so one poisonous diff can
 * never wedge the loop behind it.
 */
export async function runPreferenceExtraction(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  options: PreferenceExtractionOptions = {},
): Promise<PreferenceExtractionResult> {
  const now = options.now ?? Date.now();
  const maxGroups = options.maxGroups ?? EXTRACTION_MAX_GROUPS;
  const pending = listUndigestedEdits(db, workspaceId, EXTRACTION_GROUP_SIZE * maxGroups);
  const groups = groupEditsByScope(pending).slice(0, maxGroups);

  const result: PreferenceExtractionResult = {
    groups: groups.length,
    edits: 0,
    created: 0,
    merged: 0,
    retired: 0,
  };

  const metered = meteredLlm(llm, db, { workspaceId, pipeline: "preference_extraction" });
  for (const group of groups) {
    const editIds = group.edits.map((edit) => edit.id);
    result.edits += editIds.length;
    try {
      const extraction = await generateStructured(metered, preferenceExtractionSchema, {
        prompt: composeExtractionPrompt(group),
        tier: "frontier",
      });
      for (const candidate of extraction.value.rules) {
        // Attribute the rule to the edit its quoted evidence actually came
        // from, not to whichever edit happened to be first in the batch. A
        // rule that claims eight sources when two taught it is not provenance.
        const source = bestSourceEdit(group.edits, candidate.evidence);
        const upserted = upsertPreferenceRule(
          db,
          workspaceId,
          {
            rule: candidate.rule,
            polarity: candidate.polarity,
            scopeTaskType: group.taskType,
            scopeChannel: group.channel,
            confidence: candidate.confidence,
            origin: "extracted",
            evidence: {
              editId: source.id,
              excerpt: `${candidate.evidence.trim()}\n\n${evidenceExcerpt(source)}`,
            },
          },
          now,
        );
        if (upserted.merged) result.merged += 1;
        else result.created += 1;
      }
    } catch {
      // A failed extraction costs this batch, not the loop. The edits are
      // still stamped below so the next pass moves on.
    }
    markEditsDigested(db, editIds, now);
  }

  result.retired = retireStaleRules(db, workspaceId, now);
  return result;
}

/**
 * Which edit in the batch the model's quoted evidence came from — the one
 * sharing the most distinctive words with the quote. Falls back to the first
 * edit when the quote is generic, which is the honest default: the rule came
 * from this batch, and this batch is ordered oldest-first.
 */
function bestSourceEdit(edits: PreferenceEdit[], evidence: string): PreferenceEdit {
  const words = new Set(
    evidence
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 3),
  );
  if (words.size === 0) return edits[0]!;
  let best = edits[0]!;
  let bestScore = -1;
  for (const edit of edits) {
    const haystack =
      `${edit.instruction ?? ""} ${edit.beforeContent} ${edit.afterContent}`.toLowerCase();
    let score = 0;
    for (const word of words) if (haystack.includes(word)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = edit;
    }
  }
  return best;
}
