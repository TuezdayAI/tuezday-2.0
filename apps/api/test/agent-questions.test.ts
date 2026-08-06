import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_QUESTIONS_OPEN_MAX, AGENT_QUESTIONS_PER_RUN } from "@tuezday/contracts";
import type { Db } from "../src/db";
import {
  agentQuestions,
  pipelineDefinitions,
  pipelineRuns,
  users,
  workspaces,
} from "../src/db/schema";
import { simulatedAgentQuestions, type AgentQuestionService } from "../src/agents/questions";
import {
  answerAgentQuestion,
  countOpenQuestions,
  createAgentQuestions,
  listAnsweredQuestionsForPipelineRun,
  openQuestionForPipelineRun,
  questionFingerprint,
  AgentQuestionAlreadyClosedError,
} from "../src/services/agent-questions";
import { listPreferenceRules } from "../src/services/preference-rules";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PIPELINE_RUN_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const FOUNDER = { userId: USER_ID, label: "Founder" };

function seed(db: Db): void {
  db.insert(users)
    .values({ id: USER_ID, email: "founder@test.dev", name: "Founder", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Asking", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(pipelineDefinitions)
    .values({
      id: "44444444-4444-4444-8444-444444444444",
      workspaceId: WORKSPACE_ID,
      taskKey: "signal_social_post",
      name: "Reference",
      specJson: "{}",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(pipelineRuns)
    .values({
      id: PIPELINE_RUN_ID,
      workspaceId: WORKSPACE_ID,
      definitionId: "44444444-4444-4444-8444-444444444444",
      definitionVersion: 1,
      taskKey: "signal_social_post",
      channel: "linkedin",
      createdBy: "automation",
      createdAt: 1,
    })
    .run();
}

const ARGS = {
  type: "missing_permission" as const,
  question: "May we name the investors in the funding-round post?",
  why: "The plan does not say, and the announcement names three of them.",
  options: ["Yes, name them", "No, keep them out"],
};

describe("the ask seam (Sprint 70)", () => {
  let db: Db;
  let questions: AgentQuestionService;

  beforeEach(() => {
    db = createTestDb();
    seed(db);
    questions = createAgentQuestions({ db });
  });

  const origin = (agentRunId = randomUUID()) => ({
    workspaceId: WORKSPACE_ID,
    agentRunId,
    pipelineRunId: PIPELINE_RUN_ID,
    stepKey: "draft",
  });

  it("records the question and asks the run to suspend", async () => {
    const result = await questions.ask(origin(), ARGS);
    expect(result.status).toBe("suspend");
    const stored = openQuestionForPipelineRun(db, PIPELINE_RUN_ID)!;
    expect(stored.question).toBe(ARGS.question);
    expect(stored.why).toBe(ARGS.why);
    expect(stored.options).toEqual(ARGS.options);
    expect(stored.stepKey).toBe("draft");
  });

  it("hands back the answer when the same question is re-asked after a resume (D-70.3)", async () => {
    const first = await questions.ask(origin("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), ARGS);
    if (first.status !== "suspend") throw new Error("expected a suspension");
    answerAgentQuestion(
      db,
      WORKSPACE_ID,
      first.questionId,
      { action: "answer", answer: "No — not until the round is public.", resume: false },
      FOUNDER,
    );

    // The resumed step is a *different* agent run asking the same pipeline run's
    // question, in whatever wording the model lands on this time.
    const second = await questions.ask(origin("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), {
      ...ARGS,
      question: "  MAY WE NAME the investors, in the funding round post?  ",
    });
    expect(second.status).toBe("answered");
    if (second.status !== "answered") return;
    expect(second.answer).toBe("No — not until the round is public.");
    // And it did not file a second copy of a question already settled.
    expect(db.select().from(agentQuestions).all()).toHaveLength(1);
  });

  it("suspends on the existing row rather than duplicating an unanswered question", async () => {
    const first = await questions.ask(origin(), ARGS);
    const again = await questions.ask(origin(), ARGS);
    expect(again).toEqual(first);
    expect(db.select().from(agentQuestions).all()).toHaveLength(1);
  });

  it("counts the cap over the pipeline run, so resumes cannot reset it (D-70.4)", async () => {
    for (let i = 0; i < AGENT_QUESTIONS_PER_RUN; i += 1) {
      // A different agent run each time — exactly what a resume produces.
      const result = await questions.ask(origin(), {
        ...ARGS,
        question: `Question number ${i} about the post?`,
      });
      expect(result.status).toBe("suspend");
    }
    const overCap = await questions.ask(origin(), {
      ...ARGS,
      question: "One more thing I would like to know?",
    });
    expect(overCap.status).toBe("refused");
    if (overCap.status !== "refused") return;
    expect(overCap.error).toBe("question_cap_reached");
    // Refused as data, not recorded: a capped run must keep going, not stall.
    expect(db.select().from(agentQuestions).all()).toHaveLength(AGENT_QUESTIONS_PER_RUN);
  });

  it("refuses when the workspace already has too many unanswered questions", async () => {
    for (let i = 0; i < AGENT_QUESTIONS_OPEN_MAX; i += 1) {
      db.insert(agentQuestions)
        .values({
          id: randomUUID(),
          workspaceId: WORKSPACE_ID,
          agentRunId: randomUUID(),
          pipelineRunId: null,
          stepKey: null,
          type: "missing_fact",
          question: `Backlogged question ${i}?`,
          why: "Earlier run.",
          optionsJson: null,
          fingerprint: `fp-${i}`,
          status: "open",
          createdAt: 1,
        })
        .run();
    }
    expect(countOpenQuestions(db, WORKSPACE_ID)).toBe(AGENT_QUESTIONS_OPEN_MAX);
    const result = await questions.ask(origin(), ARGS);
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.error).toBe("workspace_question_backlog");
  });

  it("does not re-ask something the founder declined to answer", async () => {
    const first = await questions.ask(origin(), ARGS);
    if (first.status !== "suspend") throw new Error("expected a suspension");
    answerAgentQuestion(db, WORKSPACE_ID, first.questionId, { action: "dismiss", resume: false }, FOUNDER);

    const again = await questions.ask(origin(), ARGS);
    expect(again.status).toBe("refused");
    if (again.status !== "refused") return;
    expect(again.error).toBe("question_dismissed");
  });

  it("answers without suspending in every non-live mode (D-70.5)", async () => {
    const simulated = simulatedAgentQuestions();
    const result = await simulated.ask(origin(), ARGS);
    expect(result.status).toBe("simulated");
    expect(db.select().from(agentQuestions).all()).toHaveLength(0);
  });

  it("fingerprints by meaning, not by punctuation", () => {
    expect(questionFingerprint("missing_fact", "What is the price?")).toBe(
      questionFingerprint("missing_fact", "  what is   the PRICE  "),
    );
    // The type is part of the identity: the same words asking permission and
    // asking for a fact are two different questions.
    expect(questionFingerprint("missing_fact", "What is the price?")).not.toBe(
      questionFingerprint("missing_permission", "What is the price?"),
    );
  });
});

describe("answering an agent question (Sprint 70)", () => {
  let db: Db;
  let questions: AgentQuestionService;

  beforeEach(() => {
    db = createTestDb();
    seed(db);
    questions = createAgentQuestions({ db });
  });

  async function open(): Promise<string> {
    const result = await questions.ask(
      { workspaceId: WORKSPACE_ID, agentRunId: randomUUID(), pipelineRunId: PIPELINE_RUN_ID, stepKey: "draft" },
      ARGS,
    );
    if (result.status !== "suspend") throw new Error("expected a suspension");
    return result.questionId;
  }

  it("records who answered and what they said", async () => {
    const id = await open();
    const { question } = answerAgentQuestion(
      db,
      WORKSPACE_ID,
      id,
      { action: "answer", answer: "Yes, name them.", resume: false },
      FOUNDER,
    );
    expect(question.status).toBe("answered");
    expect(question.answer).toBe("Yes, name them.");
    expect(question.answeredByLabel).toBe("Founder");
    expect(listAnsweredQuestionsForPipelineRun(db, PIPELINE_RUN_ID)).toHaveLength(1);
  });

  it("mints a preference rule only when the founder says to keep one (D-70.11)", async () => {
    const plain = await open();
    answerAgentQuestion(
      db,
      WORKSPACE_ID,
      plain,
      { action: "answer", answer: "No — not until the round is public.", resume: false },
      FOUNDER,
    );
    // The prose of the answer is not parsed into a rule.
    expect(listPreferenceRules(db, WORKSPACE_ID)).toHaveLength(0);

    const kept = await questions.ask(
      { workspaceId: WORKSPACE_ID, agentRunId: randomUUID(), pipelineRunId: null, stepKey: null },
      { ...ARGS, question: "And for the press release?" },
    );
    if (kept.status !== "suspend") throw new Error("expected a suspension");
    const outcome = answerAgentQuestion(
      db,
      WORKSPACE_ID,
      kept.questionId,
      {
        action: "answer",
        answer: "Same rule there.",
        resume: false,
        remember: {
          rule: "Never name investors before the round is public.",
          polarity: "avoid",
        },
      },
      FOUNDER,
    );
    expect(outcome.rule?.origin).toBe("answered_question");
    expect(outcome.rule?.confidence).toBe(100);
    // Attributable both ways: the rule page can say where it came from.
    expect(outcome.question.ruleId).toBe(outcome.rule?.id);
  });

  it("refuses to answer the same question twice", async () => {
    const id = await open();
    answerAgentQuestion(db, WORKSPACE_ID, id, { action: "answer", answer: "Yes.", resume: false }, FOUNDER);
    expect(() =>
      answerAgentQuestion(db, WORKSPACE_ID, id, { action: "answer", answer: "No.", resume: false }, FOUNDER),
    ).toThrow(AgentQuestionAlreadyClosedError);
  });
});
