import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultResolvedMatrix, resolveContext } from "@tuezday/brain";
import { artifactTraceSchema } from "@tuezday/contracts";
import type { Db } from "../src/db";
import {
  campaigns,
  connections,
  draftRevisionTurns,
  drafts,
  externalActions,
  generations,
  preferenceRules,
  publications,
  signals,
  workspaces,
} from "../src/db/schema";
import { buildArtifactTrace } from "../src/services/artifact-trace";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const SIGNAL_ID = "33333333-3333-4333-8333-333333333333";
const GENERATION_ID = "44444444-4444-4444-8444-444444444444";
const CAMPAIGN_ID = "55555555-5555-4555-8555-555555555555";
const RULE_ID = "66666666-6666-4666-8666-666666666666";

const DRAFT_TEXT = "Seat-based pricing punishes the teams that adopt you fastest.";

const DOCS = {
  soul: "# Soul\nWe help founders sell without a sales team.",
  icp: "# ICP\nSeed-stage B2B founders.",
  voice: "# Voice\nPlain, specific, never breathless.",
  history: "# History\nWe launched in 2024.",
  now: "# Now\nShipping the pricing page rewrite.",
};

/** A real bundle, complete with the Sprint 66 examples and Sprint 68 rules
 *  blocks — the panel parses what the resolver rendered, so a hand-written
 *  fixture would only prove the parser agrees with itself. */
function bundle() {
  return resolveContext({
    workspaceName: "Acme",
    docs: DOCS,
    taskType: "linkedin_post",
    channel: "linkedin",
    matrix: defaultResolvedMatrix(),
    signal: { content: "A competitor moved to seat-based pricing.", source: "reddit" },
    examples: {
      query: "seat-based pricing",
      approved: [
        { content: "Usage-based pricing is the honest default.", wasEdited: false },
        { content: "We charge for what you use.", wasEdited: true },
      ],
      rejected: [
        {
          content: "Pricing is hard!",
          reason: "Says nothing. No point of view.",
          outcome: "rejected",
        },
      ],
    },
    preferences: {
      rules: [
        {
          id: RULE_ID,
          rule: "Open with the reader's problem, not the company",
          polarity: "do",
          confidence: 80,
          observationCount: 4,
          scope: "all tasks",
        },
        {
          id: randomUUID(),
          rule: "Never use the word delighted",
          polarity: "avoid",
          confidence: 60,
          observationCount: 2,
          scope: "linkedin_post on linkedin",
        },
      ],
    },
  });
}

async function seedDraft(db: Db, overrides: Record<string, unknown> = {}) {
  const resolved = bundle();
  await db.insert(generations)
    .values({
      id: GENERATION_ID,
      workspaceId: WORKSPACE_ID,
      taskType: "linkedin_post",
      channel: "linkedin",
      prompt: resolved.prompt,
      sectionsJson: JSON.stringify(resolved.sections),
      output: DRAFT_TEXT,
      model: "gemini-2.5-flash",
      provider: "google",
      durationMs: 900,
      createdAt: 20,
    });
  await db.insert(drafts)
    .values({
      id: DRAFT_ID,
      workspaceId: WORKSPACE_ID,
      sourceGenerationId: GENERATION_ID,
      sourceSignalId: SIGNAL_ID,
      campaignId: null,
      taskType: "linkedin_post",
      channel: "linkedin",
      originalContent: DRAFT_TEXT,
      content: DRAFT_TEXT,
      state: "pending_review",
      createdAt: 21,
      updatedAt: 21,
      ...overrides,
    });
}

describe("the why-this trace (Sprint 71 acceptance)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces)
      .values({ id: WORKSPACE_ID, name: "Acme", createdAt: 1, updatedAt: 1 });
    await db.insert(signals)
      .values({
        id: SIGNAL_ID,
        workspaceId: WORKSPACE_ID,
        content: "A competitor moved to seat-based pricing this morning.",
        source: "reddit",
        sourceUrl: "https://example.test/thread",
        createdAt: 10,
      });
  });

  it("answers 'why did it write this?' from the draft alone", async () => {
    await seedDraft(db);
    const trace = artifactTraceSchema.parse(await buildArtifactTrace(db, WORKSPACE_ID, "draft", DRAFT_ID));

    // What triggered it…
    expect(trace.origin!.kind).toBe("signal");
    expect(trace.origin!.detail).toContain("seat-based pricing");
    expect(trace.origin!.href).toContain(`signal=${SIGNAL_ID}`);
    // …which brain sections entered, and the resolver's own reason for each…
    const voice = trace.context.find((section) => section.key === "org:voice")!;
    expect(voice.included).toBe(true);
    expect(voice.reason).toContain("Org brain");
    expect(voice.href).toBe(`/workspaces/${WORKSPACE_ID}/brain?doc=voice`);
    // …what it learned from…
    expect(trace.examples.filter((e) => e.kind === "approved")).toHaveLength(2);
    expect(trace.examples.find((e) => e.kind === "rejected")!.why).toContain("No point of view");
    // …which learned rules steered it…
    expect(trace.preferences.map((rule) => rule.polarity)).toEqual(["do", "avoid"]);
    // …and what it cost.
    expect(trace.cost!.model).toBe("gemini-2.5-flash");
    expect(trace.knobs).toHaveLength(9);
  });

  it("shows the excluded sections too, with the reason they lost", async () => {
    await seedDraft(db);
    const trace = (await buildArtifactTrace(db, WORKSPACE_ID, "draft", DRAFT_ID))!;
    const excluded = trace.context.filter((section) => !section.included);
    expect(excluded.length).toBeGreaterThan(0);
    // "Why did it NOT use my campaign?" is the same question and needs the
    // same answer.
    expect(excluded.every((section) => section.reason.length > 0)).toBe(true);
  });

  it("links a rule that still exists and admits when one was retired", async () => {
    await seedDraft(db);
    await db.insert(preferenceRules)
      .values({
        id: RULE_ID,
        workspaceId: WORKSPACE_ID,
        rule: "Open with the reader's problem, not the company",
        polarity: "do",
        scopeTaskType: null,
        scopeChannel: null,
        status: "active",
        origin: "extracted",
        confidence: 80,
        observationCount: 4,
        appliedCount: 1,
        createdAt: 5,
        updatedAt: 5,
      });
    const trace = (await buildArtifactTrace(db, WORKSPACE_ID, "draft", DRAFT_ID))!;
    expect(trace.preferences[0]!.ruleId).toBe(RULE_ID);
    expect(trace.preferences[0]!.confidence).toBe(80);
    // The second rule was never stored — the panel says so rather than
    // linking to a rule page that has nothing to show.
    expect(trace.preferences[1]!.ruleId).toBeNull();
  });

  it("prefers the latest revision's context over the original generation's", async () => {
    await seedDraft(db);
    const revised = resolveContext({
      workspaceName: "Acme",
      docs: { ...DOCS, voice: "# Voice\nShorter. Sharper. No adjectives." },
      taskType: "linkedin_post",
      channel: "linkedin",
      matrix: defaultResolvedMatrix(),
    });
    await db.insert(draftRevisionTurns)
      .values({
        id: randomUUID(),
        requestId: randomUUID(),
        workspaceId: WORKSPACE_ID,
        draftId: DRAFT_ID,
        actorId: null,
        instruction: "Cut the second paragraph.",
        sourceContent: DRAFT_TEXT,
        resultContent: "Seat-based pricing punishes fast adopters.",
        sectionsJson: JSON.stringify(revised.sections),
        status: "completed",
        model: "gemini-2.5-flash",
        provider: "google",
        durationMs: 400,
        createdAt: 30,
        completedAt: 31,
      });
    const trace = (await buildArtifactTrace(db, WORKSPACE_ID, "draft", DRAFT_ID))!;
    // The words on screen came from the revision, so its context is the honest
    // answer — showing the original would explain text nobody can see.
    expect(trace.context.find((s) => s.key === "org:voice")!.excerpt).toContain("No adjectives");
    expect(trace.revisions).toHaveLength(1);
    expect(trace.revisions[0]!.changedShare).toBeGreaterThan(0);
    expect(trace.revisions[0]!.instruction).toBe("Cut the second paragraph.");
  });

  it("flags a priced-not-metered cost rather than presenting it as measured", async () => {
    await seedDraft(db);
    const trace = (await buildArtifactTrace(db, WORKSPACE_ID, "draft", DRAFT_ID))!;
    expect(trace.cost!.estimated).toBe(true);
    expect(trace.cost!.inputTokens).toBeGreaterThan(0);
  });

  it("matches the closest plan pillar by wording, and only when a campaign exists", async () => {
    await db.insert(campaigns)
      .values({
        id: CAMPAIGN_ID,
        workspaceId: WORKSPACE_ID,
        name: "Pricing rewrite",
        objective: "Land usage-based pricing",
        status: "active",
        createdAt: 5,
        updatedAt: 5,
      });
    await seedDraft(db, { campaignId: CAMPAIGN_ID });
    const trace = (await buildArtifactTrace(db, WORKSPACE_ID, "draft", DRAFT_ID))!;
    expect(trace.plan!.campaignName).toBe("Pricing rewrite");
    expect(trace.plan!.href).toContain(CAMPAIGN_ID);
  });

  it("says plainly when there is no campaign to serve a pillar of", async () => {
    await seedDraft(db);
    expect((await buildArtifactTrace(db, WORKSPACE_ID, "draft", DRAFT_ID))!.plan).toBeNull();
  });

  it("traces a publication through to the draft that produced the words", async () => {
    await seedDraft(db);
    const connectionId = randomUUID();
    await db.insert(connections)
      .values({
        id: connectionId,
        workspaceId: WORKSPACE_ID,
        providerKey: "reddit",
        nangoConnectionId: "conn-1",
        status: "connected",
        createdAt: 5,
        updatedAt: 5,
      });
    const publicationId = randomUUID();
    await db.insert(publications)
      .values({
        id: publicationId,
        workspaceId: WORKSPACE_ID,
        draftId: DRAFT_ID,
        connectionId,
        providerKey: "reddit",
        target: "r/startups",
        title: "Seat-based pricing",
        status: "scheduled",
        scheduledFor: 100,
        createdAt: 40,
        updatedAt: 40,
      });
    const trace = artifactTraceSchema.parse(
      await buildArtifactTrace(db, WORKSPACE_ID, "publication", publicationId),
    );
    expect(trace.subject.kind).toBe("publication");
    expect(trace.subject.id).toBe(publicationId);
    // Same reasoning, reached from the receipt instead of the draft.
    expect(trace.origin!.kind).toBe("signal");
    expect(trace.context.length).toBeGreaterThan(0);
  });

  it("names the gap when an action was assembled rather than written (D-71.9)", async () => {
    const actionId = randomUUID();
    await db.insert(externalActions)
      .values({
        id: actionId,
        workspaceId: WORKSPACE_ID,
        kind: "budget_change",
        status: "authorization_required",
        subjectKind: "ad_launch",
        subjectId: randomUUID(),
        draftId: null,
        payloadJson: "{}",
        subjectSnapshotJson: "{}",
        idempotencyKey: randomUUID(),
        fingerprint: "abc",
        policySnapshotJson: "{}",
        proposedByLabel: "founder",
        createdAt: 50,
        updatedAt: 50,
      });
    const trace = artifactTraceSchema.parse(
      await buildArtifactTrace(db, WORKSPACE_ID, "external_action", actionId),
    );
    expect(trace.context).toHaveLength(0);
    // A blank panel and "there was never a prompt" are different facts.
    expect(trace.contextReason).toContain("not written by a model");
    expect(trace.cost).toBeNull();
  });

  it("traces a content action through its draft", async () => {
    await seedDraft(db);
    const actionId = randomUUID();
    await db.insert(externalActions)
      .values({
        id: actionId,
        workspaceId: WORKSPACE_ID,
        kind: "publication",
        status: "authorization_required",
        subjectKind: "draft",
        subjectId: DRAFT_ID,
        draftId: DRAFT_ID,
        payloadJson: "{}",
        subjectSnapshotJson: "{}",
        idempotencyKey: randomUUID(),
        fingerprint: "def",
        policySnapshotJson: "{}",
        proposedByLabel: "agent",
        createdAt: 50,
        updatedAt: 50,
      });
    const trace = (await buildArtifactTrace(db, WORKSPACE_ID, "external_action", actionId))!;
    expect(trace.subject.kind).toBe("external_action");
    expect(trace.context.length).toBeGreaterThan(0);
    expect(trace.examples.length).toBeGreaterThan(0);
  });

  it("explains an empty context rather than rendering blank", async () => {
    await db.insert(drafts)
      .values({
        id: DRAFT_ID,
        workspaceId: WORKSPACE_ID,
        sourceGenerationId: null,
        sourceSignalId: null,
        taskType: "linkedin_post",
        channel: "linkedin",
        originalContent: "Pasted by hand.",
        content: "Pasted by hand.",
        state: "draft",
        createdAt: 21,
        updatedAt: 21,
      });
    const trace = (await buildArtifactTrace(db, WORKSPACE_ID, "draft", DRAFT_ID))!;
    expect(trace.context).toHaveLength(0);
    expect(trace.contextReason).toContain("outside the generation path");
    expect(trace.origin!.kind).toBe("manual");
    expect(trace.cost).toBeNull();
    // Still nine knobs: "nothing applied" is an answer.
    expect(trace.knobs).toHaveLength(9);
  });

  it("returns nothing for a subject in another workspace", async () => {
    await seedDraft(db);
    const other = randomUUID();
    await db.insert(workspaces).values({ id: other, name: "Other", createdAt: 1, updatedAt: 1 });
    expect(await buildArtifactTrace(db, other, "draft", DRAFT_ID)).toBeUndefined();
    expect(await buildArtifactTrace(db, WORKSPACE_ID, "draft", randomUUID())).toBeUndefined();
  });
});
