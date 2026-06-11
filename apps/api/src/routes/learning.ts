import type { FastifyInstance, FastifyReply } from "fastify";
import { createMetricInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { getDraft } from "../services/drafts";
import {
  NothingToLearnError,
  SynthesisAlreadyDecidedError,
  acceptSynthesis,
  createMetric,
  dismissSynthesis,
  getSynthesis,
  learningStats,
  listMetrics,
  listSyntheses,
  listTrainingExamples,
  synthesizeNow,
} from "../services/learning";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerLearningRoutes(app: FastifyInstance, db: Db, llm: LlmGateway): void {
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/learning/examples",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return listTrainingExamples(db, request.params.id);
    },
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id/learning/stats", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return learningStats(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/metrics", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createMetricInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    if (parsed.data.draftId && !getDraft(db, request.params.id, parsed.data.draftId)) {
      return reply.status(404).send({ error: "draft_not_found" });
    }
    return reply.status(201).send(createMetric(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/metrics", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listMetrics(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/learning/synthesize",
    async (request, reply) => {
      const workspace = workspaceOr404(db, request.params.id, reply);
      if (!workspace) return reply;
      try {
        const synthesis = await synthesizeNow(db, llm, request.params.id, workspace.name);
        return reply.status(201).send(synthesis);
      } catch (err) {
        if (err instanceof NothingToLearnError) {
          return reply.status(409).send({ error: "nothing_to_learn", message: err.message });
        }
        if (err instanceof GatewayError) {
          return reply.status(502).send({ error: "synthesis_failed", message: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/learning/syntheses",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return listSyntheses(db, request.params.id);
    },
  );

  app.post<{ Params: { id: string; synthesisId: string } }>(
    "/workspaces/:id/learning/syntheses/:synthesisId/accept",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const synthesis = getSynthesis(db, request.params.id, request.params.synthesisId);
      if (!synthesis) return reply.status(404).send({ error: "synthesis_not_found" });
      try {
        return acceptSynthesis(db, request.params.id, synthesis);
      } catch (err) {
        if (err instanceof SynthesisAlreadyDecidedError) {
          return reply.status(409).send({ error: "already_decided", message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; synthesisId: string } }>(
    "/workspaces/:id/learning/syntheses/:synthesisId/dismiss",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const synthesis = getSynthesis(db, request.params.id, request.params.synthesisId);
      if (!synthesis) return reply.status(404).send({ error: "synthesis_not_found" });
      try {
        return dismissSynthesis(db, synthesis);
      } catch (err) {
        if (err instanceof SynthesisAlreadyDecidedError) {
          return reply.status(409).send({ error: "already_decided", message: err.message });
        }
        throw err;
      }
    },
  );
}
