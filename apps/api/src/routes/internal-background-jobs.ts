import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BACKGROUND_JOB_KINDS,
  BACKGROUND_JOB_STATUSES,
} from "@tuezday/contracts";
import type { Db } from "../db";
import type { BackgroundJobPolicy } from "../runtime/background-job-policy";
import type { BackgroundJobHandlers } from "../services/background-job-handlers";
import {
  getBackgroundQueueStats,
  listBackgroundJobs,
  requeueDeadLetter,
} from "../services/background-jobs";
import { runBackgroundJobTick } from "../services/background-job-runner";

export interface InternalBackgroundJobDependencies {
  db: Db;
  handlers: BackgroundJobHandlers;
  policy: BackgroundJobPolicy;
  instanceId: string;
  shutdownSignal: AbortSignal;
}

const EMPTY_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  maxProperties: 0,
} as const;

const listQuerySchema = z
  .object({
    status: z.enum(BACKGROUND_JOB_STATUSES).optional(),
    workspaceId: z.string().uuid().optional(),
    kind: z.enum(BACKGROUND_JOB_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(250).optional(),
  })
  .strict();

const jobParamsSchema = z.object({ id: z.string().uuid() }).strict();

export function registerInternalBackgroundJobRoutes(
  app: FastifyInstance,
  deps: InternalBackgroundJobDependencies,
): void {
  app.post(
    "/internal/background-jobs/tick",
    { schema: { body: EMPTY_BODY_SCHEMA } },
    async () => await runBackgroundJobTick(deps),
  );

  app.get("/internal/background-jobs", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input" });
    }
    return { items: await listBackgroundJobs(deps.db, parsed.data) };
  });

  app.get("/internal/background-jobs/stats", async () =>
    await getBackgroundQueueStats(deps.db, {
      perWorkspaceConcurrency: deps.policy.perWorkspaceConcurrency,
      perWorkspaceAgentConcurrency: deps.policy.perWorkspaceAgentConcurrency,
    }),
  );

  app.post(
    "/internal/background-jobs/:id/requeue",
    { schema: { body: EMPTY_BODY_SCHEMA } },
    async (request, reply) => {
      const parsed = jobParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_input" });
      }
      const job = await requeueDeadLetter(deps.db, parsed.data.id);
      if (!job) {
        return reply.status(409).send({ error: "job_not_dead_lettered" });
      }
      return reply.status(201).send({ sourceJobId: parsed.data.id, job });
    },
  );
}
