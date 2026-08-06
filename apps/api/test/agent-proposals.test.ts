import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_PROPOSALS_PER_DAY } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import { agentProposals, connections, drafts, publications } from "../src/db/schema";
import { simulatedAgentProposals, type AgentProposalService } from "../src/agents/proposals";
import { createAgentProposals } from "../src/services/agent-proposals";
import { countProposalsToday } from "../src/services/agent-proposal-ledger";
import { createExternalActionAdapters } from "../src/services/external-action-adapters";
import { createExternalActionRuntime } from "../src/services/external-action-coordinator";
import { getExternalAction } from "../src/services/external-actions";
import { getDraft } from "../src/services/drafts";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

const RUN_ID = "99999999-9999-4999-8999-999999999999";

/** Reddit-shaped fabric: enough for the publish adapter to build an intent. */
function fabric(posts: Array<Record<string, string>>): ConnectorFabric {
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession() {
      return { token: "token" };
    },
    async importConnection() {},
    async connectionExists() {
      return true;
    },
    async deleteConnection() {},
    async proxyGet() {
      return { status: 200, bodySnippet: "{}" };
    },
    async proxyJson(method, path, _connectionId, _providerConfigKey, options) {
      if (method === "POST" && path.startsWith("/api/submit")) {
        posts.push(options?.form ?? {});
        return {
          status: 200,
          json: {
            json: {
              errors: [],
              data: { name: `t3_p${posts.length}`, url: `https://reddit.com/p${posts.length}` },
            },
          },
        };
      }
      return { status: 200, json: { name: "founder" } };
    },
  };
}

describe("agent proposals (Sprint 69)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let connectionId: string;
  let posts: Array<Record<string, string>>;
  let proposals: AgentProposalService;

  beforeEach(async () => {
    db = createTestDb();
    posts = [];
    const connectors = fabric(posts);
    app = await buildAuthedApp({ db, connectors });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Acting" } })
    ).json().id;
    connectionId = randomUUID();
    const now = Date.now();
    db.insert(connections)
      .values({
        id: connectionId,
        workspaceId,
        providerKey: "reddit",
        nangoConnectionId: randomUUID(),
        displayName: "Founder Reddit",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    proposals = createAgentProposals({
      db,
      runtime: createExternalActionRuntime({
        db,
        adapters: createExternalActionAdapters(db, connectors, fetch, undefined, undefined),
      }),
      fabric: connectors,
      fetcher: fetch,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const origin = () => ({ agentRunId: RUN_ID, workspaceId });

  function seedDraft(state: "approved" | "pending_review", personaId: string | null = null) {
    const id = randomUUID();
    const now = Date.now();
    db.insert(drafts)
      .values({
        id,
        workspaceId,
        taskType: "linkedin_post",
        channel: "reddit",
        personaId,
        originalContent: "A post about usage-based pricing.",
        content: "A post about usage-based pricing.",
        state,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  it("submits a written draft to the approval gate, not to a send path (D-69.2)", async () => {
    const result = await proposals.proposeDraft(origin(), {
      content: "Their pricing page is a strategy document.",
      channel: "linkedin",
      rationale: "The competitor moved to usage-based pricing this morning.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetKind).toBe("draft");
    expect(result.status).toBe("pending_review");

    const draft = getDraft(db, workspaceId, result.id!);
    expect(draft?.state).toBe("pending_review");
    // A machine-written draft must never look like a human approval — that is
    // what the Sprint 52 publish gate collapses on.
    const decisions = db.select().from(agentProposals).all();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.rationale).toContain("usage-based pricing");
    // Nothing external exists yet: writing is not sending.
    expect(posts).toHaveLength(0);
  });

  it("refuses to publish a draft a human has not approved", async () => {
    const draftId = seedDraft("pending_review");
    const result = await proposals.proposePublication(origin(), {
      draftId,
      target: "test",
      connectionId,
      rationale: "It is ready.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The refusal comes from publishIntent, which was refusing this before an
    // agent existed. No new gate was written for it.
    expect(result.error).toBe("draft_not_approved");
    expect(db.select().from(agentProposals).all()).toHaveLength(0);
  });

  it("parks a publication when the policy tree says human_required (acceptance)", async () => {
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, {
      publish: "human_required",
    });
    const draftId = seedDraft("approved");
    const result = await proposals.proposePublication(origin(), {
      draftId,
      target: "test",
      connectionId,
      rationale: "The thread is peaking now.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("authorization_required");
    expect(posts).toHaveLength(0);

    const action = getExternalAction(db, workspaceId, result.id!)!;
    expect(action.origin).toBe("agent");
    expect(action.originRunId).toBe(RUN_ID);
    // Attributable both ways: the queue names the run, the run lists the action.
    expect(db.select().from(agentProposals).all()[0]!.externalActionId).toBe(action.id);
  });

  it("lets an autonomous policy dispatch it, exactly as for a person (D-69.1)", async () => {
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, { publish: "autonomous" });
    const draftId = seedDraft("approved");
    const result = await proposals.proposePublication(origin(), {
      draftId,
      target: "test",
      connectionId,
      rationale: "Autonomous by the founder's own configuration.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("succeeded");
    expect(posts).toHaveLength(1);
    expect(db.select().from(publications).all()).toHaveLength(1);
  });

  it("resolves the destination from history and says what to pass when it cannot", async () => {
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, {
      publish: "human_required",
    });
    const draftId = seedDraft("approved");
    const noHistory = await proposals.proposePublication(origin(), {
      draftId,
      connectionId,
      rationale: "No target given.",
    });
    expect(noHistory.ok).toBe(false);
    if (noHistory.ok) return;
    expect(noHistory.error).toBe("target_unknown");
    expect(noHistory.hint).toContain("target");

    db.insert(publications)
      .values({
        id: randomUUID(),
        workspaceId,
        draftId,
        connectionId,
        providerKey: "reddit",
        target: "r/saas",
        title: "Earlier post",
        status: "published",
        scheduledFor: Date.now() - 1000,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      })
      .run();
    const resolved = await proposals.proposePublication(origin(), {
      draftId,
      connectionId,
      rationale: "Same place as last time.",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.summary).toContain("r/saas");
  });

  it("does not ask the model for a connection it has no way to know (D-69.9)", async () => {
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, {
      publish: "human_required",
    });
    // No persona on the draft, so there is no primary account to route to and
    // no connection was named. It says what is missing instead of guessing.
    const result = await proposals.proposePublication(origin(), {
      draftId: seedDraft("approved"),
      target: "test",
      rationale: "Publish it somewhere.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("persona_account_missing");
    expect(result.hint).toContain("primary social account");
  });

  it("refuses an ad mutation that changes both things or neither", async () => {
    const launchId = randomUUID();
    for (const args of [
      { launchId, rationale: "Nothing." },
      { launchId, dailyBudgetCents: 5000, countries: ["US"], ageMin: 25, ageMax: 45, rationale: "Both." },
    ]) {
      const result = await proposals.proposeAdMutation(origin(), args);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("invalid_arguments");
    }
  });

  it("stops at the daily cap before touching any adapter (D-69.8)", async () => {
    const now = Date.now();
    for (let i = 0; i < AGENT_PROPOSALS_PER_DAY; i += 1) {
      db.insert(agentProposals)
        .values({
          id: randomUUID(),
          workspaceId,
          agentRunId: randomUUID(),
          tool: "propose_draft",
          targetKind: "draft",
          draftId: null,
          externalActionId: null,
          summary: "Earlier proposal",
          rationale: "Earlier",
          createdAt: now - i * 1000,
        })
        .run();
    }
    expect(countProposalsToday(db, workspaceId)).toBe(AGENT_PROPOSALS_PER_DAY);

    const result = await proposals.proposeDraft(origin(), {
      content: "One more.",
      channel: "linkedin",
      rationale: "Over the line.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("proposal_cap_reached");
    // Nothing was written, not even the draft that would have been "harmless".
    expect(db.select().from(drafts).all()).toHaveLength(0);
  });

  it("counts only the trailing day, so yesterday's proposals do not block today", () => {
    db.insert(agentProposals)
      .values({
        id: randomUUID(),
        workspaceId,
        agentRunId: RUN_ID,
        tool: "propose_draft",
        targetKind: "draft",
        draftId: null,
        externalActionId: null,
        summary: "Two days ago",
        rationale: "Old",
        createdAt: Date.now() - 48 * 60 * 60 * 1000,
      })
      .run();
    expect(countProposalsToday(db, workspaceId)).toBe(0);
  });

  it("simulates in every non-live mode without writing anything (D-69.6)", async () => {
    const simulated = simulatedAgentProposals();
    const result = await simulated.proposePublication(origin(), {
      draftId: randomUUID(),
      rationale: "A shadow run should reason identically and change nothing.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.simulated).toBe(true);
    expect(result.id).toBeNull();
    expect(db.select().from(agentProposals).all()).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
});
