import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertCampaignInputSchema, upsertPersonaInputSchema } from "@tuezday/contracts";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../src/agents/registry";
import { getCampaignInsightsTool } from "../src/agents/tools/get-campaign-insights";
import { getMetricSummaryTool } from "../src/agents/tools/get-metric-summary";
import { getSequenceFunnelTool } from "../src/agents/tools/get-sequence-funnel";
import { getWorkspaceInsightsTool } from "../src/agents/tools/get-workspace-insights";
import { listCampaignsTool } from "../src/agents/tools/list-campaigns";
import { listPersonasTool } from "../src/agents/tools/list-personas";
import type { Db } from "../src/db";
import { workspaces } from "../src/db/schema";
import type { EvidenceStore, StoreSearchResult } from "../src/evidence/store";
import { createCampaign } from "../src/services/campaigns";
import { recordMetric } from "../src/services/metrics";
import { createPersona } from "../src/services/personas";
import { summarizeMetrics } from "../src/services/metrics";
import { createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// The six Sprint 76 registry reads. Each wraps an existing service, so what is
// tested here is the tool's own contract: scoping, empty states, and — for the
// metric rollup — the Sprint 55 rule that cumulative and periodic values must
// never be summed together.
// ---------------------------------------------------------------------------

const NEW_TOOLS = [
  listCampaignsTool,
  listPersonasTool,
  getCampaignInsightsTool,
  getWorkspaceInsightsTool,
  getMetricSummaryTool,
  getSequenceFunnelTool,
];

class NoEvidence implements EvidenceStore {
  async health() {
    return { healthy: false };
  }
  async createCollection(n: string) {
    return n;
  }
  async addDocument() {
    return "d";
  }
  async attachDocument() {}
  async deleteDocument() {}
  async search(): Promise<StoreSearchResult[]> {
    return [];
  }
}

let db: Db;
let workspaceId: string;
let ctx: ToolContext;

beforeEach(() => {
  db = createTestDb();
  workspaceId = randomUUID();
  db.insert(workspaces).values({ id: workspaceId, name: "Acme", createdAt: 1, updatedAt: 1 }).run();
  ctx = {
    db,
    evidence: new NoEvidence(),
    safeFetch: null as unknown as ToolContext["safeFetch"],
    workspaceId,
    actor: { userId: null, label: "user:test" },
    budget: DEFAULT_TOOL_BUDGET,
  };
});

describe("registration", () => {
  it("all six are read tools", () => {
    for (const tool of NEW_TOOLS) {
      expect(tool.access, tool.name).toBe("read");
    }
  });

  it("each rejects arguments its schema does not allow", () => {
    expect(getCampaignInsightsTool.input.safeParse({}).success).toBe(false);
    expect(getSequenceFunnelTool.input.safeParse({}).success).toBe(false);
    expect(listCampaignsTool.input.safeParse({ status: "not_a_status" }).success).toBe(false);
    expect(listCampaignsTool.input.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe("inventory reads", () => {
  it("list_campaigns says so plainly when there are none", async () => {
    const result = (await listCampaignsTool.run(ctx, {})) as { campaigns: unknown[]; note: string };
    expect(result.campaigns).toEqual([]);
    expect(result.note).toContain("no campaigns");
  });

  it("list_campaigns returns ids a later tool can use, and filters by status", async () => {
    const launch = createCampaign(
      db,
      workspaceId,
      upsertCampaignInputSchema.parse({ name: "Launch", objective: "Ship it", status: "active" }),
    );
    createCampaign(
      db,
      workspaceId,
      upsertCampaignInputSchema.parse({ name: "Old", objective: "Done", status: "archived" }),
    );

    const all = (await listCampaignsTool.run(ctx, {})) as { campaigns: { id: string }[] };
    expect(all.campaigns).toHaveLength(2);

    const active = (await listCampaignsTool.run(ctx, { status: "active" })) as {
      campaigns: { id: string; name: string }[];
    };
    expect(active.campaigns).toEqual([expect.objectContaining({ id: launch.id, name: "Launch" })]);
  });

  it("list_personas returns the real answer set rather than nothing to ground on", async () => {
    const empty = (await listPersonasTool.run(ctx, {})) as { personas: unknown[]; note: string };
    expect(empty.note).toContain("no personas");

    const persona = createPersona(
      db,
      workspaceId,
      upsertPersonaInputSchema.parse({ name: "Head of Growth", tone: "direct" }),
    );
    const result = (await listPersonasTool.run(ctx, {})) as { personas: { id: string }[] };
    expect(result.personas).toEqual([expect.objectContaining({ id: persona.id })]);
  });
});

describe("performance reads", () => {
  it("get_campaign_insights returns the available campaigns for an unknown id", async () => {
    const campaign = createCampaign(
      db,
      workspaceId,
      upsertCampaignInputSchema.parse({ name: "Launch", objective: "Ship it" }),
    );
    const result = (await getCampaignInsightsTool.run(ctx, { campaignId: "nope" })) as {
      error: string;
      availableCampaigns: { id: string }[];
    };
    expect(result.error).toBe("not_found");
    expect(result.availableCampaigns).toEqual([expect.objectContaining({ id: campaign.id })]);
  });

  it("get_campaign_insights answers for a real campaign", async () => {
    const campaign = createCampaign(
      db,
      workspaceId,
      upsertCampaignInputSchema.parse({ name: "Launch", objective: "Ship it" }),
    );
    const result = (await getCampaignInsightsTool.run(ctx, { campaignId: campaign.id })) as {
      campaign: { id: string };
      insights: unknown;
    };
    expect(result.campaign.id).toBe(campaign.id);
    expect(result.insights).toBeDefined();
  });

  it("get_workspace_insights needs no arguments — the workspace is the scope", async () => {
    expect(getWorkspaceInsightsTool.input.safeParse({}).success).toBe(true);
    const result = (await getWorkspaceInsightsTool.run(ctx, {})) as { campaigns: unknown[] };
    expect(result.campaigns).toEqual([]);
  });

  it("get_sequence_funnel is not_found for an unknown sequence", async () => {
    const result = (await getSequenceFunnelTool.run(ctx, { sequenceId: randomUUID() })) as {
      error: string;
      availableSequences: unknown[];
    };
    expect(result.error).toBe("not_found");
    expect(result.availableSequences).toEqual([]);
  });
});

describe("get_metric_summary respects the Sprint 55 window rule", () => {
  const record = (
    subjectId: string,
    value: number,
    window: "1d" | "7d" | "point",
    capturedAt: number,
    periodStart = capturedAt,
  ) =>
    recordMetric(db, workspaceId, {
      subjectType: "publication",
      subjectId,
      metricKey: "impressions",
      value,
      window,
      periodStart,
      source: "manual",
      capturedAt,
    });

  it("sums every observation for a PERIODIC window — days add up", () => {
    record("pub-1", 10, "1d", 1, 1);
    record("pub-1", 20, "1d", 2, 2);
    record("pub-2", 5, "1d", 1, 1);

    const summary = summarizeMetrics(db, workspaceId, {
      subjectType: "publication",
      window: "1d",
    });
    expect(summary.windowKind).toBe("periodic");
    expect(summary.entries[0]!).toEqual({
      metricKey: "impressions",
      total: 35,
      subjectCount: 2,
      observations: 3,
    });
  });

  it("takes ONE reading per subject for a CUMULATIVE window — a lifetime total is not a rate", () => {
    // The same publication observed twice: 100 then 180. Summing them would
    // report 280 impressions for a post that has had 180.
    record("pub-1", 100, "7d", 1, 1);
    record("pub-1", 180, "7d", 2, 2);
    record("pub-2", 20, "7d", 1, 1);

    const summary = summarizeMetrics(db, workspaceId, {
      subjectType: "publication",
      window: "7d",
    });
    expect(summary.windowKind).toBe("cumulative");
    expect(summary.entries[0]!.total).toBe(200);
    expect(summary.entries[0]!.subjectCount).toBe(2);
    expect(summary.entries[0]!.observations).toBe(3);
  });

  it("takes the latest reading per subject for a POINT window", () => {
    record("pub-1", 7, "point", 1, 1);
    record("pub-1", 9, "point", 2, 2);
    const summary = summarizeMetrics(db, workspaceId, {
      subjectType: "publication",
      window: "point",
    });
    expect(summary.windowKind).toBe("point");
    expect(summary.entries[0]!.total).toBe(9);
  });

  it("never mixes windows in one number", () => {
    record("pub-1", 10, "1d", 1, 1);
    record("pub-1", 500, "7d", 1, 1);
    const daily = summarizeMetrics(db, workspaceId, { subjectType: "publication", window: "1d" });
    expect(daily.entries[0]!.total).toBe(10);
  });

  it("bounds by sinceDays", async () => {
    const now = Date.now();
    record("pub-1", 10, "1d", now - 40 * 24 * 60 * 60 * 1000);
    record("pub-1", 3, "1d", now - 1 * 24 * 60 * 60 * 1000);

    const recent = (await getMetricSummaryTool.run(ctx, {
      subjectType: "publication",
      window: "1d",
      sinceDays: 7,
    })) as { entries: { total: number }[] };
    expect(recent.entries[0]!.total).toBe(3);
  });

  it("states that absence is not zero when nothing was observed", async () => {
    const result = (await getMetricSummaryTool.run(ctx, {
      subjectType: "campaign",
      window: "1d",
    })) as { entries: unknown[]; note: string };
    expect(result.entries).toEqual([]);
    expect(result.note).toContain("not a zero");
  });

  it("carries the interpretation so a model cannot misread the number", async () => {
    record("pub-1", 5, "7d", 1, 1);
    const result = (await getMetricSummaryTool.run(ctx, {
      subjectType: "publication",
      window: "7d",
    })) as { interpretation: string };
    expect(result.interpretation).toContain("latest reading");
  });

  it("filters to the requested metric keys", () => {
    record("pub-1", 5, "1d", 1, 1);
    recordMetric(db, workspaceId, {
      subjectType: "publication",
      subjectId: "pub-1",
      metricKey: "clicks",
      value: 2,
      window: "1d",
      periodStart: 1,
      source: "manual",
      capturedAt: 1,
    });

    const summary = summarizeMetrics(db, workspaceId, {
      subjectType: "publication",
      window: "1d",
      metricKeys: ["clicks"],
    });
    expect(summary.entries).toEqual([
      { metricKey: "clicks", total: 2, subjectCount: 1, observations: 1 },
    ]);
  });
});
