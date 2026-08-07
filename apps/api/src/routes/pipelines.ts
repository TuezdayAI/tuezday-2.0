import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createPipelineDefinitionInputSchema,
  dryRunPipelineInputSchema,
  pipelineRunDecisionInputSchema,
  runPipelineInputSchema,
  updatePipelineSpecInputSchema,
  PIPELINE_RUN_MODES,
  PIPELINE_RUN_STATUSES,
  type PipelineRunMode,
  type PipelineRunStatus,
} from "@tuezday/contracts";
import type { AgentProposalService } from "../agents/proposals";
import type { AgentQuestionService } from "../agents/questions";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import type { SafeFetchService } from "../safe-fetch/index";
import { llmBudgetExhausted } from "../services/entitlements";
import {
  createPipelineDefinition,
  ensurePipelineDefinitions,
  getPipelineDefinition,
  getPipelineDefinitionDetail,
  listPipelineDefinitions,
  setPipelineStatus,
  updatePipelineSpec,
  PipelineDefinitionNotFoundError,
} from "../services/pipeline-definitions";
import {
  decidePipelineRun,
  executePipelineRun,
  getPipelineRunDetail,
  listPipelineRuns,
  runPipelineDryRun,
  startPipelineRun,
  DuplicatePipelineRunError,
  InvalidPipelineRunTransitionError,
  PipelineRunNotFoundError,
  PipelineSignalNotFoundError,
  type PipelineEngineDeps,
} from "../services/pipeline-engine";
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

export interface PipelineRouteDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
  /** Sprint 69: the propose seam. Dry runs (the only mode this route
   * executes synchronously) always get the simulating one, so this matters
   * only for live runs the tick picks up. */
  proposals?: AgentProposalService;
  /** Sprint 70: the ask seam. Same reasoning — dry runs always get the
   * simulating one, so a founder previewing a definition is never asked. */
  questions?: AgentQuestionService;
}

export function registerPipelineRoutes(
  app: FastifyInstance,
  db: Db,
  deps: PipelineRouteDeps,
): void {
  const engineDeps: PipelineEngineDeps = deps;

  app.get<{ Params: { id: string } }>("/workspaces/:id/pipelines", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    await ensurePipelineDefinitions(db, request.params.id);
    return { definitions: await listPipelineDefinitions(db, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/pipelines", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createPipelineDefinitionInputSchema.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error.issues);
    const actor = actorOf(request);
    const definition = await createPipelineDefinition(db, request.params.id, parsed.data, {
      userId: actor.userId,
      label: actor.label,
    });
    return reply.status(201).send(definition);
  });

  app.get<{ Params: { id: string; pipelineId: string } }>(
    "/workspaces/:id/pipelines/:pipelineId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = await getPipelineDefinitionDetail(db, request.params.id, request.params.pipelineId);
      if (!detail) return reply.status(404).send({ error: "not_found" });
      return detail;
    },
  );

  app.put<{ Params: { id: string; pipelineId: string } }>(
    "/workspaces/:id/pipelines/:pipelineId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updatePipelineSpecInputSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      const actor = actorOf(request);
      try {
        return await updatePipelineSpec(db, request.params.id, request.params.pipelineId, parsed.data, {
          userId: actor.userId,
          label: actor.label,
        });
      } catch (err) {
        if (err instanceof PipelineDefinitionNotFoundError) {
          return reply.status(404).send({ error: "not_found" });
        }
        throw err;
      }
    },
  );

  for (const status of ["activate", "archive"] as const) {
    app.post<{ Params: { id: string; pipelineId: string } }>(
      `/workspaces/:id/pipelines/:pipelineId/${status}`,
      async (request, reply) => {
        if (!await workspaceOr404(db, request.params.id, reply)) return reply;
        try {
          return await setPipelineStatus(
            db,
            request.params.id,
            request.params.pipelineId,
            status === "activate" ? "active" : "archived",
          );
        } catch (err) {
          if (err instanceof PipelineDefinitionNotFoundError) {
            return reply.status(404).send({ error: "not_found" });
          }
          throw err;
        }
      },
    );
  }

  app.post<{ Params: { id: string; pipelineId: string } }>(
    "/workspaces/:id/pipelines/:pipelineId/run",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const definition = await getPipelineDefinition(db, request.params.id, request.params.pipelineId);
      if (!definition) return reply.status(404).send({ error: "not_found" });
      const parsed = runPipelineInputSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      if (await llmBudgetExhausted(db, request.params.id)) {
        return reply.status(409).send({ error: "llm_budget_exhausted" });
      }
      const actor = actorOf(request);
      try {
        const run = await startPipelineRun(db, {
          workspaceId: request.params.id,
          definition,
          signalId: parsed.data.signalId,
          channel: parsed.data.channel,
          campaignId: parsed.data.campaignId ?? null,
          personaId: parsed.data.personaId ?? null,
          mode: "live",
          idempotencyKey: parsed.data.idempotencyKey ?? null,
          createdBy: actor.label,
        });
        const outcome = await executePipelineRun(db, engineDeps, request.params.id, run.id);
        return reply.status(201).send(outcome.run);
      } catch (err) {
        if (err instanceof PipelineSignalNotFoundError) {
          return reply.status(404).send({ error: "signal_not_found" });
        }
        if (err instanceof DuplicatePipelineRunError) {
          return reply.status(409).send({ error: "duplicate_run" });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; pipelineId: string } }>(
    "/workspaces/:id/pipelines/:pipelineId/dry-run",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const definition = await getPipelineDefinition(db, request.params.id, request.params.pipelineId);
      if (!definition) return reply.status(404).send({ error: "not_found" });
      const parsed = dryRunPipelineInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      if (await llmBudgetExhausted(db, request.params.id)) {
        return reply.status(409).send({ error: "llm_budget_exhausted" });
      }
      const actor = actorOf(request);
      try {
        const result = await runPipelineDryRun(db, engineDeps, {
          workspaceId: request.params.id,
          definition,
          options: parsed.data,
          createdBy: actor.label,
        });
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof PipelineSignalNotFoundError) {
          return reply.status(404).send({ error: "signal_not_found" });
        }
        throw err;
      }
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: {
      definitionId?: string;
      mode?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };
  }>("/workspaces/:id/pipeline-runs", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const { mode, status } = request.query;
    if (mode && !PIPELINE_RUN_MODES.includes(mode as PipelineRunMode)) {
      return invalidInput(reply, [{ message: `Unknown mode "${mode}"` }]);
    }
    if (status && !PIPELINE_RUN_STATUSES.includes(status as PipelineRunStatus)) {
      return invalidInput(reply, [{ message: `Unknown status "${status}"` }]);
    }
    return await listPipelineRuns(db, request.params.id, {
      definitionId: request.query.definitionId || undefined,
      mode: mode as PipelineRunMode | undefined,
      status: status as PipelineRunStatus | undefined,
      limit: Number(request.query.limit) || undefined,
      offset: Number(request.query.offset) || undefined,
    });
  });

  app.get<{ Params: { id: string; runId: string } }>(
    "/workspaces/:id/pipeline-runs/:runId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = await getPipelineRunDetail(db, request.params.id, request.params.runId);
      if (!detail) return reply.status(404).send({ error: "not_found" });
      return detail;
    },
  );

  app.post<{ Params: { id: string; runId: string } }>(
    "/workspaces/:id/pipeline-runs/:runId/decision",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = pipelineRunDecisionInputSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      try {
        const outcome = await decidePipelineRun(
          db,
          engineDeps,
          request.params.id,
          request.params.runId,
          parsed.data,
        );
        if (outcome.blocked === "llm_budget_exhausted") {
          return reply.status(409).send({ error: "llm_budget_exhausted" });
        }
        if (outcome.blocked === "not_claimable") {
          return reply.status(409).send({ error: "not_claimable" });
        }
        return outcome.run;
      } catch (err) {
        if (err instanceof PipelineRunNotFoundError) {
          return reply.status(404).send({ error: "not_found" });
        }
        if (err instanceof InvalidPipelineRunTransitionError) {
          return reply.status(400).send({ error: "invalid_transition", message: err.message });
        }
        throw err;
      }
    },
  );
}
