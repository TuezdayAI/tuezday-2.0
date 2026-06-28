import type { TuezdayApp } from "../app";
import type { Db } from "../db";
import { apiKeyAuth, requireScope } from "../auth/api-key";
import { createSignalInputSchema, createLaunchInputSchema } from "@tuezday/contracts";
import { createSignal } from "../services/signals";
import { listDrafts, applyDraftAction, InvalidTransitionError, getDraft } from "../services/drafts";
import { createLaunch } from "../services/launches";

export function registerPublicApiRoutes(app: TuezdayApp, db: Db): void {
  app.register(async (apiApp) => {
    // Apply the API key auth handler to all /api/v1/* routes
    apiApp.addHook("preHandler", apiKeyAuth(db));

    // 1. Submit Idea
    apiApp.post(
      "/api/v1/ideas",
      { preHandler: [requireScope("ideas:write")] },
      async (request, reply) => {
        const parsed = createSignalInputSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: "invalid_input" });
        }
        const actor = request.apiActor!;
        const signal = createSignal(db, actor.workspaceId, parsed.data);
        return reply.status(201).send(signal);
      }
    );

    // 2. List Drafts
    apiApp.get(
      "/api/v1/drafts",
      { preHandler: [requireScope("drafts:read")] },
      async (request, reply) => {
        const actor = request.apiActor!;
        const drafts = listDrafts(db, actor.workspaceId, "pending_review");
        return drafts;
      }
    );

    // 3. Approve Draft
    apiApp.post<{ Params: { id: string } }>(
      "/api/v1/drafts/:id/approve",
      { preHandler: [requireScope("drafts:write")] },
      async (request, reply) => {
        const actor = request.apiActor!;
        const draft = getDraft(db, actor.workspaceId, request.params.id);
        if (!draft) return reply.status(404).send({ error: "not_found" });

        try {
          const updated = applyDraftAction(
            db,
            draft,
            "approve",
            { userId: null, label: "api" },
            undefined
          );
          return reply.status(200).send(updated);
        } catch (err: any) {
          if (err instanceof InvalidTransitionError) {
            return reply.status(409).send({ error: "invalid_transition", message: err.message });
          }
          throw err;
        }
      }
    );

    // 4. Reject Draft
    apiApp.post<{ Params: { id: string } }>(
      "/api/v1/drafts/:id/reject",
      { preHandler: [requireScope("drafts:write")] },
      async (request, reply) => {
        const actor = request.apiActor!;
        const draft = getDraft(db, actor.workspaceId, request.params.id);
        if (!draft) return reply.status(404).send({ error: "not_found" });

        try {
          const updated = applyDraftAction(
            db,
            draft,
            "reject",
            { userId: null, label: "api" },
            undefined
          );
          return reply.status(200).send(updated);
        } catch (err: any) {
          if (err instanceof InvalidTransitionError) {
            return reply.status(409).send({ error: "invalid_transition", message: err.message });
          }
          throw err;
        }
      }
    );

    // 5. Launch Campaign
    apiApp.post(
      "/api/v1/launches",
      { preHandler: [requireScope("campaigns:launch")] },
      async (request, reply) => {
        const parsed = createLaunchInputSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: "invalid_input" });
        }
        const actor = request.apiActor!;
        const launch = createLaunch(db, actor.workspaceId, parsed.data);
        return reply.status(201).send(launch);
      }
    );

    // 6. Fetch Insights (Gated by Sprint 34)
    apiApp.get(
      "/api/v1/insights",
      { preHandler: [requireScope("analytics:read")] },
      async (request, reply) => {
        const actor = request.apiActor!;
        let insightsService;
        try {
          // Dynamic import to detect Sprint 34 presence
          insightsService = await import("../services/insights");
        } catch (err) {
          return reply.status(503).send({ error: "insights_unavailable" });
        }

        // Return workspace-level insights
        const insights = insightsService.getWorkspaceInsights(db, actor.workspaceId);
        return reply.status(200).send(insights);
      }
    );
  });
}
