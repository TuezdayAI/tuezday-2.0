// Sprint 70 (PRD §8, Move 7a): the ask lane's durable half.
//
// Leaf-ish by design: drizzle, contracts, and the Sprint 68 preference store.
// It never imports the pipeline engine — recording an answer and *resuming the
// run* are separate concerns, and the route composes them (D-70.7). That
// separation is what lets the engine import this module for prompt injection
// without a cycle.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  AGENT_QUESTIONS_OPEN_MAX,
  AGENT_QUESTIONS_PER_RUN,
  agentQuestionSchema,
  type AgentQuestion,
  type AgentQuestionStatus,
  type AgentQuestionType,
  type AnswerAgentQuestionInput,
  type PreferenceRule,
} from "@tuezday/contracts";
import type {
  AgentQuestionService,
  AskQuestionArgs,
  AskQuestionOrigin,
  AskResult,
} from "../agents/questions";
import type { Db } from "../db";
import { agentQuestions, type AgentQuestionRow } from "../db/schema";
import { upsertPreferenceRule } from "./preference-rules";

export function rowToAgentQuestion(row: AgentQuestionRow): AgentQuestion {
  return agentQuestionSchema.parse({
    ...row,
    type: row.type as AgentQuestionType,
    status: row.status as AgentQuestionStatus,
    options: row.optionsJson ? (JSON.parse(row.optionsJson) as string[]) : [],
  });
}

/**
 * Two questions are the same question when they mean the same thing. The model
 * re-asks after a resume with the wording it happens to land on, so the
 * fingerprint has to survive casing, punctuation and whitespace — the same
 * normalization Sprint 68 uses to decide two rules are one rule.
 */
export function questionFingerprint(type: AgentQuestionType, question: string): string {
  const normalized = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(`${type}:${normalized}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListQuestionsOptions {
  status?: AgentQuestionStatus;
  limit?: number;
}

export async function listAgentQuestions(
  db: Db,
  workspaceId: string,
  options: ListQuestionsOptions = {},
): Promise<AgentQuestion[]> {
  return (await db
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspaceId),
        options.status ? eq(agentQuestions.status, options.status) : undefined,
      ),
    )
    .orderBy(desc(agentQuestions.createdAt))
    .limit(Math.min(options.limit ?? 50, 100)))
    .map(rowToAgentQuestion);
}

export async function getAgentQuestion(
  db: Db,
  workspaceId: string,
  questionId: string,
): Promise<AgentQuestion | undefined> {
  const row = (await db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.workspaceId, workspaceId), eq(agentQuestions.id, questionId))))[0];
  return row ? rowToAgentQuestion(row) : undefined;
}

/** Everything one agent run asked — the Inspector's view of a `needs_human` stop. */
export async function listQuestionsForAgentRun(db: Db, agentRunId: string): Promise<AgentQuestion[]> {
  return (await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.agentRunId, agentRunId))
    .orderBy(asc(agentQuestions.createdAt)))
    .map(rowToAgentQuestion);
}

/**
 * The answers a resuming run is entitled to see (D-70.3). Injected into every
 * step's prompt, so the model usually does not have to re-ask at all — the
 * fingerprint check is the safety net for when it does anyway.
 */
export async function listAnsweredQuestionsForPipelineRun(
  db: Db,
  pipelineRunId: string,
): Promise<AgentQuestion[]> {
  return (await db
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.pipelineRunId, pipelineRunId),
        eq(agentQuestions.status, "answered"),
      ),
    )
    .orderBy(asc(agentQuestions.createdAt)))
    .map(rowToAgentQuestion);
}

/** The question that suspended a run: the newest open one it asked. */
export async function openQuestionForPipelineRun(
  db: Db,
  pipelineRunId: string,
): Promise<AgentQuestion | undefined> {
  const row = (await db
    .select()
    .from(agentQuestions)
    .where(
      and(eq(agentQuestions.pipelineRunId, pipelineRunId), eq(agentQuestions.status, "open")),
    )
    .orderBy(desc(agentQuestions.createdAt)))[0];
  return row ? rowToAgentQuestion(row) : undefined;
}

export async function countOpenQuestions(db: Db, workspaceId: string): Promise<number> {
  return (
    ((await db
      .select({ count: sql<number>`count(*)` })
      .from(agentQuestions)
      .where(
        and(eq(agentQuestions.workspaceId, workspaceId), eq(agentQuestions.status, "open")),
      ))[0])?.count ?? 0
  );
}

// ---------------------------------------------------------------------------
// The ask seam (live)
// ---------------------------------------------------------------------------

export interface AgentQuestionsDeps {
  db: Db;
}

export function createAgentQuestions({ db }: AgentQuestionsDeps): AgentQuestionService {
  return {
    async ask(origin: AskQuestionOrigin, args: AskQuestionArgs): Promise<AskResult> {
      const fingerprint = questionFingerprint(args.type, args.question);
      // Scope the memory of what was asked to the pipeline run when there is
      // one: an agent run ends every time a question suspends it, so scoping to
      // the agent run would forget the answer on the very resume it exists for.
      const scope = origin.pipelineRunId
        ? eq(agentQuestions.pipelineRunId, origin.pipelineRunId)
        : eq(agentQuestions.agentRunId, origin.agentRunId);

      const asked = await db
        .select()
        .from(agentQuestions)
        .where(scope)
        .orderBy(asc(agentQuestions.createdAt));

      const sameQuestion = asked.find((row) => row.fingerprint === fingerprint);
      if (sameQuestion?.status === "answered" && sameQuestion.answer) {
        return { status: "answered", questionId: sameQuestion.id, answer: sameQuestion.answer };
      }
      if (sameQuestion?.status === "open") {
        // Re-asked before anyone answered: suspend on the existing row rather
        // than filing a second copy of the same question.
        return { status: "suspend", questionId: sameQuestion.id };
      }
      if (sameQuestion?.status === "dismissed") {
        return {
          status: "refused",
          error: "question_dismissed",
          note: "You already asked this and the founder chose not to answer. Proceed on your best reading, or fail the step and say what is missing.",
        };
      }

      if (asked.length >= AGENT_QUESTIONS_PER_RUN) {
        return {
          status: "refused",
          error: "question_cap_reached",
          note: `This run has already asked ${asked.length} question(s), which is the limit. Proceed on your best reading, or fail the step and say what is missing.`,
        };
      }
      if (await countOpenQuestions(db, origin.workspaceId) >= AGENT_QUESTIONS_OPEN_MAX) {
        return {
          status: "refused",
          error: "workspace_question_backlog",
          note: "There are already too many unanswered questions in this workspace to add another. Proceed on your best reading, or fail the step and say what is missing.",
        };
      }

      const id = randomUUID();
      await db.insert(agentQuestions)
        .values({
          id,
          workspaceId: origin.workspaceId,
          agentRunId: origin.agentRunId,
          pipelineRunId: origin.pipelineRunId,
          stepKey: origin.stepKey,
          type: args.type,
          question: args.question.trim(),
          why: args.why.trim(),
          optionsJson: args.options?.length ? JSON.stringify(args.options) : null,
          fingerprint,
          status: "open",
          answer: null,
          answeredByUserId: null,
          answeredByLabel: null,
          answeredAt: null,
          ruleId: null,
          createdAt: Date.now(),
        });
      return { status: "suspend", questionId: id };
    },
  };
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

export class AgentQuestionNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent question "${id}" not found.`);
    this.name = "AgentQuestionNotFoundError";
  }
}

export class AgentQuestionAlreadyClosedError extends Error {
  constructor(status: AgentQuestionStatus) {
    super(`This question is already ${status}.`);
    this.name = "AgentQuestionAlreadyClosedError";
  }
}

export interface AnswerActor {
  userId: string | null;
  label: string;
}

export interface AnswerQuestionOutcome {
  question: AgentQuestion;
  rule: PreferenceRule | null;
}

/**
 * Record the founder's answer (or their refusal to give one). Deliberately does
 * not resume anything: the caller decides that, so the read path, the tests and
 * the eventual queue-based resume all share one writer.
 */
export async function answerAgentQuestion(
  db: Db,
  workspaceId: string,
  questionId: string,
  input: AnswerAgentQuestionInput,
  actor: AnswerActor,
  now = Date.now(),
): Promise<AnswerQuestionOutcome> {
  const existing = await getAgentQuestion(db, workspaceId, questionId);
  if (!existing) throw new AgentQuestionNotFoundError(questionId);
  if (existing.status !== "open") throw new AgentQuestionAlreadyClosedError(existing.status);

  // D-70.11: the rule is what the founder said to keep, not something parsed
  // out of their prose. Minted before the update so the question can name it.
  let rule: PreferenceRule | null = null;
  if (input.action === "answer" && input.remember) {
    rule = (await upsertPreferenceRule(
      db,
      workspaceId,
      {
        rule: input.remember.rule,
        polarity: input.remember.polarity,
        scopeTaskType: input.remember.scopeTaskType ?? null,
        scopeChannel: input.remember.scopeChannel ?? null,
        // The founder answering in their own words is as authoritative as a
        // rule they wrote by hand; both are statements, not inferences.
        confidence: 100,
        origin: "answered_question",
      },
      now,
    )).rule;
  }

  await db.update(agentQuestions)
    .set({
      status: input.action === "answer" ? "answered" : "dismissed",
      answer: input.action === "answer" ? (input.answer ?? null) : null,
      answeredByUserId: actor.userId,
      answeredByLabel: actor.label,
      answeredAt: now,
      ruleId: rule?.id ?? null,
    })
    .where(eq(agentQuestions.id, questionId));

  return { question: (await getAgentQuestion(db, workspaceId, questionId))!, rule };
}
