import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  BRAIN_DOC_TYPES,
  docOutlineSchema,
  type BrainDocType,
  type BrainDocVersion,
  type BrainDocument,
  type DocOutline,
} from "@tuezday/contracts";
import {
  buildFallbackOutline,
  firstSentenceSummary,
  parseDocSections,
  renderBrainMarkdown,
  scoreBrain,
  type BrainContents,
  type BrainScore,
} from "@tuezday/brain";
import type { Db } from "../db";
import { brainDocumentVersions, brainDocuments } from "../db/schema";
import { GatewayError, type LlmGateway } from "../llm/gateway";

const CANONICAL_ORDER = new Map(BRAIN_DOC_TYPES.map((t, i) => [t, i]));

function parseOutline(outlineJson: string | null): DocOutline | null {
  if (!outlineJson) return null;
  try {
    const parsed = docOutlineSchema.safeParse(JSON.parse(outlineJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function rowToDoc(row: typeof brainDocuments.$inferSelect): BrainDocument {
  const { outlineJson, ...rest } = row;
  return { ...rest, docType: row.docType as BrainDocType, outline: parseOutline(outlineJson) };
}

/**
 * Idempotently create any missing brain docs for a workspace. Called on
 * workspace creation and again on read so workspaces that predate this
 * sprint pick up their docs lazily.
 */
export function ensureBrainDocs(db: Db, workspaceId: string): void {
  const existing = db
    .select({ docType: brainDocuments.docType })
    .from(brainDocuments)
    .where(eq(brainDocuments.workspaceId, workspaceId))
    .all();
  const have = new Set(existing.map((r) => r.docType));
  const now = Date.now();
  for (const docType of BRAIN_DOC_TYPES) {
    if (!have.has(docType)) {
      db.insert(brainDocuments)
        .values({ id: randomUUID(), workspaceId, docType, content: "", createdAt: now, updatedAt: now })
        .run();
    }
  }
}

export interface BrainView {
  docs: BrainDocument[];
  completeness: BrainScore;
}

export function getBrain(db: Db, workspaceId: string): BrainView {
  ensureBrainDocs(db, workspaceId);
  const docs = db
    .select()
    .from(brainDocuments)
    .where(eq(brainDocuments.workspaceId, workspaceId))
    .all()
    .map(rowToDoc)
    .sort((a, b) => CANONICAL_ORDER.get(a.docType)! - CANONICAL_ORDER.get(b.docType)!);

  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  return { docs, completeness: scoreBrain(contents) };
}

export interface BrainActor {
  userId: string | null;
  label: string;
}

export function updateBrainDoc(
  db: Db,
  workspaceId: string,
  docType: BrainDocType,
  content: string,
  actor: BrainActor | null = null,
): BrainDocument {
  ensureBrainDocs(db, workspaceId);
  const doc = db
    .select()
    .from(brainDocuments)
    .where(and(eq(brainDocuments.workspaceId, workspaceId), eq(brainDocuments.docType, docType)))
    .get()!;

  const now = Date.now();
  // Sprint 43: every save recomputes the doc's outline. The synchronous write
  // stores deterministic fallback summaries; enrichOutlineSummaries (below)
  // upgrades them via the LLM afterwards, best-effort.
  const outline = buildFallbackOutline(content, now);
  const outlineJson = outline ? JSON.stringify(outline) : null;
  db.update(brainDocuments)
    .set({ content, outlineJson, updatedAt: now })
    .where(eq(brainDocuments.id, doc.id))
    .run();

  const latest = db
    .select({ version: brainDocumentVersions.version })
    .from(brainDocumentVersions)
    .where(eq(brainDocumentVersions.documentId, doc.id))
    .orderBy(desc(brainDocumentVersions.version))
    .get();
  db.insert(brainDocumentVersions)
    .values({
      id: randomUUID(),
      documentId: doc.id,
      version: (latest?.version ?? 0) + 1,
      content,
      actor: actor?.label ?? null,
      actorId: actor?.userId ?? null,
      createdAt: now,
    })
    .run();

  return rowToDoc({ ...doc, content, outlineJson, updatedAt: now });
}

// ---------------------------------------------------------------------------
// Outline summaries (Sprint 43)
// ---------------------------------------------------------------------------

/** Cap on how much of each section body reaches the summary prompt. */
const SUMMARY_SECTION_MAX_CHARS = 1_500;

export function composeOutlineSummaryPrompt(
  sections: { heading: string; body: string }[],
): string {
  const blocks = sections.map(
    (s, i) =>
      `SECTION ${i + 1} (heading: "${s.heading}"):\n${s.body.slice(0, SUMMARY_SECTION_MAX_CHARS)}`,
  );
  return (
    "Task: You maintain a table of contents for a company brain document. For each numbered " +
    "section below, write ONE line (max 20 words) summarizing what the section actually says — " +
    "concrete and specific, no marketing gloss. Respond with EXACTLY one line per section, " +
    `formatted 'SUMMARY <n>: <one-line summary>' and nothing else — ${sections.length} lines total.\n\n` +
    blocks.join("\n\n")
  );
}

export function parseOutlineSummaries(text: string, count: number): Map<number, string> {
  const summaries = new Map<number, string>();
  for (const match of text.matchAll(/^SUMMARY\s+(\d+)\s*:\s*(.+)$/gim)) {
    const n = Number(match[1]);
    const summary = match[2]!.trim();
    if (n >= 1 && n <= count && summary) summaries.set(n, summary);
  }
  return summaries;
}

/**
 * Upgrade a doc's stored outline with LLM one-line summaries — one gateway
 * call for all sections. Best-effort: any failure (gateway down, unparseable
 * output) leaves the deterministic fallback summaries in place. Never throws.
 */
export async function enrichOutlineSummaries(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  docType: BrainDocType,
): Promise<BrainDocument> {
  const row = db
    .select()
    .from(brainDocuments)
    .where(and(eq(brainDocuments.workspaceId, workspaceId), eq(brainDocuments.docType, docType)))
    .get()!;
  const doc = rowToDoc(row);
  if (!doc.content.trim() || !doc.outline) return doc;

  const sections = parseDocSections(doc.content);
  if (sections.length === 0) return doc;

  let summaries: Map<number, string>;
  try {
    const result = await llm.generate({
      prompt: composeOutlineSummaryPrompt(sections.map((s) => ({ heading: s.heading, body: s.body }))),
    });
    summaries = parseOutlineSummaries(result.text, sections.length);
  } catch (err) {
    if (err instanceof GatewayError) return doc; // keep fallback summaries
    throw err;
  }
  if (summaries.size === 0) return doc;

  const outline: DocOutline = {
    generatedAt: doc.outline.generatedAt,
    sections: sections.map((s, i) => {
      const llmSummary = summaries.get(i + 1);
      return {
        id: s.id,
        parentId: s.parentId,
        heading: s.heading,
        level: s.level,
        summary: llmSummary ?? firstSentenceSummary(s.body),
        summarySource: llmSummary ? ("llm" as const) : ("fallback" as const),
        tokens: s.tokens,
      };
    }),
  };
  db.update(brainDocuments)
    .set({ outlineJson: JSON.stringify(outline) })
    .where(eq(brainDocuments.id, row.id))
    .run();
  return { ...doc, outline };
}

/**
 * Outlines for every non-empty doc: the stored one when present, otherwise a
 * fallback derived on the fly (docs saved before Sprint 43 have no stored
 * outline — no backfill, no write-on-read).
 */
export function getBrainOutlines(
  db: Db,
  workspaceId: string,
): Partial<Record<BrainDocType, DocOutline>> {
  const { docs } = getBrain(db, workspaceId);
  const outlines: Partial<Record<BrainDocType, DocOutline>> = {};
  for (const doc of docs) {
    if (!doc.content.trim()) continue;
    outlines[doc.docType] = doc.outline ?? buildFallbackOutline(doc.content, doc.updatedAt)!;
  }
  return outlines;
}

export function listDocVersions(
  db: Db,
  workspaceId: string,
  docType: BrainDocType,
): BrainDocVersion[] {
  ensureBrainDocs(db, workspaceId);
  const doc = db
    .select({ id: brainDocuments.id })
    .from(brainDocuments)
    .where(and(eq(brainDocuments.workspaceId, workspaceId), eq(brainDocuments.docType, docType)))
    .get()!;

  return db
    .select()
    .from(brainDocumentVersions)
    .where(eq(brainDocumentVersions.documentId, doc.id))
    .orderBy(desc(brainDocumentVersions.version))
    .all();
}

export function exportBrainMarkdown(db: Db, workspaceId: string, workspaceName: string): string {
  const { docs } = getBrain(db, workspaceId);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  return renderBrainMarkdown(workspaceName, contents);
}
