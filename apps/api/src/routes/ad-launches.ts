import type { FastifyInstance, FastifyReply } from "fastify";
import {
  AD_LAUNCH_ACTIONS,
  createAdLaunchInputSchema,
  proposeBudgetChangeInputSchema,
  proposeTargetingChangeInputSchema,
  updateAdLaunchInputSchema,
  updateAdSettingsInputSchema,
  type AdLaunchAction,
  type CreateAdLaunchInput,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { adsExecutionAdapterFor, type AdsExecutionAdapter } from "../connectors/ads";
import { ConnectorFabricError, type ConnectorFabric } from "../connectors/fabric";
import {
  applyLaunchAction,
  checkSpendGuardrails,
  createLaunch,
  creativeFieldsFrom,
  deleteLaunch,
  getAdSettings,
  getLaunch,
  getLaunchWithContext,
  isSpending,
  InvalidLaunchTransitionError,
  listLaunchDecisions,
  listLaunches,
  listSpendingLaunches,
  recordLaunchError,
  setLaunchPlatformStatus,
  updateAdSettings,
  updateLaunch,
} from "../services/ad-launches";
import { getAdAccount } from "../services/ads";
import { getConnection, providerByKey } from "../services/connections";
import { getDraft } from "../services/drafts";
import {
  ExternalActionPreparationError,
  preparePaidLaunchAction,
  prepareBudgetChangeAction,
  prepareTargetingChangeAction,
} from "../services/external-action-adapters";
import type { ExternalActionRuntime } from "../services/external-action-coordinator";
import { getWorkspace } from "../services/workspaces";
import { externalActionError } from "./external-actions";

type Fetcher = typeof fetch;

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

function invalidInput(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: "invalid_input", message });
}

export function registerAdLaunchRoutes(
  app: FastifyInstance,
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  runtime: ExternalActionRuntime,
): void {
  /** Resolve a launch's ad account to its connected execution adapter. */
  function executionAdapterOrError(
    workspaceId: string,
    adAccountId: string,
  ):
    | { ok: true; adapter: AdsExecutionAdapter; externalAccountId: string }
    | { ok: false; status: number; error: string; message: string } {
    const account = getAdAccount(db, workspaceId, adAccountId);
    if (!account) {
      return { ok: false, status: 404, error: "account_not_found", message: "No such ad account." };
    }
    const connection = account.connectionId
      ? getConnection(db, workspaceId, account.connectionId)
      : undefined;
    const provider = connection ? providerByKey(connection.providerKey) : undefined;
    const adapter =
      connection && provider && connection.status === "connected"
        ? adsExecutionAdapterFor(fabric, provider, connection, fetcher)
        : undefined;
    if (!adapter) {
      return {
        ok: false,
        status: 400,
        error: "account_not_launchable",
        message:
          "This ad account has no connected ads platform behind it — launches need a live connection.",
      };
    }
    return { ok: true, adapter, externalAccountId: account.externalId };
  }

  /** Shared create/edit reference checks; returns the creative's campaign. */
  function validateReferences(
    workspaceId: string,
    input: Partial<CreateAdLaunchInput>,
    reply: FastifyReply,
  ): { ok: true; campaignId: string | null } | { ok: false } {
    if (input.adAccountId !== undefined) {
      const account = getAdAccount(db, workspaceId, input.adAccountId);
      if (!account) {
        void reply.status(404).send({ error: "account_not_found" });
        return { ok: false };
      }
      const resolved = executionAdapterOrError(workspaceId, input.adAccountId);
      if (!resolved.ok) {
        void reply.status(resolved.status).send({ error: resolved.error, message: resolved.message });
        return { ok: false };
      }
    }
    let campaignId: string | null = null;
    if (input.creativeDraftId !== undefined) {
      const draft = getDraft(db, workspaceId, input.creativeDraftId);
      if (!draft) {
        void reply.status(404).send({ error: "draft_not_found" });
        return { ok: false };
      }
      if (draft.taskType !== "meta_ad_creative") {
        void reply.status(400).send({
          error: "creative_not_meta",
          message: "Launches take a Meta ad creative draft.",
        });
        return { ok: false };
      }
      if (draft.state !== "approved") {
        void reply.status(409).send({
          error: "creative_not_approved",
          message: "Only an approved creative can be launched.",
        });
        return { ok: false };
      }
      if (!creativeFieldsFrom(draft.content)) {
        void reply.status(400).send({
          error: "creative_unparseable",
          message: "The creative draft is not in the Meta ad format.",
        });
        return { ok: false };
      }
      campaignId = draft.campaignId;
    }
    return { ok: true, campaignId };
  }

  // --- Guardrail settings ---

  app.get<{ Params: { id: string } }>("/workspaces/:id/ads/settings", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return getAdSettings(db, request.params.id);
  });

  app.put<{ Params: { id: string } }>("/workspaces/:id/ads/settings", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = updateAdSettingsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalidInput(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }

    // Flipping the kill switch on pauses every spending launch, best-effort —
    // one platform failure never leaves the rest running unreported.
    const paused: Array<{ launchId: string; ok: boolean; error?: string }> = [];
    if (parsed.data.killSwitch === true) {
      for (const launch of listSpendingLaunches(db, request.params.id)) {
        const resolved = executionAdapterOrError(request.params.id, launch.adAccountId);
        if (!resolved.ok) {
          recordLaunchError(db, launch.id, resolved.message);
          paused.push({ launchId: launch.id, ok: false, error: resolved.message });
          continue;
        }
        try {
          await setLaunchPlatformStatus(db, resolved.adapter, launch, "PAUSED");
          paused.push({ launchId: launch.id, ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordLaunchError(db, launch.id, message);
          paused.push({ launchId: launch.id, ok: false, error: message });
        }
      }
    }
    const settings = updateAdSettings(db, request.params.id, parsed.data);
    return { settings, paused };
  });

  // --- Launch CRUD ---

  app.get<{ Params: { id: string } }>("/workspaces/:id/ads/launches", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listLaunches(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/ads/launches", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createAdLaunchInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalidInput(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const refs = validateReferences(request.params.id, parsed.data, reply);
    if (!refs.ok) return reply;
    return reply.status(201).send(createLaunch(db, request.params.id, parsed.data, refs.campaignId));
  });

  app.get<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/ads/launches/:launchId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const launch = getLaunchWithContext(db, request.params.id, request.params.launchId);
      if (!launch) return reply.status(404).send({ error: "launch_not_found" });
      return { ...launch, decisions: listLaunchDecisions(db, launch.id) };
    },
  );

  app.patch<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/ads/launches/:launchId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const launch = getLaunch(db, request.params.id, request.params.launchId);
      if (!launch) return reply.status(404).send({ error: "launch_not_found" });
      if (launch.status !== "draft") {
        return reply.status(409).send({
          error: "not_editable",
          message: "Only a draft launch can be edited — revise it back to draft first.",
        });
      }
      const parsed = updateAdLaunchInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidInput(reply, parsed.error.issues.map((i) => i.message).join("; "));
      }
      const refs = validateReferences(request.params.id, parsed.data, reply);
      if (!refs.ok) return reply;
      return updateLaunch(db, launch, parsed.data, refs.campaignId);
    },
  );

  app.delete<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/ads/launches/:launchId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const launch = getLaunch(db, request.params.id, request.params.launchId);
      if (!launch) return reply.status(404).send({ error: "launch_not_found" });
      if (launch.status === "launched") {
        return reply.status(409).send({
          error: "already_launched",
          message: "A launched campaign stays on record — pause it instead.",
        });
      }
      deleteLaunch(db, launch.id);
      return reply.status(204).send();
    },
  );

  // --- Approval gate ---

  for (const action of AD_LAUNCH_ACTIONS) {
    app.post<{ Params: { id: string; launchId: string } }>(
      `/workspaces/:id/ads/launches/:launchId/${action}`,
      async (request, reply) => {
        if (!workspaceOr404(db, request.params.id, reply)) return reply;
        const launch = getLaunch(db, request.params.id, request.params.launchId);
        if (!launch) return reply.status(404).send({ error: "launch_not_found" });
        try {
          return applyLaunchAction(db, launch, action as AdLaunchAction, actorOf(request));
        } catch (err) {
          if (err instanceof InvalidLaunchTransitionError) {
            return reply.status(409).send({ error: "invalid_transition", message: err.message });
          }
          throw err;
        }
      },
    );
  }

  // --- The money moment: proposes a durable `paid_launch` action; the action
  // policy decides whether it spends now or waits for authorization in Review.

  app.post<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/ads/launches/:launchId/launch",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const launch = getLaunch(db, request.params.id, request.params.launchId);
      if (!launch) return reply.status(404).send({ error: "launch_not_found" });
      const resolved = executionAdapterOrError(request.params.id, launch.adAccountId);
      if (!resolved.ok) {
        return reply.status(resolved.status).send({ error: resolved.error, message: resolved.message });
      }
      try {
        const command = preparePaidLaunchAction(db, request.params.id, launch.id);
        const submission = await runtime.propose(command, actorOf(request));
        return reply
          .status(submission.action.status === "authorization_required" ? 202 : 201)
          .send(submission);
      } catch (error) {
        if (error instanceof ExternalActionPreparationError) {
          return reply.status(error.statusCode).send({
            error: error.code,
            message: error.message,
            ...(error.details as object | undefined),
          });
        }
        return externalActionError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/ads/launches/:launchId/budget-change",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = proposeBudgetChangeInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidInput(reply, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        const command = await prepareBudgetChangeAction(
          db,
          fabric,
          fetcher,
          request.params.id,
          request.params.launchId,
          parsed.data,
        );
        const submission = await runtime.propose(command, actorOf(request));
        return reply
          .status(submission.action.status === "authorization_required" ? 202 : 201)
          .send(submission);
      } catch (error) {
        if (error instanceof ExternalActionPreparationError) {
          return reply.status(error.statusCode).send({ error: error.code, message: error.message });
        }
        if (error instanceof ConnectorFabricError) {
          return reply.status(502).send({ error: "provider_read_failed", message: error.message });
        }
        return externalActionError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/ads/launches/:launchId/targeting-change",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = proposeTargetingChangeInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidInput(reply, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        const command = await prepareTargetingChangeAction(
          db,
          fabric,
          fetcher,
          request.params.id,
          request.params.launchId,
          parsed.data,
        );
        const submission = await runtime.propose(command, actorOf(request));
        return reply
          .status(submission.action.status === "authorization_required" ? 202 : 201)
          .send(submission);
      } catch (error) {
        if (error instanceof ExternalActionPreparationError) {
          return reply.status(error.statusCode).send({ error: error.code, message: error.message });
        }
        if (error instanceof ConnectorFabricError) {
          return reply.status(502).send({ error: "provider_read_failed", message: error.message });
        }
        return externalActionError(error, reply);
      }
    },
  );

  // --- Pause / resume ---

  app.post<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/ads/launches/:launchId/pause",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const launch = getLaunch(db, request.params.id, request.params.launchId);
      if (!launch) return reply.status(404).send({ error: "launch_not_found" });
      if (launch.status !== "launched") {
        return reply.status(409).send({ error: "not_launched" });
      }
      if (!isSpending(launch)) {
        return reply.status(409).send({ error: "already_paused" });
      }
      const resolved = executionAdapterOrError(request.params.id, launch.adAccountId);
      if (!resolved.ok) {
        return reply.status(resolved.status).send({ error: resolved.error, message: resolved.message });
      }
      try {
        return await setLaunchPlatformStatus(db, resolved.adapter, launch, "PAUSED");
      } catch (err) {
        if (err instanceof ConnectorFabricError) {
          return reply.status(502).send({ error: "pause_failed", message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; launchId: string } }>(
    "/workspaces/:id/ads/launches/:launchId/resume",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const launch = getLaunch(db, request.params.id, request.params.launchId);
      if (!launch) return reply.status(404).send({ error: "launch_not_found" });
      if (launch.status !== "launched") {
        return reply.status(409).send({ error: "not_launched" });
      }
      if (isSpending(launch)) {
        return reply.status(409).send({ error: "already_active" });
      }
      // Resuming makes money flow again — same guardrails as a launch.
      const guardrails = checkSpendGuardrails(db, launch);
      if (!guardrails.ok) {
        return reply.status(409).send({ error: guardrails.error, message: guardrails.message });
      }
      const resolved = executionAdapterOrError(request.params.id, launch.adAccountId);
      if (!resolved.ok) {
        return reply.status(resolved.status).send({ error: resolved.error, message: resolved.message });
      }
      try {
        return await setLaunchPlatformStatus(db, resolved.adapter, launch, "ACTIVE");
      } catch (err) {
        if (err instanceof ConnectorFabricError) {
          return reply.status(502).send({ error: "resume_failed", message: err.message });
        }
        throw err;
      }
    },
  );
}
