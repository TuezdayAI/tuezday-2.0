import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { ContextSection } from "@tuezday/brain";
import { pipelineSpecSchema, type PipelineSpec } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { generations } from "../src/db/schema";
import type { EvidenceStore } from "../src/evidence/store";
import type { LlmGateway } from "../src/llm/gateway";
import { ScriptedGateway } from "../src/llm/scripted";
import type { SafeFetchService } from "../src/safe-fetch/index";
import { findInstructiveRejectionsTool } from "../src/agents/tools/find-instructive-rejections";
import { DEFAULT_TOOL_BUDGET } from "../src/agents/registry";
import { createPipelineDefinition } from "../src/services/pipeline-definitions";
import {
  executePipelineRun,
  startPipelineRun,
  type PipelineEngineDeps,
} from "../src/services/pipeline-engine";
import { retrievePriorExamples } from "../src/services/prior-examples";
import { buildAuthedApp, createTestDb } from "./helpers";

// Distinct content per generate() call so BM25 has something to rank.
function countingGateway(): LlmGateway {
  let n = 0;
  return {
    async generate() {
      n += 1;
      return {
        text: `Generated pricing take number ${n} — competitors and pricing pages.`,
        model: "fake-model",
        provider: "fake",
        durationMs: 5,
      };
    },
  };
}

describe("Sprint 66 — grounded critic & retrieval few-shot", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: countingGateway() });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Sprint66" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function createSignal(content: string) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/signals`,
      payload: { content, source: "other" },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  async function draftFromSignal(signalId: string) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/signals/${signalId}/draft`,
      payload: { channel: "linkedin" },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; content: string; sourceGenerationId: string };
  }

  async function act(draftId: string, action: string, payload?: Record<string, unknown>) {
    return await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/${action}`,
      ...(payload ? { payload } : {}),
    });
  }

  function decisionsOf(draftId: string) {
    return app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draftId}` })
      .then((res) => res.json().decisions as Array<{ action: string; reason: string | null }>);
  }

  describe("reject with a reason", () => {
    it("stores the reason on the decision and returns it with the draft", async () => {
      const signal = await createSignal("Competitor launched usage-based pricing.");
      const draft = await draftFromSignal(signal.id);
      const res = await act(draft.id, "reject", { reason: "Too salesy for a news day" });
      expect(res.statusCode).toBe(200);
      const decisions = await decisionsOf(draft.id);
      const reject = decisions.find((d) => d.action === "reject")!;
      expect(reject.reason).toBe("Too salesy for a news day");
      // The submit decision stays reason-less.
      expect(decisions.find((d) => d.action === "submit")!.reason).toBeNull();
    });

    it("still rejects with no body at all, reason null", async () => {
      const signal = await createSignal("Another market signal about pricing.");
      const draft = await draftFromSignal(signal.id);
      const res = await act(draft.id, "reject");
      expect(res.statusCode).toBe(200);
      const decisions = await decisionsOf(draft.id);
      expect(decisions.find((d) => d.action === "reject")!.reason).toBeNull();
    });

    it("rejects a blank or oversized reason with 400", async () => {
      const signal = await createSignal("Yet another signal.");
      const draft = await draftFromSignal(signal.id);
      expect((await act(draft.id, "reject", { reason: "   " })).statusCode).toBe(400);
      expect((await act(draft.id, "reject", { reason: "x".repeat(501) })).statusCode).toBe(400);
      // The draft is untouched by the failed attempts.
      const decisions = await decisionsOf(draft.id);
      expect(decisions.some((d) => d.action === "reject")).toBe(false);
    });
  });

  describe("retrievePriorExamples", () => {
    it("returns null when the workspace has no history", async () => {
      expect(
        await retrievePriorExamples(db, workspaceId, { query: "pricing", channel: "linkedin" }),
      ).toBeNull();
    });

    it("splits approved-to-imitate from rejected-with-why", async () => {
      const s1 = await createSignal("Competitor pricing page launched.");
      const approved = await draftFromSignal(s1.id);
      expect((await act(approved.id, "approve")).statusCode).toBe(200);

      const s2 = await createSignal("Competitor pricing teardown thread.");
      const rejected = await draftFromSignal(s2.id);
      expect(
        (await act(rejected.id, "reject", { reason: "Wrong audience" })).statusCode,
      ).toBe(200);

      const examples = (await retrievePriorExamples(db, workspaceId, {
        query: "competitors and pricing pages",
        channel: "linkedin",
        taskType: "signal_response",
      }))!;
      expect(examples.approved).toHaveLength(1);
      expect(examples.approved[0]!.content).toBe(approved.content);
      expect(examples.approved[0]!.wasEdited).toBe(false);
      expect(examples.rejected).toHaveLength(1);
      expect(examples.rejected[0]!.content).toBe(rejected.content);
      expect(examples.rejected[0]!.reason).toBe("Wrong audience");
      expect(examples.rejected[0]!.outcome).toBe("rejected");
    });

    it("prefers rejections that carry a written why", async () => {
      const s1 = await createSignal("Signal one about pricing.");
      const silent = await draftFromSignal(s1.id);
      await act(silent.id, "reject");
      const s2 = await createSignal("Signal two about pricing.");
      const reasoned = await draftFromSignal(s2.id);
      await act(reasoned.id, "reject", { reason: "No proof point" });
      const s3 = await createSignal("Signal three about pricing.");
      const alsoSilent = await draftFromSignal(s3.id);
      await act(alsoSilent.id, "reject");

      const examples = (await retrievePriorExamples(db, workspaceId, {
        query: "pricing",
        channel: "linkedin",
      }))!;
      expect(examples.rejected).toHaveLength(2);
      expect(examples.rejected[0]!.reason).toBe("No proof point");
    });
  });

  describe("find_instructive_rejections surfaces the stored reason", () => {
    it("returns rejectionReason for reasoned rejects, null otherwise", async () => {
      const s1 = await createSignal("Pricing signal for the tool test.");
      const draft = await draftFromSignal(s1.id);
      await act(draft.id, "reject", { reason: "Cites no evidence" });

      const result = (await findInstructiveRejectionsTool.run(
        {
          db,
          evidence: {} as unknown as EvidenceStore,
          safeFetch: {} as unknown as SafeFetchService,
          workspaceId,
          actor: { userId: null, label: "test" },
          budget: DEFAULT_TOOL_BUDGET,
        },
        { query: "pricing" },
      )) as { rejections: Array<{ rejectionReason: string | null }> };
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]!.rejectionReason).toBe("Cites no evidence");
    });
  });

  describe("legacy signal→draft path traces the examples section", () => {
    async function sectionsOf(generationId: string): Promise<ContextSection[]> {
      const row = (await db
        .select({ sectionsJson: generations.sectionsJson })
        .from(generations)
        .where(eq(generations.id, generationId))
        .get())!;
      return JSON.parse(row.sectionsJson) as ContextSection[];
    }

    it("excludes with a reason before any history exists, includes after", async () => {
      const s1 = await createSignal("First signal, empty history.");
      const first = await draftFromSignal(s1.id);
      const firstSection = (await sectionsOf(first.sourceGenerationId)).find(
        (s) => s.key === "examples",
      )!;
      expect(firstSection.included).toBe(false);
      expect(firstSection.reason).toContain("no approved or rejected prior outputs");

      await act(first.id, "approve");
      const s2 = await createSignal("Second signal, history exists.");
      const second = await draftFromSignal(s2.id);
      const secondSection = (await sectionsOf(second.sourceGenerationId)).find(
        (s) => s.key === "examples",
      )!;
      expect(secondSection.included).toBe(true);
      expect(secondSection.layer).toBe("examples");
      expect(secondSection.content).toContain(first.content);
    });
  });

  describe("engine draft steps get the few-shot block", () => {
    const miniSpec: PipelineSpec = pipelineSpecSchema.parse({
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

    it("injects into draft steps only and traces it in provenance", async () => {
      const s1 = await createSignal("History signal about pricing pages.");
      const approved = await draftFromSignal(s1.id);
      await act(approved.id, "approve");
      const s2 = await createSignal("History signal two about pricing.");
      const rejected = await draftFromSignal(s2.id);
      await act(rejected.id, "reject", { reason: "Too generic" });

      const gateway = new ScriptedGateway([
        { text: JSON.stringify({ content: "Engine draft about pricing." }) },
        { text: JSON.stringify({ score: 90, findings: [], guardrailUncertain: false }) },
      ]);
      const deps: PipelineEngineDeps = {
        llm: gateway,
        evidence: {} as unknown as EvidenceStore,
        safeFetch: {} as unknown as SafeFetchService,
      };
      const trigger = await createSignal("Fresh signal: competitor pricing news.");
      const definition = await createPipelineDefinition(
        db,
        workspaceId,
        { taskKey: "signal_social_post", name: "P", description: "", spec: miniSpec },
        { userId: null, label: "founder" },
      );
      const run = await startPipelineRun(db, {
        workspaceId,
        definition,
        signalId: trigger.id,
        channel: "linkedin",
        mode: "live",
        createdBy: "founder",
      });
      const outcome = await executePipelineRun(db, deps, workspaceId, run.id);
      expect(outcome.run.status).toBe("succeeded");

      const draftMessage = gateway.calls[0]!.messages[0]!.content as string;
      expect(draftMessage).toContain("Prior examples from approval history");
      expect(draftMessage).toContain(approved.content);
      expect(draftMessage).toContain("Why: Too generic");

      const critiqueMessage = gateway.calls[1]!.messages[0]!.content as string;
      expect(critiqueMessage).not.toContain("Prior examples from approval history");

      const sections = JSON.parse(
        (await db
          .select({ sectionsJson: generations.sectionsJson })
          .from(generations)
          .where(eq(generations.id, outcome.run.generationId!))
          .get())!.sectionsJson,
      ) as ContextSection[];
      const provenance = sections.find((s) => s.key === "examples")!;
      expect(provenance.layer).toBe("examples");
      expect(provenance.included).toBe(true);
      expect(provenance.reason).toContain("injected into every draft step");
    });
  });
});
