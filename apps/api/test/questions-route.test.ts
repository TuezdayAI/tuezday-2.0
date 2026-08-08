import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentQuestionSchema,
  pipelineSpecSchema,
  type PipelineSpec,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { agentQuestions, signals } from "../src/db/schema";
import type { EvidenceStore } from "../src/evidence/store";
import { ScriptedGateway } from "../src/llm/scripted";
import type { SafeFetchService } from "../src/safe-fetch/index";
import {
  createAgentQuestions,
  openQuestionForPipelineRun,
} from "../src/services/agent-questions";
import {
  createPipelineDefinition,
  setPipelineStatus,
} from "../src/services/pipeline-definitions";
import { executePipelineRun, startPipelineRun } from "../src/services/pipeline-engine";
import { listPreferenceRules } from "../src/services/preference-rules";
import { buildAuthedApp, createTestDb, registerUser } from "./helpers";

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

/** A drafting step allowed to ask, then the deterministic propose step. */
function askingSpec(): PipelineSpec {
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

describe("the ask lane over HTTP (Sprint 70)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let gateway: ScriptedGateway;

  beforeEach(async () => {
    db = await createTestDb();
    gateway = new ScriptedGateway([
      {
        toolCalls: [
          {
            name: "ask_founder",
            arguments: {
              type: "missing_permission",
              question: "May we name the investors in the funding-round post?",
              why: "The plan does not say, and the announcement names three.",
            },
          },
        ],
      },
      { text: JSON.stringify({ content: "A post that names no investors.", confidence: 90 }) },
    ]);
    app = await buildAuthedApp({ db, llm: gateway });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Asking" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedQuestion(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db.insert(agentQuestions)
      .values({
        id,
        workspaceId,
        agentRunId: randomUUID(),
        pipelineRunId: null,
        stepKey: "draft",
        type: "missing_permission",
        question: "May we name the investors?",
        why: "The plan does not say.",
        optionsJson: JSON.stringify(["Yes", "No"]),
        fingerprint: `fp-${id}`,
        status: "open",
        createdAt: 1,
        ...overrides,
      });
    return id;
  }

  const answerUrl = (id: string) => `/workspaces/${workspaceId}/questions/${id}/answer`;

  it("lists the open questions", async () => {
    await seedQuestion();
    await seedQuestion({ status: "answered", answer: "No.", answeredAt: 2, answeredByLabel: "founder" });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/questions?status=open`,
    });
    expect(res.statusCode).toBe(200);
    const { questions } = res.json() as { questions: unknown[] };
    expect(questions).toHaveLength(1);
    expect(agentQuestionSchema.parse(questions[0]).status).toBe("open");
  });

  it("records an answer and says nothing was resumed when nothing was waiting", async () => {
    const id = await seedQuestion();
    const res = await app.inject({
      method: "POST",
      url: answerUrl(id),
      payload: { answer: "No — not until the round is public." },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.question.status).toBe("answered");
    expect(body.question.answeredByLabel).toBeTruthy();
    expect(body.rule).toBeNull();
    // The question came from a one-shot run: there was never anything to resume.
    expect(body.resumedRun).toBeNull();
  });

  it("keeps a rule only when the founder said what to keep (D-70.11)", async () => {
    const plain = await seedQuestion();
    await app.inject({ method: "POST", url: answerUrl(plain), payload: { answer: "Yes, fine." } });
    expect(await listPreferenceRules(db, workspaceId)).toHaveLength(0);

    const kept = await seedQuestion();
    const res = await app.inject({
      method: "POST",
      url: answerUrl(kept),
      payload: {
        answer: "No — not until the round is public.",
        remember: {
          rule: "Never name investors before the round is public.",
          polarity: "avoid",
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rule.origin).toBe("answered_question");
    expect(await listPreferenceRules(db, workspaceId)).toHaveLength(1);
  });

  it("lets the founder decline without teaching anything", async () => {
    const id = await seedQuestion();
    const res = await app.inject({
      method: "POST",
      url: answerUrl(id),
      payload: { action: "dismiss" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().question.status).toBe("dismissed");
    expect(res.json().question.answer).toBeNull();
  });

  it("refuses an answer with nothing in it, and a second answer to the same question", async () => {
    const id = await seedQuestion();
    const empty = await app.inject({ method: "POST", url: answerUrl(id), payload: {} });
    expect(empty.statusCode).toBe(400);

    await app.inject({ method: "POST", url: answerUrl(id), payload: { answer: "Yes." } });
    const again = await app.inject({ method: "POST", url: answerUrl(id), payload: { answer: "No." } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("question_closed");
  });

  it("404s an unknown question rather than silently doing nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: answerUrl(randomUUID()),
      payload: { answer: "Yes." },
    });
    expect(res.statusCode).toBe(404);
  });

  it("continues the blocked run in the same click (acceptance)", async () => {
    // A live run that stopped to ask, exactly as the engine leaves it.
    const definition = await createPipelineDefinition(
      db,
      workspaceId,
      { taskKey: "signal_social_post", name: "Asking", description: "", spec: askingSpec() },
      { userId: null, label: "founder" },
    );
    await setPipelineStatus(db, workspaceId, definition.id, "active");
    const signalId = randomUUID();
    await db.insert(signals)
      .values({
        id: signalId,
        workspaceId,
        content: "A portfolio company announced a Series B.",
        source: "manual",
        sourceUrl: null,
        createdAt: 1,
      });
    const run = await startPipelineRun(db, {
      workspaceId,
      definition,
      signalId,
      channel: "linkedin",
      campaignId: null,
      personaId: null,
      mode: "live",
      createdBy: "automation",
    });
    const outcome = await executePipelineRun(
      db,
      { llm: gateway, evidence: noEvidence, safeFetch: noFetch, questions: createAgentQuestions({ db }) },
      workspaceId,
      run.id,
    );
    expect(outcome.run.status).toBe("escalated");
    const question = (await openQuestionForPipelineRun(db, run.id))!;

    const res = await app.inject({
      method: "POST",
      url: answerUrl(question.id),
      payload: { answer: "No — not until the round is public." },
    });
    expect(res.statusCode).toBe(200);
    // One click: the answer is recorded and the same run finished.
    expect(res.json().resumedRun).toEqual({ id: run.id, status: "succeeded" });
  });

  it("keeps one workspace's questions out of another's", async () => {
    const id = await seedQuestion();
    const stranger = await registerUser(app, "stranger@test.dev", "Stranger");
    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/questions`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(list.statusCode).toBe(403);
    const answer = await app.inject({
      method: "POST",
      url: answerUrl(id),
      headers: { authorization: `Bearer ${stranger.token}` },
      payload: { answer: "Yes." },
    });
    expect(answer.statusCode).toBe(403);
  });
});
