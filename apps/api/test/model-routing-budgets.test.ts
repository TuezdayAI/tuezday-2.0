import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PLANS } from "@tuezday/contracts";
import type { EvidenceStore } from "../src/evidence/store";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { GeminiGateway } from "../src/llm/gemini";
import { OpenRouterGateway } from "../src/llm/openrouter";
import { ScriptedGateway } from "../src/llm/scripted";
import { costCents, hasPricing, DESIGN_RENDER_FLAT_CENTS } from "../src/llm/pricing";
import { meteredLlm } from "../src/llm/metered";
import { generateStructured } from "../src/llm/structured";
import { llmUsageEvents } from "../src/db/schema";
import { recordLlmUsage, spendRollup, sumLlmSpendCents } from "../src/services/usage-ledger";
import { runAutomation } from "../src/services/automation";
import { buildAuthedApp, createTestDb } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GEMINI_OK = {
  candidates: [{ content: { parts: [{ text: "hello" }] } }],
  usageMetadata: {
    promptTokenCount: 1000,
    candidatesTokenCount: 200,
    thoughtsTokenCount: 50,
    cachedContentTokenCount: 400,
  },
};

describe("pricing (Sprint 59)", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0 };

  it("prices the cheap tier's flash-lite at its own rates", () => {
    expect(costCents("gemini-2.5-flash-lite", usage)).toBeCloseTo(10 + 40);
    expect(costCents("gemini-2.5-flash", usage)).toBeCloseTo(30 + 250);
  });

  it("normalizes OpenRouter vendor-prefixed ids to the model segment", () => {
    expect(costCents("google/gemini-2.5-flash", usage)).toBeCloseTo(30 + 250);
    expect(hasPricing("google/gemini-2.5-flash-lite")).toBe(true);
    expect(hasPricing("someone/unknown-model")).toBe(false);
  });

  it("bills cached input tokens at the cached rate", () => {
    const cached = { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 };
    expect(costCents("gemini-2.5-flash", cached)).toBeCloseTo(7.5);
  });
});

describe("tier routing (Sprint 59)", () => {
  it("Gemini resolves tier=cheap to the cheap model and reports usage on generate", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      urls.push(String(url));
      return jsonResponse(200, GEMINI_OK);
    });
    const gateway = new GeminiGateway("key", "frontier-model", "cheap-model");

    const cheap = await gateway.generate({ prompt: "triage", tier: "cheap" });
    const frontier = await gateway.generate({ prompt: "draft" });

    expect(urls[0]).toContain("/models/cheap-model:generateContent");
    expect(urls[1]).toContain("/models/frontier-model:generateContent");
    expect(cheap.model).toBe("cheap-model");
    expect(frontier.model).toBe("frontier-model");
    // Sprint 56 mapping now applies to generate() too: thoughts count as output.
    expect(cheap.usage).toEqual({ inputTokens: 1000, outputTokens: 250, cachedTokens: 400 });
  });

  it("Gemini agentStep resolves the tier the same way", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      urls.push(String(url));
      return jsonResponse(200, GEMINI_OK);
    });
    const gateway = new GeminiGateway("key", "frontier-model", "cheap-model");
    const step = await gateway.agentStep({
      system: "",
      messages: [{ role: "user", content: "score this" }],
      tier: "cheap",
    });
    expect(urls[0]).toContain("/models/cheap-model:generateContent");
    expect(step.model).toBe("cheap-model");
  });

  it("OpenRouter resolves the tier and parses usage", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = (async (_url: unknown, init: { body: string }) => {
      body = JSON.parse(init.body);
      return jsonResponse(200, {
        model: "google/gemini-2.5-flash-lite",
        choices: [{ message: { content: "labeled" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    }) as unknown as typeof fetch;
    vi.stubEnv("OPENROUTER_MODEL_CHEAP", "");
    const gateway = new OpenRouterGateway("or-key", undefined, fetcher);
    const result = await gateway.generate({ prompt: "label this", tier: "cheap" });
    expect(body.model).toBe("google/gemini-2.5-flash-lite");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, cachedTokens: 0 });
  });

  it("generateStructured passes the tier through the agentStep transport", async () => {
    const gateway = new ScriptedGateway([{ text: '["one","two"]' }]);
    const result = await generateStructured(gateway, z.array(z.string()), {
      prompt: "give two strings",
      tier: "cheap",
    });
    expect(result.value).toEqual(["one", "two"]);
    expect(gateway.calls[0]?.tier).toBe("cheap");
  });
});

describe("meteredLlm + usage ledger (Sprint 59)", () => {
  function fakeLlm(overrides?: Partial<{ fail: boolean; usage: boolean }>): LlmGateway {
    return {
      async generate({ prompt }) {
        if (overrides?.fail) throw new GatewayError("provider_error", "down");
        return {
          text: `echo:${prompt}`,
          model: "gemini-2.5-flash",
          provider: "gemini",
          durationMs: 5,
          ...(overrides?.usage === false
            ? {}
            : { usage: { inputTokens: 1000, outputTokens: 100, cachedTokens: 600 } }),
        };
      },
    };
  }

  async function workspace(db: ReturnType<typeof createTestDb>) {
    const app = await buildAuthedApp({ db });
    const id = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Metered" } })
    ).json().id as string;
    await app.close();
    return id;
  }

  it("records one ledger row per successful call with pricing-table cost", async () => {
    const db = createTestDb();
    const workspaceId = await workspace(db);
    const metered = meteredLlm(fakeLlm(), db, { workspaceId, pipeline: "generation", campaignId: null });

    await metered.generate({ prompt: "draft it" });

    const rows = await db.select().from(llmUsageEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      pipeline: "generation",
      model: "gemini-2.5-flash",
      provider: "gemini",
      inputTokens: 1000,
      outputTokens: 100,
      cachedTokens: 600,
    });
    // 400 billable input + 600 cached + 100 output at flash rates.
    expect(rows[0]!.costCents).toBeCloseTo((400 * 30 + 600 * 7.5 + 100 * 250) / 1_000_000);
    expect(await sumLlmSpendCents(db, workspaceId, 0)).toBeCloseTo(rows[0]!.costCents);
  });

  it("a throw never bills, and a result without usage goes unmetered", async () => {
    const db = createTestDb();
    const workspaceId = await workspace(db);
    await expect(
      await meteredLlm(fakeLlm({ fail: true }), db, { workspaceId, pipeline: "review" }).generate({
        prompt: "x",
      }),
    ).rejects.toMatchObject({ name: "GatewayError" });
    await meteredLlm(fakeLlm({ usage: false }), db, { workspaceId, pipeline: "review" }).generate({
      prompt: "y",
    });
    expect(await db.select().from(llmUsageEvents).all()).toHaveLength(0);
  });

  it("spendRollup groups by pipeline, sorts by cost, and computes the cache hit rate", async () => {
    const db = createTestDb();
    const workspaceId = await workspace(db);
    await recordLlmUsage(db, {
      workspaceId,
      pipeline: "generation",
      model: "m",
      provider: "p",
      usage: { inputTokens: 800, outputTokens: 100, cachedTokens: 600 },
      costCentsOverride: 10,
    });
    await recordLlmUsage(db, {
      workspaceId,
      pipeline: "generation",
      model: "m",
      provider: "p",
      usage: { inputTokens: 200, outputTokens: 50, cachedTokens: 0 },
      costCentsOverride: 2,
    });
    await recordLlmUsage(db, {
      workspaceId,
      pipeline: "signal_matching",
      model: "m",
      provider: "p",
      usage: { inputTokens: 1000, outputTokens: 10, cachedTokens: 400 },
      costCentsOverride: 30,
    });

    const rollup = await spendRollup(db, workspaceId, 0);
    expect(rollup.spentCents).toBeCloseTo(42);
    expect(rollup.byPipeline.map((r) => r.pipeline)).toEqual(["signal_matching", "generation"]);
    expect(rollup.byPipeline[1]).toMatchObject({ calls: 2, inputTokens: 1000, cachedTokens: 600 });
    // 1000 cached of 2000 input across the window.
    expect(rollup.cacheHitRate).toBeCloseTo(0.5);
  });

  it("sumLlmSpendCents respects the window boundary", async () => {
    const db = createTestDb();
    const workspaceId = await workspace(db);
    await recordLlmUsage(db, {
      workspaceId,
      pipeline: "generation",
      model: "m",
      provider: "p",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      costCentsOverride: 7,
    });
    expect(await sumLlmSpendCents(db, workspaceId, Date.now() + 60_000)).toBe(0);
    expect(await sumLlmSpendCents(db, workspaceId, Date.now() - 60_000)).toBeCloseTo(7);
  });
});

describe("worker degradation at the budget cap (Sprint 59)", () => {
  it("automation reports blocked: llm_budget_exhausted and makes zero model calls", async () => {
    vi.stubEnv("TEST_BILLING_GATING", "1");
    const db = createTestDb();
    let llmCalls = 0;
    const llm: LlmGateway = {
      async generate() {
        llmCalls += 1;
        return { text: "draft", model: "fake", provider: "fake", durationMs: 1 };
      },
    };
    const app = await buildAuthedApp({ db, llm });
    const workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Capped" } })
    ).json().id as string;
    const campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Always on", channels: ["linkedin"] },
      })
    ).json().id as string;
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/campaigns/${campaignId}/automation`,
      payload: { automationMode: "human_in_the_loop", autoDailyCap: null },
    });

    await recordLlmUsage(db, {
      workspaceId,
      pipeline: "generation",
      model: "unknown",
      provider: "fake",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      costCentsOverride: PLANS.free.entitlements.monthlyLlmCents,
    });

    const run = await runAutomation(db, llm, {} as EvidenceStore, workspaceId);
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({
      blocked: "llm_budget_exhausted",
      generated: 0,
      autoApproved: 0,
    });
    expect(llmCalls).toBe(0);
    await app.close();
  });

  it("design renders carry the flat tunable cost", () => {
    expect(DESIGN_RENDER_FLAT_CENTS).toBe(1);
  });
});
