// Sprint 36.4 — Brain auto-draft engine.
//
// Turns the verified brand profile (36.2) + the social corpus (36.3) into five
// drafted brain docs. Deliberately drafts from the *derived* profile the
// founder verified in Step 4 — never raw website HTML (spec decision #1).
// Five independent per-doc LLM calls: a failure on one doc never sinks the
// other four (decision #2). Writes only currently-empty docs, through the
// versioned updateBrainDoc with actor "system:onboarding" (decision #3).

import {
  BRAIN_DOC_TYPES,
  type BrainDocType,
  type BrandProfile,
  type SocialCorpus,
} from "@tuezday/contracts";
import { BRAIN_DOC_META, scoreDoc, type BrainDocMeta } from "@tuezday/brain";
import type { Db } from "../db";
import type { ConnectorFabric } from "../connectors/fabric";
import type { LlmGateway } from "../llm/gateway";
import { getBrain, updateBrainDoc, type BrainView } from "./brain";
import { getBrandProfileView } from "./brand-profile";
import { readSocialCorpus } from "./social-corpus";

/** Cap on how much social corpus reaches each drafting prompt. */
const MAX_SOCIAL_PROMPT_CHARS = 6_000;

const AUTODRAFT_ACTOR = { userId: null, label: "system:onboarding" } as const;

export interface DraftBrainInput {
  profile: BrandProfile | null;
  socialCorpus: SocialCorpus;
}

export interface DraftBrainResult {
  drafts: Partial<Record<BrainDocType, string>>;
  insufficient: boolean;
}

function profileBlock(profile: BrandProfile | null): string {
  if (!profile) return "BRAND PROFILE:\n(none available)";
  const v = profile.voiceDimensions;
  return [
    "BRAND PROFILE:",
    `- Business: ${profile.businessName} — ${profile.tagline}`,
    `- Summary: ${profile.summary}`,
    `- Target age: ${profile.targetAgeRange}`,
    `- Tone: ${profile.tone}`,
    `- Voice (purpose/audience/tone/emotions/character/syntax/language): ` +
      [v.purpose, v.audience, v.tone, v.emotions, v.character, v.syntax, v.language].join(" / "),
    `- Pillars: ${profile.pillars.join(", ")}`,
  ].join("\n");
}

function composeDocPrompt(meta: BrainDocMeta, input: DraftBrainInput): string {
  const businessName = input.profile?.businessName ?? "the business";
  const social = input.socialCorpus.corpus.trim().slice(0, MAX_SOCIAL_PROMPT_CHARS);
  return [
    `You are drafting the "${meta.title}" brain document for ${businessName}.`,
    meta.description,
    "Write it as concise markdown (headings + short bullets), grounded ONLY in the " +
      "material below. Do not invent facts; if the material is thin, write what is " +
      "supported and stop. 120-250 words.",
    "",
    profileBlock(input.profile),
    "",
    "RECENT SOCIAL ACTIVITY:",
    social || "(none)",
  ].join("\n");
}

/**
 * Draft all five brain docs — one focused llm.generate per doc. A per-doc
 * failure (gateway error or empty output) leaves that doc absent from
 * `drafts` and never affects the other four. With no ready profile AND an
 * empty social corpus there is nothing to ground the drafts in: typed no-op,
 * zero LLM calls (spec decision #4).
 */
export async function draftBrain(
  llm: LlmGateway,
  input: DraftBrainInput,
): Promise<DraftBrainResult> {
  if (!input.profile && !input.socialCorpus.corpus.trim()) {
    return { drafts: {}, insufficient: true };
  }

  const drafts: Partial<Record<BrainDocType, string>> = {};
  for (const meta of BRAIN_DOC_META) {
    try {
      const result = await llm.generate({ prompt: composeDocPrompt(meta, input) });
      const text = result.text.trim();
      if (text) drafts[meta.docType] = text;
    } catch {
      // Isolate per-doc failures — undrafted, retryable on re-run.
    }
  }
  return { drafts, insufficient: false };
}

export interface BrainAutoDraftView {
  insufficient: boolean;
  drafted: BrainDocType[];
  skipped: BrainDocType[];
  brain: BrainView;
}

/**
 * Orchestrate the auto-draft for a workspace: read the verified profile + the
 * social corpus, draft, then write each drafted doc via the versioned
 * updateBrainDoc — only when the current doc is empty. Non-empty docs are
 * reported as `skipped` and never overwritten.
 */
export async function runBrainAutoDraft(
  db: Db,
  llm: LlmGateway,
  fabric: ConnectorFabric,
  workspaceId: string,
): Promise<BrainAutoDraftView> {
  const profileView = getBrandProfileView(db, workspaceId);
  const profile = profileView.status === "ready" ? profileView.profile : null;

  let socialCorpus: SocialCorpus;
  try {
    socialCorpus = await readSocialCorpus(db, fabric, workspaceId);
  } catch {
    // A broken fabric must not block onboarding — draft from the profile alone.
    socialCorpus = { connected: [], entries: [], corpus: "" };
  }

  const result = await draftBrain(llm, { profile, socialCorpus });
  if (result.insufficient) {
    return { insufficient: true, drafted: [], skipped: [], brain: getBrain(db, workspaceId) };
  }

  const current = getBrain(db, workspaceId);
  const contentByType = new Map(current.docs.map((d) => [d.docType, d.content]));

  const drafted: BrainDocType[] = [];
  const skipped: BrainDocType[] = [];
  for (const docType of BRAIN_DOC_TYPES) {
    const existing = contentByType.get(docType) ?? "";
    if (scoreDoc(existing).status !== "empty") {
      skipped.push(docType);
      continue;
    }
    const draft = result.drafts[docType];
    if (draft && draft.trim()) {
      updateBrainDoc(db, workspaceId, docType, draft, AUTODRAFT_ACTOR);
      drafted.push(docType);
    }
    // Writable but no draft produced → neither drafted nor skipped.
  }

  return { insufficient: false, drafted, skipped, brain: getBrain(db, workspaceId) };
}
