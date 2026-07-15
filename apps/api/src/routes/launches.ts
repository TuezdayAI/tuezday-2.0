import type { FastifyInstance, FastifyReply } from "fastify";
import {
  LAUNCH_CHANNELS,
  createLaunchInputSchema,
  dispatchChannelInputSchema,
  generateLaunchInputSchema,
  setSequenceInputSchema,
  stopSequenceInputSchema,
  updateLaunchSequenceConfigInputSchema,
  type LaunchChannel,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import type { OutboundExporter } from "../outbound/exporter";
import { getAudience } from "../services/audiences";
import { getCampaign } from "../services/campaigns";
import type { ExternalActionRuntime } from "../services/external-action-coordinator";
import { getPersona } from "../services/personas";
import { getWorkspace } from "../services/workspaces";
import {
  createLaunch,
  deleteLaunch,
  dispatchChannel,
  exportLaunchEmail,
  generateLaunch,
  getLaunchDetail,
  listLaunches,
  updateLaunchSequenceConfig,
} from "../services/launches";
import {
  runLaunchSequence,
  runSequences,
  setSequence,
  startSequence,
  stopSequence,
} from "../services/launch-sequences";
import { externalActionError } from "./external-actions";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

const DISPATCH_ERROR_STATUS: Record<string, number> = {
  launch_not_found: 404,
  channel_not_selected: 409,
  not_generated: 409,
  media_required: 400,
  no_connection: 400,
  ambiguous_connection: 400,
  validation_failed: 400,
};

export function registerLaunchRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  exporter: OutboundExporter,
  runtime: ExternalActionRuntime,
): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/launches", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createLaunchInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    if (!getAudience(db, request.params.id, parsed.data.audienceId)) {
      return reply.status(404).send({ error: "audience_not_found" });
    }
    if (parsed.data.campaignId && !getCampaign(db, request.params.id, parsed.data.campaignId)) {
      return reply.status(404).send({ error: "campaign_not_found" });
    }
    if (parsed.data.personaId && !getPersona(db, request.params.id, parsed.data.personaId)) {
      return reply.status(404).send({ error: "persona_not_found" });
    }
    return reply.status(201).send(createLaunch(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/launches", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listLaunches(db, request.params.id);
  });

  app.get<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/launches/:launchId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = getLaunchDetail(db, request.params.id, request.params.launchId);
      if (!detail) return reply.status(404).send({ error: "launch_not_found" });
      return detail;
    },
  );

  app.delete<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/launches/:launchId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!deleteLaunch(db, request.params.id, request.params.launchId)) {
        return reply.status(404).send({ error: "launch_not_found" });
      }
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/launches/:launchId/generate",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = generateLaunchInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const result = await generateLaunch(
        db,
        llm,
        evidence,
        request.params.id,
        request.params.launchId,
        parsed.data,
        actorOf(request),
      );
      if (!result.ok) {
        const status =
          result.error === "not_draft" || result.error === "is_sequence" ? 409 : 404;
        return reply.status(status).send({ error: result.error });
      }
      return result.detail;
    },
  );

  app.get<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/launches/:launchId/export.csv",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const result = exportLaunchEmail(db, exporter, request.params.id, request.params.launchId);
      if (!result.ok) {
        const status = result.error === "launch_not_found" ? 404 : 409;
        return reply.status(status).send({ error: result.error });
      }
      return reply
        .header("content-type", result.export.contentType)
        .header("content-disposition", `attachment; filename="${result.export.filename}"`)
        .send(result.export.content);
    },
  );

  app.post<{ Params: { id: string; launchId: string; channel: string } }>(
    "/workspaces/:id/launches/:launchId/channels/:channel/dispatch",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const channel = request.params.channel as LaunchChannel;
      if (!(LAUNCH_CHANNELS as readonly string[]).includes(channel)) {
        return reply.status(404).send({ error: "unknown_channel" });
      }
      const parsed = dispatchChannelInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        const result = await dispatchChannel(
          db,
          runtime,
          request.params.id,
          request.params.launchId,
          channel,
          parsed.data,
          actorOf(request),
        );
        if (!result.ok) {
          return reply
            .status(DISPATCH_ERROR_STATUS[result.error] ?? 400)
            .send({ error: result.error, message: result.message });
        }
        return { submissions: result.submissions };
      } catch (error) {
        return externalActionError(error, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Multi-step sequences (Sprint 30)
  // -------------------------------------------------------------------------

  // Define / replace the follow-up chain (steps per personalized channel).
  app.put<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/launches/:launchId/sequence",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = setSequenceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const result = setSequence(db, request.params.id, request.params.launchId, parsed.data);
      if (!result.ok) {
        const status = result.error === "launch_not_found" ? 404 : 400;
        return reply.status(status).send({ error: result.error });
      }
      return { steps: result.steps };
    },
  );

  // Automation mode / stop-on-reply / X connection — never reset on a name edit.
  app.patch<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/launches/:launchId/sequence-config",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateLaunchSequenceConfigInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const launch = updateLaunchSequenceConfig(
        db,
        request.params.id,
        request.params.launchId,
        parsed.data,
      );
      if (!launch) return reply.status(404).send({ error: "launch_not_found" });
      return launch;
    },
  );

  // Enroll the audience + run the first tick.
  app.post<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/launches/:launchId/sequence/start",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const result = await startSequence(
        db,
        llm,
        evidence,
        runtime,
        request.params.id,
        request.params.launchId,
      );
      if (!result.ok) {
        const status = result.error === "launch_not_found" ? 404 : 409;
        return reply.status(status).send({ error: result.error });
      }
      return result.result;
    },
  );

  // Advance this launch's sequence now ("Run now" + tests).
  app.post<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/launches/:launchId/sequence/run",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const result = await runLaunchSequence(
        db,
        llm,
        evidence,
        runtime,
        request.params.id,
        request.params.launchId,
      );
      if (!result.ok) {
        const status = result.error === "launch_not_found" ? 404 : 409;
        return reply.status(status).send({ error: result.error });
      }
      return result.result;
    },
  );

  // Manual stop (email's only stop path; also a manual stop on any channel).
  app.post<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/launches/:launchId/sequence/stop",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = stopSequenceInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const result = stopSequence(db, request.params.id, request.params.launchId, parsed.data);
      if (!result.ok) return reply.status(404).send({ error: result.error });
      return { stopped: result.stopped };
    },
  );

  // Worker entry: advance every sequence launch in the workspace.
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/sequences/run",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return runSequences(db, llm, evidence, runtime, request.params.id);
    },
  );
}
