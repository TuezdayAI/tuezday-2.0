import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  brandProfileSchema,
  type BrandProfile,
  type BrandProfileStatus,
  type BrandProfileView,
  type UpdateBrandProfileInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { brandProfiles } from "../db/schema";
import type { Fetcher } from "../discovery/adapters";
import type { LlmGateway } from "../llm/gateway";
import { scrapeWebsite } from "./scrape";

/** LLM output failed to parse/validate even after the repair retry. */
export class BrandExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandExtractError";
  }
}

const EXTRACT_PROMPT_HEAD = `You are extracting a brand profile from a company's website text.
Respond with ONLY a JSON object — no prose, no markdown fences — matching exactly:
{
  "businessName": "<the company/product name>",
  "tagline": "<their tagline, or empty string>",
  "summary": "<2-4 sentences on what they do and for whom>",
  "targetAgeRange": "<estimated target customer age range like '25-45', or empty string>",
  "tone": "<one sentence describing the site's tone of voice>",
  "voiceDimensions": {
    "purpose": "<why this brand communicates>",
    "audience": "<who it speaks to>",
    "tone": "<how it sounds>",
    "emotions": "<feelings it evokes>",
    "character": "<the persona behind the words>",
    "syntax": "<sentence/structure habits>",
    "language": "<vocabulary and locale, e.g. 'US English, technical'>"
  },
  "pillars": ["<up to 8 recurring content/positioning themes>"],
  "sourceNotes": "<anything you could NOT find (pricing, audience, ...), or empty string>"
}
Use empty strings for anything the text does not support — do not invent facts.`;

function parseProfileText(text: string): { profile?: BrandProfile; error?: string } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { error: "no JSON object found in the response" };
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch (err) {
    return { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = brandProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: `schema validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { profile: parsed.data };
}

/**
 * One extraction call, one repair retry. The repair prompt carries the raw
 * first response plus the exact parse/validation error so the model can fix
 * its own output. Two failures → BrandExtractError.
 */
export async function extractBrandProfile(
  llm: LlmGateway,
  corpus: string,
): Promise<BrandProfile> {
  const prompt = `${EXTRACT_PROMPT_HEAD}\n\nWEBSITE TEXT:\n${corpus}`;
  const first = await llm.generate({ prompt });
  const attempt = parseProfileText(first.text);
  if (attempt.profile) return attempt.profile;

  const repairPrompt = [
    EXTRACT_PROMPT_HEAD,
    `Your previous response could not be used. Error: ${attempt.error}.`,
    `Previous response:\n${first.text}`,
    `Return ONLY the corrected JSON object.`,
    `WEBSITE TEXT:\n${corpus.slice(0, 4000)}`,
  ].join("\n\n");
  const second = await llm.generate({ prompt: repairPrompt });
  const repaired = parseProfileText(second.text);
  if (repaired.profile) return repaired.profile;

  throw new BrandExtractError(
    `Brand extraction failed after repair retry: ${repaired.error}`,
  );
}

// ---------------------------------------------------------------------------
// Storage + run state machine
// ---------------------------------------------------------------------------

function upsertRow(
  db: Db,
  workspaceId: string,
  values: Partial<typeof brandProfiles.$inferInsert> & { sourceUrl?: string },
): void {
  const now = Date.now();
  const existing = db
    .select({ id: brandProfiles.id })
    .from(brandProfiles)
    .where(eq(brandProfiles.workspaceId, workspaceId))
    .get();
  if (existing) {
    db.update(brandProfiles)
      .set({ ...values, updatedAt: now })
      .where(eq(brandProfiles.id, existing.id))
      .run();
  } else {
    db.insert(brandProfiles)
      .values({
        id: randomUUID(),
        workspaceId,
        sourceUrl: values.sourceUrl ?? "",
        status: values.status ?? "scraping",
        profileJson: values.profileJson ?? null,
        error: values.error ?? null,
        corpusChars: values.corpusChars ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

export function getBrandProfileView(db: Db, workspaceId: string): BrandProfileView {
  const row = db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.workspaceId, workspaceId))
    .get();
  if (!row) return { status: "none", profile: null, sourceUrl: null, error: null, updatedAt: null };
  return {
    status: row.status as BrandProfileStatus,
    profile: row.profileJson ? (JSON.parse(row.profileJson) as BrandProfile) : null,
    sourceUrl: row.sourceUrl,
    error: row.error,
    updatedAt: row.updatedAt,
  };
}

/**
 * Scrape → extract → store. Never throws: every failure lands in the row as
 * status "failed" with the error message (≤500 chars), so callers can safely
 * fire-and-forget at workspace creation.
 */
export async function runBrandProfile(
  db: Db,
  llm: LlmGateway,
  fetcher: Fetcher,
  workspaceId: string,
  websiteUrl: string,
): Promise<BrandProfileView> {
  upsertRow(db, workspaceId, {
    sourceUrl: websiteUrl,
    status: "scraping",
    error: null,
    profileJson: null,
  });
  try {
    const { corpus } = await scrapeWebsite(websiteUrl, fetcher);
    upsertRow(db, workspaceId, { status: "extracting", corpusChars: corpus.length });
    const profile = await extractBrandProfile(llm, corpus);
    upsertRow(db, workspaceId, { status: "ready", profileJson: JSON.stringify(profile) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    upsertRow(db, workspaceId, { status: "failed", error: message.slice(0, 500) });
  }
  return getBrandProfileView(db, workspaceId);
}

export type UpdateBrandProfileResult =
  | { ok: true; view: BrandProfileView }
  | { ok: false; reason: "not_ready" };

/** Apply a partial edit to a ready profile (Step 4 verification saves). */
export function updateBrandProfile(
  db: Db,
  workspaceId: string,
  input: UpdateBrandProfileInput,
): UpdateBrandProfileResult {
  const row = db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.workspaceId, workspaceId))
    .get();
  if (!row || row.status !== "ready" || !row.profileJson) {
    return { ok: false, reason: "not_ready" };
  }
  const current = JSON.parse(row.profileJson) as BrandProfile;
  const merged: BrandProfile = {
    ...current,
    ...input,
    voiceDimensions: { ...current.voiceDimensions, ...(input.voiceDimensions ?? {}) },
  };
  upsertRow(db, workspaceId, { profileJson: JSON.stringify(merged) });
  return { ok: true, view: getBrandProfileView(db, workspaceId) };
}
