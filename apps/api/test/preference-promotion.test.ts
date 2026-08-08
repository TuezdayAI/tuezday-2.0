import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db";
import { preferenceRules, workspaces } from "../src/db/schema";
import type { GenerateResult, LlmGateway } from "../src/llm/gateway";
import {
  acceptSynthesis,
  dismissSynthesis,
  promotableRuleIdsOf,
  synthesizeNow,
} from "../src/services/learning";
import { createMetric } from "../src/services/learning";
import { getPreferenceRule, listPromotableRules } from "../src/services/preference-rules";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

class CapturingGateway implements LlmGateway {
  public prompt = "";
  async generate(params: { prompt: string }): Promise<GenerateResult> {
    this.prompt = params.prompt;
    return {
      text: "PROPOSAL:\n- Lead with the result, never a question.\nRATIONALE:\nThe founder's edits say so.",
      model: "fake",
      provider: "fake",
      durationMs: 1,
    };
  }
}

function uuid(seed: number): string {
  return `55555555-5555-4555-8555-${seed.toString(16).padStart(12, "0")}`;
}

interface RuleOverrides {
  id: string;
  status?: string;
  confidence?: number;
  observationCount?: number;
  appliedCount?: number;
  rule?: string;
}

async function addRule(db: Db, overrides: RuleOverrides): Promise<string> {
  await db.insert(preferenceRules)
    .values({
      id: overrides.id,
      workspaceId: WORKSPACE_ID,
      rule: overrides.rule ?? "Never open with a rhetorical question",
      polarity: "avoid",
      scopeTaskType: null,
      scopeChannel: null,
      status: overrides.status ?? "active",
      origin: "extracted",
      confidence: overrides.confidence ?? 85,
      observationCount: overrides.observationCount ?? 3,
      appliedCount: overrides.appliedCount ?? 4,
      lastObservedAt: 10,
      lastAppliedAt: 20,
      promotedAt: null,
      retiredAt: null,
      createdAt: 1,
      updatedAt: 20,
    });
  return overrides.id;
}

async function seed(): Promise<Db> {
  const db = await createTestDb();
  await db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Promote", createdAt: 1, updatedAt: 1 });
  // Something for the synthesis to chew on, so it does not throw NothingToLearn.
  await createMetric(db, WORKSPACE_ID, {
    channel: "linkedin",
    description: "A post",
    notes: "",
    impressions: 100,
  });
  return db;
}

describe("preference promotion through the weekly synthesis (Sprint 68)", () => {
  it("promotes only rules the founder re-derived and that actually fired", async () => {
    const db = await seed();
    const ready = await addRule(db, { id: uuid(1) });
    await addRule(db, { id: uuid(2), observationCount: 1, rule: "Cut the closing hashtag block" });
    await addRule(db, { id: uuid(3), confidence: 50, rule: "Prefer short paragraphs over long ones" });
    await addRule(db, { id: uuid(4), appliedCount: 0, rule: "Say what changed, not what is trending" });
    await addRule(db, { id: uuid(5), status: "candidate", rule: "Open with a number when you have one" });

    expect((await listPromotableRules(db, WORKSPACE_ID)).map((rule) => rule.id)).toEqual([ready]);
  });

  it("puts the promotable set in the prompt and records it on the synthesis", async () => {
    const db = await seed();
    const ready = await addRule(db, { id: uuid(1) });
    const llm = new CapturingGateway();

    const synthesis = await synthesizeNow(db, llm, WORKSPACE_ID, "Promote");
    expect(llm.prompt).toContain("STABLE LEARNED PREFERENCES");
    expect(llm.prompt).toContain("Never open with a rhetorical question");
    expect(llm.prompt).toContain("observed in 3 edits");
    expect(promotableRuleIdsOf(synthesis)).toEqual([ready]);
  });

  it("promotes them when — and only when — the founder accepts (D-68.7)", async () => {
    const db = await seed();
    const ready = await addRule(db, { id: uuid(1) });
    const synthesis = await synthesizeNow(db, new CapturingGateway(), WORKSPACE_ID, "Promote");

    expect((await getPreferenceRule(db, WORKSPACE_ID, ready))!.status).toBe("active");
    await acceptSynthesis(db, WORKSPACE_ID, synthesis);

    const promoted = (await getPreferenceRule(db, WORKSPACE_ID, ready))!;
    expect(promoted.status).toBe("promoted");
    expect(promoted.promotedAt).not.toBeNull();
  });

  it("leaves the rules alone when the founder dismisses the proposal", async () => {
    const db = await seed();
    const ready = await addRule(db, { id: uuid(1) });
    const synthesis = await synthesizeNow(db, new CapturingGateway(), WORKSPACE_ID, "Promote");

    await dismissSynthesis(db, synthesis);
    expect((await getPreferenceRule(db, WORKSPACE_ID, ready))!.status).toBe("active");
  });

  it("a promoted rule stops being injected — the brain doc carries it now", async () => {
    const db = await seed();
    const ready = await addRule(db, { id: uuid(1) });
    const synthesis = await synthesizeNow(db, new CapturingGateway(), WORKSPACE_ID, "Promote");
    await acceptSynthesis(db, WORKSPACE_ID, synthesis);

    const rows = await db
      .select()
      .from(preferenceRules)
      .where(eq(preferenceRules.status, "active"));
    expect(rows).toHaveLength(0);
    expect((await getPreferenceRule(db, WORKSPACE_ID, ready))!.status).toBe("promoted");
  });

  it("accepting a pre-Sprint-68 synthesis promotes nothing and does not throw", async () => {
    const db = await seed();
    const synthesis = await synthesizeNow(db, new CapturingGateway(), WORKSPACE_ID, "Promote");
    const legacy = { ...synthesis, basedOnJson: '{"examples":3}' };
    expect(promotableRuleIdsOf(legacy)).toEqual([]);
    expect(async () => await acceptSynthesis(db, WORKSPACE_ID, legacy)).not.toThrow();
  });
});
