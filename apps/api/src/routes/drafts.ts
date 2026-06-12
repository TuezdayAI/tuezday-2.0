import type { FastifyInstance, FastifyReply } from "fastify";
import {
  APPROVAL_STATES,
  editDraftInputSchema,
  isAdCreativeTaskType,
  validateAdCreative,
  type ApprovalAction,
  type ApprovalState,
  type Channel,
  type TaskType,
} from "@tuezday/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { generations } from "../db/schema";
import {
  InvalidTransitionError,
  applyDraftAction,
  draftForGeneration,
  getDraft,
  listDecisions,
  listDrafts,
  submitDraft,
} from "../services/drafts";
import { emitEvent } from "../services/events";
import { getWorkspace } from "../services/workspaces";

type Fetcher = typeof fetch;

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerDraftRoutes(app: FastifyInstance, db: Db, fetcher: Fetcher): void {
  app.post<{ Params: { id: string; generationId: string } }>(
    "/workspaces/:id/generations/:generationId/submit",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const generation = db
        .select()
        .from(generations)
        .where(eq(generations.id, request.params.generationId))
        .get();
      if (!generation || generation.workspaceId !== request.params.id) {
        return reply.status(404).send({ error: "generation_not_found" });
      }
      if (draftForGeneration(db, request.params.id, generation.id)) {
        return reply.status(409).send({
          error: "already_submitted",
          message: "This generation is already in the approval queue.",
        });
      }
      const draft = submitDraft(db, {
        workspaceId: request.params.id,
        sourceGenerationId: generation.id,
        campaignId: generation.campaignId,
        taskType: generation.taskType as TaskType,
        channel: generation.channel as Channel,
        personaId: generation.personaId,
        content: generation.output,
      });
      return reply.status(201).send(draft);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { state?: string; campaignId?: string } }>(
    "/workspaces/:id/drafts",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const { state, campaignId } = request.query;
      if (state !== undefined && !(APPROVAL_STATES as readonly string[]).includes(state)) {
        return reply.status(400).send({ error: "invalid_state" });
      }
      return listDrafts(db, request.params.id, state as ApprovalState | undefined, campaignId);
    },
  );

  app.get<{ Params: { id: string; draftId: string } }>(
    "/workspaces/:id/drafts/:draftId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const draft = getDraft(db, request.params.id, request.params.draftId);
      if (!draft) return reply.status(404).send({ error: "draft_not_found" });
      return { ...draft, decisions: listDecisions(db, draft.id) };
    },
  );

  const actions: ApprovalAction[] = ["edit", "resubmit", "approve", "reject"];
  for (const action of actions) {
    app.post<{ Params: { id: string; draftId: string } }>(
      `/workspaces/:id/drafts/:draftId/${action}`,
      async (request, reply) => {
        if (!workspaceOr404(db, request.params.id, reply)) return reply;
        const draft = getDraft(db, request.params.id, request.params.draftId);
        if (!draft) return reply.status(404).send({ error: "draft_not_found" });

        let newContent: string | undefined;
        if (action === "edit") {
          const parsed = editDraftInputSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply.status(400).send({
              error: "invalid_input",
              message: parsed.error.issues.map((i) => i.message).join("; "),
            });
          }
          newContent = parsed.data.content;
          // Ad creative carries hard platform limits — an edit can never
          // introduce a violation.
          if (isAdCreativeTaskType(draft.taskType)) {
            const validation = validateAdCreative(draft.taskType, newContent);
            if (!validation.ok) {
              return reply.status(400).send({
                error: "format_violation",
                message: validation.violations.map((v) => v.message).join(" "),
                violations: validation.violations,
              });
            }
          }
        }

        // The hard guarantee: an approved ad creative is always platform-valid.
        if (action === "approve" && isAdCreativeTaskType(draft.taskType)) {
          const validation = validateAdCreative(draft.taskType, draft.content);
          if (!validation.ok) {
            return reply.status(409).send({
              error: "format_violation",
              message: validation.violations.map((v) => v.message).join(" "),
              violations: validation.violations,
            });
          }
        }

        try {
          const updated = applyDraftAction(db, draft, action, newContent);
          if (action === "approve" || action === "reject") {
            await emitEvent(
              db,
              fetcher,
              request.params.id,
              action === "approve" ? "draft.approved" : "draft.rejected",
              {
                draftId: updated.id,
                taskType: updated.taskType,
                channel: updated.channel,
                personaId: updated.personaId,
                campaignId: updated.campaignId,
                leadId: updated.leadId,
                content: updated.content,
              },
            );
          }
          return updated;
        } catch (err) {
          if (err instanceof InvalidTransitionError) {
            return reply.status(409).send({ error: "invalid_transition", message: err.message });
          }
          throw err;
        }
      },
    );
  }
}
