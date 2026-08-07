import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  pipelineSpecSchema,
  type PipelineDefinition,
  type PipelineRunMode,
  type PipelineSpec,
} from "@tuezday/contracts";
import type { ConnectorFabric } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import {
  agentProposals,
  connections,
  drafts,
  externalActions,
  publications,
  signals,
  workspaces,
} from "../src/db/schema";
import type { EvidenceStore } from "../src/evidence/store";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import type { SafeFetchService } from "../src/safe-fetch/index";
import { createAgentProposals } from "../src/services/agent-proposals";
import { ensureWorkspaceActionPolicies } from "../src/services/external-action-backfill";
import { createExternalActionAdapters } from "../src/services/external-action-adapters";
import { createExternalActionRuntime } from "../src/services/external-action-coordinator";
import {
  listExternalActionPolicies,
  upsertExternalActionPolicies,
} from "../src/services/external-action-policy";
import {
  createPipelineDefinition,
  setPipelineStatus,
} from "../src/services/pipeline-definitions";
import {
  executePipelineRun,
  startPipelineRun,
  type PipelineEngineDeps,
} from "../src/services/pipeline-engine";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SIGNAL_ID = "33333333-3333-4333-8333-333333333333";
const DRAFT_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR = { userId: null, label: "founder" };

const noEvidence: EvidenceStore = {
  async health() {
    return { healthy: true };
  },
  async createCollection() {
    return "unused";
  },
  async addDocument() {
    return "unused";
  },
  async attachDocument() {},
  async deleteDocument() {},
  async search() {
    return [];
  },
};

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
            json: { errors: [], data: { name: "t3_p1", url: "https://reddit.com/p1" } },
          },
        };
      }
      return { status: 200, json: { name: "founder" } };
    },
  };
}

/** One draft step that calls propose_publication, then answers. */
function spec(): PipelineSpec {
  return pipelineSpecSchema.parse({
    steps: [
      {
        key: "draft",
        title: "Draft",
        goal: "Write the post and propose publishing the approved one.",
        kind: "agent",
        tools: ["propose_publication"],
        tier: "cheap",
        output: "draft",
        maxSteps: 3,
        maxTokens: 8_000,
      },
      { key: "propose", title: "Propose", goal: "Submit.", kind: "propose", output: "proposal" },
    ],
    budget: { maxTokens: 100_000 },
  });
}

const script = (connectionId: string): ScriptedStep[] => [
  {
    toolCalls: [
      {
        name: "propose_publication",
        arguments: {
          draftId: DRAFT_ID,
          connectionId,
          target: "test",
          rationale: "The thread about pricing is peaking right now.",
        },
      },
    ],
  },
  { text: JSON.stringify({ content: "A post about usage-based pricing.", confidence: 90 }) },
];

function fixture(posts: Array<Record<string, string>>) {
  const db = createTestDb();
  const connectors = fabric(posts);
  db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Acting", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(signals)
    .values({
      id: SIGNAL_ID,
      workspaceId: WORKSPACE_ID,
      content: "A competitor moved to usage-based pricing.",
      source: "manual",
      sourceUrl: null,
      createdAt: 2,
    })
    .run();
  const connectionId = randomUUID();
  db.insert(connections)
    .values({
      id: connectionId,
      workspaceId: WORKSPACE_ID,
      providerKey: "reddit",
      nangoConnectionId: randomUUID(),
      displayName: "Founder Reddit",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(drafts)
    .values({
      id: DRAFT_ID,
      workspaceId: WORKSPACE_ID,
      taskType: "linkedin_post",
      channel: "linkedin",
      originalContent: "Approved post",
      content: "Approved post",
      // The human gate that already stood in front of publishing.
      state: "approved",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  ensureWorkspaceActionPolicies(db, WORKSPACE_ID);
  const proposals = createAgentProposals({
    db,
    runtime: createExternalActionRuntime({
      db,
      adapters: createExternalActionAdapters(db, connectors, fetch, undefined, undefined),
    }),
    fabric: connectors,
    fetcher: fetch,
  });
  return { db, connectionId, proposals };
}

function setPublishPolicy(db: Db, rule: "autonomous" | "human_required") {
  const current = listExternalActionPolicies(db, WORKSPACE_ID, "workspace", WORKSPACE_ID);
  upsertExternalActionPolicies(
    db,
    WORKSPACE_ID,
    {
      scope: "workspace",
      scopeId: WORKSPACE_ID,
      expectedUpdatedAt: current.updatedAt,
      rules: current.rules.map((entry) => ({
        actionKind: entry.actionKind,
        rule: entry.actionKind === "publish" ? rule : entry.rule,
      })),
    },
    null,
  );
}

function definitionFor(db: Db): PipelineDefinition {
  const definition = createPipelineDefinition(
    db,
    WORKSPACE_ID,
    { taskKey: "signal_social_post", name: "Acting", description: "", spec: spec() },
    ACTOR,
  );
  setPipelineStatus(db, WORKSPACE_ID, definition.id, "active");
  return definition;
}

async function runEngine(
  db: Db,
  deps: PipelineEngineDeps,
  definition: PipelineDefinition,
  mode: PipelineRunMode,
) {
  const run = startPipelineRun(db, {
    workspaceId: WORKSPACE_ID,
    definition,
    signalId: SIGNAL_ID,
    channel: "linkedin",
    mode,
    createdBy: "founder",
  });
  return executePipelineRun(db, deps, WORKSPACE_ID, run.id);
}

describe("an agent proposes, and the policy tree gates it (Sprint 69 acceptance)", () => {
  it("parks the agent's publication when the policy says human_required, and stops it dead", async () => {
    const posts: Array<Record<string, string>> = [];
    const { db, connectionId, proposals } = fixture(posts);
    setPublishPolicy(db, "human_required");
    const gateway = new ScriptedGateway(script(connectionId));
    const executed = await runEngine(
      db,
      { llm: gateway, evidence: noEvidence, safeFetch: {} as SafeFetchService, proposals },
      definitionFor(db),
      "live",
    );
    expect(executed.run.status).toBe("succeeded");

    const action = db.select().from(externalActions).all()[0];
    expect(action?.status).toBe("authorization_required");
    // Demonstrably stopped: nothing left the building.
    expect(posts).toHaveLength(0);
    expect(db.select().from(publications).all()).toHaveLength(0);

    // ...and it is attributable, both directions.
    expect(action?.origin).toBe("agent");
    const proposal = db.select().from(agentProposals).all()[0];
    expect(proposal?.externalActionId).toBe(action?.id);
    expect(proposal?.rationale).toContain("peaking");
    expect(action?.originRunId).toBe(proposal?.agentRunId);
  });

  it("lets it through when the policy says autonomous, gated exactly as a person's would be", async () => {
    const posts: Array<Record<string, string>> = [];
    const { db, connectionId, proposals } = fixture(posts);
    setPublishPolicy(db, "autonomous");
    const gateway = new ScriptedGateway(script(connectionId));
    await runEngine(
      db,
      { llm: gateway, evidence: noEvidence, safeFetch: {} as SafeFetchService, proposals },
      definitionFor(db),
      "live",
    );

    expect(posts).toHaveLength(1);
    const action = db.select().from(externalActions).all()[0];
    expect(action?.status).toBe("succeeded");
    // The policy that let it out is the same one a human proposal resolves.
    expect(JSON.parse(action!.policySnapshotJson).effective).toBe("autonomous");
  });

  it("offers the tool in a shadow run but mints nothing (D-69.6)", async () => {
    const posts: Array<Record<string, string>> = [];
    const { db, connectionId, proposals } = fixture(posts);
    setPublishPolicy(db, "autonomous");
    const gateway = new ScriptedGateway(script(connectionId));
    await runEngine(
      db,
      { llm: gateway, evidence: noEvidence, safeFetch: {} as SafeFetchService, proposals },
      definitionFor(db),
      "shadow",
    );

    // Same surface — the model that runs in shadow is the model that runs live.
    const declared = gateway.calls[0]!.tools?.map((tool) => tool.name);
    expect(declared).toContain("propose_publication");
    // ...and no effect whatsoever, even though the policy was autonomous.
    expect(posts).toHaveLength(0);
    expect(db.select().from(externalActions).all()).toHaveLength(0);
    expect(db.select().from(agentProposals).all()).toHaveLength(0);
  });

  it("does not offer the tool at all when no propose seam was injected (D-69.7)", async () => {
    const posts: Array<Record<string, string>> = [];
    const { db, connectionId } = fixture(posts);
    const gateway = new ScriptedGateway([
      { text: JSON.stringify({ content: "No tools to call.", confidence: 90 }) },
    ]);
    await runEngine(
      db,
      { llm: gateway, evidence: noEvidence, safeFetch: {} as SafeFetchService },
      definitionFor(db),
      "live",
    );
    expect(connectionId).toBeTruthy();
    expect(gateway.calls[0]!.tools ?? []).toHaveLength(0);
    expect(db.select().from(externalActions).all()).toHaveLength(0);
  });

  it("keeps the read tools untouched by all of this", async () => {
    const posts: Array<Record<string, string>> = [];
    const { db, proposals } = fixture(posts);
    const readSpec = pipelineSpecSchema.parse({
      steps: [
        {
          key: "draft",
          title: "Draft",
          goal: "Write the post.",
          kind: "agent",
          tools: ["list_channel_guardrails"],
          tier: "cheap",
          output: "draft",
          maxSteps: 2,
          maxTokens: 8_000,
        },
        { key: "propose", title: "Propose", goal: "Submit.", kind: "propose", output: "proposal" },
      ],
      budget: { maxTokens: 100_000 },
    });
    const definition = createPipelineDefinition(
      db,
      WORKSPACE_ID,
      { taskKey: "signal_social_post", name: "Reading", description: "", spec: readSpec },
      ACTOR,
    );
    setPipelineStatus(db, WORKSPACE_ID, definition.id, "active");
    const gateway = new ScriptedGateway([
      { text: JSON.stringify({ content: "Read-only.", confidence: 90 }) },
    ]);
    await runEngine(
      db,
      { llm: gateway, evidence: noEvidence, safeFetch: {} as SafeFetchService, proposals },
      definition,
      "live",
    );
    // A step that did not ask for a propose tool never sees one, injected
    // service or not: the allowlist is still the allowlist.
    const declared = gateway.calls[0]!.tools?.map((tool) => tool.name);
    expect(declared).toEqual(["list_channel_guardrails"]);
  });
});

describe("the draft an agent writes still meets a human first (D-69.2)", () => {
  it("lands in the approval queue and cannot publish itself", async () => {
    const posts: Array<Record<string, string>> = [];
    const { db, proposals } = fixture(posts);
    setPublishPolicy(db, "autonomous");
    const written = await proposals.proposeDraft(
      { agentRunId: randomUUID(), workspaceId: WORKSPACE_ID },
      {
        content: "Their pricing page is a strategy document.",
        channel: "linkedin",
        rationale: "Worth saying while the thread is live.",
      },
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const draft = db.select().from(drafts).where(eq(drafts.id, written.id!)).get();
    expect(draft?.state).toBe("pending_review");

    // Even under an autonomous publish policy, the agent's own writing cannot
    // go out: publishIntent refuses anything that has not cleared Review.
    const published = await proposals.proposePublication(
      { agentRunId: randomUUID(), workspaceId: WORKSPACE_ID },
      { draftId: written.id!, target: "test", rationale: "Send my own work." },
    );
    expect(published.ok).toBe(false);
    expect(posts).toHaveLength(0);
  });
});
