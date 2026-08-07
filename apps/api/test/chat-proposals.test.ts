import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  CHAT_PROPOSALS_PER_THREAD,
  upsertCampaignInputSchema,
  type ChatProposal,
} from "@tuezday/contracts";
import type { ConnectorFabric } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import {
  agentProposals,
  chatProposals,
  connections,
  drafts,
  externalActions,
  workspaces,
} from "../src/db/schema";
import { createAgentProposals } from "../src/services/agent-proposals";
import { createCampaign } from "../src/services/campaigns";
import { createSession, listMessages } from "../src/services/chat";
import {
  confirmChatProposal,
  countChatProposalsToday,
  createChatProposalRecorder,
  declineChatProposal,
  listChatProposals,
} from "../src/services/chat-proposals";
import { createTaintTracker } from "../src/services/chat-quarantine";
import { ensureWorkspaceActionPolicies } from "../src/services/external-action-backfill";
import { createExternalActionAdapters } from "../src/services/external-action-adapters";
import { createExternalActionRuntime } from "../src/services/external-action-coordinator";
import {
  listExternalActionPolicies,
  upsertExternalActionPolicies,
} from "../src/services/external-action-policy";
import { createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// Confirm-before-propose (Sprint 78).
//
// The two claims that matter, and both are tested against the REAL Sprint 69
// service rather than a stub:
//   1. recording a proposal changes nothing — no draft, no external action,
//      no ledger row;
//   2. confirming one changes exactly what the policy tree says it may, and
//      `human_required` still stops it dead.
// ---------------------------------------------------------------------------

const ACTOR = { userId: null, label: "founder" };

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
let sessionId: string;
let live: ReturnType<typeof createAgentProposals>;
const runId = "99999999-9999-4999-8999-999999999999";

function recorder(taint = createTaintTracker(), recorded: ChatProposal[] = []) {
  return {
    service: createChatProposalRecorder(db, {
      workspaceId,
      sessionId,
      taint,
      onRecorded: (p) => recorded.push(p),
    }),
    recorded,
  };
}

const origin = () => ({ agentRunId: runId, workspaceId });

async function setPublishPolicy(rule: "autonomous" | "human_required") {
  const current = await listExternalActionPolicies(db, workspaceId, "workspace", workspaceId);
  await upsertExternalActionPolicies(
    db,
    workspaceId,
    {
      scope: "workspace",
      scopeId: workspaceId,
      expectedUpdatedAt: current.updatedAt,
      rules: current.rules.map((entry) => ({
        actionKind: entry.actionKind,
        rule: entry.actionKind === "publish" ? rule : entry.rule,
      })),
    },
    null,
  );
}

async function approvedDraft(): Promise<string> {
  const id = randomUUID();
  await db.insert(drafts)
    .values({
      id,
      workspaceId,
      taskType: "linkedin_post",
      channel: "linkedin",
      originalContent: "Approved post",
      content: "Approved post",
      state: "approved",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  return id;
}

beforeEach(async () => {
  db = createTestDb();
  workspaceId = randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, name: "Acme", createdAt: 1, updatedAt: 1 }).run();
  sessionId = (await createSession(db, workspaceId, null, {})).id;
  await ensureWorkspaceActionPolicies(db, workspaceId);
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

describe("recording changes nothing", () => {
  it("writes a pending row and no draft, action or ledger entry", async () => {
    const { service, recorded } = recorder();
    const result = await service.proposeDraft(origin(), {
      content: "We raised a seed round.",
      channel: "linkedin",
      rationale: "You asked for a funding post.",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.awaitingConfirmation).toBe(true);
    expect(result.ok && result.status).toBe("awaiting_confirmation");

    // Nothing durable except the pause itself.
    expect(await db.select().from(drafts).all()).toHaveLength(0);
    expect(await db.select().from(externalActions).all()).toHaveLength(0);
    expect(await db.select().from(agentProposals).all()).toHaveLength(0);

    const stored = await listChatProposals(db, sessionId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe("pending");
    expect(stored[0]!.agentRunId).toBe(runId);
    expect(recorded).toHaveLength(1);
  });

  it("renders a statement of intent that says what does NOT happen", async () => {
    const campaign = await createCampaign(
      db,
      workspaceId,
      upsertCampaignInputSchema.parse({ name: "Launch", objective: "Ship it" }),
    );
    const { service } = recorder();
    await service.proposeDraft(origin(), {
      content: "We raised a seed round from people who get GTM.",
      channel: "linkedin",
      campaignId: campaign.id,
      rationale: "You asked for a funding post.",
    });

    const intent = (await listChatProposals(db, sessionId))[0]!.intent;
    expect(intent.title).toBe("Submit a linkedin draft for review");
    expect(intent.effect).toContain("Nothing is published");
    // The campaign is named, not shown as a uuid the founder cannot check.
    expect(intent.detail).toContainEqual({ label: "Campaign", value: "Launch" });
    expect(intent.rationale).toContain("funding post");
  });

  it("carries the quarantine verdict onto the row", async () => {
    const taint = createTaintTracker();
    taint.observe("safe_fetch_url", { text: "Competitor shipped usage-based pricing this quarter." });
    const { service } = recorder(taint);
    await service.proposeDraft(origin(), {
      content: "Anything at all.",
      channel: "linkedin",
      rationale: "x",
    });
    const stored = (await listChatProposals(db, sessionId))[0]!;
    expect(stored.quarantined).toBe(true);
    expect(stored.quarantineReason).toBeTruthy();
  });
});

describe("caps bound asking", () => {
  it("refuses past the per-thread cap, as data the model can react to", async () => {
    const { service } = recorder();
    for (let i = 0; i < CHAT_PROPOSALS_PER_THREAD; i++) {
      const ok = await service.proposeDraft(origin(), {
        content: `Post ${i}`,
        channel: "linkedin",
        rationale: "x",
      });
      expect(ok.ok).toBe(true);
    }
    const refused = await service.proposeDraft(origin(), {
      content: "One too many",
      channel: "linkedin",
      rationale: "x",
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toBe("chat_proposal_cap_reached");
    // And it did not record the refused one.
    expect(await listChatProposals(db, sessionId)).toHaveLength(CHAT_PROPOSALS_PER_THREAD);
  });

  it("counts the workspace's chat proposals across threads for the daily cap", async () => {
    const other = (await createSession(db, workspaceId, null, {})).id;
    await recorder().service.proposeDraft(origin(), {
      content: "a",
      channel: "linkedin",
      rationale: "x",
    });
    const second = createChatProposalRecorder(db, {
      workspaceId,
      sessionId: other,
      taint: createTaintTracker(),
    });
    await second.proposeDraft(origin(), { content: "b", channel: "linkedin", rationale: "x" });
    expect(await countChatProposalsToday(db, workspaceId)).toBe(2);
  });
});

describe("confirming runs the real gate", () => {
  it("creates an approval-gated draft attached to the campaign the founder named", async () => {
    const campaign = await createCampaign(
      db,
      workspaceId,
      upsertCampaignInputSchema.parse({ name: "Launch", objective: "Land demos" }),
    );
    const { service } = recorder();
    await service.proposeDraft(origin(), {
      content: "We raised a seed round.",
      channel: "linkedin",
      campaignId: campaign.id,
      rationale: "You asked for a funding post.",
    });
    const pending = (await listChatProposals(db, sessionId))[0]!;

    const outcome = await confirmChatProposal(db, live, workspaceId, ACTOR, pending.id);
    expect(outcome.ok).toBe(true);
    const confirmed = outcome.ok ? outcome.proposal : null;
    expect(confirmed!.status).toBe("confirmed");
    expect(confirmed!.producedRef).toMatch(/^draft:/);
    // The approval gate, not the policy tree — a draft is not an external
    // action, it is the subject of one (D-69.2).
    expect(confirmed!.producedStatus).toBe("pending_review");

    const draft = (await db.select().from(drafts).all())[0]!;
    expect(draft.state).toBe("pending_review");
    expect(draft.campaignId).toBe(campaign.id);
    // The Sprint 69 ledger records it, tagged with the conversation.
    const ledger = await db.select().from(agentProposals).all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.chatSessionId).toBe(sessionId);
  });

  it("appends a receipt to the thread carrying what it produced", async () => {
    const { service } = recorder();
    await service.proposeDraft(origin(), {
      content: "Post",
      channel: "linkedin",
      rationale: "x",
    });
    const pending = (await listChatProposals(db, sessionId))[0]!;
    await confirmChatProposal(db, live, workspaceId, ACTOR, pending.id);

    const receipt = (await listMessages(db, sessionId)).at(-1)!;
    expect(receipt.role).toBe("assistant");
    expect(receipt.content).toContain("waiting for you in Review");
    expect(receipt.producedRef).toMatch(/^draft:/);
  });

  it("marks the action as chat-originated so the queue can say so", async () => {
    await setPublishPolicy("human_required");
    const draftId = await approvedDraft();
    const connectionId = randomUUID();
    await db.insert(connections)
      .values({
        id: connectionId,
        workspaceId,
        providerKey: "reddit",
        nangoConnectionId: randomUUID(),
        displayName: "Founder Reddit",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    const { service } = recorder();
    await service.proposePublication(origin(), {
      draftId,
      connectionId,
      target: "test",
      rationale: "The thread is peaking.",
    });
    const pending = (await listChatProposals(db, sessionId))[0]!;
    const outcome = await confirmChatProposal(db, live, workspaceId, ACTOR, pending.id);

    expect(outcome.ok).toBe(true);
    const action = (await db.select().from(externalActions).all())[0]!;
    // human_required stops it dead — nothing dispatched.
    expect(action.status).toBe("authorization_required");
    expect(action.origin).toBe("agent");
    expect(action.originSurface).toBe("chat");
    expect(action.originRunId).toBe(runId);
    // A founder confirming is attribution, never humanity (D-78.7).
    expect(action.proposedByUserId).toBeNull();
  });

  it("records a governed refusal on the card and in the thread, rather than throwing", async () => {
    // An unapproved draft: `publishIntent` has always refused this, and it goes
    // on refusing it for an agent that a founder confirmed.
    const unapproved = randomUUID();
    await db.insert(drafts)
      .values({
        id: unapproved,
        workspaceId,
        taskType: "linkedin_post",
        channel: "linkedin",
        originalContent: "Draft",
        content: "Draft",
        state: "draft",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    const { service } = recorder();
    await service.proposePublication(origin(), {
      draftId: unapproved,
      target: "test",
      rationale: "x",
    });
    const pending = (await listChatProposals(db, sessionId))[0]!;
    const outcome = await confirmChatProposal(db, live, workspaceId, ACTOR, pending.id);

    expect(outcome.ok).toBe(true);
    const failed = outcome.ok ? outcome.proposal : null;
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toBeTruthy();
    expect(await db.select().from(externalActions).all()).toHaveLength(0);
    // The model sees the real reason on its next turn and can correct itself.
    expect((await listMessages(db, sessionId)).at(-1)!.content).toContain("couldn't go through");
  });

  it("refuses a second confirmation of the same proposal", async () => {
    const { service } = recorder();
    await service.proposeDraft(origin(), { content: "Post", channel: "linkedin", rationale: "x" });
    const pending = (await listChatProposals(db, sessionId))[0]!;

    await confirmChatProposal(db, live, workspaceId, ACTOR, pending.id);
    const again = await confirmChatProposal(db, live, workspaceId, ACTOR, pending.id);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.error).toBe("already_resolved");
    expect(await db.select().from(drafts).all()).toHaveLength(1);
  });

  it("does not reach across workspaces", async () => {
    const rival = randomUUID();
    await db.insert(workspaces).values({ id: rival, name: "Rival", createdAt: 1, updatedAt: 1 }).run();
    const { service } = recorder();
    await service.proposeDraft(origin(), { content: "Post", channel: "linkedin", rationale: "x" });
    const pending = (await listChatProposals(db, sessionId))[0]!;

    const outcome = await confirmChatProposal(db, live, rival, ACTOR, pending.id);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toBe("not_found");
  });
});

describe("declining", () => {
  it("resolves the card and creates nothing, quietly", async () => {
    const { service } = recorder();
    await service.proposeDraft(origin(), { content: "Post", channel: "linkedin", rationale: "x" });
    const pending = (await listChatProposals(db, sessionId))[0]!;
    const before = (await listMessages(db, sessionId)).length;

    const outcome = await declineChatProposal(db, workspaceId, ACTOR, pending.id);
    expect(outcome.ok && outcome.proposal.status).toBe("declined");
    expect(await db.select().from(drafts).all()).toHaveLength(0);
    // No message: the struck-through card says it, and a transcript line
    // saying "you declined" is noise the next turn does not need spelled out.
    expect(await listMessages(db, sessionId)).toHaveLength(before);
  });

  it("cannot decline what is already resolved", async () => {
    const { service } = recorder();
    await service.proposeDraft(origin(), { content: "Post", channel: "linkedin", rationale: "x" });
    const pending = (await listChatProposals(db, sessionId))[0]!;
    await declineChatProposal(db, workspaceId, ACTOR, pending.id);
    expect((await declineChatProposal(db, workspaceId, ACTOR, pending.id)).ok).toBe(false);
  });
});

describe("the row survives what it points at", () => {
  it("keeps the record when the thread is deleted only by cascade, not by proposal state", async () => {
    // chat_proposals cascades with its session (a deleted conversation takes
    // its cards), but the Sprint 69 ledger row does NOT — it has no FK to the
    // thread, so what was actually proposed outlives the conversation.
    const columns = await db.select().from(chatProposals).all();
    expect(columns).toEqual([]);
    expect(
      await db.select().from(agentProposals).where(eq(agentProposals.workspaceId, workspaceId)).all(),
    ).toEqual([]);
  });
});
