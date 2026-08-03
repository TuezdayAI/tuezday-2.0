import type { FastifyInstance, FastifyReply } from "fastify";
import { proofAgentRunInputSchema } from "@tuezday/contracts";
import { toAgentTools } from "../agents/adapter";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../agents/registry";
import { AgentRunner } from "../agents/runner";
import { READ_TOOLS } from "../agents/tools/index";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { meteredLlm } from "../llm/metered";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import type { SafeFetchService } from "../safe-fetch/index";
import { getAgentRunDetail, listAgentRuns } from "../services/agent-runs";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

const PROOF_SYSTEM = `You are Tuezday's workspace research agent. Answer the user's question using the workspace tools — search the brain, evidence, campaigns, publications and discovery before answering. Ground every claim in what a tool returned, and say which tools you used. If the tools return nothing relevant, say so plainly instead of guessing.`;

// Conservative proof-run bounds: enough for a few lookups and an answer,
// small enough that a runaway loop costs cents, not dollars.
const PROOF_BOUNDS = { maxSteps: 8, maxTokens: 16_000, timeoutMs: 60_000 };

export interface AgentRunRouteDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
}

export function registerAgentRunRoutes(
  app: FastifyInstance,
  db: Db,
  deps: AgentRunRouteDeps,
): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: string; task?: string } }>(
    "/workspaces/:id/agent-runs",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return {
        runs: listAgentRuns(db, request.params.id, {
          limit: Number(request.query.limit) || undefined,
          task: request.query.task || undefined,
        }),
      };
    },
  );

  app.get<{ Params: { id: string; runId: string } }>(
    "/workspaces/:id/agent-runs/:runId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = getAgentRunDetail(db, request.params.id, request.params.runId);
      if (!detail) return reply.status(404).send({ error: "not_found" });
      return detail;
    },
  );

  // The Inspector's ignition (build rule 4: something a human can trigger and
  // inspect). Deliberately minimal — not a chat surface; Phase O owns that.
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/agent-runs/proof",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = proofAgentRunInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const actor = actorOf(request);
      const ctx: ToolContext = {
        db,
        evidence: deps.evidence,
        safeFetch: deps.safeFetch,
        workspaceId: request.params.id,
        actor: { userId: actor.userId, label: actor.label },
        budget: DEFAULT_TOOL_BUDGET,
      };
      // Metered (Sprint 59): every step of the run lands in the usage ledger;
      // agent_runs keeps its own totals for the Inspector.
      const runner = new AgentRunner(
        db,
        meteredLlm(deps.llm, db, { workspaceId: request.params.id, pipeline: "agent_run" }),
      );
      const result = await runner.run({
        workspaceId: request.params.id,
        task: "proof",
        createdBy: actor.label,
        system: PROOF_SYSTEM,
        messages: [{ role: "user", content: parsed.data.question }],
        tools: toAgentTools(READ_TOOLS, ctx),
        ...PROOF_BOUNDS,
      });
      return reply.status(201).send({ runId: result.runId, stopReason: result.stopReason });
    },
  );
}
