import { describe, expect, it } from "vitest";
import {
  pipelineSpecSchema,
  type PipelineDefinition,
  type PipelineRunMode,
  type PipelineSpec,
} from "@tuezday/contracts";
import type { Db } from "../src/db";
import { agentQuestions, drafts, signals, workspaces } from "../src/db/schema";
import type { EvidenceStore } from "../src/evidence/store";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import type { SafeFetchService } from "../src/safe-fetch/index";
import { createAgentQuestions } from "../src/services/agent-questions";
import { answerAgentQuestion, openQuestionForPipelineRun } from "../src/services/agent-questions";
import {
  createPipelineDefinition,
  setPipelineStatus,
} from "../src/services/pipeline-definitions";
import {
  decidePipelineRun,
  executePipelineRun,
  startPipelineRun,
  type PipelineEngineDeps,
} from "../src/services/pipeline-engine";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SIGNAL_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR = { userId: null, label: "founder" };
const FOUNDER = { userId: null, label: "founder" };

const noEvidence: EvidenceStore = {
  async health() {
    return { healthy: true };
  },
  async createCollection() {
    return "unused";
  },
  async addDocument() {
    return "unused";
  },
  async attachDocument() {},
  async deleteDocument() {},
  async search() {
    return [];
  },
};

const noFetch: SafeFetchService = {
  async fetch() {
    throw new Error("not used");
  },
  validateUrl(url: string) {
    return new URL(url);
  },
};

/** One drafting step allowed to ask, then the deterministic propose step. */
function spec(): PipelineSpec {
  return pipelineSpecSchema.parse({
    steps: [
      {
        key: "draft",
        title: "Draft",
        goal: "Write the post; ask if the plan does not cover something.",
        kind: "agent",
        tools: ["ask_founder"],
        tier: "cheap",
        output: "draft",
        maxSteps: 3,
        maxTokens: 8_000,
      },
      { key: "propose", title: "Propose", goal: "Submit.", kind: "propose", output: "proposal" },
    ],
    budget: { maxTokens: 100_000 },
  });
}

const QUESTION = "May we name the investors in the funding-round post?";

/** Pass 1 asks and never gets to answer; pass 2 (the resume) writes the post. */
const script = (): ScriptedStep[] => [
  {
    toolCalls: [
      {
        name: "ask_founder",
        arguments: {
          type: "missing_permission",
          question: QUESTION,
          why: "The campaign plan does not say, and the announcement names three of them.",
          options: ["Yes, name them", "No, keep them out"],
        },
      },
    ],
  },
  { text: JSON.stringify({ content: "A post that names no investors.", confidence: 90 }) },
];

function fixture() {
  const db = createTestDb();
  db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Asking", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(signals)
    .values({
      id: SIGNAL_ID,
      workspaceId: WORKSPACE_ID,
      content: "A portfolio company announced a Series B this morning.",
      source: "manual",
      sourceUrl: null,
      createdAt: 2,
    })
    .run();
  return { db, questions: createAgentQuestions({ db }) };
}

function definitionFor(db: Db): PipelineDefinition {
  const definition = createPipelineDefinition(
    db,
    WORKSPACE_ID,
    { taskKey: "signal_social_post", name: "Asking", description: "", spec: spec() },
    ACTOR,
  );
  setPipelineStatus(db, WORKSPACE_ID, definition.id, "active");
  return definition;
}

async function startRun(
  db: Db,
  deps: PipelineEngineDeps,
  definition: PipelineDefinition,
  mode: PipelineRunMode,
) {
  const run = startPipelineRun(db, {
    workspaceId: WORKSPACE_ID,
    definition,
    signalId: SIGNAL_ID,
    channel: "linkedin",
    campaignId: null,
    personaId: null,
    mode,
    createdBy: "automation",
  });
  return executePipelineRun(db, deps, WORKSPACE_ID, run.id);
}

describe("the ask lane, end to end (Sprint 70 acceptance)", () => {
  it("suspends the run on a question and continues the SAME run on the answer", async () => {
    const { db, questions } = fixture();
    const gateway = new ScriptedGateway(script());
    const deps: PipelineEngineDeps = {
      llm: gateway,
      evidence: noEvidence,
      safeFetch: noFetch,
      questions,
    };
    const definition = definitionFor(db);

    // 1. The agent hits an ambiguity it cannot resolve and stops.
    const first = await startRun(db, deps, definition, "live");
    expect(first.run.status).toBe("escalated");
    expect(first.run.pausedAtStepKey).toBe("draft");
    expect(first.run.escalationReason).toContain("needs_human");
    expect(db.select().from(drafts).all()).toHaveLength(0);

    // 2. The question is durable, attached to the run, and carries what it
    //    takes to answer it in one click.
    const question = openQuestionForPipelineRun(db, first.run.id)!;
    expect(question.question).toBe(QUESTION);
    expect(question.type).toBe("missing_permission");
    expect(question.options).toEqual(["Yes, name them", "No, keep them out"]);
    expect(question.stepKey).toBe("draft");

    // 3. The founder answers.
    answerAgentQuestion(
      db,
      WORKSPACE_ID,
      question.id,
      { action: "answer", answer: "No — not until the round is public.", resume: false },
      FOUNDER,
    );

    // 4. The same run continues to completion.
    const resumed = await decidePipelineRun(db, deps, WORKSPACE_ID, first.run.id, {
      action: "resume",
    });
    expect(resumed.run.id).toBe(first.run.id);
    expect(resumed.run.status).toBe("succeeded");
    expect(db.select().from(drafts).all()).toHaveLength(1);

    // 5. And the resumed step was actually told the answer (D-70.3) — the
    //    prompt carries it, which is why the model did not have to ask again.
    const resumedPrompt = gateway.calls.at(-1)!.messages[0]!.content;
    expect(resumedPrompt).toContain("Answers you already have");
    expect(resumedPrompt).toContain("No — not until the round is public.");
    expect(resumedPrompt).toContain("Do not ask them again.");
  });

  it("never suspends a dry run, so previews and evals still finish (D-70.5)", async () => {
    const { db, questions } = fixture();
    const deps: PipelineEngineDeps = {
      llm: new ScriptedGateway(script()),
      evidence: noEvidence,
      safeFetch: noFetch,
      questions,
    };
    const outcome = await startRun(db, deps, definitionFor(db), "dry_run");
    expect(outcome.run.status).toBe("succeeded");
    // Nothing was recorded and nobody was asked.
    expect(db.select().from(agentQuestions).all()).toHaveLength(0);
  });

  it("does not offer the tool at all when nothing can answer it (D-70.7 shape)", async () => {
    const { db } = fixture();
    // A live run with no ask seam: the model is never shown `ask_founder`, so
    // it answers directly rather than calling a tool that cannot be honoured.
    const gateway = new ScriptedGateway([
      { text: JSON.stringify({ content: "A post written without asking.", confidence: 80 }) },
    ]);
    const outcome = await startRun(
      db,
      { llm: gateway, evidence: noEvidence, safeFetch: noFetch },
      definitionFor(db),
      "live",
    );
    expect(outcome.run.status).toBe("succeeded");
    expect(gateway.calls[0]!.tools ?? []).toHaveLength(0);
  });
});
