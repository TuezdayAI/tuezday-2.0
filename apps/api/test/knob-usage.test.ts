import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultResolvedMatrix, resolveContext, type ContextSection } from "@tuezday/brain";
import type { Db } from "../src/db";
import {
  contextMatrixOverrides,
  designOverlays,
  designSystems,
  generationSettings,
  generations,
  guidanceOverrides,
  workspaces,
} from "../src/db/schema";
import {
  buildKnobUsageReport,
  knobStatesForResolve,
  readKnobConfiguration,
} from "../src/services/knob-usage";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const DOCS = {
  soul: "# Soul\nWe help founders sell without a sales team.",
  icp: "# ICP\nSeed-stage B2B founders.\n\n## Pricing\nThey hate seat-based pricing.",
  voice: "# Voice\nPlain, specific, never breathless.",
  history: "# History\nWe launched in 2024.\n\n## Pricing experiment\nWe moved to usage-based.",
  now: "# Now\nShipping the pricing page rewrite.",
};

/**
 * Real resolver output, not a hand-written fixture. The three guidance knobs
 * are detected from the resolver's own written reasons, so a fixture would test
 * the detector against itself and pass forever after the resolver drifted.
 */
function resolve(overrides: Parameters<typeof resolveContext>[0] extends infer T ? Partial<T> : never) {
  return resolveContext({
    workspaceName: "Acme",
    docs: DOCS,
    taskType: "linkedin_post",
    channel: "linkedin",
    matrix: defaultResolvedMatrix(),
    ...overrides,
  } as Parameters<typeof resolveContext>[0]).sections;
}

/** Big enough that the resolver keeps it as an outline instead of promoting it
 *  to full — zoom only runs on docs that stay outlined. */
const LONG_HISTORY = [
  "# History",
  ...Array.from({ length: 30 }, (_, i) =>
    `\n## Chapter ${i} ${i === 7 ? "pricing experiment" : "operations"}\n${
      "We shipped a thing and learned something durable about the market. ".repeat(20)
    }`,
  ),
].join("\n");

function knob(sections: ContextSection[], db: Db, key: string, meta = {}) {
  return knobStatesForResolve(db, WORKSPACE_ID, sections, meta).find((k) => k.key === key)!;
}

describe("the nine knobs, judged by what they did (Sprint 71)", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    db.insert(workspaces)
      .values({ id: WORKSPACE_ID, name: "Acme", createdAt: 1, updatedAt: 1 })
      .run();
  });

  it("returns all nine, in precedence order, for any bundle", () => {
    const knobs = knobStatesForResolve(db, WORKSPACE_ID, resolve({}));
    expect(knobs).toHaveLength(9);
    expect(knobs[0]!.key).toBe("brain_docs");
    expect(knobs.at(-1)!.key).toBe("design_overlays");
    for (const entry of knobs) expect(entry.href).toContain(`/workspaces/${WORKSPACE_ID}`);
  });

  it("says the built-in channel guidance applied when nothing overrode it", () => {
    const sections = resolve({});
    expect(knob(sections, db, "channel_guidance_builtin").state).toBe("applied");
    expect(knob(sections, db, "channel_guidance_workspace").state).toBe("absent");
    expect(knob(sections, db, "scoped_guidance").state).toBe("absent");
  });

  it("says the workspace override applied, and stops crediting the built-in", () => {
    const sections = resolve({
      channelGuidance: { content: "Ship short posts.", source: "workspace" },
    });
    expect(knob(sections, db, "channel_guidance_workspace").state).toBe("applied");
    expect(knob(sections, db, "channel_guidance_builtin").state).toBe("absent");
  });

  it("credits the scoped override, not the workspace one, when a scope won", () => {
    const sections = resolve({
      channelGuidance: {
        content: "Ship short posts.",
        source: "workspace",
        scope: 'persona "Founder"',
      },
    });
    // Most-specific-wins means exactly one of these three shaped the prompt.
    expect(knob(sections, db, "scoped_guidance").state).toBe("applied");
    expect(knob(sections, db, "channel_guidance_workspace").state).toBe("absent");
    expect(knob(sections, db, "scoped_guidance").detail).toContain("Founder");
  });

  it("separates a knob that is set from a knob that did something", () => {
    // Guidance exists for a channel this resolve never touched.
    db.insert(guidanceOverrides)
      .values({
        id: randomUUID(),
        workspaceId: WORKSPACE_ID,
        channel: "x",
        personaId: null,
        campaignId: null,
        content: "Short posts on X.",
        createdAt: 1,
        updatedAt: 2,
      })
      .run();
    const entry = knob(resolve({}), db, "channel_guidance_workspace");
    // The gap between these two words is the whole deletion decision (D-71.5).
    expect(entry.state).toBe("configured");
    expect(entry.detail).toContain("not for this channel");
  });

  it("credits the matrix only when a workspace cell won", () => {
    const matrix = defaultResolvedMatrix();
    matrix.linkedin_post.history = {
      mode: "omit",
      reason: "The founder decided history is noise here.",
      source: "workspace",
    };
    const sections = resolve({ matrix });
    expect(knob(sections, db, "context_matrix", { taskType: "linkedin_post" }).state).toBe(
      "applied",
    );
    // The shipped defaults are not a knob anybody turned.
    expect(
      knob(resolve({}), db, "context_matrix", { taskType: "linkedin_post" }).state,
    ).toBe("absent");
  });

  it("reports zoom by the sections it actually pulled", () => {
    const matrix = defaultResolvedMatrix();
    matrix.linkedin_post.history = {
      mode: "outline",
      reason: "Outline plus zoom.",
      source: "workspace",
    };
    const zoomed = resolve({
      docs: { ...DOCS, history: LONG_HISTORY },
      matrix,
      signal: { content: "pricing experiment", source: "manual" },
    });
    const entry = knob(zoomed, db, "zoom", { taskType: "linkedin_post" });
    expect(entry.state).toBe("applied");
    // Deferred improvement #22 is surfaced, not fixed: the panel says out loud
    // that zoom ranks lexically, which is what makes the case for hybrid.
    expect(entry.detail).toContain("BM25");
    expect(knob(resolve({}), db, "zoom").state).toBe("absent");
  });

  it("never claims a design overlay shaped the text, because it cannot", () => {
    const systemId = randomUUID();
    db.insert(designSystems)
      .values({
        id: systemId,
        workspaceId: WORKSPACE_ID,
        name: "Brand",
        content: "# DESIGN.md",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(designOverlays)
      .values({
        id: randomUUID(),
        workspaceId: WORKSPACE_ID,
        designSystemId: systemId,
        channel: "linkedin",
        personaId: null,
        campaignId: null,
        content: "Bigger type.",
        createdAt: 1,
        updatedAt: 3,
      })
      .run();
    const entry = knob(resolve({}), db, "design_overlays");
    expect(entry.state).toBe("configured");
    expect(entry.detail).toContain("not this text");
  });

  it("does not count generation settings that match the shipped defaults", () => {
    db.insert(generationSettings)
      .values({
        workspaceId: WORKSPACE_ID,
        reviewEnabled: 1,
        angleEnabled: 0,
        angleCount: 3,
        flagThreshold: 70,
        updatedAt: 5,
      })
      .run();
    expect(readKnobConfiguration(db, WORKSPACE_ID).generationSettings.count).toBe(0);
    db.update(generationSettings).set({ angleEnabled: 1, updatedAt: 6 }).run();
    expect(readKnobConfiguration(db, WORKSPACE_ID).generationSettings).toEqual({
      count: 1,
      lastAt: 6,
    });
  });
});

describe("the knob-usage report (Sprint 71 acceptance)", () => {
  let db: Db;

  function seedGeneration(sections: ContextSection[], createdAt: number) {
    db.insert(generations)
      .values({
        id: randomUUID(),
        workspaceId: WORKSPACE_ID,
        taskType: "linkedin_post",
        channel: "linkedin",
        prompt: "prompt",
        sectionsJson: JSON.stringify(sections),
        output: "output",
        model: "gemini-2.5-flash",
        provider: "google",
        durationMs: 10,
        createdAt,
      })
      .run();
  }

  beforeEach(() => {
    db = createTestDb();
    db.insert(workspaces)
      .values({ id: WORKSPACE_ID, name: "Acme", createdAt: 1, updatedAt: 1 })
      .run();
  });

  it("gives every knob a configured flag, an applied count, and a visible denominator", () => {
    seedGeneration(resolve({}), 10);
    seedGeneration(
      resolve({ channelGuidance: { content: "Short.", source: "workspace" } }),
      20,
    );
    const report = buildKnobUsageReport(db, WORKSPACE_ID);
    expect(report.knobs).toHaveLength(9);
    expect(report.sampledResolves).toBe(2);
    const workspaceGuidance = report.knobs.find(
      (k) => k.key === "channel_guidance_workspace",
    )!;
    expect(workspaceGuidance.appliedResolves).toBe(1);
    expect(workspaceGuidance.appliedShare).toBe(0.5);
  });

  it("finds the knob nobody uses — the one the follow-up should delete", () => {
    for (let i = 0; i < 5; i += 1) seedGeneration(resolve({}), 10 + i);
    db.insert(contextMatrixOverrides)
      .values({
        id: randomUUID(),
        workspaceId: WORKSPACE_ID,
        taskType: "x_post",
        docType: "history",
        mode: "omit",
        reason: null,
        createdAt: 1,
        updatedAt: 2,
      })
      .run();
    const matrix = buildKnobUsageReport(db, WORKSPACE_ID).knobs.find(
      (k) => k.key === "context_matrix",
    )!;
    // Configured once, applied never, across every resolve on record.
    expect(matrix.configured).toBe(true);
    expect(matrix.configuredCount).toBe(1);
    expect(matrix.lastConfiguredAt).toBe(2);
    expect(matrix.appliedResolves).toBe(0);
    expect(matrix.appliedShare).toBe(0);
  });

  it("samples, and says what it sampled", () => {
    for (let i = 0; i < 6; i += 1) seedGeneration(resolve({}), 100 + i);
    const report = buildKnobUsageReport(db, WORKSPACE_ID, { sampleLimit: 3 });
    expect(report.sampleLimit).toBe(3);
    expect(report.sampledResolves).toBe(3);
  });

  it("skips a trace it cannot read rather than scoring it as unused", () => {
    seedGeneration(resolve({}), 10);
    db.insert(generations)
      .values({
        id: randomUUID(),
        workspaceId: WORKSPACE_ID,
        taskType: "linkedin_post",
        channel: "linkedin",
        prompt: "prompt",
        sectionsJson: "not json",
        output: "output",
        model: "gemini-2.5-flash",
        provider: "google",
        durationMs: 10,
        createdAt: 20,
      })
      .run();
    const report = buildKnobUsageReport(db, WORKSPACE_ID);
    // Counting the unreadable row would silently halve every applied share.
    expect(report.sampledResolves).toBe(1);
    expect(report.knobs.find((k) => k.key === "brain_docs")!.appliedShare).toBe(1);
  });

  it("returns zeroes, not NaN, for a workspace that has generated nothing", () => {
    const report = buildKnobUsageReport(db, WORKSPACE_ID);
    expect(report.sampledResolves).toBe(0);
    for (const entry of report.knobs) expect(entry.appliedShare).toBe(0);
  });
});
