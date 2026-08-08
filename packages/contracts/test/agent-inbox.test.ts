import { describe, expect, it } from "vitest";
import {
  AGENT_INBOX_ITEM_KINDS,
  AGENT_INBOX_LANES,
  AGENT_QUESTIONS_OPEN_MAX,
  AGENT_QUESTIONS_PER_RUN,
  AGENT_QUESTION_TYPES,
  AGENT_TOOL_NAMES,
  ASK_TOOL_NAMES,
  PRIORITY_ITEM_KINDS,
  QUESTION_TEXT_MAX_CHARS,
  agentInboxLaneFor,
  agentQuestionSchema,
  answerAgentQuestionInputSchema,
  isAskToolName,
  isProposeToolName,
  toolInputSchemas,
} from "../src/index";

const RUN_ID = "99999999-9999-4999-8999-999999999999";

function question(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    agentRunId: RUN_ID,
    pipelineRunId: "33333333-3333-4333-8333-333333333333",
    agentTaskId: null,
    stepKey: "draft",
    type: "missing_permission" as const,
    question: "May we name the investors in the funding-round post?",
    why: "The campaign plan does not say, and the announcement names three of them.",
    options: ["Yes, name them", "No, keep them out"],
    status: "open" as const,
    answer: null,
    answeredByUserId: null,
    answeredByLabel: null,
    answeredAt: null,
    ruleId: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("the ask lane's vocabulary (Sprint 70)", () => {
  it("adds one ask tool that is not a propose tool", () => {
    expect([...ASK_TOOL_NAMES]).toEqual(["ask_founder"]);
    expect(AGENT_TOOL_NAMES).toContain("ask_founder");
    // A tool that records a question is not a tool that acts. Filing it under
    // `propose` would count it against the proposal cap and, worse, would read
    // to a founder as something the agent tried to do.
    expect(isProposeToolName("ask_founder")).toBe(false);
    expect(isAskToolName("ask_founder")).toBe(true);
    expect(isAskToolName("propose_publication")).toBe(false);
  });

  it("names the four things an agent can be stuck on", () => {
    expect([...AGENT_QUESTION_TYPES]).toEqual([
      "disambiguation",
      "missing_permission",
      "missing_fact",
      "policy_escalation",
    ]);
  });

  it("forces the model to say why it is asking, and bounds what it may write", () => {
    const schema = toolInputSchemas.ask_founder;
    expect(schema.safeParse({ type: "missing_fact", question: "What is the price?" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        type: "missing_fact",
        question: "x".repeat(QUESTION_TEXT_MAX_CHARS + 1),
        why: "Because.",
      }).success,
    ).toBe(false);
    // One option is not a choice; five is a form.
    expect(
      schema.safeParse({
        type: "disambiguation",
        question: "Which segment?",
        why: "Two read equally well.",
        options: ["Only one"],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        type: "disambiguation",
        question: "Which segment?",
        why: "Two read equally well.",
        options: ["Ops leads", "Finance leads"],
      }).success,
    ).toBe(true);
  });

  it("caps how much one run may ask, and how much may pile up unanswered", () => {
    expect(AGENT_QUESTIONS_PER_RUN).toBeLessThan(AGENT_QUESTIONS_OPEN_MAX);
    expect(AGENT_QUESTIONS_PER_RUN).toBeGreaterThan(0);
  });
});

describe("agent question schema (Sprint 70)", () => {
  it("accepts an open question and an answered one", () => {
    expect(agentQuestionSchema.safeParse(question()).success).toBe(true);
    expect(
      agentQuestionSchema.safeParse(
        question({ status: "answered", answer: "No — never name them.", answeredAt: 5 }),
      ).success,
    ).toBe(true);
  });

  it("refuses an answered question with no answer, and an open one with an answer time", () => {
    // Both would make the inbox lie: the first shows a resolved question with
    // nothing to read, the second an open one nobody can answer again.
    expect(agentQuestionSchema.safeParse(question({ status: "answered" })).success).toBe(false);
    expect(agentQuestionSchema.safeParse(question({ answeredAt: 5 })).success).toBe(false);
  });

  it("allows a question with nothing to resume", () => {
    const oneShot = agentQuestionSchema.parse(
      question({ pipelineRunId: null, stepKey: null }),
    );
    expect(oneShot.pipelineRunId).toBeNull();
  });
});

describe("answering (Sprint 70)", () => {
  it("requires an answer to answer with", () => {
    expect(answerAgentQuestionInputSchema.safeParse({ action: "answer" }).success).toBe(false);
    expect(
      answerAgentQuestionInputSchema.safeParse({ action: "answer", answer: "Yes." }).success,
    ).toBe(true);
    expect(answerAgentQuestionInputSchema.safeParse({ action: "dismiss" }).success).toBe(true);
  });

  it("resumes by default, because that is the point of answering", () => {
    const parsed = answerAgentQuestionInputSchema.parse({ answer: "Yes." });
    expect(parsed.action).toBe("answer");
    expect(parsed.resume).toBe(true);
  });

  it("will not remember anything from a dismissal", () => {
    // Declining to answer teaches nothing; a rule minted from it would be a
    // rule the founder never stated.
    expect(
      answerAgentQuestionInputSchema.safeParse({
        action: "dismiss",
        remember: { rule: "Never name investors in launch posts." },
      }).success,
    ).toBe(false);
  });

  it("takes the rule to remember explicitly, never inferring it (D-70.11)", () => {
    const parsed = answerAgentQuestionInputSchema.parse({
      answer: "No — not until the round is public.",
      remember: { rule: "Never name investors before the round is public." },
    });
    expect(parsed.remember?.rule).toBe("Never name investors before the round is public.");
    expect(parsed.remember?.polarity).toBe("do");
  });
});

describe("inbox lanes (Sprint 70)", () => {
  it("keeps the nine priority kinds and adds exactly two", () => {
    expect(AGENT_INBOX_ITEM_KINDS).toEqual([
      ...PRIORITY_ITEM_KINDS,
      "agent_question",
      "setup_task",
      // Sprint 79: a finished background task, unread.
      "agent_task_result",
    ]);
  });

  it("lanes every kind, with no gaps", () => {
    for (const kind of AGENT_INBOX_ITEM_KINDS) {
      expect(AGENT_INBOX_LANES, kind).toContain(agentInboxLaneFor(kind));
    }
  });

  it("puts judgment in review, facts in notify, and only questions in ask", () => {
    expect(agentInboxLaneFor("agent_question")).toBe("ask");
    for (const kind of ["authorization", "content_review", "signal_triage", "learning_review"] as const) {
      expect(agentInboxLaneFor(kind)).toBe("review");
    }
    // A failure is true whether or not anyone decides anything about it.
    for (const kind of ["execution_failure", "policy_block", "campaign_risk", "setup_task"] as const) {
      expect(agentInboxLaneFor(kind)).toBe("notify");
    }
  });
});
