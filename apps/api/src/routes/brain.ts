import type { FastifyInstance, FastifyReply } from "fastify";
import {
  BRAIN_DOC_TYPES,
  type BrainDocType,
  updateBrainDocInputSchema,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { exportBrainMarkdown, getBrain, listDocVersions, updateBrainDoc } from "../services/brain";
import { getWorkspace } from "../services/workspaces";

function isDocType(value: string): value is BrainDocType {
  return (BRAIN_DOC_TYPES as readonly string[]).includes(value);
}

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerBrainRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/brain", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return getBrain(db, request.params.id);
  });

  app.put<{ Params: { id: string; docType: string } }>(
    "/workspaces/:id/brain/:docType",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!isDocType(request.params.docType)) {
        return reply.status(400).send({ error: "invalid_doc_type" });
      }
      const parsed = updateBrainDocInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      return updateBrainDoc(db, request.params.id, request.params.docType, parsed.data.content, actorOf(request));
    },
  );

  app.get<{ Params: { id: string; docType: string } }>(
    "/workspaces/:id/brain/:docType/versions",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!isDocType(request.params.docType)) {
        return reply.status(400).send({ error: "invalid_doc_type" });
      }
      return listDocVersions(db, request.params.id, request.params.docType);
    },
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id/brain/export", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    const markdown = exportBrainMarkdown(db, request.params.id, workspace.name);
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="${workspace.name.replace(/[^a-z0-9-_ ]/gi, "")}-gtm-brain.md"`,
      )
      .send(markdown);
  });
}
