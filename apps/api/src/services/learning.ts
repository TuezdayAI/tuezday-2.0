import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type {
  ApprovalState,
  Channel,
  CreateMetricInput,
  EngagementMetric,
  NowSynthesis,
  OutputRating,
  SynthesisStatus,
  TaskType,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  drafts,
  engagementMetrics,
  generations,
  nowSyntheses,
  type EngagementMetricRow,
  type NowSynthesisRow,
} from "../db/schema";
import type { LlmGateway } from "../llm/gateway";
import { getBrain, updateBrainDoc } from "./brain";

// ---------------------------------------------------------------------------
// Training examples (derived from what already happened — no new storage)
// ---------------------------------------------------------------------------

export interface TrainingExample {
  kind: "rating" | "decision";
  id: string;
  taskType: TaskType;
  channel: Channel;
  personaId: string | null;
  campaignId: string | null;
  content: string;
  originalContent: string | null;
  wasEdited: boolean;
  rating: OutputRating | null;
  decision: "approved" | "rejected" | null;
  createdAt: number;
}

export function listTrainingExamples(db: Db, workspaceId: string): TrainingExample[] {
  const ratedGenerations = db
    .select()
    .from(generations)
    .where(and(eq(generations.workspaceId, workspaceId), isNotNull(generations.rating)))
    .orderBy(desc(generations.createdAt))
    .all()
    // Generations submitted as drafts get their learning signal from the
    // draft decision instead — avoid double counting.
    .map((g) => ({
      kind: "rating" as const,
      id: g.id,
      taskType: g.taskType as TaskType,
      channel: g.channel as Channel,
      personaId: g.personaId,
      campaignId: g.campaignId,
      content: g.output,
      originalContent: null,
      wasEdited: false,
      rating: g.rating as OutputRating,
      decision: null,
      createdAt: g.createdAt,
    }));

  const decidedDrafts = db
    .select()
    .from(drafts)
    .where(eq(drafts.workspaceId, workspaceId))
    .orderBy(desc(drafts.createdAt))
    .all()
    .filter((d) => d.state === "approved" || d.state === "rejected")
    .map((d) => ({
      kind: "decision" as const,
      id: d.id,
      taskType: d.taskType as TaskType,
      channel: d.channel as Channel,
      personaId: d.personaId,
      campaignId: d.campaignId,
      content: d.content,
      originalContent: d.content !== d.originalContent ? d.originalContent : null,
      wasEdited: d.content !== d.originalContent,
      rating: null,
      decision: (d.state === "approved" ? "approved" : "rejected") as "approved" | "rejected",
      createdAt: d.createdAt,
    }));

  return [...ratedGenerations, ...decidedDrafts].sort((a, b) => b.createdAt - a.createdAt);
}

export interface LearningStats {
  ratings: Record<OutputRating, number>;
  decisions: { approved: number; rejected: number };
  editedCount: number;
  metricsCount: number;
}

export function learningStats(db: Db, workspaceId: string): LearningStats {
  const examples = listTrainingExamples(db, workspaceId);
  const ratings = { accepted: 0, needs_edit: 0, rejected: 0 } as Record<OutputRating, number>;
  const decisions = { approved: 0, rejected: 0 };
  let editedCount = 0;
  for (const e of examples) {
    if (e.kind === "rating" && e.rating) ratings[e.rating] += 1;
    if (e.kind === "decision" && e.decision) decisions[e.decision] += 1;
    if (e.wasEdited) editedCount += 1;
  }
  const metricsCount = db
    .select({ id: engagementMetrics.id })
    .from(engagementMetrics)
    .where(eq(engagementMetrics.workspaceId, workspaceId))
    .all().length;
  return { ratings, decisions, editedCount, metricsCount };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function rowToMetric(row: EngagementMetricRow): EngagementMetric {
  return { ...row, channel: row.channel as Channel };
}

export function createMetric(db: Db, workspaceId: string, input: CreateMetricInput): EngagementMetric {
  const now = Date.now();
  const row: EngagementMetricRow = {
    id: randomUUID(),
    workspaceId,
    draftId: input.draftId ?? null,
    channel: input.channel,
    description: input.description,
    impressions: input.impressions ?? null,
    engagements: input.engagements ?? null,
    clicks: input.clicks ?? null,
    notes: input.notes,
    recordedAt: input.recordedAt ?? now,
    createdAt: now,
  };
  db.insert(engagementMetrics).values(row).run();
  return rowToMetric(row);
}

export function listMetrics(db: Db, workspaceId: string): EngagementMetric[] {
  return db
    .select()
    .from(engagementMetrics)
    .where(eq(engagementMetrics.workspaceId, workspaceId))
    .orderBy(desc(engagementMetrics.recordedAt))
    .all()
    .map(rowToMetric);
}

// ---------------------------------------------------------------------------
// Now synthesis
// ---------------------------------------------------------------------------

const MAX_EXAMPLES_IN_PROMPT = 20;
const EXAMPLE_EXCERPT_CHARS = 400;

function rowToSynthesis(row: NowSynthesisRow): NowSynthesis {
  return { ...row, status: row.status as SynthesisStatus };
}

export function listSyntheses(db: Db, workspaceId: string): NowSynthesis[] {
  return db
    .select()
    .from(nowSyntheses)
    .where(eq(nowSyntheses.workspaceId, workspaceId))
    .orderBy(desc(nowSyntheses.createdAt))
    .all()
    .map(rowToSynthesis);
}

export function getSynthesis(
  db: Db,
  workspaceId: string,
  synthesisId: string,
): NowSynthesis | undefined {
  const row = db
    .select()
    .from(nowSyntheses)
    .where(and(eq(nowSyntheses.workspaceId, workspaceId), eq(nowSyntheses.id, synthesisId)))
    .get();
  return row ? rowToSynthesis(row) : undefined;
}

export class NothingToLearnError extends Error {
  constructor() {
    super("No decisions, ratings, or metrics to learn from yet.");
    this.name = "NothingToLearnError";
  }
}

/**
 * Parse the PROPOSAL/RATIONALE delimiter format. JSON is deliberately not
 * used here: learnings are prose full of quotes, which models reliably fail
 * to escape. Falls back to treating the whole response as the proposal.
 */
function parseSynthesisResponse(text: string): { proposal: string; rationale: string } {
  const cleaned = text.replace(/```[a-z]*\n?|```/g, "").trim();
  const match = /PROPOSAL:\s*([\s\S]*?)\s*RATIONALE:\s*([\s\S]*)/i.exec(cleaned);
  if (match) {
    return { proposal: match[1]!.trim(), rationale: match[2]!.trim() };
  }
  return { proposal: cleaned, rationale: "" };
}

export async function synthesizeNow(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  workspaceName: string,
): Promise<NowSynthesis> {
  const stats = learningStats(db, workspaceId);
  const examples = listTrainingExamples(db, workspaceId);
  const metrics = listMetrics(db, workspaceId);
  if (examples.length === 0 && metrics.length === 0) {
    throw new NothingToLearnError();
  }

  const { docs } = getBrain(db, workspaceId);
  const nowDoc = docs.find((d) => d.docType === "now")?.content.trim() ?? "";

  const exampleLines = examples.slice(0, MAX_EXAMPLES_IN_PROMPT).map((e) => {
    const verdict = e.kind === "rating" ? `rated ${e.rating}` : e.decision;
    const edited = e.wasEdited
      ? `\n  EDITED FROM: ${e.originalContent?.slice(0, EXAMPLE_EXCERPT_CHARS)}\n  EDITED TO: ${e.content.slice(0, EXAMPLE_EXCERPT_CHARS)}`
      : `\n  CONTENT: ${e.content.slice(0, EXAMPLE_EXCERPT_CHARS)}`;
    return `- [${e.taskType} / ${e.channel}] ${verdict}${edited}`;
  });

  const metricLines = metrics.map(
    (m) =>
      `- [${m.channel}] ${m.description || "untitled"}: impressions=${m.impressions ?? "?"} engagements=${m.engagements ?? "?"} clicks=${m.clicks ?? "?"}${m.notes ? ` (${m.notes})` : ""}`,
  );

  const prompt = [
    `You synthesize GTM learnings for ${workspaceName}. Review the human decisions, edits, and engagement metrics below and synthesize what is actually working and what should change. Be specific and grounded only in the data shown — no generic advice.`,
    `DECISION STATS: accepted: ${stats.ratings.accepted}, needs_edit: ${stats.ratings.needs_edit}, rejected ratings: ${stats.ratings.rejected}; approved drafts: ${stats.decisions.approved}, rejected drafts: ${stats.decisions.rejected}, edited before decision: ${stats.editedCount}.`,
    `EXAMPLES:\n${exampleLines.join("\n") || "(none)"}`,
    `ENGAGEMENT METRICS:\n${metricLines.join("\n") || "(none)"}`,
    `CURRENT NOW DOC:\n${nowDoc || "(empty)"}`,
    `Respond in EXACTLY this format (no code fences, no other text):\nPROPOSAL:\n<markdown bullet list of 2-6 concrete learnings, max ~250 words, written so it can be appended to the now doc>\nRATIONALE:\n<one short paragraph explaining what in the data supports these learnings>`,
  ].join("\n\n");

  const result = await llm.generate({ prompt });
  const { proposal, rationale } = parseSynthesisResponse(result.text);

  const row: NowSynthesisRow = {
    id: randomUUID(),
    workspaceId,
    proposal,
    rationale,
    basedOnJson: JSON.stringify({
      examples: examples.length,
      metrics: metrics.length,
      stats,
    }),
    status: "proposed",
    createdAt: Date.now(),
    decidedAt: null,
  };
  db.insert(nowSyntheses).values(row).run();
  return rowToSynthesis(row);
}

export class SynthesisAlreadyDecidedError extends Error {
  constructor(status: string) {
    super(`This synthesis was already ${status}.`);
    this.name = "SynthesisAlreadyDecidedError";
  }
}

export function acceptSynthesis(
  db: Db,
  workspaceId: string,
  synthesis: NowSynthesis,
): { synthesis: NowSynthesis; nowContent: string } {
  if (synthesis.status !== "proposed") throw new SynthesisAlreadyDecidedError(synthesis.status);

  const { docs } = getBrain(db, workspaceId);
  const current = docs.find((d) => d.docType === "now")?.content ?? "";
  const date = new Date(synthesis.createdAt).toISOString().slice(0, 10);
  const block = `## Learnings (synthesized ${date})\n\n${synthesis.proposal}`;
  const updated = current.trim() ? `${current.trimEnd()}\n\n${block}` : block;
  // Through the standard brain update path: creates a version like any edit.
  const doc = updateBrainDoc(db, workspaceId, "now", updated);

  const decidedAt = Date.now();
  db.update(nowSyntheses)
    .set({ status: "accepted", decidedAt })
    .where(eq(nowSyntheses.id, synthesis.id))
    .run();
  return { synthesis: { ...synthesis, status: "accepted", decidedAt }, nowContent: doc.content };
}

export function dismissSynthesis(db: Db, synthesis: NowSynthesis): NowSynthesis {
  if (synthesis.status !== "proposed") throw new SynthesisAlreadyDecidedError(synthesis.status);
  const decidedAt = Date.now();
  db.update(nowSyntheses)
    .set({ status: "dismissed", decidedAt })
    .where(eq(nowSyntheses.id, synthesis.id))
    .run();
  return { ...synthesis, status: "dismissed", decidedAt };
}
