import { describe, expect, it } from "vitest";
import { RETIRE_AFTER_MS } from "@tuezday/contracts";
import type { Db } from "../src/db";
import { preferenceEdits, preferenceRules, workspaces } from "../src/db/schema";
import type { GenerateResult, LlmGateway } from "../src/llm/gateway";
import { GatewayError } from "../src/llm/gateway";
import { listPreferenceEdits } from "../src/services/preference-edits";
import {
  composeExtractionPrompt,
  groupEditsByScope,
  runPreferenceExtraction,
} from "../src/services/preference-extraction";
import {
  listPreferenceRules,
  listRuleEvidence,
  retireStaleRules,
} from "../src/services/preference-rules";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

/** Replays canned JSON responses through generate() — generateStructured's fallback path. */
class ScriptedTextGateway implements LlmGateway {
  public prompts: string[] = [];
  constructor(private readonly script: string[]) {}
  async generate(params: { prompt: string }): Promise<GenerateResult> {
    this.prompts.push(params.prompt);
    const next = this.script.shift();
    if (next === undefined) throw new GatewayError("provider_error", "script exhausted");
    return { text: next, model: "fake", provider: "fake", durationMs: 1 };
  }
}

class ThrowingGateway implements LlmGateway {
  async generate(): Promise<GenerateResult> {
    throw new GatewayError("provider_error", "the model is down");
  }
}

function extraction(rules: unknown[]): string {
  return JSON.stringify({ rules });
}

const RHETORICAL = {
  rule: "Never open with a rhetorical question",
  polarity: "avoid",
  confidence: 85,
  evidence: "the founder cut the opening question about seats every time",
};

function seed(db: Db): void {
  db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Extract", createdAt: 1, updatedAt: 1 })
    .run();
}

let counter = 0;
/** Deterministic v4-shaped ids — the contracts schemas validate uuid. */
function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `33333333-3333-4333-8333-${hex}`;
}

function addEdit(
  db: Db,
  overrides: Partial<{
    taskType: string;
    channel: string;
    beforeContent: string;
    afterContent: string;
    instruction: string | null;
    createdAt: number;
  }> = {},
): string {
  const id = uuid((counter += 1));
  db.insert(preferenceEdits)
    .values({
      id,
      workspaceId: WORKSPACE_ID,
      source: "draft_edit",
      sourceId: id,
      draftId: null,
      taskType: overrides.taskType ?? "signal_response",
      channel: overrides.channel ?? "linkedin",
      beforeContent: overrides.beforeContent ?? "Should you charge per seat? Here is the answer.",
      afterContent: overrides.afterContent ?? "We shipped usage-based billing to 40 customers.",
      instruction: overrides.instruction ?? null,
      editDistance: 60,
      digestedAt: null,
      createdAt: overrides.createdAt ?? counter,
    })
    .run();
  return id;
}

describe("preference extraction (Sprint 68)", () => {
  it("groups edits by scope so a rule cannot escape the channel it was learned on (D-68.4)", () => {
    const db = createTestDb();
    seed(db);
    addEdit(db, { channel: "linkedin" });
    addEdit(db, { channel: "linkedin" });
    addEdit(db, { channel: "email", taskType: "outbound_email" });

    const groups = groupEditsByScope(listPreferenceEdits(db, WORKSPACE_ID));
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.channel).sort()).toEqual(["email", "linkedin"]);
    expect(groups.find((group) => group.channel === "linkedin")!.edits).toHaveLength(2);
  });

  it("shows the model both sides of every diff and the founder's instruction", () => {
    const db = createTestDb();
    seed(db);
    addEdit(db, { instruction: "stop hedging" });
    const [group] = groupEditsByScope(listPreferenceEdits(db, WORKSPACE_ID));
    const prompt = composeExtractionPrompt(group!);
    expect(prompt).toContain("BEFORE");
    expect(prompt).toContain("AFTER");
    expect(prompt).toContain("stop hedging");
    expect(prompt).toContain("signal_response");
    expect(prompt).toContain("linkedin");
  });

  it("creates an active rule scoped to the group, with its evidence", async () => {
    const db = createTestDb();
    seed(db);
    addEdit(db);
    const llm = new ScriptedTextGateway([extraction([RHETORICAL])]);

    const result = await runPreferenceExtraction(db, llm, WORKSPACE_ID);
    expect(result).toMatchObject({ groups: 1, edits: 1, created: 1, merged: 0 });

    const [rule] = listPreferenceRules(db, WORKSPACE_ID);
    expect(rule!.rule).toBe(RHETORICAL.rule);
    expect(rule!.status).toBe("active");
    expect(rule!.scopeChannel).toBe("linkedin");
    expect(rule!.scopeTaskType).toBe("signal_response");
    expect(rule!.observationCount).toBe(1);
    expect(rule!.origin).toBe("extracted");

    const evidence = listRuleEvidence(db, rule!.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.excerpt).toContain("cut the opening question");
    expect(evidence[0]!.edit).not.toBeNull();
  });

  it("reinforces a restated rule instead of duplicating it", async () => {
    const db = createTestDb();
    seed(db);
    addEdit(db);
    await runPreferenceExtraction(
      db,
      new ScriptedTextGateway([extraction([RHETORICAL])]),
      WORKSPACE_ID,
    );

    addEdit(db);
    const restated = {
      ...RHETORICAL,
      // Same instruction, different wording — the model rarely repeats itself.
      rule: "Never open with a rhetorical question.",
      confidence: 90,
    };
    const second = await runPreferenceExtraction(
      db,
      new ScriptedTextGateway([extraction([restated])]),
      WORKSPACE_ID,
    );

    expect(second).toMatchObject({ created: 0, merged: 1 });
    const rules = listPreferenceRules(db, WORKSPACE_ID);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.observationCount).toBe(2);
    expect(rules[0]!.confidence).toBe(90);
  });

  it("keeps a low-confidence guess out of generation as a candidate (D-68.9)", async () => {
    const db = createTestDb();
    seed(db);
    addEdit(db);
    await runPreferenceExtraction(
      db,
      new ScriptedTextGateway([extraction([{ ...RHETORICAL, confidence: 40 }])]),
      WORKSPACE_ID,
    );
    const [rule] = listPreferenceRules(db, WORKSPACE_ID);
    expect(rule!.status).toBe("candidate");
  });

  it("digests the batch even when the model call fails, so one bad diff cannot wedge the loop", async () => {
    const db = createTestDb();
    seed(db);
    addEdit(db);
    const result = await runPreferenceExtraction(db, new ThrowingGateway(), WORKSPACE_ID);
    expect(result).toMatchObject({ groups: 1, edits: 1, created: 0, merged: 0 });
    expect(listPreferenceEdits(db, WORKSPACE_ID)[0]!.digestedAt).not.toBeNull();
  });

  it("never re-reads an edit it already digested", async () => {
    const db = createTestDb();
    seed(db);
    addEdit(db);
    await runPreferenceExtraction(
      db,
      new ScriptedTextGateway([extraction([RHETORICAL])]),
      WORKSPACE_ID,
    );
    // A second pass with no script would throw if it tried to extract again.
    const second = await runPreferenceExtraction(
      db,
      new ScriptedTextGateway([]),
      WORKSPACE_ID,
    );
    expect(second.groups).toBe(0);
    expect(listPreferenceRules(db, WORKSPACE_ID)[0]!.observationCount).toBe(1);
  });

  it("treats an empty extraction as a correct answer", async () => {
    const db = createTestDb();
    seed(db);
    addEdit(db);
    const result = await runPreferenceExtraction(
      db,
      new ScriptedTextGateway([extraction([])]),
      WORKSPACE_ID,
    );
    expect(result.created).toBe(0);
    expect(listPreferenceRules(db, WORKSPACE_ID)).toHaveLength(0);
    expect(listPreferenceEdits(db, WORKSPACE_ID)[0]!.digestedAt).not.toBeNull();
  });

  it("retires a rule only when it stopped being observed AND stopped being applied (D-68.8)", () => {
    const db = createTestDb();
    seed(db);
    const now = 1_000_000_000_000;
    const stale = now - RETIRE_AFTER_MS - 1;
    const base = {
      workspaceId: WORKSPACE_ID,
      rule: "Never open with a rhetorical question",
      polarity: "avoid",
      scopeTaskType: null,
      scopeChannel: null,
      status: "active",
      origin: "extracted",
      confidence: 80,
      observationCount: 1,
      appliedCount: 0,
      promotedAt: null,
      retiredAt: null,
      createdAt: stale,
      updatedAt: stale,
    };
    db.insert(preferenceRules)
      .values([
        { ...base, id: uuid(900), lastObservedAt: stale, lastAppliedAt: null },
        // Still working: nobody has had to re-teach it, but it fires constantly.
        { ...base, id: uuid(901), lastObservedAt: stale, lastAppliedAt: now - 1000 },
        { ...base, id: uuid(902), lastObservedAt: now - 1000, lastAppliedAt: null },
      ])
      .run();

    expect(retireStaleRules(db, WORKSPACE_ID, now)).toBe(1);
    const byId = new Map(listPreferenceRules(db, WORKSPACE_ID).map((r) => [r.id, r.status]));
    expect(byId.get(uuid(900))).toBe("retired");
    expect(byId.get(uuid(901))).toBe("active");
    expect(byId.get(uuid(902))).toBe("active");
  });
});
