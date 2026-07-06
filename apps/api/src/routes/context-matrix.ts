import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MATRIX_DOC_TYPES,
  TASK_TYPES,
  updateMatrixCellInputSchema,
  type MatrixDocType,
  type TaskType,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { listMatrixCells, resetMatrixCell, setMatrixCell } from "../services/context-matrix";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}

function isMatrixDocType(value: string): value is MatrixDocType {
  return (MATRIX_DOC_TYPES as readonly string[]).includes(value);
}

export function registerContextMatrixRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/context-matrix", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listMatrixCells(db, request.params.id);
  });

  app.put<{ Params: { id: string; taskType: string; docType: string } }>(
    "/workspaces/:id/context-matrix/:taskType/:docType",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!isTaskType(request.params.taskType)) {
        return reply.status(400).send({ error: "invalid_task_type" });
      }
      if (!isMatrixDocType(request.params.docType)) {
        return reply.status(400).send({ error: "invalid_doc_type" });
      }
      const parsed = updateMatrixCellInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      return setMatrixCell(db, request.params.id, request.params.taskType, request.params.docType, parsed.data);
    },
  );

  app.delete<{ Params: { id: string; taskType: string; docType: string } }>(
    "/workspaces/:id/context-matrix/:taskType/:docType",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!isTaskType(request.params.taskType)) {
        return reply.status(400).send({ error: "invalid_task_type" });
      }
      if (!isMatrixDocType(request.params.docType)) {
        return reply.status(400).send({ error: "invalid_doc_type" });
      }
      return resetMatrixCell(db, request.params.id, request.params.taskType, request.params.docType);
    },
  );
}
