import type { FastifyInstance, FastifyReply } from "fastify";
import type { AnalyticsSink } from "../analytics/sink";
import { track } from "../analytics/track";
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
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { generations } from "../db/schema";
import type { LlmGateway } from "../llm/gateway";
import { getBrain } from "../services/brain";
import { composeCampaignOverlay, getCampaign } from "../services/campaigns";
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
import { getGenerationSettings } from "../services/generation-settings";
import { getPersona, toResolvePersona } from "../services/personas";
import { runPreReview, setDraftReview } from "../services/review";
import { getWorkspace } from "../services/workspaces";
import type { BrainContents } from "@tuezday/brain";
import type { Mailer } from "../mail/mailer";
import { notifyDraftPending } from "../services/notifications";

type Fetcher = typeof fetch;

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerDraftRoutes(
  app: FastifyInstance,
  db: Db,
  fetcher: Fetcher,
  llm: LlmGateway,
  analytics: AnalyticsSink,
  mailer: Mailer,
): void {
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
      }, actorOf(request));
      notifyDraftPending(db, mailer, fetcher, draft).catch(() => {});
      return reply.status(201).send(draft);
    },
  );

  // Re-run the dual-LLM pre-review against the draft's CURRENT content
  // (Sprint 22). Manual, on-demand — edits do not auto-trigger review. Works
  // regardless of the workspace toggle; best-effort, never 5xx on reviewer
  // failure (runPreReview returns null scores instead).
  app.post<{ Params: { id: string; draftId: string } }>(
    "/workspaces/:id/drafts/:draftId/review",
    async (request, reply) => {
      const workspace = workspaceOr404(db, request.params.id, reply);
      if (!workspace) return reply;
      const draft = getDraft(db, request.params.id, request.params.draftId);
      if (!draft) return reply.status(404).send({ error: "draft_not_found" });

      const persona = draft.personaId
        ? getPersona(db, request.params.id, draft.personaId)
        : undefined;
      const campaign = draft.campaignId
        ? getCampaign(db, request.params.id, draft.campaignId)
        : undefined;
      const { docs } = getBrain(db, request.params.id);
      const contents = Object.fromEntries(
        docs.map((d) => [d.docType, d.content]),
      ) as BrainContents;
      const settings = getGenerationSettings(db, request.params.id);

      const review = await runPreReview(
        llm,
        {
          workspaceName: workspace.name,
          docs: contents,
          taskType: draft.taskType,
          channel: draft.channel,
          persona: persona ? toResolvePersona(persona) : undefined,
          campaign: campaign
            ? { name: campaign.name, overlay: composeCampaignOverlay(campaign) }
            : undefined,
        },
        draft.content,
        settings.flagThreshold,
      );
      setDraftReview(db, request.params.id, draft.id, review);
      return { ...draft, review };
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
          const updated = applyDraftAction(db, draft, action, actorOf(request), newContent);
          if (action === "resubmit") {
            notifyDraftPending(db, mailer, fetcher, updated).catch(() => {});
          }
          if (action === "approve") {
            track(db, analytics, {
              event: "draft.approved",
              distinctId: request.actor.userId!,
              workspaceId: request.params.id,
            });
          }
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
