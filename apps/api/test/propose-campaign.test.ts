import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { ConnectorFabric } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import { agentProposals, campaigns, workspaces } from "../src/db/schema";
import { createAgentProposals } from "../src/services/agent-proposals";
import { simulatedAgentProposals } from "../src/agents/proposals";
import { listCampaigns } from "../src/services/campaigns";
import { createSession, listMessages } from "../src/services/chat";
import {
  confirmChatProposal,
  createChatProposalRecorder,
  listChatProposals,
} from "../src/services/chat-proposals";
import { createTaintTracker } from "../src/services/chat-quarantine";
import { createExternalActionAdapters } from "../src/services/external-action-adapters";
import { createExternalActionRuntime } from "../src/services/external-action-coordinator";
import { ensureWorkspaceActionPolicies } from "../src/services/external-action-backfill";
import { createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// propose_campaign (Sprint 77, D-77.7).
//
// The founder's requirement was "the chat has to be able to create campaigns".
// The claim this file defends is the second half of that: it creates them in a
// state that DOES NOTHING. A campaign has no approval queue, so its own status
// is the gate — and a model that could set `status: "active"` would be able to
// start a campaign matching live discovery signals by naming a field.
// ---------------------------------------------------------------------------

const noFabric: ConnectorFabric = {
  async health() {
    return { healthy: true };
  },
  async ensureIntegration() {},
  async createConnectSession() {
    return { token: "t" };
  },
  async importConnection() {},
  async connectionExists() {
    return true;
  },
  async deleteConnection() {},
  async proxyGet() {
    return { status: 200, bodySnippet: "{}" };
  },
  async proxyJson() {
    return { status: 200, json: {} };
  },
};

let db: Db;
let workspaceId: string;
let live: ReturnType<typeof createAgentProposals>;
const runId = "99999999-9999-4999-8999-999999999999";
const origin = () => ({ agentRunId: runId, workspaceId });

beforeEach(() => {
  db = createTestDb();
  workspaceId = randomUUID();
  db.insert(workspaces).values({ id: workspaceId, name: "Acme", createdAt: 1, updatedAt: 1 }).run();
  ensureWorkspaceActionPolicies(db, workspaceId);
  live = createAgentProposals({
    db,
    runtime: createExternalActionRuntime({
      db,
      adapters: createExternalActionAdapters(db, noFabric, fetch, undefined, undefined),
    }),
    fabric: noFabric,
    fetcher: fetch,
  });
});

describe("the live implementation", () => {
  it("creates the campaign, and creates it inert", async () => {
    const result = await live.proposeCampaign(origin(), {
      name: "Q4 Launch",
      objective: "Land 50 RevOps demos",
      kpi: "demos booked",
      timeframe: "Oct–Dec",
      channels: ["linkedin"],
      rationale: "You asked for a launch campaign.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetKind).toBe("campaign");
    expect(result.status).toBe("draft");

    const created = listCampaigns(db, workspaceId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: "Q4 Launch",
      objective: "Land 50 RevOps demos",
      status: "draft",
      // Attribution: the campaigns list can say which ones an agent drew up.
      origin: "system",
      // The three fields that would make it act, all off.
      automationMode: "manual",
      autoDailyCap: null,
    });
  });

  it("forces draft status even when the row it wrote is inspected directly", async () => {
    await live.proposeCampaign(origin(), { name: "Q4", rationale: "r" });
    const row = db.select().from(campaigns).where(eq(campaigns.workspaceId, workspaceId)).get();
    expect(row?.status).toBe("draft");
    expect(row?.origin).toBe("system");
  });

  it("records a ledger row pointing at the campaign", async () => {
    const result = await live.proposeCampaign(origin(), { name: "Q4", rationale: "why" });
    const row = db.select().from(agentProposals).where(eq(agentProposals.agentRunId, runId)).get();
    expect(row).toMatchObject({
      tool: "propose_campaign",
      targetKind: "campaign",
      rationale: "why",
      draftId: null,
      externalActionId: null,
    });
    expect(row?.campaignId).toBe(result.ok ? result.id : null);
  });

  it("refuses a nameless campaign with the campaign contract's own message", async () => {
    const result = await live.proposeCampaign(origin(), { name: "   ", rationale: "r" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_arguments");
    expect(listCampaigns(db, workspaceId)).toHaveLength(0);
  });

  it("refuses a hallucinated persona id rather than dropping it silently", async () => {
    const result = await live.proposeCampaign(origin(), {
      name: "Q4",
      personaIds: ["not-a-uuid"],
      rationale: "r",
    });
    expect(result.ok).toBe(false);
    expect(listCampaigns(db, workspaceId)).toHaveLength(0);
  });

  it("creates nothing in a simulated run", async () => {
    const result = await simulatedAgentProposals().proposeCampaign(origin(), {
      name: "Q4",
      rationale: "r",
    });
    expect(result).toMatchObject({ ok: true, id: null, simulated: true, targetKind: "campaign" });
  });
});

describe("inside a conversation it is double-gated", () => {
  it("records a confirmation card and creates nothing until it is confirmed", async () => {
    const sessionId = createSession(db, workspaceId, null, {}).id;
    const recorder = createChatProposalRecorder(db, {
      workspaceId,
      sessionId,
      taint: createTaintTracker(),
    });

    const recorded = await recorder.proposeCampaign(origin(), {
      name: "Q4 Launch",
      objective: "Land 50 RevOps demos",
      rationale: "You asked for a launch campaign.",
    });
    expect(recorded).toMatchObject({ ok: true, awaitingConfirmation: true });
    // Nothing exists yet. This is the Sprint 78 pause doing its job.
    expect(listCampaigns(db, workspaceId)).toHaveLength(0);

    const pending = listChatProposals(db, sessionId)[0]!;
    expect(pending.tool).toBe("propose_campaign");
    expect(pending.intent.title).toContain("Q4 Launch");
    // The card says what confirming does AND what it does not.
    expect(pending.intent.effect).toContain("DRAFT");
    expect(pending.intent.effect.toLowerCase()).toContain("until you open it and activate it");

    const outcome = await confirmChatProposal(db, live, workspaceId, { userId: null, label: "founder" }, pending.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.proposal.status).toBe("confirmed");
    expect(outcome.proposal.producedRef).toMatch(/^campaign:/);
    expect(outcome.proposal.producedStatus).toBe("draft");

    const created = listCampaigns(db, workspaceId);
    expect(created).toHaveLength(1);
    expect(created[0]!.status).toBe("draft");

    // The receipt tells the founder — and the next turn's model — the truth.
    const receipt = listMessages(db, sessionId).at(-1)!;
    expect(receipt.content).toContain("inert until you activate it");
    expect(receipt.producedRef).toBe(outcome.proposal.producedRef);
  });
});
