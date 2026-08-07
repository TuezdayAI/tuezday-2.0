import { describe, expect, it } from "vitest";
import {
  AGENT_PROPOSALS_PER_DAY,
  AGENT_PROPOSALS_PER_RUN,
  AGENT_TOOL_NAMES,
  ASK_TOOL_NAMES,
  EXTERNAL_ACTION_ORIGINS,
  PROPOSAL_RATIONALE_MAX_CHARS,
  PROPOSE_TOOL_NAMES,
  READ_TOOL_NAMES,
  agentProposalSchema,
  externalActionSchema,
  isProposeToolName,
  toolInputSchemas,
} from "../src/index";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";

function action(overrides: Record<string, unknown> = {}) {
  return {
    id: actionId,
    workspaceId,
    kind: "publish",
    status: "authorization_required",
    subject: {
      kind: "draft",
      id: "44444444-4444-4444-8444-444444444444",
      title: "Pricing post",
      summary: "The approved post.",
      channel: "linkedin",
      destination: "Founder account",
    },
    context: {
      campaignId: null,
      campaignName: null,
      personaId: null,
      personaName: null,
      connectionId: null,
      connectionName: null,
      laneRevisionId: null,
      laneName: null,
    },
    requestedFor: null,
    idempotencyKey: "agent:publish:x:0",
    fingerprint: "a".repeat(64),
    policy: {
      effective: "human_required",
      contributingRules: [
        {
          scope: "workspace",
          scopeId: workspaceId,
          scopeLabel: "Workspace default",
          rule: "human_required",
        },
      ],
    },
    blocker: null,
    supersedesActionId: null,
    supersededByActionId: null,
    execution: null,
    proposedBy: { userId: null, label: `agent:${runId}` },
    origin: "agent",
    originRunId: runId,
    originSurface: "pipeline" as const,
    createdAt: 1,
    updatedAt: 1,
    authorizedAt: null,
    dispatchedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("propose-tool contracts (Sprint 69)", () => {
  it("partitions the registry into read, propose and ask, with no overlap or gaps", () => {
    expect(AGENT_TOOL_NAMES).toEqual([
      ...READ_TOOL_NAMES,
      ...PROPOSE_TOOL_NAMES,
      ...ASK_TOOL_NAMES,
    ]);
    expect(new Set(AGENT_TOOL_NAMES).size).toBe(AGENT_TOOL_NAMES.length);
    for (const name of READ_TOOL_NAMES) expect(isProposeToolName(name)).toBe(false);
    for (const name of PROPOSE_TOOL_NAMES) expect(isProposeToolName(name)).toBe(true);
    // Sprint 70: the ask tier is not a propose tier. A tool misfiled as
    // `propose` would be counted against the proposal cap and, worse, would
    // read to a founder as something the agent tried to do.
    for (const name of ASK_TOOL_NAMES) expect(isProposeToolName(name)).toBe(false);
  });

  it("gives every tool — including the five new ones — an input schema", () => {
    for (const name of AGENT_TOOL_NAMES) {
      expect(toolInputSchemas[name], name).toBeDefined();
    }
  });

  it("requires a rationale on every proposal, and bounds it", () => {
    for (const name of PROPOSE_TOOL_NAMES) {
      const schema = toolInputSchemas[name];
      const parsed = schema.safeParse({});
      expect(parsed.success, name).toBe(false);
      // The rationale is what the founder reads in the queue. A proposal that
      // cannot say why it exists is not a proposal, it is a side effect.
      expect(JSON.stringify(parsed.error?.issues), name).toContain("rationale");
    }
    expect(
      toolInputSchemas.propose_reply.safeParse({
        inboxItemId: actionId,
        rationale: "x".repeat(PROPOSAL_RATIONALE_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it("carries a typed origin on every action", () => {
    expect(EXTERNAL_ACTION_ORIGINS).toEqual(["human", "system", "agent"]);
    expect(externalActionSchema.safeParse(action()).success).toBe(true);
    expect(
      externalActionSchema.safeParse(action({ origin: "human", originRunId: null })).success,
    ).toBe(true);
  });

  it("refuses an agent action that cannot name the run behind it", () => {
    // Unattributable agent action = the one thing this sprint owed the queue.
    expect(externalActionSchema.safeParse(action({ originRunId: null })).success).toBe(false);
    // ...and the converse: a human action pretending to have a run.
    expect(externalActionSchema.safeParse(action({ origin: "system" })).success).toBe(false);
  });

  it("keeps the caps small enough to matter", () => {
    expect(AGENT_PROPOSALS_PER_RUN).toBeLessThan(AGENT_PROPOSALS_PER_DAY);
    expect(AGENT_PROPOSALS_PER_RUN).toBeGreaterThan(0);
  });

  it("keeps a proposal pointing at exactly one kind of thing", () => {
    const base = {
      id: actionId,
      workspaceId,
      agentRunId: runId,
      tool: "propose_draft" as const,
      targetKind: "draft" as const,
      draftId: "44444444-4444-4444-8444-444444444444",
      externalActionId: null,
      summary: "Submitted a linkedin draft for review.",
      rationale: "The pricing change is worth a post.",
      createdAt: 1,
    };
    expect(agentProposalSchema.safeParse(base).success).toBe(true);
    expect(
      agentProposalSchema.safeParse({ ...base, externalActionId: actionId }).success,
    ).toBe(false);
    // A deleted target nulls both links; the record of the proposal survives.
    expect(
      agentProposalSchema.safeParse({
        ...base,
        targetKind: "external_action",
        draftId: null,
        externalActionId: null,
      }).success,
    ).toBe(true);
  });
});
