import type { FastifyInstance, FastifyReply } from "fastify";
import {
  bannedClaimInputSchema,
  buildEvalSuiteInputSchema,
  labelBaselineInputSchema,
  runEvalSuiteInputSchema,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import type { SafeFetchService } from "../safe-fetch/index";
import { addBannedClaim, listBannedClaims, removeBannedClaim } from "../services/banned-claims";
import {
  buildEvalSuite,
  getEvalComparison,
  getEvalRunDetail,
  labelBaseline,
  listEvalCases,
  listEvalRuns,
  listEvalSuites,
  runEvalSuite,
  EvalDefinitionUnavailableError,
  EvalSuiteNotFoundError,
  type EvalHarnessDeps,
} from "../services/eval-harness";
import { getWorkspace } from "../services/workspaces";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

function invalidInput(reply: FastifyReply, issues: { message: string }[]) {
  return reply.status(400).send({
    error: "invalid_input",
    message: issues.map((issue) => issue.message).join("; "),
  });
}

export type EvalRouteDeps = EvalHarnessDeps & {
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
};

export function registerEvalRoutes(app: FastifyInstance, db: Db, deps: EvalRouteDeps): void {
  // --- Banned claims (D-67.5) ------------------------------------------------

  app.get<{ Params: { id: string } }>("/workspaces/:id/banned-claims", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    return { claims: await listBannedClaims(db, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/banned-claims", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = bannedClaimInputSchema.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error.issues);
    return reply.status(201).send(await addBannedClaim(db, request.params.id, parsed.data));
  });

  app.delete<{ Params: { id: string; claimId: string } }>(
    "/workspaces/:id/banned-claims/:claimId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      if (!await removeBannedClaim(db, request.params.id, request.params.claimId)) {
        return reply.status(404).send({ error: "not_found" });
      }
      return reply.status(204).send();
    },
  );

  // --- Suites ----------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/workspaces/:id/evals/suites", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    return { suites: await listEvalSuites(db, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/evals/suites", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = buildEvalSuiteInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidInput(reply, parsed.error.issues);
    const actor = actorOf(request);
    const built = await buildEvalSuite(db, request.params.id, parsed.data, { userId: actor.userId });
    return reply.status(201).send(built);
  });

  app.get<{ Params: { id: string; suiteId: string } }>(
    "/workspaces/:id/evals/suites/:suiteId/cases",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return { cases: await listEvalCases(db, request.params.id, request.params.suiteId) };
    },
  );

  // --- Runs ------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/workspaces/:id/evals/runs", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    return { runs: await listEvalRuns(db, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/evals/runs", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = runEvalSuiteInputSchema.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error.issues);
    const actor = actorOf(request);
    try {
      const run = await runEvalSuite(db, deps, request.params.id, parsed.data, {
        userId: actor.userId,
        label: actor.label,
      });
      return reply.status(201).send(run);
    } catch (err) {
      if (err instanceof EvalSuiteNotFoundError) {
        return reply.status(404).send({ error: "suite_not_found" });
      }
      if (err instanceof EvalDefinitionUnavailableError) {
        // Nothing to replay through — activate a pipeline definition first.
        return reply.status(409).send({ error: "no_active_definition", message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string; runId: string } }>(
    "/workspaces/:id/evals/runs/:runId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = await getEvalRunDetail(db, request.params.id, request.params.runId);
      if (!detail) return reply.status(404).send({ error: "not_found" });
      return detail;
    },
  );

  app.post<{ Params: { id: string; runId: string } }>(
    "/workspaces/:id/evals/runs/:runId/baseline",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = labelBaselineInputSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      const run = await labelBaseline(
        db,
        request.params.id,
        request.params.runId,
        parsed.data.baselineLabel,
      );
      if (!run) return reply.status(404).send({ error: "not_found" });
      return run;
    },
  );

  app.get<{ Params: { id: string; runId: string }; Querystring: { baselineLabel?: string } }>(
    "/workspaces/:id/evals/runs/:runId/comparison",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const comparison = await getEvalComparison(
        db,
        request.params.id,
        request.params.runId,
        request.query.baselineLabel,
      );
      if (!comparison) return reply.status(404).send({ error: "not_found" });
      return comparison;
    },
  );
}
