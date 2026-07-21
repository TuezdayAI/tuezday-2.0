import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createOutreachSequenceInputSchema,
  setOutreachMailboxesInputSchema,
  setOutreachStepsInputSchema,
  stopOutreachInputSchema,
  updateOutreachSequenceInputSchema,
} from "@tuezday/contracts";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import type { ExternalActionRuntime } from "../services/external-action-coordinator";
import { runOutreach } from "../services/outreach-engine";
import {
  OutreachSequenceError,
  activateOutreachSequence,
  createOutreachSequence,
  deleteOutreachSequence,
  getOutreachSequenceDetail,
  listEnrollments,
  listOutreachSequences,
  pauseOutreachSequence,
  rowToEnrollment,
  setMailboxes,
  setSteps,
  stopOutreach,
  updateOutreachSequence,
} from "../services/outreach-sequences";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply): boolean {
  if (getWorkspace(db, id)) return true;
  void reply.status(404).send({ error: "workspace_not_found" });
  return false;
}

function sendSequenceError(error: unknown, reply: FastifyReply) {
  if (error instanceof OutreachSequenceError) {
    return reply.status(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export function registerOutreachRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  runtime: ExternalActionRuntime,
): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/outreach-sequences", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listOutreachSequences(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/outreach-sequences", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createOutreachSequenceInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input", issues: parsed.error.issues });
    }
    try {
      return reply.status(201).send(createOutreachSequence(db, request.params.id, parsed.data));
    } catch (error) {
      return sendSequenceError(error, reply);
    }
  });

  app.get<{ Params: { id: string; seqId: string } }>(
    "/workspaces/:id/outreach-sequences/:seqId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = getOutreachSequenceDetail(db, request.params.id, request.params.seqId);
      if (!detail) return reply.status(404).send({ error: "sequence_not_found" });
      return detail;
    },
  );

  app.patch<{ Params: { id: string; seqId: string } }>(
    "/workspaces/:id/outreach-sequences/:seqId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateOutreachSequenceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_input", issues: parsed.error.issues });
      }
      try {
        const seq = updateOutreachSequence(db, request.params.id, request.params.seqId, parsed.data);
        if (!seq) return reply.status(404).send({ error: "sequence_not_found" });
        return seq;
      } catch (error) {
        return sendSequenceError(error, reply);
      }
    },
  );

  app.delete<{ Params: { id: string; seqId: string } }>(
    "/workspaces/:id/outreach-sequences/:seqId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!deleteOutreachSequence(db, request.params.id, request.params.seqId)) {
        return reply.status(404).send({ error: "sequence_not_found" });
      }
      return reply.status(204).send();
    },
  );

  app.put<{ Params: { id: string; seqId: string } }>(
    "/workspaces/:id/outreach-sequences/:seqId/steps",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = setOutreachStepsInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_input", issues: parsed.error.issues });
      }
      const steps = setSteps(db, request.params.id, request.params.seqId, parsed.data);
      if (!steps) return reply.status(404).send({ error: "sequence_not_found" });
      return steps;
    },
  );

  app.put<{ Params: { id: string; seqId: string } }>(
    "/workspaces/:id/outreach-sequences/:seqId/mailboxes",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = setOutreachMailboxesInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_input", issues: parsed.error.issues });
      }
      try {
        const ids = setMailboxes(db, request.params.id, request.params.seqId, parsed.data.mailboxIds);
        if (!ids) return reply.status(404).send({ error: "sequence_not_found" });
        return { mailboxIds: ids };
      } catch (error) {
        return sendSequenceError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string; seqId: string } }>(
    "/workspaces/:id/outreach-sequences/:seqId/activate",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return activateOutreachSequence(db, request.params.id, request.params.seqId);
      } catch (error) {
        return sendSequenceError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string; seqId: string } }>(
    "/workspaces/:id/outreach-sequences/:seqId/pause",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const seq = pauseOutreachSequence(db, request.params.id, request.params.seqId);
      if (!seq) return reply.status(404).send({ error: "sequence_not_found" });
      return seq;
    },
  );

  app.get<{ Params: { id: string; seqId: string } }>(
    "/workspaces/:id/outreach-sequences/:seqId/enrollments",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return listEnrollments(db, request.params.seqId).map(rowToEnrollment);
    },
  );

  app.post<{ Params: { id: string; seqId: string } }>(
    "/workspaces/:id/outreach-sequences/:seqId/stop",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = stopOutreachInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_input", issues: parsed.error.issues });
      }
      const stopped = stopOutreach(db, request.params.id, request.params.seqId, parsed.data);
      return { stopped };
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/outreach/run", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return runOutreach(db, { llm, evidence, runtime }, request.params.id);
  });
}
