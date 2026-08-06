// Sprint 71: the read-only transparency surface (D-71.10). Two GETs, no writes,
// workspace-scoped like everything else under /workspaces/:id.

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  KNOB_USAGE_SAMPLE_LIMIT,
  artifactTraceSchema,
  isTraceSubjectKind,
  knobUsageReportSchema,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { buildArtifactTrace } from "../services/artifact-trace";
import { buildKnobUsageReport } from "../services/knob-usage";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) void reply.status(404).send({ error: "workspace_not_found" });
  return workspace;
}

const knobUsageQuerySchema = z.object({
  sampleLimit: z.coerce.number().int().min(1).max(1_000).optional(),
});

export function registerTraceRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string; subjectKind: string; subjectId: string } }>(
    "/workspaces/:id/trace/:subjectKind/:subjectId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const { subjectKind, subjectId } = request.params;
      if (!isTraceSubjectKind(subjectKind)) {
        return reply.status(400).send({ error: "invalid_subject_kind" });
      }
      const trace = buildArtifactTrace(db, request.params.id, subjectKind, subjectId);
      if (!trace) return reply.status(404).send({ error: "subject_not_found" });
      return artifactTraceSchema.parse(trace);
    },
  );

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/workspaces/:id/knob-usage",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = knobUsageQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }
      return knobUsageReportSchema.parse(
        buildKnobUsageReport(db, request.params.id, {
          sampleLimit: parsed.data.sampleLimit ?? KNOB_USAGE_SAMPLE_LIMIT,
        }),
      );
    },
  );
}
