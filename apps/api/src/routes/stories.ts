import type { FastifyInstance, FastifyReply } from "fastify";
import {
  STORY_STATUSES,
  mergeStoryInputSchema,
  splitOccurrenceInputSchema,
  updateStoryInputSchema,
  type StoryStatus,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { actorOf } from "../auth/guard";
import {
  OccurrenceNotFoundError,
  StoryArchivedError,
  StoryMergeSelfError,
  StoryNotFoundError,
  backfillCanonicalStories,
  getStoryDetail,
  listStories,
  mergeStories,
  setStoryStatus,
  splitOccurrence,
} from "../services/canonical-stories";
import { getWorkspace } from "../services/workspaces";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

function sendStoryError(reply: FastifyReply, err: unknown) {
  if (err instanceof StoryNotFoundError) {
    return reply.status(404).send({ error: "story_not_found" });
  }
  if (err instanceof OccurrenceNotFoundError) {
    return reply.status(404).send({ error: "occurrence_not_found" });
  }
  if (err instanceof StoryMergeSelfError) {
    return reply.status(400).send({ error: "merge_self" });
  }
  if (err instanceof StoryArchivedError) {
    return reply.status(409).send({ error: "story_archived" });
  }
  throw err;
}

// Sprint 60: canonical stories & source occurrences — read/curate surface for
// the shadow intelligence layer. Registered with db only; no LLM or fabric.
export function registerStoryRoutes(app: FastifyInstance, db: Db): void {
  app.get<{
    Params: { id: string };
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/workspaces/:id/stories", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const { status, limit, offset } = request.query;
    if (status !== undefined && !STORY_STATUSES.includes(status as StoryStatus)) {
      return reply.status(400).send({ error: "invalid_input", message: "unknown status" });
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    const parsedOffset = offset === undefined ? undefined : Number(offset);
    if (
      (parsedLimit !== undefined &&
        (!Number.isInteger(parsedLimit) || parsedLimit < 1)) ||
      (parsedOffset !== undefined &&
        (!Number.isInteger(parsedOffset) || parsedOffset < 0))
    ) {
      return reply.status(400).send({
        error: "invalid_input",
        message: "limit must be a positive integer and offset a non-negative integer",
      });
    }
    return await listStories(db, request.params.id, {
      status: status as StoryStatus | undefined,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  });

  app.get<{ Params: { id: string; storyId: string } }>(
    "/workspaces/:id/stories/:storyId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return await getStoryDetail(db, request.params.id, request.params.storyId);
      } catch (err) {
        return sendStoryError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string; storyId: string } }>(
    "/workspaces/:id/stories/:storyId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateStoryInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        return await setStoryStatus(db, request.params.id, request.params.storyId, parsed.data.status);
      } catch (err) {
        return sendStoryError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; storyId: string } }>(
    "/workspaces/:id/stories/:storyId/merge",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = mergeStoryInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        return await mergeStories(db, request.params.id, {
          storyId: request.params.storyId,
          intoStoryId: parsed.data.intoStoryId,
          actor: actorOf(request),
          reason: parsed.data.reason,
        });
      } catch (err) {
        return sendStoryError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; occurrenceId: string } }>(
    "/workspaces/:id/stories/occurrences/:occurrenceId/split",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = splitOccurrenceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        return await splitOccurrence(db, request.params.id, {
          occurrenceId: request.params.occurrenceId,
          actor: actorOf(request),
          reason: parsed.data.reason,
        });
      } catch (err) {
        return sendStoryError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/stories/backfill",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await backfillCanonicalStories(db, request.params.id);
    },
  );
}
