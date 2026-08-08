import { describe, expect, it } from "vitest";
import {
  PREFERENCE_MAX_TOKENS,
  pipelineSpecSchema,
  type PipelineDefinition,
  type PipelineSpec,
} from "@tuezday/contracts";
import { resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../src/db";
import { drafts, signals, workspaces } from "../src/db/schema";
import type { EvidenceStore } from "../src/evidence/store";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import type { SafeFetchService } from "../src/safe-fetch/index";
import { applyDraftAction, getDraft, listDrafts } from "../src/services/drafts";
import { runPreferenceExtraction } from "../src/services/preference-extraction";
import {
  createManualRule,
  listPreferenceRules,
  retrievePreferenceRules,
  setRuleStatus,
} from "../src/services/preference-rules";
import {
  createPipelineDefinition,
  setPipelineStatus,
} from "../src/services/pipeline-definitions";
import { executePipelineRun, startPipelineRun } from "../src/services/pipeline-engine";
import type { PipelineEngineDeps } from "../src/services/pipeline-engine";
import type { AgentStepParams, AgentStepResult, LlmGateway } from "../src/llm/gateway";
import { GatewayError } from "../src/llm/gateway";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SIGNAL_ID = "33333333-3333-4333-8333-333333333333";
const DRAFT_ID = "44444444-4444-4444-8444-444444444444";
const HUMAN = { userId: null, label: "founder", human: true };
const ACTOR = { userId: null, label: "founder" };

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

const emptyDocs: BrainContents = { soul: "", icp: "", voice: "", history: "", now: "" };

async function seedWorkspace(): Promise<Db> {
  const db = await createTestDb();
  await db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Memory", createdAt: 1, updatedAt: 1 });
  return db;
}

// --- The resolver seam ------------------------------------------------------

describe("preference injection — resolver section (Sprint 68)", () => {
  it("pushes no section at all for a call site that does not participate", () => {
    const resolved = resolveContext({
      workspaceName: "Memory",
      docs: emptyDocs,
      taskType: "signal_response",
      channel: "linkedin",
    });
    expect(resolved.sections.find((section) => section.key === "preferences")).toBeUndefined();
  });

  it("renders the rules with their provenance and says the voice doc wins", () => {
    const resolved = resolveContext({
      workspaceName: "Memory",
      docs: emptyDocs,
      taskType: "signal_response",
      channel: "linkedin",
      preferences: {
        rules: [
          {
            id: "a",
            rule: "Never open with a rhetorical question",
            polarity: "avoid",
            confidence: 85,
            observationCount: 3,
            scope: "signal_response on linkedin",
          },
        ],
      },
    });
    const section = resolved.sections.find((s) => s.key === "preferences")!;
    expect(section.included).toBe(true);
    expect(section.layer).toBe("preferences");
    expect(section.content).toContain("Never open with a rhetorical question");
    expect(section.content).toContain("learned from 3 edits");
    // Inferred rules must not outrank the founder's authored voice doc.
    expect(section.content).toContain("the voice doc wins");
    expect(section.reason).toContain("reversible");
  });

  it("states why it is empty rather than going silent", () => {
    const resolved = resolveContext({
      workspaceName: "Memory",
      docs: emptyDocs,
      taskType: "signal_response",
      channel: "linkedin",
      preferencesExclusionReason: "no active learned rules apply to this task yet.",
    });
    const section = resolved.sections.find((s) => s.key === "preferences")!;
    expect(section.included).toBe(false);
    expect(section.reason).toContain("no active learned rules");
  });

  it("drops the lowest-ranked rules to fit the section's own budget", () => {
    const rules = Array.from({ length: 40 }, (_, index) => ({
      id: `rule-${index}`,
      rule: `Rule number ${index} about a fairly wordy stylistic preference the founder holds`,
      polarity: "avoid" as const,
      confidence: 90 - index,
      observationCount: 2,
      scope: "all tasks",
    }));
    const resolved = resolveContext({
      workspaceName: "Memory",
      docs: emptyDocs,
      taskType: "signal_response",
      channel: "linkedin",
      preferences: { rules },
    });
    const section = resolved.sections.find((s) => s.key === "preferences")!;
    expect(section.tokens).toBeLessThanOrEqual(PREFERENCE_MAX_TOKENS);
    // The highest-ranked rule survives; the tail is what gets cut.
    expect(section.content).toContain("Rule number 0 ");
    expect(section.content).not.toContain("Rule number 39 ");
    expect(section.reason).toContain("did not fit");
  });

  it("is dropped after few-shot examples and before zoomed content when the bundle is over budget", () => {
    const resolved = resolveContext({
      workspaceName: "Memory",
      docs: { ...emptyDocs, soul: "We believe in usage-based pricing. ".repeat(200) },
      taskType: "signal_response",
      channel: "linkedin",
      tokenBudget: 200,
      preferences: {
        rules: [
          {
            id: "a",
            rule: "Never open with a rhetorical question",
            polarity: "avoid",
            confidence: 85,
            observationCount: 3,
            scope: "all tasks",
          },
        ],
      },
      examples: {
        query: "pricing",
        approved: [{ content: "An approved post about pricing.", wasEdited: false }],
        rejected: [],
      },
    });
    const examples = resolved.sections.find((s) => s.key === "examples")!;
    const preferences = resolved.sections.find((s) => s.key === "preferences")!;
    expect(examples.included).toBe(false);
    expect(preferences.included).toBe(false);
    expect(preferences.reason).toContain("token budget");
  });
});

// --- Retrieval --------------------------------------------------------------

describe("preference retrieval ranking (Sprint 68)", () => {
  it("returns only active rules, most specific scope first (D-68.5)", async () => {
    const db = await seedWorkspace();
    const global = await createManualRule(db, WORKSPACE_ID, {
      rule: "Name the segment, not the persona",
      polarity: "avoid",
    });
    const scoped = await createManualRule(db, WORKSPACE_ID, {
      rule: "Never open with a rhetorical question",
      polarity: "avoid",
      scopeChannel: "linkedin",
      scopeTaskType: "signal_response",
    });
    const offChannel = await createManualRule(db, WORKSPACE_ID, {
      rule: "Keep the subject line under nine words",
      polarity: "avoid",
      scopeChannel: "email",
    });
    await setRuleStatus(db, WORKSPACE_ID, offChannel.id, "active");

    const retrieved = (await retrievePreferenceRules(db, WORKSPACE_ID, {
      taskType: "signal_response",
      channel: "linkedin",
    }))!;
    expect(retrieved.rules.map((rule) => rule.id)).toEqual([scoped.id, global.id]);
    expect(retrieved.rules[0]!.scope).toBe("signal_response on linkedin");
  });

  it("omits a rule the founder switched off", async () => {
    const db = await seedWorkspace();
    const rule = await createManualRule(db, WORKSPACE_ID, {
      rule: "Never open with a rhetorical question",
      polarity: "avoid",
    });
    await setRuleStatus(db, WORKSPACE_ID, rule.id, "disabled");
    expect(
      await retrievePreferenceRules(db, WORKSPACE_ID, {
        taskType: "signal_response",
        channel: "linkedin",
      }),
    ).toBeNull();
  });

  it("does not move the hit count — retrieval is read-only (D-68.6)", async () => {
    const db = await seedWorkspace();
    await createManualRule(db, WORKSPACE_ID, {
      rule: "Never open with a rhetorical question",
      polarity: "avoid",
    });
    for (let i = 0; i < 5; i += 1) {
      await retrievePreferenceRules(db, WORKSPACE_ID, {
        taskType: "signal_response",
        channel: "linkedin",
      });
    }
    expect((await listPreferenceRules(db, WORKSPACE_ID))[0]!.appliedCount).toBe(0);
  });
});

// --- The acceptance criterion ----------------------------------------------

function miniSpec(): PipelineSpec {
  return pipelineSpecSchema.parse({
    steps: [
      {
        key: "draft",
        title: "Draft",
        goal: "Write the post.",
        kind: "agent",
        tools: [],
        tier: "cheap",
        output: "draft",
        maxSteps: 2,
        maxTokens: 8_000,
      },
      {
        key: "critique",
        title: "Critique",
        goal: "Judge the draft.",
        kind: "agent",
        tools: [],
        tier: "cheap",
        output: "findings",
        maxSteps: 2,
        maxTokens: 8_000,
      },
      { key: "propose", title: "Propose", goal: "Submit.", kind: "propose", output: "proposal" },
    ],
    budget: { maxTokens: 100_000 },
  });
}

const engineRun = (content: string): ScriptedStep[] => [
  { text: JSON.stringify({ content, confidence: 90 }) },
  { text: JSON.stringify({ score: 90, findings: [], guardrailUncertain: false, confidence: 90 }) },
];

/**
 * Engine steps come off the script; the extraction call is answered separately.
 * `generateStructured` prefers `agentStep` when a gateway exposes one, so the
 * two paths have to be told apart here or extraction would silently eat the
 * engine's script — the pipeline step's system prompt is the discriminator.
 */
class ExtractionAndEngineGateway extends ScriptedGateway {
  constructor(
    script: ScriptedStep[],
    private readonly extractions: string[],
  ) {
    super(script);
  }
  override async agentStep(params: AgentStepParams): Promise<AgentStepResult> {
    if (params.system?.includes("content pipeline for the workspace")) {
      return await super.agentStep(params);
    }
    const next = this.extractions.shift();
    if (next === undefined) throw new GatewayError("provider_error", "no extraction scripted");
    return {
      message: { role: "assistant", content: next },
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      model: "fake",
      provider: "fake",
      durationMs: 1,
    };
  }
}

async function runEngineOnce(db: Db, gateway: LlmGateway, definition: PipelineDefinition) {
  const deps: PipelineEngineDeps = {
    llm: gateway,
    evidence: noEvidence,
    safeFetch: {} as unknown as SafeFetchService,
  };
  const run = await startPipelineRun(db, {
    workspaceId: WORKSPACE_ID,
    definition,
    signalId: SIGNAL_ID,
    channel: "linkedin",
    mode: "live",
    createdBy: "founder",
  });
  return await executePipelineRun(db, deps, WORKSPACE_ID, run.id);
}

describe("this morning's edit changes this afternoon's generation (Sprint 68 acceptance)", () => {
  it("captures an edit, learns a rule, and the next engine draft step sees it — until it is switched off", async () => {
    const db = await seedWorkspace();
    await db.insert(signals)
      .values({
        id: SIGNAL_ID,
        workspaceId: WORKSPACE_ID,
        content: "A competitor moved to usage-based pricing.",
        source: "manual",
        sourceUrl: null,
        createdAt: 2,
      });
    await db.insert(drafts)
      .values({
        id: DRAFT_ID,
        workspaceId: WORKSPACE_ID,
        taskType: "signal_response",
        channel: "linkedin",
        originalContent: "Should you charge per seat? Here is what we think about the change.",
        content: "Should you charge per seat? Here is what we think about the change.",
        state: "pending_review",
        createdAt: 3,
        updatedAt: 3,
      });

    // 09:00 — the founder rewrites the opening.
    await applyDraftAction(
      db,
      (await getDraft(db, WORKSPACE_ID, DRAFT_ID))!,
      "edit",
      HUMAN,
      "We moved 40 customers to usage-based billing last quarter. Per-seat hid the churn.",
      undefined,
      { instruction: "Never open with a rhetorical question" },
    );

    // 09:10 — the extraction tick reads it.
    const gateway = new ExtractionAndEngineGateway(engineRun("Engine draft."), [
      JSON.stringify({
        rules: [
          {
            rule: "Never open with a rhetorical question",
            polarity: "avoid",
            confidence: 85,
            evidence: "the founder replaced the opening question with a concrete result",
          },
        ],
      }),
    ]);
    const extracted = await runPreferenceExtraction(db, gateway, WORKSPACE_ID);
    expect(extracted.created).toBe(1);

    // 14:00 — the next run's draft step is told about it.
    const definition = await createPipelineDefinition(
      db,
      WORKSPACE_ID,
      { taskKey: "signal_social_post", name: "Mini", description: "", spec: miniSpec() },
      ACTOR,
    );
    await setPipelineStatus(db, WORKSPACE_ID, definition.id, "active");
    const executed = await runEngineOnce(db, gateway, definition);
    expect(executed.run.status).toBe("succeeded");

    const draftStepMessages = gateway.calls[0]!.messages;
    const draftContext = JSON.stringify(draftStepMessages);
    expect(draftContext).toContain("Learned preferences from your edits");
    expect(draftContext).toContain("Never open with a rhetorical question");

    // The application is recorded — only now, on a real live generation.
    const rule = (await listPreferenceRules(db, WORKSPACE_ID))[0]!;
    expect(rule.appliedCount).toBe(1);
    expect(rule.lastAppliedAt).not.toBeNull();

    // The trace on the produced draft says the rule was applied.
    const produced = (await listDrafts(db, WORKSPACE_ID)).find((d) => d.id !== DRAFT_ID)!;
    expect(produced).toBeDefined();

    // 14:05 — the founder disagrees and switches it off. The next run is clean.
    await setRuleStatus(db, WORKSPACE_ID, rule.id, "disabled");
    const secondGateway = new ExtractionAndEngineGateway(engineRun("Second engine draft."), []);
    const second = await runEngineOnce(db, secondGateway, definition);
    expect(second.run.status).toBe("succeeded");
    const secondContext = JSON.stringify(secondGateway.calls[0]!.messages);
    expect(secondContext).not.toContain("Learned preferences from your edits");
    expect((await listPreferenceRules(db, WORKSPACE_ID))[0]!.appliedCount).toBe(1);
  });
});
